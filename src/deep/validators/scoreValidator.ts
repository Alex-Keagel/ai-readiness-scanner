import { SignalResult, LevelSignal } from '../../scoring/types';
import { ModuleProfile } from '../types';
import { ValidationIssue } from '../validationAgent';

export interface ScoreValidationResult {
  evidenceAlignment: number; // 0.0-1.0 how well score matches evidence
  suggestedScore?: number; // Recommended score if current seems inflated
  issues: ValidationIssue[];
  evidenceStrength: 'weak' | 'moderate' | 'strong';
}

/**
 * Validates LLM-assigned scores against deterministic evidence.
 * Catches score inflation where LLM gives high scores without sufficient supporting evidence.
 */
export class ScoreValidator {

  /**
   * Checks if the LLM-assigned score is consistent with the available evidence.
   * Returns alignment score and flags potential score inflation.
   */
  async validate(
    signalResult: SignalResult,
    signal: LevelSignal, 
    codebaseModules: ModuleProfile[]
  ): Promise<ScoreValidationResult> {
    const issues: ValidationIssue[] = [];
    
    // Calculate evidence-based score bounds
    const evidenceMetrics = this.calculateEvidenceMetrics(signalResult, signal, codebaseModules);
    const expectedScoreRange = this.computeExpectedScoreRange(evidenceMetrics, signal);
    
    const actualScore = signalResult.score;
    const evidenceAlignment = this.computeAlignment(actualScore, expectedScoreRange);
    
    let suggestedScore: number | undefined;
    
    // Check for score inflation
    if (actualScore > expectedScoreRange.max + 15) {
      const severity = actualScore > expectedScoreRange.max + 30 ? 'high' : 'medium';
      
      issues.push({
        type: 'score-inflation',
        severity,
        description: `Score ${actualScore} appears inflated (evidence suggests ${expectedScoreRange.min}-${expectedScoreRange.max})`,
        evidence: `File count: ${signalResult.files.length}, Evidence strength: ${evidenceMetrics.strength}`
      });
      
      // Suggest a more conservative score
      suggestedScore = Math.min(actualScore, expectedScoreRange.max + 10);
    }
    
    // Check for under-scoring (less common but possible)
    if (actualScore < expectedScoreRange.min - 20 && evidenceMetrics.strength === 'strong') {
      issues.push({
        type: 'score-inflation', // Reuse type, but this is under-scoring
        severity: 'low',
        description: `Score ${actualScore} may be too conservative (evidence suggests ${expectedScoreRange.min}-${expectedScoreRange.max})`,
        evidence: `Strong evidence with ${signalResult.files.length} files and clear content markers`
      });
    }

    return {
      evidenceAlignment,
      suggestedScore,
      issues,
      evidenceStrength: evidenceMetrics.strength
    };
  }

  /**
   * Calculates metrics about the strength of evidence supporting the signal.
   */
  private calculateEvidenceMetrics(
    signalResult: SignalResult,
    signal: LevelSignal,
    codebaseModules: ModuleProfile[]
  ): {
    fileCount: number;
    contentMarkerMatches: number;
    moduleQuality: number;
    strength: 'weak' | 'moderate' | 'strong';
  } {
    const fileCount = signalResult.files.length;
    
    // Count how many content markers were likely found
    let contentMarkerMatches = 0;
    const finding = signalResult.finding.toLowerCase();
    
    for (const marker of signal.contentMarkers) {
      // Simple heuristic: if the marker (or part of it) appears in the finding, count it
      const markerKeywords = marker.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
      const markerFound = markerKeywords.some(keyword => finding.includes(keyword));
      if (markerFound) {
        contentMarkerMatches++;
      }
    }
    
    // Calculate module quality metrics from the files involved
    let moduleQuality = 0.0;
    const relevantModules = codebaseModules.filter(m => signalResult.files.includes(m.path));
    
    if (relevantModules.length > 0) {
      const avgComplexity = relevantModules.filter(m => m.complexity === 'high').length / relevantModules.length;
      const avgExports = relevantModules.reduce((sum, m) => sum + m.exportCount, 0) / relevantModules.length;
      const hasTests = relevantModules.some(m => m.hasTests);
      const hasDocstring = relevantModules.some(m => m.hasDocstring);
      
      moduleQuality = (
        Math.min(avgExports / 5, 1) * 0.3 +  // Export diversity
        avgComplexity * 0.2 +                 // Complexity indicator
        (hasTests ? 0.25 : 0) +               // Test presence
        (hasDocstring ? 0.25 : 0)             // Documentation
      );
    }
    
    // Determine overall evidence strength
    let strength: 'weak' | 'moderate' | 'strong' = 'weak';
    
    if (fileCount >= 3 && contentMarkerMatches >= 2 && moduleQuality > 0.5) {
      strength = 'strong';
    } else if (fileCount >= 2 || contentMarkerMatches >= 1 || moduleQuality > 0.3) {
      strength = 'moderate';
    }
    
    return {
      fileCount,
      contentMarkerMatches,
      moduleQuality,
      strength
    };
  }

  /**
   * Computes the expected score range based on evidence strength.
   */
  private computeExpectedScoreRange(
    evidenceMetrics: { fileCount: number; contentMarkerMatches: number; moduleQuality: number; strength: string },
    signal: LevelSignal
  ): { min: number; max: number } {
    const { fileCount, contentMarkerMatches, moduleQuality, strength } = evidenceMetrics;
    
    // Base score ranges by signal category and weight
    let baseMin = 0;
    let baseMax = 100;
    
    if (signal.category === 'file-presence') {
      // File presence signals: score based mainly on file count and quality
      if (fileCount === 0) {
        baseMin = 0;
        baseMax = 10;
      } else if (fileCount === 1) {
        baseMin = 20;
        baseMax = 60;
      } else if (fileCount >= 2) {
        baseMin = 50;
        baseMax = 90;
      }
    } else if (signal.category === 'content-quality') {
      // Content quality signals: score based on content markers and module quality
      if (contentMarkerMatches === 0) {
        baseMin = 0;
        baseMax = 30;
      } else if (contentMarkerMatches === 1) {
        baseMin = 30;
        baseMax = 70;
      } else {
        baseMin = 60;
        baseMax = 95;
      }
      
      // Adjust based on module quality
      const qualityAdjustment = (moduleQuality - 0.5) * 20; // -10 to +10 adjustment
      baseMin = Math.max(0, baseMin + qualityAdjustment);
      baseMax = Math.min(100, baseMax + qualityAdjustment);
    } else if (signal.category === 'depth') {
      // Depth signals: require strong evidence for high scores
      if (strength === 'weak') {
        baseMax = 50;
      } else if (strength === 'moderate') {
        baseMax = 75;
      }
      // Strong evidence allows full range
    }
    
    // Adjust based on signal weight/importance
    const weightFactor = Math.min(signal.weight / 25, 1.0); // Normalize to 0-1
    const weightAdjustment = (1 - weightFactor) * 15; // Reduce max by up to 15 points for low-weight signals
    baseMax = Math.max(baseMin + 10, baseMax - weightAdjustment);
    
    return {
      min: Math.round(baseMin),
      max: Math.round(baseMax)
    };
  }

  /**
   * Computes alignment score between actual score and expected range.
   */
  private computeAlignment(actualScore: number, expectedRange: { min: number; max: number }): number {
    if (actualScore >= expectedRange.min && actualScore <= expectedRange.max) {
      // Score is within expected range - perfect alignment
      return 1.0;
    }
    
    if (actualScore > expectedRange.max) {
      // Score is too high - penalize based on how far outside range
      const overage = actualScore - expectedRange.max;
      return Math.max(0, 1 - (overage / 50)); // Gradual penalty up to 50 points over
    }
    
    if (actualScore < expectedRange.min) {
      // Score is too low - smaller penalty (conservative scoring is usually safer)
      const underage = expectedRange.min - actualScore;
      return Math.max(0.5, 1 - (underage / 100)); // Gentler penalty for under-scoring
    }
    
    return 0.0;
  }
}
import { LevelSignal, SignalResult, RealityCheckRef } from '../scoring/types';
import { ModuleProfile } from './types';
import { logger } from '../logging';
import { PathValidator } from './validators/pathValidator';
import { ScoreValidator } from './validators/scoreValidator';
import { ContradictionValidator } from './validators/contradictionValidator';

export interface ValidationResult {
  isValid: boolean;
  confidence: number; // 0.0-1.0 computed confidence score
  evidenceScore: number; // 0.0-1.0 based on supporting evidence
  contradictionScore: number; // 0.0-1.0 based on contradictions found
  pathValidationRate: number; // 0.0-1.0 % of referenced paths that exist
  issues: ValidationIssue[];
  corrections: string[];
}

export interface ValidationIssue {
  type: 'path-hallucination' | 'score-inflation' | 'contradiction' | 'stale-claim';
  severity: 'high' | 'medium' | 'low';
  description: string;
  evidence?: string;
}

/**
 * Validation agent that runs AFTER each LLM phase to catch hallucinations and inconsistencies.
 * Replaces hard-coded confidence scores with computed ones based on evidence strength.
 */
export class ValidationAgent {
  private pathValidator: PathValidator;
  private scoreValidator: ScoreValidator;
  private contradictionValidator: ContradictionValidator;

  constructor() {
    this.pathValidator = new PathValidator();
    this.scoreValidator = new ScoreValidator();
    this.contradictionValidator = new ContradictionValidator();
  }

  /**
   * Validates an LLM signal finding against filesystem reality and deterministic data.
   * Returns a ValidationResult with computed confidence score (0.0-1.0).
   */
  async validateSignalFinding(
    signal: LevelSignal,
    signalResult: SignalResult,
    realityChecks: RealityCheckRef[],
    codebaseModules: ModuleProfile[]
  ): Promise<ValidationResult> {
    const timer = logger.time(`ValidationAgent-${signal.id}`);
    const issues: ValidationIssue[] = [];
    const corrections: string[] = [];

    try {
      // 1. Path validation - check if referenced paths actually exist
      const pathValidation = await this.pathValidator.validate(
        signalResult.finding,
        realityChecks,
        codebaseModules.map(m => m.path)
      );
      issues.push(...pathValidation.issues);
      corrections.push(...pathValidation.corrections);

      // 2. Score validation - check if score matches evidence
      const scoreValidation = await this.scoreValidator.validate(
        signalResult,
        signal,
        codebaseModules
      );
      issues.push(...scoreValidation.issues);
      if (scoreValidation.suggestedScore !== undefined) {
        corrections.push(`Score adjusted from ${signalResult.score} to ${scoreValidation.suggestedScore} based on evidence`);
      }

      // 3. Contradiction validation - check for internal contradictions
      const contradictionValidation = await this.contradictionValidator.validate(
        signalResult,
        signal,
        realityChecks
      );
      issues.push(...contradictionValidation.issues);
      corrections.push(...contradictionValidation.corrections);

      // Compute confidence score based on validation results
      const confidence = this.computeConfidence(signalResult, {
        pathValidation,
        scoreValidation,
        contradictionValidation
      });

      timer?.end?.();

      return {
        isValid: issues.filter(i => i.severity === 'high').length === 0,
        confidence: confidence.overall,
        evidenceScore: confidence.evidence,
        contradictionScore: confidence.contradiction,
        pathValidationRate: pathValidation.pathValidationRate,
        issues,
        corrections
      };

    } catch (error) {
      timer?.end?.();
      logger.debug(`ValidationAgent: Error validating ${signal.id}`, error);
      
      // Return low confidence on validation failure
      return {
        isValid: false,
        confidence: 0.3,
        evidenceScore: 0.0,
        contradictionScore: 0.0,
        pathValidationRate: 0.0,
        issues: [{ 
          type: 'contradiction', 
          severity: 'medium', 
          description: 'Validation failed due to internal error',
          evidence: String(error) 
        }],
        corrections: []
      };
    }
  }

  /**
   * Computes a real confidence score (0.0-1.0) based on multiple validation signals.
   * Replaces the current hard-coded 0.75/0.85 confidence with evidence-based scoring.
   */
  computeConfidence(
    signal: SignalResult,
    validationResults: {
      pathValidation: any;
      scoreValidation: any; 
      contradictionValidation: any;
    }
  ): { overall: number; evidence: number; contradiction: number } {
    const { pathValidation, scoreValidation, contradictionValidation } = validationResults;
    
    // Evidence strength (0.0-1.0)
    let evidenceScore = 0.0;
    
    // Base evidence from file count
    const fileCount = signal.files.length;
    evidenceScore += Math.min(fileCount / 3, 0.3); // Up to 30% from file diversity
    
    // Path validation rate
    evidenceScore += pathValidation.pathValidationRate * 0.4; // Up to 40% from valid paths
    
    // Score-evidence alignment 
    const scoreAlignment = scoreValidation.evidenceAlignment || 0.0;
    evidenceScore += scoreAlignment * 0.3; // Up to 30% from score consistency
    
    // Contradiction penalty (0.0-1.0, lower is better)
    const contradictionCount = contradictionValidation.contradictions || 0;
    const contradictionScore = Math.max(0, 1 - (contradictionCount * 0.25));
    
    // Source diversity bonus (but cap total to prevent overconfidence)
    let diversityBonus = 0.0;
    if (signal.modelUsed) diversityBonus += 0.05; // LLM analysis present
    if (signal.realityChecks && signal.realityChecks.length > 0) diversityBonus += 0.05; // Reality checks
    if (fileCount > 1) diversityBonus += 0.05; // Multiple files
    
    evidenceScore = Math.min(evidenceScore + diversityBonus, 0.9); // Cap at 90% to leave room for penalties
    
    // Apply penalty for high-severity issues
    let severityPenalty = 0.0;
    
    if (pathValidation.issues?.some((i: any) => i.severity === 'high')) {
      severityPenalty += 0.4; // Major penalty for path hallucinations
    }
    if (scoreValidation.issues?.some((i: any) => i.severity === 'high')) {
      severityPenalty += 0.3; // Penalty for score inflation
    }
    if (contradictionValidation.issues?.some((i: any) => i.severity === 'high')) {
      severityPenalty += 0.3; // Penalty for contradictions
    }

    // Overall confidence: weighted combination with penalty
    const overall = Math.max(0.0, (
      evidenceScore * 0.6 +           // 60% evidence strength  
      contradictionScore * 0.3 +      // 30% contradiction penalty
      (signal.detected ? 0.1 : 0.0)   // 10% detection bonus
    ) - severityPenalty);
    
    return {
      overall: Math.max(0.0, Math.min(1.0, overall)),
      evidence: evidenceScore,
      contradiction: contradictionScore
    };
  }

  /**
   * Sanitizes LLM finding text by removing or correcting false claims.
   * Enhanced version of the existing graphBuilder.sanitizeFinding() with broader validation.
   */
  sanitizeFinding(finding: string, realityChecks: RealityCheckRef[]): string {
    if (!realityChecks || realityChecks.length === 0) {
      return finding;
    }

    const validPathChecks = realityChecks.filter(
      c => c.category === 'path' && c.status === 'valid'
    );
    if (validPathChecks.length === 0) {
      return finding;
    }

    // Expanded patterns for false claims
    const falseClaims: RegExp[] = [
      // Existing patterns from graphBuilder
      /(?:non-?existent|missing|hallucinated|fabricated|incorrect|invalid|fake|wrong)\s+(?:script\s+)?(?:paths?|directories?|dir|folders?|files?|structures?)/gi,
      /(?:paths?|directories?|dir|folders?|files?|structures?)\s+(?:do(?:es)?n'?t|don'?t|does\s+not|do\s+not)\s+exist/gi,
      /referenc(?:es?|ing)\s+(?:non-?existent|missing|invalid|incorrect|wrong)\s+(?:paths?|directories?|folders?|files?)/gi,
      /(?:paths?|directories?|folders?|files?)\s+(?:are|is)\s+(?:non-?existent|missing|invalid|incorrect|fabricated|hallucinated)/gi,
      
      // New patterns for common LLM hallucinations
      /(?:could\s+not|cannot|unable\s+to)\s+(?:find|locate|access)\s+(?:the\s+)?(?:paths?|directories?|folders?|files?)/gi,
      /(?:no|zero|none)\s+(?:valid\s+)?(?:paths?|directories?|folders?|files?)\s+(?:found|detected|present)/gi,
      /(?:paths?|directories?|folders?|files?)\s+(?:appear\s+to\s+be\s+)?(?:missing|absent|not\s+present)/gi,
      /seems?\s+to\s+(?:reference|point\s+to)\s+(?:non-?existent|invalid|missing)\s+(?:paths?|directories?|folders?|files?)/gi,
    ];

    let sanitized = finding;
    const verifiedPaths = validPathChecks.map(c => c.claim);

    // Check each verified-valid path — if the finding negatively references it, correct it
    for (const check of validPathChecks) {
      const pathSegments = check.claim.replace(/^['"`]+|['"`]+$/g, '').split('/');
      const leafName = pathSegments[pathSegments.length - 1];
      const parentDir = pathSegments.length > 1 ? pathSegments[pathSegments.length - 2] : null;

      // If the finding mentions this specific path or its parent directory in a negative context
      if (parentDir && sanitized.toLowerCase().includes(parentDir.toLowerCase())) {
        for (const pattern of falseClaims) {
          pattern.lastIndex = 0;
          if (pattern.test(sanitized)) {
            sanitized = sanitized.replace(pattern, 'referenced paths');
          }
        }
      }
      if (leafName && sanitized.toLowerCase().includes(leafName.toLowerCase())) {
        for (const pattern of falseClaims) {
          pattern.lastIndex = 0;
          if (pattern.test(sanitized)) {
            sanitized = sanitized.replace(pattern, 'referenced paths');
          }
        }
      }
    }

    // Score inflation detection and correction
    const scoreMatch = sanitized.match(/score[:\s]*(\d+)/i);
    if (scoreMatch) {
      const mentionedScore = parseInt(scoreMatch[1], 10);
      // If the finding mentions a suspiciously high score, flag it
      if (mentionedScore > 90 && validPathChecks.length < 3) {
        sanitized = sanitized.replace(/score[:\s]*\d+/gi, 'score (validation-adjusted)');
      }
    }

    // If false claims were detected and corrected, append verification note
    if (sanitized !== finding) {
      const pathList = verifiedPaths.slice(0, 5).join(', ');
      sanitized += ` [Verified valid: ${pathList}${verifiedPaths.length > 5 ? ` (+${verifiedPaths.length - 5} more)` : ''}]`;
    } else {
      // Even if no regex matched, do a broader check: does the finding contain
      // any negative path sentiment while reality checks confirm validity?
      const negativePathIndicators = [
        'non-existent', 'nonexistent', 'doesn\'t exist', 'does not exist',
        'don\'t exist', 'do not exist', 'missing path', 'invalid path',
        'hallucinated', 'fabricated', 'incorrect directory', 'incorrect path',
        'wrong path', 'wrong directory', 'could not find', 'unable to locate',
        'no valid paths', 'none found', 'not present', 'appears missing'
      ];
      const lowerFinding = finding.toLowerCase();
      const hasNegativeClaim = negativePathIndicators.some(indicator => lowerFinding.includes(indicator));

      if (hasNegativeClaim) {
        const pathList = verifiedPaths.slice(0, 5).join(', ');
        sanitized += ` [Note: reality checks verified these paths as valid: ${pathList}${verifiedPaths.length > 5 ? ` (+${verifiedPaths.length - 5} more)` : ''}]`;
      }
    }

    return sanitized;
  }
}
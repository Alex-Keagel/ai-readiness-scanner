import { SignalResult, LevelSignal, RealityCheckRef } from '../../scoring/types';
import { ValidationIssue } from '../validationAgent';

export interface ContradictionValidationResult {
  contradictions: number; // Count of contradictions found
  issues: ValidationIssue[];
  corrections: string[];
}

/**
 * Detects contradictions where LLM output contradicts its own input data or internal logic.
 * Catches cases like "no instruction files found" when files ARE detected.
 */
export class ContradictionValidator {

  /**
   * Validates LLM output for internal contradictions and conflicts with deterministic data.
   */
  async validate(
    signalResult: SignalResult,
    signal: LevelSignal,
    realityChecks: RealityCheckRef[]
  ): Promise<ContradictionValidationResult> {
    const issues: ValidationIssue[] = [];
    const corrections: string[] = [];
    let contradictions = 0;

    // 1. Check detection vs. finding contradiction
    const detectionContradiction = this.checkDetectionFindingContradiction(signalResult);
    if (detectionContradiction) {
      issues.push(detectionContradiction);
      contradictions++;
    }

    // 2. Check files vs. finding contradiction  
    const filesContradiction = this.checkFilesFindingContradiction(signalResult, signal);
    if (filesContradiction) {
      issues.push(filesContradiction);
      corrections.push(`LLM found ${signalResult.files.length} files but claimed none exist`);
      contradictions++;
    }

    // 3. Check reality checks vs. finding contradictions
    const realityContradictions = this.checkRealityFindingContradictions(signalResult, realityChecks);
    issues.push(...realityContradictions);
    contradictions += realityContradictions.length;

    // 4. Check score vs. finding contradiction
    const scoreContradiction = this.checkScoreFindingContradiction(signalResult);
    if (scoreContradiction) {
      issues.push(scoreContradiction);
      contradictions++;
    }

    // 5. Check for stale claims (timestamps, deprecated references)
    const staleClaims = this.checkStaleClaims(signalResult);
    issues.push(...staleClaims);
    if (staleClaims.length > 0) {
      corrections.push(`Found ${staleClaims.length} potentially stale claims in finding`);
    }

    return {
      contradictions,
      issues,
      corrections
    };
  }

  /**
   * Checks if detected=true but finding says nothing was found, or vice versa.
   */
  private checkDetectionFindingContradiction(signalResult: SignalResult): ValidationIssue | null {
    const finding = signalResult.finding.toLowerCase();
    const hasNegativeLanguage = this.containsNegativeLanguage(finding);
    
    if (signalResult.detected && hasNegativeLanguage) {
      return {
        type: 'contradiction',
        severity: 'high',
        description: 'Signal marked as detected but finding contains negative language',
        evidence: `Detected: ${signalResult.detected}, but finding suggests absence/failure`
      };
    }
    
    if (!signalResult.detected && !hasNegativeLanguage && signalResult.score > 50) {
      return {
        type: 'contradiction',
        severity: 'medium',
        description: 'Signal not detected but finding is positive with decent score',
        evidence: `Detected: false, Score: ${signalResult.score}, but finding seems positive`
      };
    }
    
    return null;
  }

  /**
   * Checks if LLM claims no files exist but files array is populated.
   */
  private checkFilesFindingContradiction(signalResult: SignalResult, _signal: LevelSignal): ValidationIssue | null {
    if (signalResult.files.length === 0) {
      return null; // No files, no contradiction possible
    }
    
    const finding = signalResult.finding.toLowerCase();
    const noFilesIndicators = [
      'no files', 'no file', 'files not found', 'file not found',
      'missing files', 'missing file', 'absent files', 'absent file',
      'no.*found', 'not.*present', 'not.*detected', 'none.*exist',
      'zero files', 'empty directory', 'no matches'
    ];
    
    const claimsNoFiles = noFilesIndicators.some(indicator => {
      const regex = new RegExp(indicator, 'i');
      return regex.test(finding);
    });
    
    if (claimsNoFiles) {
      return {
        type: 'contradiction',
        severity: 'high',
        description: `Finding claims no files exist but ${signalResult.files.length} files were found`,
        evidence: `Files: [${signalResult.files.slice(0, 3).join(', ')}${signalResult.files.length > 3 ? '...' : ''}]`
      };
    }
    
    return null;
  }

  /**
   * Checks if finding contradicts reality check results.
   */
  private checkRealityFindingContradictions(
    signalResult: SignalResult, 
    realityChecks: RealityCheckRef[]
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const finding = signalResult.finding.toLowerCase();
    
    for (const check of realityChecks) {
      if (check.status === 'valid' && check.category === 'path') {
        // Check if finding claims this valid path doesn't exist
        const pathName = check.claim.split('/').pop()?.toLowerCase() || '';
        const dirName = check.claim.split('/').slice(-2, -1)[0]?.toLowerCase() || '';
        
        if (pathName && (finding.includes(pathName) || finding.includes(dirName))) {
          const negativeIndicators = [
            'does not exist', 'doesn\'t exist', 'not found', 'missing',
            'non-existent', 'absent', 'invalid', 'incorrect'
          ];
          
          const hasNegative = negativeIndicators.some(indicator => {
            const pathIndex = finding.indexOf(pathName);
            if (pathIndex === -1) return false;
            
            // Look for negative indicator within 30 characters of the path
            const contextStart = Math.max(0, pathIndex - 30);
            const contextEnd = Math.min(finding.length, pathIndex + pathName.length + 30);
            const context = finding.slice(contextStart, contextEnd);
            
            return context.includes(indicator);
          });
          
          if (hasNegative) {
            issues.push({
              type: 'contradiction',
              severity: 'high',
              description: `Finding claims "${check.claim}" doesn't exist but reality check confirms it's valid`,
              evidence: `Reality check status: ${check.status} for path: ${check.claim}`
            });
          }
        }
      } else if (check.status === 'invalid' && check.category === 'path') {
        // Check if finding claims this invalid path exists
        const pathName = check.claim.split('/').pop()?.toLowerCase() || '';
        
        if (pathName && finding.includes(pathName)) {
          const positiveIndicators = [
            'found', 'exists', 'present', 'detected', 'available', 'valid'
          ];
          
          const hasPositive = positiveIndicators.some(indicator => {
            const pathIndex = finding.indexOf(pathName);
            if (pathIndex === -1) return false;
            
            const contextStart = Math.max(0, pathIndex - 30);
            const contextEnd = Math.min(finding.length, pathIndex + pathName.length + 30);
            const context = finding.slice(contextStart, contextEnd);
            
            return context.includes(indicator);
          });
          
          if (hasPositive) {
            issues.push({
              type: 'contradiction',
              severity: 'medium',
              description: `Finding claims "${check.claim}" exists but reality check shows it's invalid`,
              evidence: `Reality check status: ${check.status} for path: ${check.claim}`
            });
          }
        }
      }
    }
    
    return issues;
  }

  /**
   * Checks if high score contradicts negative finding text.
   */
  private checkScoreFindingContradiction(signalResult: SignalResult): ValidationIssue | null {
    const { score, finding } = signalResult;
    const finding_lower = finding.toLowerCase();
    
    if (score >= 70) {
      // High score should have positive language
      const hasNegativeLanguage = this.containsNegativeLanguage(finding_lower);
      
      if (hasNegativeLanguage) {
        return {
          type: 'contradiction',
          severity: 'medium',
          description: `High score (${score}) contradicts negative language in finding`,
          evidence: 'Finding contains words like "missing", "not found", "incomplete" despite high score'
        };
      }
    } else if (score <= 30) {
      // Low score should not have overly positive language
      const positiveIndicators = [
        'excellent', 'outstanding', 'perfect', 'comprehensive',
        'well-structured', 'high quality', 'robust', 'complete'
      ];
      
      const hasPositiveLanguage = positiveIndicators.some(indicator => finding_lower.includes(indicator));
      
      if (hasPositiveLanguage) {
        return {
          type: 'contradiction',
          severity: 'low',
          description: `Low score (${score}) contradicts positive language in finding`,
          evidence: 'Finding contains positive language despite low score'
        };
      }
    }
    
    return null;
  }

  /**
   * Checks for stale claims like old timestamps, deprecated references, or outdated information.
   */
  private checkStaleClaims(signalResult: SignalResult): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const finding = signalResult.finding;
    
    // Check for old timestamps (more than 2 years ago)
    const datePattern = /\b(20\d{2})\b/g;
    const currentYear = new Date().getFullYear();
    let match;
    
    while ((match = datePattern.exec(finding)) !== null) {
      const year = parseInt(match[1], 10);
      if (year < currentYear - 2) {
        issues.push({
          type: 'stale-claim',
          severity: 'low',
          description: `Finding references old date: ${year}`,
          evidence: `May indicate outdated information or stale analysis`
        });
      }
    }
    
    // Check for deprecated technology references
    const deprecatedTerms = [
      'bower', 'grunt', 'gulp', 'node 8', 'node 10', 'python 2',
      'angular.js', 'angularjs', 'jquery', 'coffeescript',
      'internet explorer', 'ie 11', 'flash', 'silverlight'
    ];
    
    const lowerFinding = finding.toLowerCase();
    for (const term of deprecatedTerms) {
      if (lowerFinding.includes(term)) {
        issues.push({
          type: 'stale-claim',
          severity: 'medium',
          description: `Finding references potentially deprecated technology: ${term}`,
          evidence: 'May indicate analysis based on outdated codebase state'
        });
      }
    }
    
    // Check for TODO/FIXME references that might be outdated
    const todoPattern = /\b(TODO|FIXME|HACK|DEPRECATED)\b/gi;
    if (todoPattern.test(finding)) {
      issues.push({
        type: 'stale-claim',
        severity: 'low',
        description: 'Finding references TODO/FIXME items',
        evidence: 'These items may have been resolved since analysis was performed'
      });
    }
    
    return issues;
  }

  /**
   * Helper to detect negative language patterns in text.
   */
  private containsNegativeLanguage(text: string): boolean {
    const negativePatterns = [
      /\b(no|none|zero|absent|missing|not\s+found|not\s+present|not\s+detected|not\s+available)\b/gi,
      /\b(doesn'?t\s+exist|don'?t\s+exist|does\s+not\s+exist|do\s+not\s+exist)\b/gi,
      /\b(incomplete|insufficient|inadequate|poor|weak|limited|lacking)\b/gi,
      /\b(failed|failure|unsuccessful|unable|cannot|can'?t)\b/gi,
      /\b(empty|blank|void|null|undefined)\b/gi
    ];
    
    return negativePatterns.some(pattern => pattern.test(text));
  }
}
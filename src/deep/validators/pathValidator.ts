import { RealityCheckRef } from '../../scoring/types';
import { ValidationIssue } from '../validationAgent';

export interface PathValidationResult {
  pathValidationRate: number; // 0.0-1.0 percentage of valid paths referenced
  issues: ValidationIssue[];
  corrections: string[];
  validPaths: string[];
  invalidPaths: string[];
}

/**
 * Validates path references in LLM findings against known valid paths.
 * Catches hallucinations where LLM claims paths don't exist when they actually do.
 */
export class PathValidator {
  
  /**
   * Cross-references path claims in finding text against filesystem reality.
   * Identifies both false negatives (claiming valid paths don't exist) and 
   * false positives (referencing paths that don't exist).
   */
  async validate(
    finding: string, 
    realityChecks: RealityCheckRef[], 
    knownValidPaths: string[]
  ): Promise<PathValidationResult> {
    const issues: ValidationIssue[] = [];
    const corrections: string[] = [];
    const validPaths: string[] = [];
    const invalidPaths: string[] = [];

    // Extract path references from finding text
    const pathReferences = this.extractPathReferences(finding);
    
    if (pathReferences.length === 0) {
      return {
        pathValidationRate: 1.0, // No paths referenced = no validation issues
        issues,
        corrections,
        validPaths,
        invalidPaths
      };
    }

    // Check each path reference against reality checks and known paths
    for (const pathRef of pathReferences) {
      const isValidByReality = realityChecks.some(
        rc => rc.category === 'path' && 
              rc.status === 'valid' && 
              (rc.claim === pathRef || rc.claim.includes(pathRef))
      );
      
      const isValidByKnown = knownValidPaths.some(
        knownPath => knownPath === pathRef || 
                    knownPath.includes(pathRef) || 
                    pathRef.includes(knownPath)
      );
      
      if (isValidByReality || isValidByKnown) {
        validPaths.push(pathRef);
        
        // Check if finding falsely claims this valid path doesn't exist
        if (this.findingClaimsPathMissing(finding, pathRef)) {
          issues.push({
            type: 'path-hallucination',
            severity: 'high',
            description: `LLM claims path "${pathRef}" doesn't exist, but it's verified as valid`,
            evidence: `Reality check confirms "${pathRef}" exists`
          });
          corrections.push(`Path "${pathRef}" is actually valid (corrected false negative)`);
        }
      } else {
        invalidPaths.push(pathRef);
        
        // Check if this path might be a hallucination
        if (this.looksLikeHallucinatedPath(pathRef)) {
          issues.push({
            type: 'path-hallucination',
            severity: 'medium',
            description: `Referenced path "${pathRef}" may not exist`,
            evidence: `Path not found in reality checks or known valid paths`
          });
        }
      }
    }

    const pathValidationRate = pathReferences.length > 0 
      ? validPaths.length / pathReferences.length 
      : 1.0;

    return {
      pathValidationRate,
      issues,
      corrections,
      validPaths,
      invalidPaths
    };
  }

  /**
   * Extracts potential path references from LLM finding text.
   * Looks for patterns that resemble file/directory paths.
   */
  private extractPathReferences(finding: string): string[] {
    const pathPatterns = [
      // Quoted paths: ".github/copilot-instructions.md"
      /["'`]([^"'`]+\.(?:md|ts|js|py|json|yaml|yml|txt|conf|config)[^"'`]*?)["'`]/g,
      
      // Unquoted paths with extensions: src/deep/types.ts
      /\b([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.(?:md|ts|js|py|json|yaml|yml|txt|conf|config|sh|bat))\b/g,
      
      // Directory paths: .github/instructions/
      /\b([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\/)\b/g,
      
      // Hidden files/directories: .vscode/settings.json
      /\b(\.[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)*(?:\.(?:md|ts|js|py|json|yaml|yml|txt|conf|config))?)\b/g,
    ];

    const paths = new Set<string>();
    
    for (const pattern of pathPatterns) {
      let match;
      while ((match = pattern.exec(finding)) !== null) {
        const path = match[1].trim();
        
        // Skip common false positives
        if (!this.shouldSkipPath(path)) {
          paths.add(path);
        }
      }
    }

    return Array.from(paths);
  }

  /**
   * Checks if the finding text claims a specific path is missing/non-existent.
   */
  private findingClaimsPathMissing(finding: string, path: string): boolean {
    const pathSegments = path.split('/');
    const filename = pathSegments[pathSegments.length - 1];
    const dirname = pathSegments.length > 1 ? pathSegments[pathSegments.length - 2] : null;
    
    const negativeIndicators = [
      'does not exist', 'doesn\'t exist', 'do not exist', 'don\'t exist',
      'non-existent', 'nonexistent', 'missing', 'not found', 
      'could not find', 'unable to locate', 'not present',
      'invalid path', 'incorrect path', 'wrong path',
      'hallucinated', 'fabricated'
    ];
    
    const lowerFinding = finding.toLowerCase();
    
    // Check if any negative indicators appear near the path or its components
    for (const indicator of negativeIndicators) {
      const indicatorIndex = lowerFinding.indexOf(indicator);
      if (indicatorIndex === -1) continue;
      
      // Look for the path within 50 characters of the negative indicator
      const contextStart = Math.max(0, indicatorIndex - 50);
      const contextEnd = Math.min(lowerFinding.length, indicatorIndex + indicator.length + 50);
      const context = lowerFinding.slice(contextStart, contextEnd);
      
      if (context.includes(path.toLowerCase()) || 
          (filename && context.includes(filename.toLowerCase())) ||
          (dirname && context.includes(dirname.toLowerCase()))) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Determines if a path looks like it might be hallucinated based on patterns.
   */
  private looksLikeHallucinatedPath(path: string): boolean {
    // Very generic/template-like paths are often hallucinated
    const suspiciousPatterns = [
      /example/i,
      /sample/i,
      /placeholder/i,
      /template/i,
      /your-project/i,
      /my-project/i,
      /project-name/i,
      /foo/i,
      /bar/i,
      /test123/i,
    ];
    
    return suspiciousPatterns.some(pattern => pattern.test(path));
  }

  /**
   * Determines if a path should be skipped during extraction (common false positives).
   */
  private shouldSkipPath(path: string): boolean {
    // Skip patterns from reality checker
    const skipPatterns = [
      /^https?:\/\//,
      /^mailto:/,
      /^ftp:\/\//,
      /^\w+:\/\//,
      /^[a-z]+\/[a-z]+$/, // MIME types like text/plain
      /^application\//,
      /^[A-Z][a-z]+\/[A-Z]/, // PascalCase/PascalCase (class references)
      /^node_modules\//,
      /^\.git\//,
      /^\d+\.\d+/, // version numbers like 3.0/stable
      /^[a-z]+\/\*/, // glob-only patterns
      /^[a-z]+\.[a-z]+\.[a-z]/i, // API references: context.globalState, vscode.Uri.joinPath
      /^[A-Z][a-zA-Z]*\.[a-z]/,  // Class.method: Promise.all, Array.from, Object.entries
      /\.[a-z]+\(/,  // Method calls: .get(, .map(, .filter(
      /^[a-z]+</, // Generic types: Record<, Map<, Set<
      /^[a-z]+\?\./,  // Optional chaining: report?.insights
      /^\d/, // Starts with number
      /^[@#]/, // Decorators or anchors
      /\{[^}]*\}/, // Contains template literals: ${var}
      /^[a-z]+\.[A-Z][a-z]+$/, // module.ClassName: vscode.Uri, crypto.Hash
      /^[a-z]+s\/[a-z]+s$/, // Plural/plural patterns: classes/interfaces, functions/variables
    ];

    return skipPatterns.some(pattern => pattern.test(path)) || 
           path.length < 3 || 
           path.length > 200;
  }
}
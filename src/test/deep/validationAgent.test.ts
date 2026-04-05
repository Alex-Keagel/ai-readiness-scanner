import { describe, it, expect, beforeEach } from 'vitest';
import { ValidationAgent, ValidationResult } from '../../deep/validationAgent';
import { SignalResult, LevelSignal, RealityCheckRef, MaturityLevel } from '../../scoring/types';
import { ModuleProfile } from '../../deep/types';

describe('ValidationAgent', () => {
  let validationAgent: ValidationAgent;
  let mockSignal: LevelSignal;
  let mockModules: ModuleProfile[];

  beforeEach(() => {
    validationAgent = new ValidationAgent();
    
    mockSignal = {
      id: 'test_signal',
      level: 2 as MaturityLevel,
      name: 'Test Signal',
      description: 'Test signal for validation',
      filePatterns: ['**/*.md'],
      contentMarkers: ['instruction', 'guideline'],
      weight: 20,
      category: 'file-presence'
    };

    mockModules = [
      {
        path: 'src/components/auth.ts',
        language: 'typescript',
        lines: 150,
        exports: ['AuthService', 'login', 'logout'],
        exportCount: 3,
        importCount: 5,
        fanIn: 8,
        hasTests: true,
        hasDocstring: true,
        complexity: 'medium',
        role: 'core-logic'
      },
      {
        path: '.github/copilot-instructions.md',
        language: 'markdown',
        lines: 50,
        exports: [],
        exportCount: 0,
        importCount: 0,
        fanIn: 0,
        hasTests: false,
        hasDocstring: false,
        complexity: 'low',
        role: 'config'
      }
    ];
  });

  describe('validateSignalFinding', () => {
    it('should validate a signal with strong evidence', async () => {
      const signalResult: SignalResult = {
        signalId: 'test_signal',
        level: 2,
        detected: true,
        score: 85,
        finding: 'Found comprehensive instructions in .github/copilot-instructions.md with clear guidelines.',
        files: ['.github/copilot-instructions.md', 'src/components/auth.ts'],
        modelUsed: 'gpt-4',
        confidence: 'high',
        realityChecks: []
      };

      const realityChecks: RealityCheckRef[] = [
        {
          category: 'path',
          status: 'valid',
          claim: '.github/copilot-instructions.md',
          reality: 'File exists',
          file: '.github/copilot-instructions.md'
        }
      ];

      const result = await validationAgent.validateSignalFinding(
        mockSignal,
        signalResult, 
        realityChecks,
        mockModules
      );

      expect(result.isValid).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.7);
      expect(result.pathValidationRate).toBe(1.0);
      expect(result.issues).toHaveLength(0);
    });

    it('should detect path hallucinations', async () => {
      const signalResult: SignalResult = {
        signalId: 'test_signal',
        level: 2,
        detected: false,
        score: 20,
        finding: 'No instruction files found. The path .github/copilot-instructions.md does not exist.',
        files: [],
        modelUsed: 'gpt-4',
        confidence: 'low'
      };

      const realityChecks: RealityCheckRef[] = [
        {
          category: 'path',
          status: 'valid',
          claim: '.github/copilot-instructions.md',
          reality: 'File exists',
          file: '.github/copilot-instructions.md'
        }
      ];

      const result = await validationAgent.validateSignalFinding(
        mockSignal,
        signalResult,
        realityChecks,
        mockModules
      );

      expect(result.isValid).toBe(false);
      expect(result.confidence).toBeLessThan(0.6); // Allow for some tolerance
      expect(result.issues.some(i => i.type === 'path-hallucination')).toBe(true);
      expect(result.corrections.length).toBeGreaterThan(0);
    });

    it('should detect score inflation', async () => {
      const signalResult: SignalResult = {
        signalId: 'test_signal',
        level: 2,
        detected: true,
        score: 95,
        finding: 'Found one instruction file with minimal content.',
        files: ['.github/copilot-instructions.md'],
        modelUsed: 'gpt-4',
        confidence: 'high'
      };

      const realityChecks: RealityCheckRef[] = [
        {
          category: 'path',
          status: 'valid',
          claim: '.github/copilot-instructions.md',
          reality: 'File exists',
          file: '.github/copilot-instructions.md'
        }
      ];

      const result = await validationAgent.validateSignalFinding(
        mockSignal,
        signalResult,
        realityChecks,
        mockModules
      );

      expect(result.issues.some(i => i.type === 'score-inflation')).toBe(true);
      expect(result.evidenceScore).toBeLessThan(0.9); // Should be high due to file presence, but issues should reduce overall confidence
    });

    it('should detect contradictions', async () => {
      const signalResult: SignalResult = {
        signalId: 'test_signal',
        level: 2,
        detected: true,
        score: 80,
        finding: 'No instruction files were found in the repository.',
        files: ['.github/copilot-instructions.md', 'src/auth.ts'],
        modelUsed: 'gpt-4',
        confidence: 'high'
      };

      const realityChecks: RealityCheckRef[] = [];

      const result = await validationAgent.validateSignalFinding(
        mockSignal,
        signalResult,
        realityChecks,
        mockModules
      );

      expect(result.issues.some(i => i.type === 'contradiction')).toBe(true);
    });
  });

  describe('computeConfidence', () => {
    it('should compute high confidence for strong evidence', () => {
      const signalResult: SignalResult = {
        signalId: 'test_signal',
        level: 2,
        detected: true,
        score: 85,
        finding: 'Found comprehensive instructions with guidelines',
        files: ['.github/copilot-instructions.md', 'src/auth.ts', 'src/utils.ts'],
        modelUsed: 'gpt-4',
        confidence: 'high',
        realityChecks: [
          { category: 'path', status: 'valid', claim: '.github/copilot-instructions.md', reality: 'exists', file: 'test' }
        ]
      };

      const mockValidation = {
        pathValidation: { pathValidationRate: 1.0 },
        scoreValidation: { evidenceAlignment: 0.9 },
        contradictionValidation: { contradictions: 0 }
      };

      const result = validationAgent.computeConfidence(signalResult, mockValidation);

      expect(result.overall).toBeGreaterThan(0.8);
      expect(result.evidence).toBeGreaterThan(0.7);
      expect(result.contradiction).toBe(1.0);
    });

    it('should compute low confidence for weak evidence', () => {
      const signalResult: SignalResult = {
        signalId: 'test_signal',
        level: 2,
        detected: true,
        score: 95,
        finding: 'Some instructions found',
        files: [], // No files = weak evidence
        modelUsed: 'gpt-4',
        confidence: 'low'
      };

      const mockValidation = {
        pathValidation: { pathValidationRate: 0.0 },
        scoreValidation: { evidenceAlignment: 0.2 },
        contradictionValidation: { contradictions: 2 }
      };

      const result = validationAgent.computeConfidence(signalResult, mockValidation);

      expect(result.overall).toBeLessThan(0.4);
      expect(result.evidence).toBeLessThan(0.5);
      expect(result.contradiction).toBeLessThan(0.6);
    });
  });

  describe('sanitizeFinding', () => {
    it('should correct false path claims', () => {
      const finding = 'The path .github/copilot-instructions.md does not exist and no instruction files were found.';
      const realityChecks: RealityCheckRef[] = [
        {
          category: 'path',
          status: 'valid', 
          claim: '.github/copilot-instructions.md',
          reality: 'File exists',
          file: '.github/copilot-instructions.md'
        }
      ];

      const result = validationAgent.sanitizeFinding(finding, realityChecks);

      expect(result).toContain('[Note: reality checks verified these paths as valid:');
      expect(result).toContain('.github/copilot-instructions.md');
    });

    it('should detect and flag score inflation in finding text', () => {
      const finding = 'Score: 95 - Excellent instruction coverage found.';
      const realityChecks: RealityCheckRef[] = [
        {
          category: 'path',
          status: 'valid',
          claim: 'one-file.md',
          reality: 'exists',
          file: 'one-file.md'
        }
      ];

      const result = validationAgent.sanitizeFinding(finding, realityChecks);

      // Should replace inflated score mentions with adjusted ones
      expect(result).toContain('score (validation-adjusted)');
    });

    it('should add verification notes for negative claims about valid paths', () => {
      const finding = 'The instructions appear to be missing and paths are non-existent.';
      const realityChecks: RealityCheckRef[] = [
        {
          category: 'path',
          status: 'valid',
          claim: '.github/instructions.md',
          reality: 'exists',
          file: '.github/instructions.md'
        }
      ];

      const result = validationAgent.sanitizeFinding(finding, realityChecks);

      expect(result).toContain('[Note: reality checks verified these paths as valid:');
      expect(result).toContain('.github/instructions.md');
    });

    it('should return original finding if no reality checks provided', () => {
      const finding = 'Original finding text';
      const realityChecks: RealityCheckRef[] = [];

      const result = validationAgent.sanitizeFinding(finding, realityChecks);

      expect(result).toBe(finding);
    });
  });
});
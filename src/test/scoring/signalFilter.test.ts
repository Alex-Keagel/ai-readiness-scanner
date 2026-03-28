import { describe, it, expect } from 'vitest';
import { PlatformSignalFilter } from '../../scoring/signalFilter';

describe('PlatformSignalFilter', () => {

  describe('getSignalIds', () => {
    it('returns copilot-specific signals for copilot', () => {
      const ids = PlatformSignalFilter.getSignalIds('copilot');
      expect(ids).toContain('copilot_instructions');
      expect(ids).toContain('copilot_agents');
      expect(ids).toContain('copilot_skills');
    });

    it('does NOT include cline signals for copilot', () => {
      const ids = PlatformSignalFilter.getSignalIds('copilot');
      expect(ids).not.toContain('cline_rules');
      expect(ids).not.toContain('cline_domains');
      expect(ids).not.toContain('safe_commands');
    });

    it('returns cline-specific signals for cline', () => {
      const ids = PlatformSignalFilter.getSignalIds('cline');
      expect(ids).toContain('cline_rules');
      expect(ids).toContain('memory_bank');
      expect(ids).toContain('safe_commands');
    });

    it('does NOT include copilot signals for cline', () => {
      const ids = PlatformSignalFilter.getSignalIds('cline');
      expect(ids).not.toContain('copilot_instructions');
      expect(ids).not.toContain('copilot_agents');
    });

    it('includes shared L1 codebase signals for ALL platforms', () => {
      const platforms = ['copilot', 'cline', 'cursor', 'claude', 'roo', 'windsurf', 'aider'] as const;
      for (const p of platforms) {
        const ids = PlatformSignalFilter.getSignalIds(p);
        expect(ids).toContain('codebase_type_strictness');
        expect(ids).toContain('codebase_semantic_density');
        expect(ids).toContain('codebase_context_efficiency');
      }
    });

    it('includes shared structure signals for ALL platforms', () => {
      const platforms = ['copilot', 'cline', 'cursor', 'claude', 'roo', 'windsurf', 'aider'] as const;
      for (const p of platforms) {
        const ids = PlatformSignalFilter.getSignalIds(p);
        expect(ids).toContain('project_structure_doc');
        expect(ids).toContain('conventions_documented');
        expect(ids).toContain('instruction_accuracy');
      }
    });

    it('returns different signal counts per platform', () => {
      const copilotCount = PlatformSignalFilter.getSignalIds('copilot').length;
      const clineCount = PlatformSignalFilter.getSignalIds('cline').length;
      const aiderCount = PlatformSignalFilter.getSignalIds('aider').length;
      // Cline has more signals than Copilot (memory bank, safe commands, etc.)
      expect(clineCount).toBeGreaterThan(copilotCount);
      // Aider has fewer signals than Copilot (minimal config)
      expect(aiderCount).toBeLessThan(copilotCount);
    });

    it('uses cached map when provided', () => {
      const cachedMap = {
        platform: 'copilot',
        generatedAt: new Date().toISOString(),
        signals: [
          { id: 'custom_signal', relevant: true, weight: 10, dimension: 'quality' as const, description: 'Custom' },
          { id: 'irrelevant_signal', relevant: false, weight: 5, dimension: 'presence' as const, description: 'Skip' },
        ],
      };
      const ids = PlatformSignalFilter.getSignalIds('copilot', cachedMap);
      expect(ids).toContain('custom_signal');
      expect(ids).not.toContain('irrelevant_signal');
    });
  });

  describe('isRelevant', () => {
    it('shared signals are relevant for ALL platforms', () => {
      const shared = ['project_structure_doc', 'conventions_documented', 'ignore_files', 'instruction_accuracy',
        'codebase_type_strictness', 'codebase_semantic_density', 'codebase_context_efficiency'];
      for (const id of shared) {
        expect(PlatformSignalFilter.isRelevant(id, 'copilot')).toBe(true);
        expect(PlatformSignalFilter.isRelevant(id, 'cline')).toBe(true);
        expect(PlatformSignalFilter.isRelevant(id, 'aider')).toBe(true);
      }
    });

    it('memory_bank signals only relevant for cline and roo', () => {
      expect(PlatformSignalFilter.isRelevant('memory_bank', 'cline')).toBe(true);
      expect(PlatformSignalFilter.isRelevant('memory_bank', 'roo')).toBe(true);
      expect(PlatformSignalFilter.isRelevant('memory_bank', 'copilot')).toBe(false);
      expect(PlatformSignalFilter.isRelevant('memory_bank', 'cursor')).toBe(false);
      expect(PlatformSignalFilter.isRelevant('memory_bank', 'claude')).toBe(false);
    });

    it('memory_bank_accuracy only relevant for cline and roo', () => {
      expect(PlatformSignalFilter.isRelevant('memory_bank_accuracy', 'cline')).toBe(true);
      expect(PlatformSignalFilter.isRelevant('memory_bank_accuracy', 'roo')).toBe(true);
      expect(PlatformSignalFilter.isRelevant('memory_bank_accuracy', 'copilot')).toBe(false);
      expect(PlatformSignalFilter.isRelevant('memory_bank_accuracy', 'windsurf')).toBe(false);
    });

    it('copilot_instructions only relevant for copilot', () => {
      expect(PlatformSignalFilter.isRelevant('copilot_instructions', 'copilot')).toBe(true);
      expect(PlatformSignalFilter.isRelevant('copilot_instructions', 'cline')).toBe(false);
      expect(PlatformSignalFilter.isRelevant('copilot_instructions', 'cursor')).toBe(false);
    });

    it('cursor_rules only relevant for cursor', () => {
      expect(PlatformSignalFilter.isRelevant('cursor_rules', 'cursor')).toBe(true);
      expect(PlatformSignalFilter.isRelevant('cursor_rules', 'copilot')).toBe(false);
      expect(PlatformSignalFilter.isRelevant('cursor_rules', 'cline')).toBe(false);
    });

    it('claude_instructions only relevant for claude', () => {
      expect(PlatformSignalFilter.isRelevant('claude_instructions', 'claude')).toBe(true);
      expect(PlatformSignalFilter.isRelevant('claude_instructions', 'copilot')).toBe(false);
    });

    it('unknown signal is not relevant', () => {
      expect(PlatformSignalFilter.isRelevant('totally_fake_signal', 'copilot')).toBe(false);
      expect(PlatformSignalFilter.isRelevant('totally_fake_signal', 'cline')).toBe(false);
    });
  });

  describe('getByDimension', () => {
    it('returns 4 dimension groups', () => {
      const dims = PlatformSignalFilter.getByDimension('copilot');
      expect(Object.keys(dims)).toEqual(['presence', 'quality', 'operability', 'breadth']);
    });

    it('copilot has signals in multiple dimensions', () => {
      const dims = PlatformSignalFilter.getByDimension('copilot');
      expect(dims.presence.length).toBeGreaterThan(0);
      expect(dims.quality.length).toBeGreaterThan(0);
    });

    it('cline has more signals than aider', () => {
      const clineDims = PlatformSignalFilter.getByDimension('cline');
      const aiderDims = PlatformSignalFilter.getByDimension('aider');
      const clineTotal = Object.values(clineDims).flat().length;
      const aiderTotal = Object.values(aiderDims).flat().length;
      expect(clineTotal).toBeGreaterThan(aiderTotal);
    });

    it('only includes signals relevant to the platform', () => {
      const dims = PlatformSignalFilter.getByDimension('copilot');
      const allIds = Object.values(dims).flat().map(s => s.id);
      expect(allIds).not.toContain('cline_rules');
      expect(allIds).not.toContain('memory_bank');
      expect(allIds).not.toContain('safe_commands');
    });

    it('includes L1 codebase signals for all platforms', () => {
      const dims = PlatformSignalFilter.getByDimension('aider');
      const allIds = Object.values(dims).flat().map(s => s.id);
      expect(allIds).toContain('codebase_type_strictness');
      expect(allIds).toContain('codebase_semantic_density');
    });
  });

  describe('getSignalDimension', () => {
    it('maps operability signals correctly', () => {
      expect(PlatformSignalFilter.getSignalDimension('safe_commands', 'content-quality')).toBe('operability');
      expect(PlatformSignalFilter.getSignalDimension('mcp_config', 'file-presence')).toBe('operability');
      expect(PlatformSignalFilter.getSignalDimension('workflow_verification', 'content-quality')).toBe('operability');
    });

    it('maps accuracy signals to quality', () => {
      expect(PlatformSignalFilter.getSignalDimension('instruction_accuracy', 'content-quality')).toBe('quality');
      expect(PlatformSignalFilter.getSignalDimension('memory_bank_accuracy', 'content-quality')).toBe('quality');
    });

    it('maps file-presence to presence', () => {
      expect(PlatformSignalFilter.getSignalDimension('copilot_instructions', 'file-presence')).toBe('presence');
      expect(PlatformSignalFilter.getSignalDimension('cline_rules', 'file-presence')).toBe('presence');
    });

    it('maps depth category to breadth', () => {
      expect(PlatformSignalFilter.getSignalDimension('copilot_domain_instructions', 'depth')).toBe('breadth');
    });

    it('maps memory signals to breadth', () => {
      expect(PlatformSignalFilter.getSignalDimension('memory_bank', 'file-presence')).toBe('breadth');
      expect(PlatformSignalFilter.getSignalDimension('memory_bank_update', 'content-quality')).toBe('breadth');
    });
  });

  describe('getSharedSignalIds', () => {
    it('includes base shared signals for all platforms', () => {
      const shared = PlatformSignalFilter.getSharedSignalIds('copilot');
      expect(shared).toContain('project_structure_doc');
      expect(shared).toContain('conventions_documented');
      expect(shared).toContain('instruction_accuracy');
    });

    it('includes memory_bank_accuracy only for cline/roo', () => {
      expect(PlatformSignalFilter.getSharedSignalIds('cline')).toContain('memory_bank_accuracy');
      expect(PlatformSignalFilter.getSharedSignalIds('roo')).toContain('memory_bank_accuracy');
      expect(PlatformSignalFilter.getSharedSignalIds('copilot')).not.toContain('memory_bank_accuracy');
      expect(PlatformSignalFilter.getSharedSignalIds('cursor')).not.toContain('memory_bank_accuracy');
    });
  });

  describe('cross-platform consistency', () => {
    it('no signal appears in a platform it should not', () => {
      const platformSpecific: Record<string, string[]> = {
        copilot: ['copilot_instructions', 'copilot_agents', 'copilot_skills', 'copilot_domain_instructions', 'copilot_cli_instructions'],
        cline: ['cline_rules', 'cline_domains'],
        cursor: ['cursor_rules'],
        claude: ['claude_instructions'],
        roo: ['roo_modes'],
        windsurf: ['windsurf_rules'],
        aider: ['aider_config'],
      };

      for (const [platform, ownSignals] of Object.entries(platformSpecific)) {
        for (const [otherPlatform, otherSignals] of Object.entries(platformSpecific)) {
          if (platform === otherPlatform) continue;
          const otherIds = PlatformSignalFilter.getSignalIds(otherPlatform as any);
          for (const sig of ownSignals) {
            expect(otherIds).not.toContain(sig);
          }
        }
      }
    });

    it('every platform has at least 5 signals', () => {
      const platforms = ['copilot', 'cline', 'cursor', 'claude', 'roo', 'windsurf', 'aider'] as const;
      for (const p of platforms) {
        expect(PlatformSignalFilter.getSignalIds(p).length).toBeGreaterThanOrEqual(5);
      }
    });
  });
});

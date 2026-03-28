import { describe, it, expect } from 'vitest';
import { getFixTier } from '../../remediation/fixClassifier';

describe('getFixTier', () => {
  // ── AUTO_FIX_SIGNALS ───────────────────────────────────────────
  describe('auto-fix signals', () => {
    const autoFixIds = [
      'copilot_instructions',
      'memory_bank',
      'project_structure_doc',
      'conventions_documented',
      'ignore_files',
      'copilot_domain_instructions',
      'copilot_agents',
      'copilot_skills',
      'cline_rules',
      'cline_domains',
      'cursor_rules',
      'claude_instructions',
      'roo_modes',
      'windsurf_rules',
      'aider_config',
      'safe_commands',
      'tool_definitions',
      'agent_personas',
      'agent_workflows',
      'agents_md',
      'mcp_config',
      'pattern_to_skill_pipeline',
    ];

    for (const id of autoFixIds) {
      it(`returns 'auto' for ${id}`, () => {
        expect(getFixTier(id)).toBe('auto');
      });
    }
  });

  // ── GUIDED_FIX_SIGNALS ─────────────────────────────────────────
  describe('guided-fix signals', () => {
    const guidedIds = [
      'instruction_accuracy',
      'memory_bank_accuracy',
      'gitignore_comprehensive',
      'dependency_update_automation',
      'pre_commit_hooks',
    ];

    for (const id of guidedIds) {
      it(`returns 'guided' for ${id}`, () => {
        expect(getFixTier(id)).toBe('guided');
      });
    }
  });

  // ── Tool-level dynamic signals → auto ──────────────────────────
  describe('tool-level dynamic signals', () => {
    it("returns 'auto' for copilot_l2_instructions", () => {
      expect(getFixTier('copilot_l2_instructions')).toBe('auto');
    });

    it("returns 'auto' for cline_l3_skills_and_tools", () => {
      expect(getFixTier('cline_l3_skills_and_tools')).toBe('auto');
    });

    it("returns 'auto' for roo_l4_workflows", () => {
      expect(getFixTier('roo_l4_workflows')).toBe('auto');
    });

    it("returns 'auto' for claude_l5_memory_feedback", () => {
      expect(getFixTier('claude_l5_memory_feedback')).toBe('auto');
    });
  });

  // ── Unknown / fallback → recommend ─────────────────────────────
  describe('unknown signals', () => {
    it("returns 'recommend' for completely unknown signal", () => {
      expect(getFixTier('totally_unknown_thing')).toBe('recommend');
    });

    it("returns 'recommend' for empty string", () => {
      expect(getFixTier('')).toBe('recommend');
    });
  });
});

import { describe, it, expect } from 'vitest';
import { humanizeSignalId } from '../utils';

describe('humanizeSignalId', () => {
  // ── Shared / legacy signal lookups ──────────────────────────────
  it('returns mapped name for known shared signal', () => {
    expect(humanizeSignalId('copilot_instructions')).toBe('Copilot Instructions');
  });

  it('returns mapped name for another known shared signal', () => {
    expect(humanizeSignalId('project_structure_doc')).toBe('Project Structure Documented');
  });

  it('returns mapped name for memory_bank', () => {
    expect(humanizeSignalId('memory_bank')).toBe('Memory Bank');
  });

  // ── Tool-specific level IDs ─────────────────────────────────────
  it('returns category name for tool-level signal with known category', () => {
    expect(humanizeSignalId('cline_l2_instructions')).toBe('Instructions & Rules');
  });

  it('returns category name for skills_and_tools', () => {
    expect(humanizeSignalId('copilot_l3_skills_and_tools')).toBe('Skills, Tools & MCP');
  });

  it('returns category name for workflows', () => {
    expect(humanizeSignalId('roo_l4_workflows')).toBe('Workflows & Playbooks');
  });

  it('returns category name for memory_feedback', () => {
    expect(humanizeSignalId('claude_l5_memory_feedback')).toBe('Memory & Feedback');
  });

  it('humanizes unknown tool-level category by replacing underscores', () => {
    expect(humanizeSignalId('cursor_l2_custom_stuff')).toBe('custom stuff');
  });

  // ── Fallback: unknown signal ID ─────────────────────────────────
  it('replaces underscores with spaces for unknown IDs', () => {
    expect(humanizeSignalId('some_unknown_signal')).toBe('some unknown signal');
  });

  // ── Edge cases ──────────────────────────────────────────────────
  it('returns "Unknown Signal" for empty string', () => {
    expect(humanizeSignalId('')).toBe('Unknown Signal');
  });

  it('returns "Unknown Signal" for undefined (cast)', () => {
    expect(humanizeSignalId(undefined as unknown as string)).toBe('Unknown Signal');
  });

  it('returns "Unknown Signal" for null (cast)', () => {
    expect(humanizeSignalId(null as unknown as string)).toBe('Unknown Signal');
  });

  it('returns the id itself if it has no underscores and is not mapped', () => {
    expect(humanizeSignalId('readme')).toBe('readme');
  });
});

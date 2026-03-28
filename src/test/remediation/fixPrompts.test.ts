import { describe, it, expect } from 'vitest';
import { getPlatformExpertPrompt, formatProjectContext } from '../../remediation/fixPrompts';

describe('getPlatformExpertPrompt', () => {
  const platforms = ['copilot', 'cline', 'cursor', 'claude', 'roo', 'windsurf', 'aider'] as const;

  for (const platform of platforms) {
    it(`returns non-empty expert prompt for ${platform}`, () => {
      const prompt = getPlatformExpertPrompt(platform);
      expect(prompt).toBeTruthy();
      expect(prompt.length).toBeGreaterThan(100);
    });

    it(`${platform} expert includes platform-specific expertise`, () => {
      const prompt = getPlatformExpertPrompt(platform);
      expect(prompt).toContain('EXPERTISE');
      expect(prompt).toContain('PLATFORM RULES');
      expect(prompt).toContain('WRITING RULES');
    });
  }

  it('copilot expert mentions copilot-instructions.md', () => {
    const prompt = getPlatformExpertPrompt('copilot');
    expect(prompt).toContain('copilot-instructions.md');
    expect(prompt).toContain('applyTo');
  });

  it('cline expert mentions .clinerules and memory banks', () => {
    const prompt = getPlatformExpertPrompt('cline');
    expect(prompt).toContain('.clinerules');
    expect(prompt).toContain('memory');
  });

  it('claude expert mentions CLAUDE.md and 200 lines', () => {
    const prompt = getPlatformExpertPrompt('claude');
    expect(prompt).toContain('CLAUDE.md');
    expect(prompt).toContain('200');
  });

  it('cursor expert mentions .cursor/rules and paths frontmatter', () => {
    const prompt = getPlatformExpertPrompt('cursor');
    expect(prompt).toContain('.cursor/rules');
    expect(prompt).toContain('paths');
  });

  it('roo expert mentions modes and numbered files', () => {
    const prompt = getPlatformExpertPrompt('roo');
    expect(prompt).toContain('mode');
    expect(prompt).toContain('.roo');
  });

  it('windsurf expert mentions trigger modes and AGENTS.md', () => {
    const prompt = getPlatformExpertPrompt('windsurf');
    expect(prompt).toContain('trigger');
    expect(prompt).toContain('AGENTS.md');
  });

  it('aider expert mentions .aider.conf.yml', () => {
    const prompt = getPlatformExpertPrompt('aider');
    expect(prompt).toContain('.aider.conf.yml');
  });

  it('returns fallback for unknown platform', () => {
    const prompt = getPlatformExpertPrompt('unknown' as any);
    expect(prompt).toBe('');
  });

  it('includes anti-patterns warning', () => {
    for (const p of platforms) {
      const prompt = getPlatformExpertPrompt(p);
      expect(prompt.toLowerCase()).toContain('anti-pattern');
    }
  });

  it('includes conciseness rule', () => {
    for (const p of platforms) {
      const prompt = getPlatformExpertPrompt(p);
      expect(prompt).toContain('concise');
    }
  });
});

describe('formatProjectContext', () => {
  it('formats basic context', () => {
    const ctx = {
      languages: ['Python', 'C#'],
      frameworks: ['FastAPI'],
      projectType: 'monorepo' as const,
      packageManager: 'uv',
      directoryTree: 'src/\n  app/\n  lib/',
      components: [],
    };
    const result = formatProjectContext(ctx);
    expect(result).toContain('Python');
    expect(result).toContain('C#');
    expect(result).toContain('FastAPI');
    expect(result).toContain('monorepo');
    expect(result).toContain('uv');
    expect(result).toContain('src/');
  });

  it('includes components when present', () => {
    const ctx = {
      languages: ['TypeScript'],
      frameworks: [],
      projectType: 'app' as const,
      packageManager: 'npm',
      directoryTree: '',
      components: [
        { name: 'API Server', type: 'service' as const, language: 'TypeScript', path: 'src/api', description: 'REST API' },
        { name: 'Frontend', type: 'app' as const, language: 'TypeScript', path: 'src/web' },
      ],
    };
    const result = formatProjectContext(ctx);
    expect(result).toContain('API Server');
    expect(result).toContain('Frontend');
    expect(result).toContain('src/api');
    expect(result).toContain('REST API');
  });

  it('handles empty context gracefully', () => {
    const ctx = {
      languages: [],
      frameworks: [],
      projectType: 'unknown' as const,
      packageManager: '',
      directoryTree: '',
      components: [],
    };
    const result = formatProjectContext(ctx);
    expect(result).toContain('unknown');
    expect(result).toBeTruthy();
  });

  it('truncates long directory trees', () => {
    const longTree = Array(200).fill('dir/subdir/file.ts').join('\n');
    const ctx = {
      languages: ['TypeScript'],
      frameworks: [],
      projectType: 'app' as const,
      packageManager: 'npm',
      directoryTree: longTree,
      components: [],
    };
    const result = formatProjectContext(ctx);
    expect(result.length).toBeLessThan(longTree.length + 500);
  });
});

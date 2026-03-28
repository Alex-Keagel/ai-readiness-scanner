import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  auditMCPHealth,
  auditSkillQuality,
  auditContextEfficiency,
  auditToolSecurity,
  auditHookCoverage,
  auditSkillCoverage,
} from '../../scoring/contextAudit';
import { Uri, workspace } from '../mocks/vscode';
import type { ProjectContext } from '../../scoring/types';

// ── Helpers ──────────────────────────────────────────────────────

const workspaceUri = Uri.file('/mock-workspace');

function makeContext(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    languages: ['TypeScript'],
    frameworks: ['express'],
    projectType: 'app',
    packageManager: 'npm',
    directoryTree: '.',
    components: [],
    ...overrides,
  };
}

/** Encode string as Uint8Array — simulates vscode.workspace.fs.readFile output */
function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// ── Shared setup ────────────────────────────────────────────────

let findFilesSpy: ReturnType<typeof vi.fn>;
let readFileSpy: ReturnType<typeof vi.fn>;
let statSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  findFilesSpy = vi.fn().mockResolvedValue([]);
  readFileSpy = vi.fn().mockResolvedValue(new Uint8Array());
  statSpy = vi.fn().mockRejectedValue(new Error('Not found'));

  workspace.findFiles = findFilesSpy as typeof workspace.findFiles;
  workspace.fs.readFile = readFileSpy as typeof workspace.fs.readFile;
  workspace.fs.stat = statSpy as typeof workspace.fs.stat;
  // asRelativePath is used by auditSkillQuality — mock it
  (workspace as any).asRelativePath = (uri: any, _?: boolean) =>
    typeof uri === 'string' ? uri : uri.fsPath?.replace('/mock-workspace/', '') ?? uri.path;
});

// ═══════════════════════════════════════════════════════════════
// auditMCPHealth
// ═══════════════════════════════════════════════════════════════

describe('auditMCPHealth', () => {
  it('returns score 0 and empty servers when no MCP config files exist', async () => {
    const result = await auditMCPHealth(workspaceUri as any);
    expect(result.score).toBe(0);
    expect(result.servers).toEqual([]);
    expect(result.totalTools).toBe(0);
  });

  it('returns healthy status for a valid server config', async () => {
    const configUri = Uri.file('/mock-workspace/.vscode/mcp.json');
    findFilesSpy.mockImplementation(async (pattern: any) => {
      const pat = typeof pattern === 'string' ? pattern : pattern.pattern;
      if (pat === '.vscode/mcp.json') return [configUri];
      return [];
    });

    const validConfig = JSON.stringify({
      mcpServers: {
        'my-server': {
          command: 'npx',
          args: ['my-mcp-server'],
        },
      },
    });
    readFileSpy.mockResolvedValue(encode(validConfig));

    const result = await auditMCPHealth(workspaceUri as any);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].name).toBe('my-server');
    expect(result.servers[0].status).toBe('healthy');
    expect(result.servers[0].issues).toHaveLength(0);
    expect(result.score).toBe(100);
  });

  it('flags hardcoded secret env vars as misconfigured', async () => {
    const configUri = Uri.file('/mock-workspace/.vscode/mcp.json');
    findFilesSpy.mockImplementation(async (pattern: any) => {
      const pat = typeof pattern === 'string' ? pattern : pattern.pattern;
      if (pat === '.vscode/mcp.json') return [configUri];
      return [];
    });

    const config = JSON.stringify({
      mcpServers: {
        'secret-server': {
          command: 'npx',
          args: ['mcp-server'],
          env: {
            API_TOKEN: 'hardcoded-value-12345',
          },
        },
      },
    });
    readFileSpy.mockResolvedValue(encode(config));

    const result = await auditMCPHealth(workspaceUri as any);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].status).toBe('misconfigured');
    expect(result.servers[0].issues.some(i => i.includes('API_TOKEN'))).toBe(true);
  });

  it('flags overly broad filesystem path in args', async () => {
    const configUri = Uri.file('/mock-workspace/.vscode/mcp.json');
    findFilesSpy.mockImplementation(async (pattern: any) => {
      const pat = typeof pattern === 'string' ? pattern : pattern.pattern;
      if (pat === '.vscode/mcp.json') return [configUri];
      return [];
    });

    const config = JSON.stringify({
      mcpServers: {
        'fs-server': {
          command: 'node',
          args: ['server.js', '--root', ' /'],
        },
      },
    });
    readFileSpy.mockResolvedValue(encode(config));

    const result = await auditMCPHealth(workspaceUri as any);
    expect(result.servers[0].status).toBe('misconfigured');
    expect(result.servers[0].issues.some(i => i.includes('root filesystem'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// auditSkillQuality
// ═══════════════════════════════════════════════════════════════

describe('auditSkillQuality', () => {
  it('returns score 0 and empty skills when no skill files exist', async () => {
    const result = await auditSkillQuality(workspaceUri as any);
    expect(result.score).toBe(0);
    expect(result.skills).toEqual([]);
  });

  it('scores a skill with valid frontmatter and sections highly', async () => {
    const skillUri = Uri.file('/mock-workspace/.github/skills/testing/SKILL.md');
    findFilesSpy.mockImplementation(async (pattern: any) => {
      const pat = typeof pattern === 'string' ? pattern : pattern.pattern;
      if (pat === '.github/skills/**/SKILL.md') return [skillUri];
      return [];
    });

    const skillContent = `---
name: testing-skill
description: A comprehensive testing skill for unit and integration tests
---

## Prerequisites
- Node.js 18+
- Vitest installed

## Steps
1. Create test files in the test directory
2. Run tests with npm test
3. Check coverage reports

## Guidelines
- Use descriptive test names
- Mock external dependencies
- Test edge cases thoroughly
- Aim for 80% coverage minimum
- Test both happy path and error paths
`;
    readFileSpy.mockResolvedValue(encode(skillContent));

    const result = await auditSkillQuality(workspaceUri as any);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe('testing-skill');
    // Has frontmatter name+description (25) + description length OK (15) + ## sections (20) + body > 10 lines (15) + no refs to check (25) = 100
    expect(result.skills[0].score).toBeGreaterThanOrEqual(60);
    expect(result.skills[0].issues).toHaveLength(0);
  });

  it('scores a skill missing frontmatter poorly with issues', async () => {
    const skillUri = Uri.file('/mock-workspace/.github/skills/bad/SKILL.md');
    findFilesSpy.mockImplementation(async (pattern: any) => {
      const pat = typeof pattern === 'string' ? pattern : pattern.pattern;
      if (pat === '.github/skills/**/SKILL.md') return [skillUri];
      return [];
    });

    const skillContent = `# My Skill

This skill does stuff.
`;
    readFileSpy.mockResolvedValue(encode(skillContent));

    const result = await auditSkillQuality(workspaceUri as any);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].score).toBeLessThanOrEqual(50);
    expect(result.skills[0].issues.some(i => i.includes('name'))).toBe(true);
  });

  it('flags a skill with an empty body', async () => {
    const skillUri = Uri.file('/mock-workspace/.github/skills/empty/SKILL.md');
    findFilesSpy.mockImplementation(async (pattern: any) => {
      const pat = typeof pattern === 'string' ? pattern : pattern.pattern;
      if (pat === '.github/skills/**/SKILL.md') return [skillUri];
      return [];
    });

    const skillContent = `---
name: empty-skill
description: An empty skill with no content
---
`;
    readFileSpy.mockResolvedValue(encode(skillContent));

    const result = await auditSkillQuality(workspaceUri as any);
    expect(result.skills).toHaveLength(1);
    const issues = result.skills[0].issues;
    expect(issues.some(i => i.includes('No ## sections'))).toBe(true);
    expect(issues.some(i => i.includes('non-empty lines'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// auditContextEfficiency
// ═══════════════════════════════════════════════════════════════

describe('auditContextEfficiency', () => {
  it('returns low-moderate score when no instruction files exist (no agent guidance)', async () => {
    const result = await auditContextEfficiency(workspaceUri as any, makeContext(), 0);
    // Score blends coverage (50 default) + budget (15 for zero tokens) → ~36
    expect(result.score).toBeGreaterThan(20);
    expect(result.score).toBeLessThan(50);
    expect(result.totalTokens).toBe(0);
    expect(result.budgetPct).toBe(0);
  });

  it('returns lower score with large instruction files', async () => {
    const instrUri = Uri.file('/mock-workspace/.github/copilot-instructions.md');
    findFilesSpy.mockImplementation(async (pattern: any) => {
      const pat = typeof pattern === 'string' ? pattern : pattern.pattern;
      if (pat.includes('copilot-instructions')) return [instrUri];
      return [];
    });

    // Simulate a very large instruction file (50k chars ≈ 12,500 tokens)
    const largeContent = 'x'.repeat(50000);
    readFileSpy.mockResolvedValue(encode(largeContent));

    const result = await auditContextEfficiency(workspaceUri as any, makeContext(), 0);
    expect(result.score).toBeLessThan(100);
    expect(result.totalTokens).toBeGreaterThan(0);
    expect(result.budgetPct).toBeGreaterThan(0);
  });

  it('includes instructions, mcp, and memory in breakdown categories', async () => {
    const result = await auditContextEfficiency(workspaceUri as any, makeContext(), 1000);
    expect(result.breakdown).toHaveLength(3);
    const categories = result.breakdown.map(b => b.category);
    expect(categories).toContain('Instructions');
    expect(categories).toContain('MCP Tools');
    expect(categories).toContain('Memory Bank');
  });
});

// ═══════════════════════════════════════════════════════════════
// auditToolSecurity
// ═══════════════════════════════════════════════════════════════

describe('auditToolSecurity', () => {
  it('returns score 100 when no agent files exist', async () => {
    const result = await auditToolSecurity(workspaceUri as any);
    expect(result.score).toBe(100);
    expect(result.issues).toEqual([]);
  });

  it('reports healthy for agent with explicit tools array', async () => {
    const agentUri = Uri.file('/mock-workspace/.github/agents/coder.agent.md');
    findFilesSpy.mockImplementation(async (pattern: any) => {
      const pat = typeof pattern === 'string' ? pattern : pattern.pattern;
      if (pat.includes('agent.md')) return [agentUri];
      return [];
    });

    const agentContent = `---
name: coder
description: A coding agent that writes and edits code
tools: [edit, read, search]
---

You are a helpful coding assistant.
`;
    readFileSpy.mockResolvedValue(encode(agentContent));

    const result = await auditToolSecurity(workspaceUri as any);
    expect(result.issues).toHaveLength(0);
    expect(result.score).toBe(100);
  });

  it('flags warning when agent is missing tools key', async () => {
    const agentUri = Uri.file('/mock-workspace/.github/agents/helper.agent.md');
    findFilesSpy.mockImplementation(async (pattern: any) => {
      const pat = typeof pattern === 'string' ? pattern : pattern.pattern;
      if (pat.includes('agent.md')) return [agentUri];
      return [];
    });

    const agentContent = `---
name: helper
description: A general helper agent
---

You are helpful.
`;
    readFileSpy.mockResolvedValue(encode(agentContent));

    const result = await auditToolSecurity(workspaceUri as any);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe('warning');
    expect(result.issues[0].issue).toContain('No "tools" key');
  });

  it('flags critical when reviewer agent has shell + edit access', async () => {
    const agentUri = Uri.file('/mock-workspace/.github/agents/reviewer.agent.md');
    findFilesSpy.mockImplementation(async (pattern: any) => {
      const pat = typeof pattern === 'string' ? pattern : pattern.pattern;
      if (pat.includes('agent.md')) return [agentUri];
      return [];
    });

    const agentContent = `---
name: code-reviewer
description: A code reviewer that checks code quality
tools: [shell, edit, read]
---

You are a code reviewer.
`;
    readFileSpy.mockResolvedValue(encode(agentContent));

    const result = await auditToolSecurity(workspaceUri as any);
    const criticals = result.issues.filter(i => i.severity === 'critical');
    expect(criticals.length).toBeGreaterThanOrEqual(1);
    expect(criticals[0].issue).toContain('least-privilege');
    expect(result.score).toBeLessThan(100);
  });
});

// ═══════════════════════════════════════════════════════════════
// auditHookCoverage
// ═══════════════════════════════════════════════════════════════

describe('auditHookCoverage', () => {
  it('returns score 0 and all false when no hooks exist', async () => {
    // readFile rejects (no package.json content)
    readFileSpy.mockRejectedValue(new Error('Not found'));

    const result = await auditHookCoverage(workspaceUri as any);
    expect(result.score).toBe(0);
    expect(result.hasPostTask).toBe(false);
    expect(result.hasMemoryUpdate).toBe(false);
    expect(result.hasSafeCommands).toBe(false);
    expect(result.hasPreCommit).toBe(false);
  });

  it('detects safe-commands and scores +25', async () => {
    const safeUri = Uri.file('/mock-workspace/.clinerules/safe-commands.md');
    findFilesSpy.mockImplementation(async (pattern: any) => {
      const pat = typeof pattern === 'string' ? pattern : pattern.pattern;
      if (pat.includes('safe-commands')) return [safeUri];
      return [];
    });
    readFileSpy.mockRejectedValue(new Error('Not found'));

    const result = await auditHookCoverage(workspaceUri as any);
    expect(result.hasSafeCommands).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(25);
  });

  it('detects memory-bank and scores +25', async () => {
    const memUri = Uri.file('/mock-workspace/memory-bank/context.md');
    findFilesSpy.mockImplementation(async (pattern: any) => {
      const pat = typeof pattern === 'string' ? pattern : pattern.pattern;
      if (pat.includes('memory-bank')) return [memUri];
      return [];
    });
    readFileSpy.mockRejectedValue(new Error('Not found'));

    const result = await auditHookCoverage(workspaceUri as any);
    expect(result.hasMemoryUpdate).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(25);
  });

  it('detects .husky directory and scores +25', async () => {
    const huskyUri = Uri.file('/mock-workspace/.husky/pre-commit');
    findFilesSpy.mockImplementation(async (pattern: any) => {
      const pat = typeof pattern === 'string' ? pattern : pattern.pattern;
      if (pat.includes('.husky')) return [huskyUri];
      return [];
    });
    readFileSpy.mockRejectedValue(new Error('Not found'));

    const result = await auditHookCoverage(workspaceUri as any);
    expect(result.hasPreCommit).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(25);
  });
});

// ═══════════════════════════════════════════════════════════════
// auditSkillCoverage
// ═══════════════════════════════════════════════════════════════

describe('auditSkillCoverage', () => {
  it('detects gaps for a Python project with no skills', async () => {
    const ctx = makeContext({ languages: ['Python'] });

    const result = await auditSkillCoverage(workspaceUri as any, ctx);
    expect(result.gaps.length).toBeGreaterThan(0);
    expect(result.gaps.some(g => g.area === 'pytest')).toBe(true);
    expect(result.score).toBeLessThan(100);
  });

  it('marks covered areas when matching skills exist', async () => {
    const ctx = makeContext({ languages: ['Python'] });
    const skillUri = Uri.file('/mock-workspace/.github/skills/pytest/SKILL.md');

    findFilesSpy.mockImplementation(async (pattern: any) => {
      const pat = typeof pattern === 'string' ? pattern : pattern.pattern;
      if (pat.includes('.github/skills')) return [skillUri];
      return [];
    });

    const skillContent = `---
name: pytest
description: Pytest testing skill
---
## Steps
Run pytest.
`;
    readFileSpy.mockResolvedValue(encode(skillContent));

    const result = await auditSkillCoverage(workspaceUri as any, ctx);
    expect(result.coveredAreas).toContain('pytest');
    expect(result.score).toBeGreaterThan(0);
  });

  it('returns score 100 with no gaps for unsupported languages', async () => {
    const ctx = makeContext({ languages: ['Haskell'] });

    const result = await auditSkillCoverage(workspaceUri as any, ctx);
    expect(result.score).toBe(100);
    expect(result.gaps).toHaveLength(0);
    expect(result.coveredAreas).toHaveLength(0);
  });
});

import { describe, it, expect } from 'vitest';

/**
 * Tests for multi-file LLM response parsing.
 * Validates the 3 parsing strategies used by generateViaLLM.
 */

// Extract the parsing logic so we can test it without vscode dependencies
function parseMultiFileResponse(content: string, recommendation: string, signalId: string): { filePath: string; content: string }[] {
  const results: { filePath: string; content: string }[] = [];

  // Strategy 1: === FILE: path === ... === END FILE ===
  const fileBlocks = content.matchAll(/===\s*FILE:\s*(.+?)\s*===\n([\s\S]*?)===\s*END FILE\s*===/gi);
  for (const match of fileBlocks) {
    results.push({ filePath: match[1].trim(), content: match[2].trim() });
  }
  if (results.length > 0) return results;

  // Strategy 2: ## `path/file.md` headers — split by header
  const sections = content.split(/^(?=##\s+`)/m).filter(s => s.trim());
  for (const sec of sections) {
    const pathMatch = sec.match(/^##\s+`([^`]+)`/);
    if (!pathMatch) continue;
    const body = sec.replace(/^##\s+`[^`]+`\s*\n/, '').trim();
    const fenced = body.match(/```(?:markdown|yaml|json|md)?\n([\s\S]*?)```/);
    results.push({ filePath: pathMatch[1].trim(), content: fenced ? fenced[1].trim() : body });
  }
  if (results.length > 0) return results;

  // Strategy 3: single file fallback
  const pathMatch = recommendation.match(/`([^`]+\.[a-z]+)`/i) || recommendation.match(/Create\s+(\S+\.\w+)/i) || recommendation.match(/(\S+\/\S+\.\w+)/);
  const filePath = pathMatch?.[1] || `generated-${signalId.replace(/[^a-z0-9]/gi, '-').slice(0, 30)}.md`;
  return [{ filePath, content }];
}

describe('Multi-file response parsing', () => {

  describe('Strategy 1: === FILE === blocks', () => {
    it('parses single file block', () => {
      const response = `=== FILE: .clinerules/default-rules.md ===
# Default Rules
- Rule 1
- Rule 2
=== END FILE ===`;

      const files = parseMultiFileResponse(response, '', 'test');
      expect(files).toHaveLength(1);
      expect(files[0].filePath).toBe('.clinerules/default-rules.md');
      expect(files[0].content).toContain('# Default Rules');
    });

    it('parses multiple file blocks', () => {
      const response = `=== FILE: .clinerules/default-rules.md ===
# Default Rules
=== END FILE ===

=== FILE: .clinerules/safe-commands.md ===
# Safe Commands
- git status
=== END FILE ===

=== FILE: .clinerules/domains/python.md ===
---
paths:
  - src/python/**
---
# Python Rules
=== END FILE ===`;

      const files = parseMultiFileResponse(response, '', 'test');
      expect(files).toHaveLength(3);
      expect(files[0].filePath).toBe('.clinerules/default-rules.md');
      expect(files[1].filePath).toBe('.clinerules/safe-commands.md');
      expect(files[2].filePath).toBe('.clinerules/domains/python.md');
      expect(files[2].content).toContain('paths:');
    });

    it('handles nested paths', () => {
      const response = `=== FILE: .clinerules/workflows/update-memory-bank.md ===
# Update Memory Bank
=== END FILE ===

=== FILE: memory-bank/projectbrief.md ===
# Project Brief
=== END FILE ===`;

      const files = parseMultiFileResponse(response, '', 'test');
      expect(files).toHaveLength(2);
      expect(files[0].filePath).toBe('.clinerules/workflows/update-memory-bank.md');
      expect(files[1].filePath).toBe('memory-bank/projectbrief.md');
    });

    it('preserves multiline content with code blocks inside', () => {
      const response = `=== FILE: .clinerules/safe-commands.md ===
# Safe Commands

## Python
- \`uv run pytest\`
- \`uv run ruff check\`

## C#
- \`dotnet build\`
- \`dotnet test\`
=== END FILE ===`;

      const files = parseMultiFileResponse(response, '', 'test');
      expect(files).toHaveLength(1);
      expect(files[0].content).toContain('## Python');
      expect(files[0].content).toContain('## C#');
      expect(files[0].content).toContain('uv run pytest');
    });

    it('trims whitespace from paths and content', () => {
      const response = `===  FILE:  .clinerules/rules.md  ===

  # Rules  

=== END FILE ===`;

      const files = parseMultiFileResponse(response, '', 'test');
      expect(files).toHaveLength(1);
      expect(files[0].filePath).toBe('.clinerules/rules.md');
      expect(files[0].content).toBe('# Rules');
    });
  });

  describe('Strategy 2: ## `path` headers', () => {
    it('parses header-based multi-file response', () => {
      const response = `## \`.clinerules/default-rules.md\`

\`\`\`markdown
# Default Rules
- Rule 1
\`\`\`

## \`.clinerules/safe-commands.md\`

\`\`\`markdown
# Safe Commands
- git status
\`\`\`
`;

      const files = parseMultiFileResponse(response, '', 'test');
      expect(files).toHaveLength(2);
      expect(files[0].filePath).toBe('.clinerules/default-rules.md');
      expect(files[0].content).toContain('# Default Rules');
      expect(files[1].filePath).toBe('.clinerules/safe-commands.md');
      expect(files[1].content).toContain('# Safe Commands');
    });

    it('extracts content from code fences', () => {
      const response = `## \`memory-bank/techContext.md\`

\`\`\`markdown
# Tech Context
- Python 3.13
- .NET 8
\`\`\`
`;

      const files = parseMultiFileResponse(response, '', 'test');
      expect(files).toHaveLength(1);
      expect(files[0].content).toContain('# Tech Context');
      expect(files[0].content).not.toContain('```');
    });

    it('handles content without code fences', () => {
      const response = `## \`.clinerules/rules.md\`

# Rules
Just plain text content here.
No code fences.
`;

      const files = parseMultiFileResponse(response, '', 'test');
      expect(files).toHaveLength(1);
      expect(files[0].content).toContain('# Rules');
    });
  });

  describe('Strategy 3: single file fallback', () => {
    it('extracts path from backtick in recommendation', () => {
      const response = '# Default Rules\n- Rule 1';
      const files = parseMultiFileResponse(response, 'Create `.clinerules/default-rules.md` with rules', 'test');
      expect(files).toHaveLength(1);
      expect(files[0].filePath).toBe('.clinerules/default-rules.md');
      expect(files[0].content).toBe(response);
    });

    it('extracts path from Create X pattern', () => {
      const response = '# README';
      const files = parseMultiFileResponse(response, 'Create src/api/README.md describing the API', 'test');
      expect(files).toHaveLength(1);
      expect(files[0].filePath).toBe('src/api/README.md');
    });

    it('extracts path from slash pattern', () => {
      const response = 'content';
      const files = parseMultiFileResponse(response, 'Update the file at memory-bank/techContext.md', 'test');
      expect(files).toHaveLength(1);
      expect(files[0].filePath).toBe('memory-bank/techContext.md');
    });

    it('generates fallback filename from signalId', () => {
      const response = 'some content';
      const files = parseMultiFileResponse(response, 'Do something vague', 'insight_improvement_fix_stuff');
      expect(files).toHaveLength(1);
      expect(files[0].filePath).toContain('insight-improvement-fix-stuff');
      expect(files[0].filePath.endsWith('.md')).toBe(true);
    });
  });

  describe('Strategy priority', () => {
    it('prefers === FILE === blocks over ## headers', () => {
      const response = `=== FILE: correct/path.md ===
Correct content
=== END FILE ===

## \`wrong/path.md\`
Wrong content`;

      const files = parseMultiFileResponse(response, '', 'test');
      expect(files).toHaveLength(1);
      expect(files[0].filePath).toBe('correct/path.md');
    });

    it('falls back to ## headers when no === FILE === blocks', () => {
      const response = `## \`header/path.md\`

Header content
`;

      const files = parseMultiFileResponse(response, 'Create `fallback.md`', 'test');
      expect(files).toHaveLength(1);
      expect(files[0].filePath).toBe('header/path.md');
    });

    it('falls back to single file when no structured blocks', () => {
      const response = 'Just plain text with no file markers';
      const files = parseMultiFileResponse(response, 'Create `single.md`', 'test');
      expect(files).toHaveLength(1);
      expect(files[0].filePath).toBe('single.md');
      expect(files[0].content).toBe(response);
    });
  });

  describe('Edge cases', () => {
    it('handles empty response', () => {
      const files = parseMultiFileResponse('', 'Create `test.md`', 'test');
      expect(files).toHaveLength(1);
      expect(files[0].content).toBe('');
    });

    it('handles response with only explanation text', () => {
      const response = "I'll create the files for you. Here's the content:";
      const files = parseMultiFileResponse(response, 'Create `rules.md`', 'test');
      expect(files).toHaveLength(1);
      expect(files[0].filePath).toBe('rules.md');
    });

    it('handles many files (10+)', () => {
      const blocks = Array.from({ length: 12 }, (_, i) =>
        `=== FILE: dir/file${i}.md ===\n# File ${i}\n=== END FILE ===`
      ).join('\n\n');

      const files = parseMultiFileResponse(blocks, '', 'test');
      expect(files).toHaveLength(12);
      expect(files[11].filePath).toBe('dir/file11.md');
    });

    it('handles YAML frontmatter in file content', () => {
      const response = `=== FILE: .clinerules/domains/python.md ===
---
paths:
  - src/python/**
---

# Python Domain Rules
Use uv for package management.
=== END FILE ===`;

      const files = parseMultiFileResponse(response, '', 'test');
      expect(files).toHaveLength(1);
      expect(files[0].content).toContain('---');
      expect(files[0].content).toContain('paths:');
      expect(files[0].content).toContain('# Python Domain Rules');
    });

    it('handles file paths with dots', () => {
      const response = `=== FILE: .github/copilot-instructions.md ===
# Instructions
=== END FILE ===

=== FILE: .config/settings.json ===
{}
=== END FILE ===`;

      const files = parseMultiFileResponse(response, '', 'test');
      expect(files).toHaveLength(2);
      expect(files[0].filePath).toBe('.github/copilot-instructions.md');
      expect(files[1].filePath).toBe('.config/settings.json');
    });
  });
});

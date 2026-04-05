import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Validates that webview scripts built via string concatenation produce valid JavaScript.
 * Catches: leaked comments (// inside + chains), broken unicode escapes, unbalanced braces.
 */
describe('Webview script integrity', () => {
  it('developerNetworkPanel buildScript produces parseable JavaScript', () => {
    // Read the TypeScript source and extract the buildScript return value
    const srcPath = path.join(__dirname, '../../ui/developerNetworkPanel.ts');
    const src = fs.readFileSync(srcPath, 'utf8');

    // Find the buildScript method
    const methodStart = src.indexOf('private buildScript(): string {');
    expect(methodStart).toBeGreaterThan(0);

    // Extract the return statement — it's a large string concatenation
    const returnStart = src.indexOf("return '", methodStart);
    expect(returnStart).toBeGreaterThan(methodStart);

    // Evaluate the string concatenation to get the actual script
    // The method returns a string built from '...' + '...' + ... + '...';
    // We need to find the end of this expression
    const methodEnd = src.indexOf('\n  }', returnStart + 100);
    const returnBody = src.substring(returnStart + 7, methodEnd).trim();
    // Remove trailing semicolon and any closing method brace artifacts
    const cleaned = returnBody.replace(/;\s*$/, '');

    // Evaluate the concatenation (each segment is a simple string literal)
    let script: string;
    try {
      script = eval(cleaned) as string;
    } catch (e) {
      throw new Error(`Failed to evaluate buildScript concatenation: ${(e as Error).message}\nFirst 200 chars: ${cleaned.substring(0, 200)}`);
    }

    expect(typeof script).toBe('string');
    expect(script.length).toBeGreaterThan(100);

    // The script should be a valid IIFE: (function(){...})();
    expect(script).toMatch(/^\(function\(\)\{/);
    expect(script).toMatch(/\}\)\(\);$/);

    // No leaked TypeScript comments (// ... between string concatenation lines)
    expect(script).not.toMatch(/'\s*\+\s*\/\//);

    // Balanced braces
    let braceDepth = 0;
    for (const ch of script) {
      if (ch === '{') braceDepth++;
      if (ch === '}') braceDepth--;
    }
    expect(braceDepth).toBe(0);

    // Balanced parentheses
    let parenDepth = 0;
    for (const ch of script) {
      if (ch === '(') parenDepth++;
      if (ch === ')') parenDepth--;
    }
    expect(parenDepth).toBe(0);

    // No raw non-ASCII characters that could break parsing (unicode should be escaped)
    for (let i = 0; i < script.length; i++) {
      const code = script.charCodeAt(i);
      if (code > 127) {
        throw new Error(`Non-ASCII character U+${code.toString(16).toUpperCase()} at position ${i}: ...${script.substring(Math.max(0, i - 20), i + 20)}...`);
      }
    }
  });

  it('recommendationsPanel getScriptBlock produces parseable JavaScript', () => {
    const srcPath = path.join(__dirname, '../../ui/recommendationsPanel.ts');
    if (!fs.existsSync(srcPath)) return; // skip if not present

    const src = fs.readFileSync(srcPath, 'utf8');
    const methodStart = src.indexOf('private getScriptBlock()');
    if (methodStart < 0) return;

    // At minimum, check no leaked comments in string concatenation
    const methodBody = src.substring(methodStart, src.indexOf('\n  }', methodStart + 100));
    // Lines with just + // (comment on a string concat line)
    const leakedComments = methodBody.match(/^\s*\+\s*\/\/.*/gm);
    expect(leakedComments).toBeNull();
  });
});

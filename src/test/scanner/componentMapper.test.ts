import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ComponentMapper, isVirtualEnvPath } from '../../scanner/componentMapper';

/**
 * Helper: build a `relPattern` function that just concatenates base + glob,
 * and a mock `findFiles` that resolves against a virtual file list.
 */
function setupMocks(virtualFiles: string[]) {
  const uris = virtualFiles.map(f => vscode.Uri.file(f));

  // relPattern just returns a RelativePattern whose `pattern` is the glob
  const relPattern = (glob: string) => new vscode.RelativePattern('/repo', glob);

  // Mock findFiles: match virtual files against the glob (simple substring matching
  // sufficient for our tests because we control both the globs and the file list).
  vi.spyOn(vscode.workspace, 'findFiles').mockImplementation(
    async (include: any, _exclude?: any, maxResults?: number) => {
      const pattern: string =
        typeof include === 'string' ? include : (include as vscode.RelativePattern).pattern;

      const matched = uris.filter(uri => {
        const p = uri.fsPath;
        // Match extension-based globs like /repo/**/*.py
        if (pattern.includes('**/*.')) {
          // Extract extensions from glob (handles {ts,tsx} brace patterns)
          const extPart = pattern.split('**/*.').pop()!;
          const exts = extPart.replace(/[{}]/g, '').split(',');
          return exts.some(ext => p.endsWith(`.${ext}`));
        }
        // Match specific marker files like /repo/**/*.csproj or /repo/**/tsconfig.json
        const markerPart = pattern.split('/').pop()!;
        if (markerPart.startsWith('*.')) {
          const ext = markerPart.slice(1); // e.g. ".csproj"
          return p.endsWith(ext);
        }
        // Exact filename match (e.g. tsconfig.json, go.mod)
        return p.endsWith(`/${markerPart}`);
      });

      return maxResults ? matched.slice(0, maxResults) : matched;
    },
  );

  return relPattern;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isVirtualEnvPath', () => {
  it.each([
    '.venv/lib/python3.11/site-packages/pip/__init__.py',
    'venv/bin/activate',
    'src/__pycache__/module.cpython-311.pyc',
    '.tox/py311/bin/python',
    'env/lib/python3.12/site-packages/pip/__init__.py',
  ])('matches %s', (path) => {
    expect(isVirtualEnvPath(path)).toBe(true);
  });

  it.each([
    'src/env/config.ts',
    'src/environment/python-guide.md',
    'services/api/Program.cs',
  ])('does not match %s', (path) => {
    expect(isVirtualEnvPath(path)).toBe(false);
  });
});

describe('detectDirLanguage', () => {
  // Access the private method via bracket notation
  function callDetect(mapper: ComponentMapper, relPattern: ReturnType<typeof setupMocks>, dirPath = '.') {
    return (mapper as any).detectDirLanguage(relPattern, dirPath);
  }

  it('detects C# when .csproj exists even with .venv/*.py files', async () => {
    const relPattern = setupMocks([
      '/repo/src/MyApp/MyApp.csproj',
      '/repo/src/MyApp/Program.cs',
      '/repo/.venv/lib/python3.11/site.py',
      '/repo/.venv/lib/python3.11/os.py',
      '/repo/.venv/lib/python3.11/json.py',
      '/repo/.venv/bin/activate.py',
    ]);

    const mapper = new ComponentMapper();
    const lang = await callDetect(mapper, relPattern);
    expect(lang).toBe('C#');
  });

  it('uses recursive C# marker globs for nested projects', async () => {
    const mapper = new ComponentMapper();
    const relPattern = (glob: string) => new vscode.RelativePattern('/repo', glob);

    const findFilesSpy = vi.spyOn(vscode.workspace, 'findFiles').mockImplementation(
      async (include: any) => {
        const pattern = typeof include === 'string' ? include : include.pattern;
        if (pattern === 'services/**/*.csproj') {
          return [vscode.Uri.file('/repo/services/api/MyApp.csproj')];
        }
        return [];
      },
    );

    const lang = await callDetect(mapper, relPattern, 'services');
    expect(lang).toBe('C#');
    expect(findFilesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: 'services/**/*.csproj' }),
      expect.any(String),
      1,
    );
  });

  it('detects Python when only .py files exist (no .venv)', async () => {
    const relPattern = setupMocks([
      '/repo/app.py',
      '/repo/utils.py',
      '/repo/tests/test_app.py',
    ]);

    const mapper = new ComponentMapper();
    const lang = await callDetect(mapper, relPattern);
    expect(lang).toBe('Python');
  });

  it('detects C# when more .cs files than .py files (no markers)', async () => {
    const relPattern = setupMocks([
      '/repo/src/Program.cs',
      '/repo/src/Startup.cs',
      '/repo/src/Models/User.cs',
      '/repo/scripts/helper.py',
    ]);

    const mapper = new ComponentMapper();
    const lang = await callDetect(mapper, relPattern);
    expect(lang).toBe('C#');
  });

  it('excludes venv python files from extension counting', async () => {
    // No markers at all — falls through to extension counting.
    // 10 .py files inside venv vs 2 .cs files outside.
    const relPattern = setupMocks([
      '/repo/src/App.cs',
      '/repo/src/Util.cs',
      '/repo/venv/lib/a.py',
      '/repo/venv/lib/b.py',
      '/repo/venv/lib/c.py',
      '/repo/venv/lib/d.py',
      '/repo/venv/lib/e.py',
      '/repo/venv/lib/f.py',
      '/repo/venv/lib/g.py',
      '/repo/venv/lib/h.py',
      '/repo/venv/lib/i.py',
      '/repo/venv/lib/j.py',
    ]);

    const mapper = new ComponentMapper();
    const lang = await callDetect(mapper, relPattern);
    expect(lang).toBe('C#');
  });

  it('excludes site-packages python files from extension counting', async () => {
    const relPattern = setupMocks([
      '/repo/main.go',
      '/repo/site-packages/pip/index.py',
      '/repo/site-packages/pip/utils.py',
      '/repo/site-packages/setuptools/setup.py',
    ]);

    const mapper = new ComponentMapper();
    const lang = await callDetect(mapper, relPattern);
    expect(lang).toBe('Go');
  });
});

describe('detectComponents', () => {
  it('does not create components from virtual environment manifests', async () => {
    const mapper = new ComponentMapper();
    const workspaceUri = vscode.Uri.file('/repo');
    const relPattern = (glob: string) => new vscode.RelativePattern(workspaceUri, glob);

    vi.spyOn(vscode.workspace, 'findFiles').mockImplementation(async (include: any) => {
      const pattern = typeof include === 'string' ? include : include.pattern;

      if (pattern.includes('setup.py')) {
        return [vscode.Uri.file('/repo/.venv/lib/python3.11/site-packages/pip/setup.py')];
      }

      if (pattern === 'src/**/*.cs') {
        return [vscode.Uri.file('/repo/src/Service/Program.cs')];
      }

      return [];
    });

    const components = await (mapper as any).detectComponents(
      relPattern,
      workspaceUri,
      [
        vscode.Uri.file('/repo/src/Service/Program.cs'),
        vscode.Uri.file('/repo/.venv/lib/python3.11/site-packages/pip/__init__.py'),
      ],
      ['C#'],
    );

    expect(components.some((component: { path: string }) => isVirtualEnvPath(component.path))).toBe(false);
  });
});

describe('aggregate language stats exclude .venv files', () => {
  it('detectLanguages does not detect a language solely from .venv files', async () => {
    // Only .py files exist, but all inside .venv — should NOT detect Python
    const relPattern = setupMocks([
      '/repo/.venv/lib/python3.11/site-packages/pip/__init__.py',
      '/repo/.venv/lib/python3.11/site-packages/setuptools/setup.py',
      '/repo/src/App.cs',
    ]);

    const mapper = new ComponentMapper();
    const languages: string[] = await (mapper as any).detectLanguages(relPattern);
    expect(languages).not.toContain('Python');
  });

  it('detectLanguages detects Python from non-.venv files even when .venv files exist', async () => {
    const relPattern = setupMocks([
      '/repo/.venv/lib/python3.11/site-packages/pip/__init__.py',
      '/repo/src/app.py',
      '/repo/pyproject.toml',
    ]);

    const mapper = new ComponentMapper();
    const languages: string[] = await (mapper as any).detectLanguages(relPattern);
    expect(languages).toContain('Python');
  });

  it('isVirtualEnvPath filters all venv-like paths from file lists', () => {
    const files = [
      '/repo/src/main.py',
      '/repo/.venv/lib/python3.11/site-packages/click/__init__.py',
      '/repo/venv/lib/python3.11/os.py',
      '/repo/site-packages/setuptools/setup.py',
      '/repo/.tox/py311/lib/site.py',
      '/repo/__pycache__/module.cpython-311.pyc',
      '/repo/env/lib/python3.12/site-packages/pip/__init__.py',
      '/repo/src/utils.ts',
    ];

    const filtered = files.filter(f => !isVirtualEnvPath(f));
    expect(filtered).toEqual(['/repo/src/main.py', '/repo/src/utils.ts']);
  });
});

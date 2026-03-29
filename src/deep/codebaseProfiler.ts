import * as vscode from 'vscode';
import { CopilotClient } from '../llm/copilotClient';
import { logger } from '../logging';
import { CodebaseProfile, ModuleProfile, CodebasePipeline } from './types';
import { ExclusionClassifierAgent, TestClassificationAgent } from './relevanceAgents';

const EXCLUDE = '**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**,**/vendor/**,**/.venv/**,**/venv/**,**/.idea/**,**/.vs/**,**/.settings/**,**/__pycache__/**,**/.tox/**,**/.mypy_cache/**,**/.pytest_cache/**';

export class CodebaseProfiler {
  constructor(private copilotClient?: CopilotClient) {}

  async profile(workspaceUri: vscode.Uri): Promise<CodebaseProfile> {
    const timer = logger.time('CodebaseProfiler');

    // Find all source files
    const codeExts = '{ts,tsx,js,jsx,py,cs,java,go,rs,rb,kt}';
    const sourceFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceUri, `**/*.${codeExts}`),
      EXCLUDE, 500
    );

    // Analyze each file (skip statically excluded paths)
    const modules: ModuleProfile[] = [];
    const importGraph = new Map<string, string[]>(); // file → imported files

    for (const uri of sourceFiles) {
      try {
        const relPath = vscode.workspace.asRelativePath(uri, false);
        if (ExclusionClassifierAgent.isExcluded(relPath)) continue;
        const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
        const mod = this.analyzeModule(relPath, content);
        modules.push(mod);
        importGraph.set(relPath, this.extractImportPaths(content, relPath));
      } catch { /* skip */ }
    }

    // Refine test classifications via TestClassificationAgent
    const testAgent = new TestClassificationAgent(this.copilotClient);
    const testClassifications = await testAgent.classify(modules);
    for (const mod of modules) {
      const cls = testClassifications.get(mod.path);
      if (cls === 'test' || cls === 'test-utility') {
        mod.role = 'test';
      }
    }

    // Calculate fan-in
    for (const mod of modules) {
      let fanIn = 0;
      for (const [, imports] of importGraph) {
        if (imports.some(imp => mod.path.includes(imp) || imp.includes(mod.path.replace(/\.[^.]+$/, '')))) {
          fanIn++;
        }
      }
      mod.fanIn = fanIn;
    }

    // Identify hotspots (high fan-in + high complexity)
    const hotspots = modules
      .filter(m => m.fanIn >= 3 && m.lines > 100)
      .sort((a, b) => (b.fanIn * b.lines) - (a.fanIn * a.lines))
      .slice(0, 10)
      .map(m => m.path);

    // Identify entry points
    const entryPoints = modules
      .filter(m => m.role === 'entry-point')
      .map(m => m.path);

    // Detect languages
    const langCounts = new Map<string, number>();
    for (const m of modules) {
      langCounts.set(m.language, (langCounts.get(m.language) || 0) + 1);
    }
    const languages = [...langCounts.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);

    // Discover pipelines via LLM (understands call chains)
    let pipelines: CodebasePipeline[] = [];
    if (this.copilotClient?.isAvailable() && entryPoints.length > 0) {
      try {
        pipelines = await this.discoverPipelines(modules, importGraph, entryPoints);
      } catch (err) {
        logger.debug('CodebaseProfiler: pipeline discovery failed', err);
      }
    }

    // Find untested and undocumented modules
    const testFiles = new Set(modules.filter(m => m.role === 'test').map(m => {
      return m.path.replace(/\.test\.|\.spec\.|__tests__\//, '').replace(/test\//, 'src/');
    }));

    const criticalModules = modules.filter(m => m.role !== 'test' && m.role !== 'type-def' && m.lines > 50);
    const untestedModules = criticalModules.filter(m => !testFiles.has(m.path) && !m.hasTests).map(m => m.path);
    const undocumentedModules = criticalModules.filter(m => !m.hasDocstring && m.lines > 100).map(m => m.path);

    const profile: CodebaseProfile = {
      name: vscode.workspace.workspaceFolders?.[0]?.name || 'workspace',
      languages,
      frameworks: [], // populated by component mapper already
      entryPoints,
      modules,
      pipelines,
      totalFiles: modules.length,
      totalExports: modules.reduce((s, m) => s + m.exportCount, 0),
      hotspots,
      untestedModules,
      undocumentedModules,
    };

    logger.info(`CodebaseProfiler: ${modules.length} modules, ${entryPoints.length} entry points, ${hotspots.length} hotspots, ${pipelines.length} pipelines`);
    timer?.end?.();
    return profile;
  }

  private analyzeModule(path: string, content: string): ModuleProfile {
    const lines = content.split('\n');
    const ext = path.split('.').pop()?.toLowerCase() || '';
    const langMap: Record<string, string> = { ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', py: 'Python', cs: 'C#', java: 'Java', go: 'Go', rs: 'Rust', rb: 'Ruby' };

    // Count exports
    const exportMatches = content.match(/export\s+(function|class|const|let|var|interface|type|enum|default|async)/g) || [];
    const exportNames: string[] = [];
    const exportRe = /export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g;
    let m;
    while ((m = exportRe.exec(content)) !== null) exportNames.push(m[1]);

    // Count imports
    const importCount = (content.match(/^import\s+/gm) || []).length;

    // Detect role
    let role: ModuleProfile['role'] = 'unknown';
    const fileName = path.split('/').pop() || '';
    if (path.includes('.test.') || path.includes('.spec.') || path.includes('__tests__')) role = 'test';
    else if (path.includes('/tests/') || path.includes('/test/') || fileName.startsWith('test_') || fileName === 'conftest.py') role = 'test';
    else if (path.includes('types') && !path.includes('test')) role = 'type-def';
    else if (path.match(/extension\.(ts|js)$/) || path.match(/main\.(ts|js)$/) || path.match(/index\.(ts|js)$/)) role = 'entry-point';
    else if (path.includes('/ui/') || path.includes('/views/') || path.includes('/components/')) role = 'ui';
    else if (path.includes('/utils') || path.includes('/helpers') || path.includes('/lib/')) role = 'utility';
    else if (path.includes('/config') || path.endsWith('.config.ts') || path.endsWith('.config.js')) role = 'config';
    else if (exportMatches.length > 0 && lines.length > 30) role = 'core-logic';

    // Detect docstring/JSDoc
    const hasDocstring = /\/\*\*[\s\S]*?\*\//.test(content) || /^"""/m.test(content);

    // Complexity estimate
    const complexity: ModuleProfile['complexity'] = lines.length > 500 ? 'high' : lines.length > 150 ? 'medium' : 'low';

    // Has tests check (for non-test files)
    const hasTests = role === 'test' || content.includes('describe(') || content.includes('it(') || content.includes('test(');

    return {
      path,
      language: langMap[ext] || ext,
      lines: lines.length,
      exports: exportNames,
      exportCount: exportNames.length,
      importCount,
      fanIn: 0, // calculated later
      hasTests,
      hasDocstring,
      complexity,
      role,
    };
  }

  private extractImportPaths(content: string, filePath: string): string[] {
    const imports: string[] = [];
    const patterns = [
      /import\s+.*?from\s+['"]([^'"]+)['"]/g,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];
    for (const pat of patterns) {
      pat.lastIndex = 0;
      let m;
      while ((m = pat.exec(content)) !== null) {
        const imp = m[1];
        if (imp.startsWith('.')) {
          // Resolve relative path
          const dir = filePath.split('/').slice(0, -1).join('/');
          const resolved = imp.replace(/^\.\//, dir + '/').replace(/^\.\.\//, dir + '/../');
          imports.push(resolved);
        } else {
          imports.push(imp);
        }
      }
    }
    return imports;
  }

  private async discoverPipelines(
    modules: ModuleProfile[],
    importGraph: Map<string, string[]>,
    entryPoints: string[]
  ): Promise<CodebasePipeline[]> {
    // Build a compact module summary for LLM
    const modulesSummary = modules
      .filter(m => m.role !== 'test' && m.role !== 'type-def')
      .sort((a, b) => b.fanIn - a.fanIn)
      .slice(0, 30)
      .map(m => `${m.path} (${m.role}, ${m.lines}L, ${m.exportCount} exports, fan-in:${m.fanIn}): ${m.exports.slice(0, 5).join(', ')}`)
      .join('\n');

    const importSummary = [...importGraph.entries()]
      .filter(([k]) => !k.includes('.test.'))
      .slice(0, 20)
      .map(([file, imports]) => `${file} → ${imports.filter(i => i.startsWith('.')).slice(0, 5).join(', ')}`)
      .join('\n');

    const prompt = `Analyze this codebase's module structure and identify the main execution pipelines (sequences of function calls that form a workflow).

MODULES:
${modulesSummary}

IMPORT GRAPH (file → imports):
${importSummary}

ENTRY POINTS: ${entryPoints.join(', ')}

Identify 2-5 main pipelines. For each, list the files in execution order and name the pipeline.

Respond as JSON:
[{"name":"pipeline name","entryPoint":"file","steps":[{"file":"path","function":"optional","order":1}]}]`;

    const response = await this.copilotClient!.analyze(prompt, undefined, 60_000);
    const match = response.match(/\[[\s\S]*\]/);
    if (!match) return [];

    try {
      const parsed = JSON.parse(match[0]) as CodebasePipeline[];
      logger.info(`CodebaseProfiler: LLM discovered ${parsed.length} pipelines`);
      return parsed;
    } catch {
      return [];
    }
  }
}

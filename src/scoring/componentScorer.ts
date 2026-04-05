import * as vscode from 'vscode';
import {
  ProjectContext,
  ComponentInfo,
  ComponentScore,
  ComponentSignal,
  LanguageScore,
  MaturityLevel,
  MATURITY_LEVELS,
  AITool,
  AI_TOOLS,
} from './types';
import { logger } from '../logging';

const EXCLUDE_GLOB =
  '**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/vendor/**,**/__pycache__/**,**/.venv/**,**/venv/**,**/target/**';

export class ComponentScorer {
  async scoreComponents(
    workspaceUri: vscode.Uri,
    context: ProjectContext,
    selectedTool: AITool
  ): Promise<ComponentScore[]> {
    if (context.components.length === 0) {
      // Single-project repo — treat root as one component
      const rootScore = await this.scoreComponent(
        workspaceUri,
        {
          name: context.languages[0] || 'project',
          path: '.',
          language: context.languages[0] || 'unknown',
          type: context.projectType === 'unknown' ? 'app' : context.projectType as ComponentInfo['type'],
        },
        context,
        selectedTool
      );
      return [rootScore];
    }

    const scores: ComponentScore[] = [];
    for (const comp of context.components) {
      try {
        // Skip removed/deprecated/legacy components — score them minimally
        const nameLower = (comp.name || '').toLowerCase();
        const descLower = (comp.description || '').toLowerCase();
        if (/(removed|deprecated|obsolete|archived)/.test(nameLower) || /(removed|deprecated|obsolete|archived)/.test(descLower)) {
          scores.push({
            name: comp.name,
            path: comp.path,
            language: comp.language || 'unknown',
            type: comp.type || 'unknown',
            primaryLevel: 1,
            overallScore: 0,
            depth: 0,
            signals: [],
            levels: [],
            description: comp.description,
            parentPath: comp.parentPath,
            isGenerated: comp.isGenerated,
          } as ComponentScore);
          continue;
        }
        // Generated components: check weight from config (default 0 = skip scoring)
        if (comp.isGenerated) {
          let genWeight = 0;
          try { 
            const tw = vscode.workspace.getConfiguration('ai-readiness').get<Record<string, number>>('componentTypeWeights');
            genWeight = tw?.generated ?? 0;
          } catch { /* tests */ }
          if (genWeight === 0) {
            scores.push({
              name: comp.name,
              path: comp.path,
              language: comp.language || 'unknown',
              type: comp.type || 'unknown',
              primaryLevel: 1,
              overallScore: 0,
              depth: 0,
              signals: [],
              levels: [],
              description: comp.description,
              parentPath: comp.parentPath,
              isGenerated: true,
            } as ComponentScore);
            continue;
          }
        }
        const score = await this.scoreComponent(workspaceUri, comp, context, selectedTool);
        scores.push(score);
      } catch (err) {
        logger.warn(`Skipping component "${comp.name}" at "${comp.path}"`, { error: err instanceof Error ? err.message : String(err) });
        // Add a minimal score so it still appears in the report
        scores.push({
          name: comp.name,
          path: comp.path,
          language: comp.language || 'unknown',
          type: comp.type || 'unknown',
          primaryLevel: 1,
          overallScore: 0,
          depth: 0,
          signals: [],
          levels: [],
          description: comp.description,
          parentPath: comp.parentPath,
          isGenerated: comp.isGenerated,
        } as ComponentScore);
      }
    }

    // Parent-group score inheritance
    for (const comp of scores) {
      if (!comp.children?.length) continue;
      const childScores = scores.filter(s => comp.children!.includes(s.path));
      if (childScores.length === 0) continue;
      const childAvg = Math.round(childScores.reduce((sum, c) => sum + c.overallScore, 0) / childScores.length);

      // Virtual/synthetic groups (created by Phase 3 grouping) fully inherit child average
      const isVirtualGroup = comp.path.startsWith('.') || comp.path.includes('.group-');
      if (isVirtualGroup) {
        comp.overallScore = childAvg;
        comp.depth = childAvg;
        comp.primaryLevel = childAvg >= 80 ? 4 : childAvg >= 60 ? 3 : childAvg >= 40 ? 2 : 1;
      } else if (comp.overallScore < childAvg && comp.overallScore < 50) {
        // Real containers: boost to 80% of child average if they score too low
        comp.overallScore = Math.max(comp.overallScore, Math.round(childAvg * 0.8));
        comp.depth = comp.overallScore;
        comp.primaryLevel = comp.overallScore >= 80 ? 4 : comp.overallScore >= 60 ? 3 : comp.overallScore >= 40 ? 2 : 1;
      }
    }

    // Filter out virtual/phantom components from output
    // They served their purpose for score inheritance but shouldn't appear in reports
    return scores.filter(comp => {
      // Remove .group-* virtual aggregation groups
      if (comp.path.includes('.group-')) return false;
      // Remove phantom aggregators (.devconfig, .infrastructure) — these are scanner-created
      // virtual parents that don't exist on disk. Real dotfile dirs (.github, .vscode) are kept.
      const REAL_DOTDIRS = new Set(['.github', '.vscode', '.devcontainer', '.clinerules', '.roo',
        '.windsurf', '.cursor', '.config', '.azuredevops', '.pipelines', '.release',
        '.release-fpa', '.release-manifestRollout', '.dev-setup', '.build', '.editorconfig']);
      if (/^\.[\w-]+$/.test(comp.path) && !REAL_DOTDIRS.has(comp.path)) return false;
      return true;
    });
  }

  async scoreLanguages(
    workspaceUri: vscode.Uri,
    context: ProjectContext,
    componentScores: ComponentScore[],
    selectedTool: AITool
  ): Promise<LanguageScore[]> {
    const langMap = new Map<string, { components: string[]; fileCount: number }>();

    // Group by language
    for (const lang of context.languages) {
      if (!langMap.has(lang)) {
        langMap.set(lang, { components: [], fileCount: 0 });
      }
    }

    for (const comp of componentScores) {
      const lang = comp.language || 'unknown';
      if (!langMap.has(lang)) {
        langMap.set(lang, { components: [], fileCount: 0 });
      }
      langMap.get(lang)!.components.push(comp.name);
    }

    // Count files per language
    const extToLang: Record<string, string> = {
      ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
      py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin',
      cs: 'C#', rb: 'Ruby', swift: 'Swift', c: 'C', cpp: 'C++', h: 'C',
      kql: 'KQL', csl: 'KQL', bicep: 'Bicep',
    };

    for (const [ext, lang] of Object.entries(extToLang)) {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(workspaceUri, `**/*.${ext}`),
        EXCLUDE_GLOB,
        500
      );
      if (uris.length > 0) {
        if (!langMap.has(lang)) {
          langMap.set(lang, { components: [], fileCount: 0 });
        }
        langMap.get(lang)!.fileCount += uris.length;
      }
    }

    // Score each language
    const scores: LanguageScore[] = [];
    for (const [lang, data] of langMap) {
      if (data.fileCount === 0 && data.components.length === 0) { continue; }
      const signals = await this.checkLanguageSignals(workspaceUri, lang, selectedTool);
      const passed = signals.filter(s => s.present).length;
      const total = signals.length;
      const passRate = total > 0 ? passed / total : 0;
      const level = passRate >= 0.8 ? 4 : passRate >= 0.6 ? 3 : passRate >= 0.4 ? 2 : 1;

      scores.push({
        language: lang,
        fileCount: data.fileCount,
        components: data.components,
        primaryLevel: level as MaturityLevel,
        depth: Math.round(passRate * 100),
        signals,
      });
    }

    return scores.sort((a, b) => b.fileCount - a.fileCount);
  }

  private async scoreComponent(
    workspaceUri: vscode.Uri,
    comp: ComponentInfo,
    context: ProjectContext,
    selectedTool: AITool
  ): Promise<ComponentScore> {
    const compUri = comp.path === '.'
      ? workspaceUri
      : vscode.Uri.joinPath(workspaceUri, comp.path);

    // Check if path is a file (not a directory) — score differently
    let isFile = false;
    try {
      const stat = await vscode.workspace.fs.stat(compUri);
      isFile = stat.type === vscode.FileType.File;
    } catch {
      // Path doesn't exist — treat as directory (findFiles will return empty)
    }

    let signals: ComponentSignal[];
    if (isFile) {
      // File-as-component: check if it exists + has content
      signals = [
        { signal: 'File Exists', present: true, detail: `${comp.path} exists` },
      ];
      try {
        const content = Buffer.from(await vscode.workspace.fs.readFile(compUri)).toString('utf-8');
        const lines = content.split('\n').length;
        signals.push({ signal: 'Documentation', present: content.includes('#') || content.includes('//'), detail: `${lines} lines, ${content.includes('#') ? 'has comments' : 'no comments'}` });
      } catch { /* skip */ }
    } else {
      signals = await this.checkComponentSignals(workspaceUri, compUri, comp, context, selectedTool);
    }

    const passed = signals.filter(s => s.present).length;
    const total = signals.length;
    const passRate = total > 0 ? passed / total : 0;
    let level = passRate >= 0.8 ? 4 : passRate >= 0.6 ? 3 : passRate >= 0.4 ? 2 : 1;

    // Minimum complexity threshold: prevent small/config-only directories from inflated levels
    if (!isFile && comp.path !== '.') {
      const codePattern = new vscode.RelativePattern(compUri,
        '**/*.{ts,tsx,js,jsx,py,go,rs,java,kt,cs,rb,swift,c,cpp,h,php,scala}');
      const codeFiles = await vscode.workspace.findFiles(codePattern, EXCLUDE_GLOB, 200);

      if (codeFiles.length === 0) {
        // Pure config directory (no code files) — cap at L1
        level = Math.min(level, 1);
      } else if (codeFiles.length < 5) {
        // Small component — check total lines
        let totalLines = 0;
        for (const f of codeFiles) {
          try {
            const content = Buffer.from(await vscode.workspace.fs.readFile(f)).toString('utf-8');
            totalLines += content.split('\n').length;
          } catch { /* skip unreadable files */ }
        }
        if (totalLines < 200) {
          level = Math.min(level, 2);
        }
      }
    }

    // Cap overallScore/depth to match level cap:
    // L1 → max 25%, L2 → max 50%, L3 → max 75%, L4 → 100%
    const maxScoreForLevel = level * 25;
    const cappedScore = Math.min(Math.round(passRate * 100), maxScoreForLevel);

    return {
      name: comp.name,
      path: comp.path,
      language: comp.language,
      type: comp.type,
      description: comp.description,
      parentPath: comp.parentPath,
      children: comp.children?.map(child => typeof child === 'string' ? child : child.path),
      primaryLevel: level as MaturityLevel,
      depth: cappedScore,
      overallScore: cappedScore,
      levels: [],
      signals,
      isGenerated: comp.isGenerated,
    };
  }

  private async checkComponentSignals(
    workspaceUri: vscode.Uri,
    compUri: vscode.Uri,
    comp: ComponentInfo,
    context: ProjectContext,
    selectedTool: AITool
  ): Promise<ComponentSignal[]> {
    const signals: ComponentSignal[] = [];
    const rel = (pattern: string) => new vscode.RelativePattern(compUri, pattern);
    const langLower = (comp.language || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    // Classify component type for signal selection
    const programmingLangs = new Set(['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'kotlin', 'c#', 'csharp', 'ruby', 'swift', 'c', 'c++', 'cpp', 'php']);
    const isProgramming = programmingLangs.has(langLower);
    const isConfig = ['json', 'yaml', 'yml', 'toml', 'xml'].includes(langLower);
    const isData = ['kql', 'sql', 'csv', 'powerbi'].includes(langLower);
    const isInfra = ['bicep', 'terraform', 'hcl', 'dockerfile'].includes(langLower);
    const isDocs = ['markdown', 'md'].includes(langLower);
    const compType = comp.type;

    // ── 1. README (all components) ──
    const hasReadme = await this.hasFile(rel('README.md'));
    signals.push({ signal: 'README', present: hasReadme, detail: hasReadme ? 'Component has its own README' : 'No component-level README' });

    // ── 2. Documentation (all components) ──
    const hasDocs = await this.hasFile(rel('{docs/**,*.md}'));
    signals.push({ signal: 'Documentation', present: hasDocs, detail: hasDocs ? 'Documentation found' : 'No docs' });

    // ── 3. Agent Instructions (component-scoped only) ──
    const toolConfig = AI_TOOLS[selectedTool];
    const agentPatterns = [...toolConfig.level2Files, ...toolConfig.level3Files];
    const hasAgentInstructions = await this.hasComponentScopedFiles(
      workspaceUri,
      compUri,
      comp.path,
      agentPatterns
    );
    signals.push({
      signal: `${toolConfig.name} Instructions`,
      present: hasAgentInstructions,
      detail: hasAgentInstructions ? `${toolConfig.name} instructions found` : `No ${toolConfig.name} instructions found`,
    });

    // ── 4. Build Config (programming + infra only) ──
    if (isProgramming || isInfra) {
      const hasBuild = await this.hasFile(rel('{package.json,pyproject.toml,Cargo.toml,go.mod,Makefile,*.csproj}'));
      // Also check .vscode/tasks.json referencing this component
      let hasTasksRef = false;
      if (!hasBuild) {
        hasTasksRef = await this.componentReferencedInTasks(workspaceUri, comp);
      }
      signals.push({ signal: 'Build Config', present: hasBuild || hasTasksRef, 
        detail: hasBuild ? 'Build system configured' : hasTasksRef ? 'Referenced in VS Code tasks' : 'No build config' });
    }

    // ── 6. Structure Documented (programming components) ──
    if (isProgramming) {
      const hasStructureDocs = await this.hasFile(rel('{ARCHITECTURE.md,STRUCTURE.md,docs/architecture*,docs/structure*}'))
        || await this.hasFile(new vscode.RelativePattern(workspaceUri, '{ARCHITECTURE.md,STRUCTURE.md,docs/architecture*,docs/structure*}'));
      signals.push({ signal: 'Structure Documented', present: hasStructureDocs, detail: hasStructureDocs ? 'Architecture docs found' : 'No structure documentation' });
    }

    // ── 7. Conventions Documented (programming only) ──
    if (isProgramming) {
      const hasConventions = await this.hasFile(rel('{CONTRIBUTING.md,.editorconfig}'))
        || await this.hasFile(new vscode.RelativePattern(workspaceUri, '{CONTRIBUTING.md,.editorconfig,.github/copilot-instructions.md,CLAUDE.md}'));
      signals.push({ signal: 'Conventions Documented', present: hasConventions, detail: hasConventions ? 'Coding conventions documented' : 'No conventions documentation' });
    }

    // ── 8. Automation (data/config components — check tasks.json) ──
    if (isData || isConfig) {
      const hasAutomation = await this.componentReferencedInTasks(workspaceUri, comp);
      signals.push({ signal: 'Automation', present: hasAutomation, 
        detail: hasAutomation ? 'VS Code tasks or scripts automate this component' : 'No automation scripts found' });
    }

    // ── 9. Deployment Docs (infra components) ──
    if (isInfra) {
      const hasDeploy = await this.hasFile(rel('{deploy*,*.parameters.json,**/parameters/**}'))
        || await this.hasFile(new vscode.RelativePattern(workspaceUri, '{docs/deploy*,docs/infrastructure*,runbooks/**}'));
      signals.push({ signal: 'Deployment Documented', present: hasDeploy, detail: hasDeploy ? 'Deployment docs found' : 'No deployment documentation' });
    }

    // ── 10. Tests (app/service/library components) ──
    if (isProgramming && (compType === 'app' || compType === 'service' || compType === 'library')) {
      let hasTests = await this.hasFile(rel('{tests/**,test/**,**/test_*,**/*_test.*,**/*.test.*,**/*.spec.*,**/*Tests*}'));
      // Check for companion test projects (e.g., Storage → Storage.Tests, X → X.Tests)
      if (!hasTests) {
        const compName = comp.name;
        const parentDir = comp.path.includes('/') ? comp.path.substring(0, comp.path.lastIndexOf('/')) : '';
        // Also extract parent namespace (DataProcessing.Domain → DataProcessing)
        const parentNs = compName.includes('.') ? compName.substring(0, compName.lastIndexOf('.')) : '';
        const companionPatterns = [
          // Direct companion: Foo → Foo.Tests
          `${parentDir ? parentDir + '/' : ''}${compName}.Tests`,
          `${parentDir ? parentDir + '/' : ''}${compName}.Test`,
          `${parentDir ? parentDir + '/' : ''}${compName}.Integration.Tests`,
        ];
        // Shared test project: DataProcessing.Domain → DataProcessing.Tests
        if (parentNs && parentNs !== compName) {
          companionPatterns.push(`${parentDir ? parentDir + '/' : ''}${parentNs}.Tests`);
          companionPatterns.push(`${parentDir ? parentDir + '/' : ''}${parentNs}.Integration.Tests`);
        }
        // Also check parent directory for Tests subdir (Sample.Console → Console/Sample.Console.Tests)
        if (parentDir) {
          const grandParent = parentDir.includes('/') ? parentDir.substring(0, parentDir.lastIndexOf('/')) : '';
          if (grandParent) {
            companionPatterns.push(`${grandParent}/${compName}.Tests`);
          }
        }
        for (const pattern of companionPatterns) {
          try {
            await vscode.workspace.fs.stat(vscode.Uri.joinPath(workspaceUri, pattern));
            hasTests = true;
            break;
          } catch { /* companion doesn't exist */ }
        }
      }
      signals.push({ signal: 'Tests', present: hasTests, detail: hasTests ? 'Test files found' : 'No test directory or test files' });
    }

    return signals;
  }

  /** Check if a component is referenced in .vscode/tasks.json */
  private async componentReferencedInTasks(workspaceUri: vscode.Uri, comp: ComponentInfo): Promise<boolean> {
    try {
      const tasksUri = vscode.Uri.joinPath(workspaceUri, '.vscode/tasks.json');
      const bytes = await vscode.workspace.fs.readFile(tasksUri);
      const content = Buffer.from(bytes).toString('utf-8').toLowerCase();
      const compPath = comp.path.toLowerCase();
      const compName = comp.name.toLowerCase();
      return content.includes(compPath) || content.includes(compName);
    } catch {
      return false;
    }
  }

  private async checkLanguageSignals(
    workspaceUri: vscode.Uri,
    language: string,
    selectedTool: AITool
  ): Promise<ComponentSignal[]> {
    const signals: ComponentSignal[] = [];
    const rel = (pattern: string) => new vscode.RelativePattern(workspaceUri, pattern);
    const langLower = language.toLowerCase().replace(/[^a-z0-9]/g, '');

    const toolConfig = AI_TOOLS[selectedTool];
    const toolName = toolConfig.name;

    // Classify languages: programming vs config/data vs documentation
    const programmingLangs = new Set([
      'typescript', 'javascript', 'python', 'go', 'rust', 'java', 'kotlin',
      'c#', 'csharp', 'ruby', 'swift', 'c', 'c++', 'cpp', 'php', 'scala',
    ]);
    const queryLangs = new Set(['kql', 'sql', 'graphql']);
    const configLangs = new Set(['json', 'yaml', 'yml', 'toml', 'xml', 'ini']);
    const docLangs = new Set(['markdown', 'md', 'rst', 'asciidoc']);
    const binaryLangs = new Set(['powerbi', 'excel', 'pbix']);
    const infraLangs = new Set(['bicep', 'terraform', 'hcl', 'dockerfile']);

    const isProgramming = programmingLangs.has(langLower);
    const isQuery = queryLangs.has(langLower);
    const isConfig = configLangs.has(langLower);
    const isDoc = docLangs.has(langLower);
    const isBinary = binaryLangs.has(langLower);
    const isInfra = infraLangs.has(langLower);

    // ── 1. Agent Instructions (applies to ALL languages) ──
    const toolInstructionPatterns = [...toolConfig.level2Files, ...toolConfig.level3Files];
    let hasLangInstructions = false;
    let instructionsDetail = `No ${toolName} instructions reference ${language}`;

    // Check if any instruction file mentions this language
    for (const pattern of toolInstructionPatterns) {
      if (hasLangInstructions) break;
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(workspaceUri, pattern), EXCLUDE_GLOB, 5
      );
      for (const uri of files) {
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const content = Buffer.from(bytes).toString('utf-8').toLowerCase();
          if (content.includes(langLower) || content.includes(language.toLowerCase())) {
            hasLangInstructions = true;
            instructionsDetail = `${toolName} instructions reference ${language}`;
            break;
          }
        } catch (err) { logger.warn('Failed to read instruction file for language check', { error: err instanceof Error ? err.message : String(err) }); }
      }
    }
    signals.push({ signal: `${toolName} Instructions`, present: hasLangInstructions, detail: hasLangInstructions ? `${toolName} instruction file references ${language}` : `No ${toolName} instruction file mentions ${language}` });

    // ── 2. Documentation (applies to ALL languages) ──
    const readmeFiles = await vscode.workspace.findFiles(rel('{README.md,readme.md}'), EXCLUDE_GLOB, 1);
    let hasDocumentation = false;
    let readmeContent = '';
    if (readmeFiles.length > 0) {
      try {
        const bytes = await vscode.workspace.fs.readFile(readmeFiles[0]);
        readmeContent = Buffer.from(bytes).toString('utf-8').toLowerCase();
        hasDocumentation = readmeContent.includes(langLower) || readmeContent.includes(language.toLowerCase());
      } catch (err) { logger.warn('Failed to read README for documentation check', { error: err instanceof Error ? err.message : String(err) }); }
    }
    if (!hasDocumentation) {
      const docsFiles = await vscode.workspace.findFiles(rel('{docs/**/*.md,doc/**/*.md}'), EXCLUDE_GLOB, 10);
      for (const uri of docsFiles) {
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const content = Buffer.from(bytes).toString('utf-8').toLowerCase();
          if (content.includes(langLower) || content.includes(language.toLowerCase())) {
            hasDocumentation = true;
            break;
          }
        } catch (err) { logger.warn('Failed to read docs file for documentation check', { error: err instanceof Error ? err.message : String(err) }); }
      }
    }
    signals.push({ signal: 'Documentation', present: hasDocumentation, detail: hasDocumentation ? `README/docs mention ${language}` : `No documentation references ${language}` });

    // ── 3. Structure Documented (applies to ALL except binary) ──
    if (!isBinary) {
      const hasStructureDocs = await this.hasFile(rel('{ARCHITECTURE.md,STRUCTURE.md,docs/architecture*,docs/structure*,.github/copilot-instructions.md,CLAUDE.md}'));
      let structurePresent = hasStructureDocs;
      let structureDetail = 'No architecture or structure documentation found';
      if (hasStructureDocs) {
        structureDetail = 'Architecture/structure documentation available';
      } else if (readmeContent) {
        if (readmeContent.includes('## structure') || readmeContent.includes('## architecture') ||
            readmeContent.includes('## project structure') || readmeContent.includes('## directory')) {
          structureDetail = 'README contains project structure documentation';
          structurePresent = true;
        }
      }
      signals.push({ signal: 'Structure Documented', present: structurePresent, detail: structureDetail });
    }

    // ── 4. Build/Run Documented (ONLY for programming and infra) ──
    if (isProgramming || isInfra) {
      let hasBuildDocs = false;
      if (readmeContent) {
        hasBuildDocs = (readmeContent.includes('## build') || readmeContent.includes('## install') ||
                        readmeContent.includes('## setup') || readmeContent.includes('## getting started') ||
                        readmeContent.includes('## development') || readmeContent.includes('## running') ||
                        readmeContent.includes('## usage'));
      }
      if (!hasBuildDocs) {
        hasBuildDocs = await this.hasFile(rel('{CONTRIBUTING.md,docs/development.md,docs/getting-started.md,Makefile}'));
      }
      signals.push({ signal: 'Build/Run Documented', present: hasBuildDocs, detail: hasBuildDocs ? `Build/run instructions available` : `No build/run documentation` });
    }

    // ── 6. Conventions Documented (programming and query languages) ──
    if (isProgramming || isQuery) {
      let hasConventions = false;
      const conventionPatterns = ['.editorconfig', 'CONTRIBUTING.md', ...toolConfig.level2Files];
      const conventionGlob = `{${conventionPatterns.join(',')}}`;
      const conventionFiles = await vscode.workspace.findFiles(rel(conventionGlob), EXCLUDE_GLOB, 10);
      for (const uri of conventionFiles) {
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const content = Buffer.from(bytes).toString('utf-8').toLowerCase();
          if (content.includes('convention') || content.includes('style') || content.includes('pattern') ||
              content.includes('naming') || content.includes(langLower)) {
            hasConventions = true;
            break;
          }
        } catch (err) { logger.warn('Failed to read file for conventions check', { error: err instanceof Error ? err.message : String(err) }); }
      }
      signals.push({ signal: 'Conventions Documented', present: hasConventions, detail: hasConventions ? `Coding conventions specified for ${language}` : `No coding conventions for ${language}` });
    }

    // ── 7. Schema/Validation (config and data languages) ──
    if (isConfig) {
      const hasSchema = await this.hasFile(rel(`{**/*.schema.json,**/schema*,**/*schema*}`));
      signals.push({ signal: 'Schema Defined', present: hasSchema, detail: hasSchema ? `JSON/config schema found` : `No schema validation for ${language} files` });
    }

    // ── 8. Deployment Docs (infra languages) ──
    if (isInfra) {
      let hasDeployDocs = false;
      if (readmeContent) {
        hasDeployDocs = readmeContent.includes('deploy') || readmeContent.includes('provision') ||
                        readmeContent.includes('infrastructure');
      }
      if (!hasDeployDocs) {
        hasDeployDocs = await this.hasFile(rel('{docs/deploy*,docs/infrastructure*,runbooks/**}'));
      }
      signals.push({ signal: 'Deployment Documented', present: hasDeployDocs, detail: hasDeployDocs ? `Deployment docs available` : `No deployment documentation` });
    }

    // ── 9. Purpose Documented (doc and binary languages) ──
    if (isDoc || isBinary) {
      // For documentation and binary file types, check if their purpose is explained somewhere
      let hasPurpose = hasDocumentation; // if README mentions them, that counts
      if (!hasPurpose && readmeContent) {
        hasPurpose = readmeContent.includes(langLower) || readmeContent.includes('dashboard') ||
                     readmeContent.includes('report') || readmeContent.includes('documentation');
      }
      signals.push({ signal: 'Purpose Documented', present: hasPurpose, detail: hasPurpose ? `${language} files are documented` : `No documentation explains ${language} files` });
    }

    return signals;
  }

  private async hasFile(pattern: vscode.RelativePattern): Promise<boolean> {
    const uris = await vscode.workspace.findFiles(pattern, EXCLUDE_GLOB, 1);
    return uris.length > 0;
  }

  private async hasComponentScopedFiles(
    workspaceUri: vscode.Uri,
    compUri: vscode.Uri,
    compPath: string,
    patterns: string[]
  ): Promise<boolean> {
    const searches = this.getComponentScopedPatterns(workspaceUri, compUri, compPath, patterns);
    for (const { base, pattern } of searches) {
      if (await this.hasFile(new vscode.RelativePattern(base, pattern))) {
        return true;
      }
    }
    return false;
  }

  private getComponentScopedPatterns(
    workspaceUri: vscode.Uri,
    compUri: vscode.Uri,
    compPath: string,
    patterns: string[]
  ): Array<{ base: vscode.Uri; pattern: string }> {
    const searches: Array<{ base: vscode.Uri; pattern: string }> = [];
    const seen = new Set<string>();
    const normalizedCompPath = this.normalizeRelativePath(compPath);

    const addSearch = (base: vscode.Uri, pattern: string) => {
      if (!pattern) { return; }
      const key = `${base.fsPath}::${pattern}`;
      if (seen.has(key)) { return; }
      seen.add(key);
      searches.push({ base, pattern });
    };

    for (const rawPattern of patterns) {
      const candidatePatterns = this.normalizeSearchPatterns(rawPattern);
      for (const pattern of candidatePatterns) {
        addSearch(compUri, pattern);
        if (normalizedCompPath) {
          addSearch(workspaceUri, `${normalizedCompPath}/${pattern}`);
        }
      }
    }

    return searches;
  }

  private normalizeSearchPatterns(pattern: string): string[] {
    const candidates = new Set<string>([pattern]);
    if (pattern.startsWith('./')) {
      candidates.add(pattern.slice(2));
    }
    const withoutGlobstar = pattern.replace(/^(?:\*\*\/)+/, '');
    if (withoutGlobstar && withoutGlobstar !== pattern) {
      candidates.add(withoutGlobstar);
    }
    return [...candidates];
  }

  private normalizeRelativePath(value: string): string {
    if (!value || value === '.') { return ''; }
    return value
      .replace(/\\/g, '/')
      .replace(/^\.\/+/, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
  }
}

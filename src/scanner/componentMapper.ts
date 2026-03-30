import * as vscode from 'vscode';
import { ProjectContext, ComponentInfo, FileContent } from '../scoring/types';
import { CopilotClient } from '../llm/copilotClient';
import { logger } from '../logging';

const EXCLUDE_GLOB = '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/vendor/**,**/__pycache__/**,**/.venv/**,**/venv/**,**/target/**}';

const MAX_TREE_LINES = 100;
const MAX_DEEP_TREE_LINES = 200;

const LANGUAGE_INDICATORS: Record<string, { markers: string[]; extensions: string[] }> = {
  'TypeScript': { markers: ['tsconfig.json'], extensions: ['ts', 'tsx'] },
  'JavaScript': { markers: ['package.json'], extensions: ['js', 'jsx', 'mjs', 'cjs'] },
  'Python': { markers: ['pyproject.toml', 'setup.py', 'requirements.txt'], extensions: ['py'] },
  'Go': { markers: ['go.mod'], extensions: ['go'] },
  'Rust': { markers: ['Cargo.toml'], extensions: ['rs'] },
  'Java': { markers: ['pom.xml'], extensions: ['java'] },
  'Kotlin': { markers: [], extensions: ['kt'] },
  'C#': { markers: ['global.json'], extensions: ['cs', 'csproj', 'sln'] },
  'Ruby': { markers: ['Gemfile'], extensions: ['rb'] },
  'Swift': { markers: ['Package.swift'], extensions: ['swift'] },
  'C': { markers: ['CMakeLists.txt', 'Makefile'], extensions: ['c', 'h'] },
  'C++': { markers: [], extensions: ['cpp', 'hpp', 'cc', 'cxx'] },
  'KQL': { markers: [], extensions: ['kql', 'csl'] },
  'Bicep': { markers: ['bicepconfig.json'], extensions: ['bicep'] },
};

const JS_FRAMEWORK_PATTERNS: Record<string, string[]> = {
  'react': ['react'],
  'next': ['next'],
  'express': ['express'],
  'fastify': ['fastify'],
  'nestjs': ['@nestjs/core'],
  'vue': ['vue'],
  'angular': ['@angular/core'],
  'svelte': ['svelte'],
};

const PYTHON_FRAMEWORK_PATTERNS: Record<string, string[]> = {
  'fastapi': ['fastapi'],
  'django': ['django'],
  'flask': ['flask'],
  'streamlit': ['streamlit'],
};

const GO_FRAMEWORK_PATTERNS: Record<string, string[]> = {
  'gin': ['github.com/gin-gonic/gin'],
  'echo': ['github.com/labstack/echo'],
  'fiber': ['github.com/gofiber/fiber'],
};

const RUST_FRAMEWORK_PATTERNS: Record<string, string[]> = {
  'actix-web': ['actix-web'],
  'rocket': ['rocket'],
  'axum': ['axum'],
};

export class ComponentMapper {

  constructor(private copilotClient?: CopilotClient) {}

  async mapWorkspace(
    workspaceUri: vscode.Uri,
    deep: boolean = false,
    token?: vscode.CancellationToken,
    semanticData?: { path: string; summary: string; dependencies: string[]; exports: string[]; complexity: string }[],
  ): Promise<ProjectContext> {
    const context = await this.detectBasics(workspaceUri);

    if (deep && this.copilotClient?.isAvailable()) {
      logger.info(`Deep mapping ${context.components.length} components via LLM...`);
      const deepTimer = logger.time('Phase 2c: LLM deep component mapping');
      context.components = await this.deepMapComponents(workspaceUri, context, token, semanticData);
      deepTimer?.end?.();
    }

    return context;
  }

  private async detectBasics(workspaceUri: vscode.Uri): Promise<ProjectContext> {
    const relPattern = (glob: string) =>
      new vscode.RelativePattern(workspaceUri, glob);

    const t1 = logger.time('Phase 2a: detectLanguages + findFiles');
    const [languages, packageManager, rawFiles] = await Promise.all([
      this.detectLanguages(relPattern),
      this.detectPackageManager(relPattern),
      vscode.workspace.findFiles(relPattern('**/*'), EXCLUDE_GLOB, 5000),
    ]);
    t1.end();
    logger.info(`Found ${languages.length} languages, ${rawFiles.length} files`);

    // Run independent detections in parallel
    const t2 = logger.time('Phase 2b: frameworks + projectType + components');
    const [frameworks, projectType, components] = await Promise.all([
      this.detectFrameworks(relPattern, languages),
      this.detectProjectType(relPattern),
      this.detectComponents(relPattern, workspaceUri, rawFiles, languages),
    ]);
    t2.end();
    logger.info(`Found ${components.length} components, ${frameworks.length} frameworks`);

    const directoryTree = this.buildDirectoryTree(rawFiles, workspaceUri);
    const buildTasks = await this.readBuildTasks(workspaceUri);

    return {
      languages,
      frameworks,
      projectType,
      packageManager,
      directoryTree,
      components,
      buildTasks,
    };
  }

  // ── Language detection ──────────────────────────────────────────────

  private async detectLanguages(
    relPattern: (glob: string) => vscode.RelativePattern,
  ): Promise<string[]> {
    const checks = Object.entries(LANGUAGE_INDICATORS).map(
      async ([language, { markers, extensions }]) => {
        const globs = [
          ...markers.map(m => m),
          ...extensions.map(ext => `**/*.${ext}`),
        ];

        for (const g of globs) {
          const files = await vscode.workspace.findFiles(relPattern(g), EXCLUDE_GLOB, 1);
          if (files.length > 0) {
            return language;
          }
        }
        return null;
      },
    );

    const results = await Promise.all(checks);
    const detected = results.filter((lang): lang is string => lang !== null);

    // Merge Java/Kotlin marker overlap: build.gradle can indicate either
    const hasGradle = await vscode.workspace.findFiles(relPattern('**/build.gradle*'), EXCLUDE_GLOB, 1);
    if (hasGradle.length > 0) {
      if (!detected.includes('Java') && !detected.includes('Kotlin')) {
        detected.push('Java');
      }
    }

    // Merge C# project markers
    const csprojFiles = await vscode.workspace.findFiles(relPattern('**/*.{csproj,sln}'), EXCLUDE_GLOB, 1);
    if (csprojFiles.length > 0 && !detected.includes('C#')) {
      detected.push('C#');
    }

    return [...new Set(detected)];
  }

  // ── Framework detection ─────────────────────────────────────────────

  private async detectFrameworks(
    relPattern: (glob: string) => vscode.RelativePattern,
    languages: string[],
  ): Promise<string[]> {
    const frameworks: string[] = [];

    const hasJS = languages.some(l => l === 'TypeScript' || l === 'JavaScript');
    const hasPython = languages.includes('Python');
    const hasGo = languages.includes('Go');
    const hasRust = languages.includes('Rust');

    const tasks: Promise<void>[] = [];

    if (hasJS) {
      tasks.push(this.detectJSFrameworks(relPattern, frameworks));
    }
    if (hasPython) {
      tasks.push(this.detectPythonFrameworks(relPattern, frameworks));
    }
    if (hasGo) {
      tasks.push(this.detectGoFrameworks(relPattern, frameworks));
    }
    if (hasRust) {
      tasks.push(this.detectRustFrameworks(relPattern, frameworks));
    }

    await Promise.all(tasks);
    return [...new Set(frameworks)];
  }

  private async detectJSFrameworks(
    relPattern: (glob: string) => vscode.RelativePattern,
    frameworks: string[],
  ): Promise<void> {
    const packageFiles = await vscode.workspace.findFiles(relPattern('**/package.json'), EXCLUDE_GLOB);
    for (const uri of packageFiles) {
      const pkg = await this.readJson(uri);
      if (!pkg) continue;

      const allDeps: Record<string, string> = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };

      for (const [framework, packages] of Object.entries(JS_FRAMEWORK_PATTERNS)) {
        if (packages.some(p => p in allDeps)) {
          frameworks.push(framework);
        }
      }
    }
  }

  private async detectPythonFrameworks(
    relPattern: (glob: string) => vscode.RelativePattern,
    frameworks: string[],
  ): Promise<void> {
    // Check pyproject.toml
    const pyprojectFiles = await vscode.workspace.findFiles(relPattern('**/pyproject.toml'), EXCLUDE_GLOB);
    for (const uri of pyprojectFiles) {
      const content = await this.readText(uri);
      if (!content) continue;
      for (const [framework, packages] of Object.entries(PYTHON_FRAMEWORK_PATTERNS)) {
        if (packages.some(p => content.includes(p))) {
          frameworks.push(framework);
        }
      }
    }

    // Check requirements.txt
    const reqFiles = await vscode.workspace.findFiles(relPattern('**/requirements*.txt'), EXCLUDE_GLOB);
    for (const uri of reqFiles) {
      const content = await this.readText(uri);
      if (!content) continue;
      const lines = content.toLowerCase().split('\n');
      for (const [framework, packages] of Object.entries(PYTHON_FRAMEWORK_PATTERNS)) {
        if (packages.some(p => lines.some(line => line.startsWith(p)))) {
          frameworks.push(framework);
        }
      }
    }
  }

  private async detectGoFrameworks(
    relPattern: (glob: string) => vscode.RelativePattern,
    frameworks: string[],
  ): Promise<void> {
    const goModFiles = await vscode.workspace.findFiles(relPattern('**/go.mod'), EXCLUDE_GLOB);
    for (const uri of goModFiles) {
      const content = await this.readText(uri);
      if (!content) continue;
      for (const [framework, packages] of Object.entries(GO_FRAMEWORK_PATTERNS)) {
        if (packages.some(p => content.includes(p))) {
          frameworks.push(framework);
        }
      }
    }
  }

  private async detectRustFrameworks(
    relPattern: (glob: string) => vscode.RelativePattern,
    frameworks: string[],
  ): Promise<void> {
    const cargoFiles = await vscode.workspace.findFiles(relPattern('**/Cargo.toml'), EXCLUDE_GLOB);
    for (const uri of cargoFiles) {
      const content = await this.readText(uri);
      if (!content) continue;
      for (const [framework, packages] of Object.entries(RUST_FRAMEWORK_PATTERNS)) {
        if (packages.some(p => content.includes(p))) {
          frameworks.push(framework);
        }
      }
    }
  }

  // ── Package manager detection ───────────────────────────────────────

  private async detectPackageManager(
    relPattern: (glob: string) => vscode.RelativePattern,
  ): Promise<string> {
    const lockFileMap: [string, string][] = [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['package-lock.json', 'npm'],
      ['uv.lock', 'uv'],
      ['poetry.lock', 'poetry'],
      ['requirements.txt', 'pip'],
      ['Cargo.lock', 'cargo'],
      ['go.sum', 'go mod'],
    ];

    const checks = lockFileMap.map(async ([file, manager]) => {
      const found = await vscode.workspace.findFiles(relPattern(file), EXCLUDE_GLOB, 1);
      return found.length > 0 ? manager : null;
    });

    const results = await Promise.all(checks);
    return results.find((m): m is string => m !== null) ?? 'unknown';
  }

  // ── Project type detection ──────────────────────────────────────────

  private async detectProjectType(
    relPattern: (glob: string) => vscode.RelativePattern,
  ): Promise<ProjectContext['projectType']> {
    if (await this.isMonorepo(relPattern)) return 'monorepo';
    if (await this.isLibrary(relPattern)) return 'library';
    if (await this.isService(relPattern)) return 'service';
    if (await this.isApp(relPattern)) return 'app';
    return 'unknown';
  }

  private async isMonorepo(
    relPattern: (glob: string) => vscode.RelativePattern,
  ): Promise<boolean> {
    // Explicit monorepo markers
    const markerFiles = ['pnpm-workspace.yaml', 'lerna.json', 'nx.json'];
    const markerChecks = markerFiles.map(f =>
      vscode.workspace.findFiles(relPattern(f), EXCLUDE_GLOB, 1),
    );
    const markerResults = await Promise.all(markerChecks);
    if (markerResults.some(r => r.length > 0)) return true;

    // package.json with "workspaces"
    const rootPkg = await this.readRootJson(relPattern, 'package.json');
    if (rootPkg?.workspaces) return true;

    // Cargo.toml with [workspace]
    const rootCargoFiles = await vscode.workspace.findFiles(relPattern('Cargo.toml'), EXCLUDE_GLOB, 1);
    if (rootCargoFiles.length > 0) {
      const content = await this.readText(rootCargoFiles[0]);
      if (content && /\[workspace\]/i.test(content)) return true;
    }

    return false;
  }

  private async isLibrary(
    relPattern: (glob: string) => vscode.RelativePattern,
  ): Promise<boolean> {
    // package.json with main/exports but no bin
    const rootPkg = await this.readRootJson(relPattern, 'package.json');
    if (rootPkg) {
      const hasExports = rootPkg.main || rootPkg.exports || rootPkg.module;
      const hasBin = rootPkg.bin;
      if (hasExports && !hasBin) return true;
    }

    // pyproject.toml with [build-system]
    const pyprojectFiles = await vscode.workspace.findFiles(relPattern('pyproject.toml'), EXCLUDE_GLOB, 1);
    if (pyprojectFiles.length > 0) {
      const content = await this.readText(pyprojectFiles[0]);
      if (content && content.includes('[build-system]')) return true;
    }

    // Cargo.toml with [lib]
    const cargoFiles = await vscode.workspace.findFiles(relPattern('Cargo.toml'), EXCLUDE_GLOB, 1);
    if (cargoFiles.length > 0) {
      const content = await this.readText(cargoFiles[0]);
      if (content && content.includes('[lib]')) return true;
    }

    return false;
  }

  private async isService(
    relPattern: (glob: string) => vscode.RelativePattern,
  ): Promise<boolean> {
    const dockerfiles = await vscode.workspace.findFiles(
      relPattern('{Dockerfile,docker-compose.yml,docker-compose.yaml}'),
      EXCLUDE_GLOB,
      1,
    );
    if (dockerfiles.length === 0) return false;

    // Look for common port-listening patterns in source files
    const sourceFiles = await vscode.workspace.findFiles(
      relPattern('**/*.{ts,js,py,go,rs,java,kt,cs,rb}'),
      EXCLUDE_GLOB,
      20,
    );
    for (const uri of sourceFiles) {
      const content = await this.readText(uri);
      if (!content) continue;
      if (/\.(listen|serve|bind)\s*\(|EXPOSE\s+\d|port/i.test(content)) {
        return true;
      }
    }

    return false;
  }

  private async isApp(
    relPattern: (glob: string) => vscode.RelativePattern,
  ): Promise<boolean> {
    // Check for common entry points
    const entryPatterns = [
      'src/index.{ts,js,tsx,jsx}',
      'src/main.{ts,js,tsx,jsx,py,go,rs}',
      'src/app.{ts,js,tsx,jsx,py}',
      'main.{py,go}',
      'app.{py,js,ts}',
    ];

    for (const pattern of entryPatterns) {
      const files = await vscode.workspace.findFiles(relPattern(pattern), EXCLUDE_GLOB, 1);
      if (files.length > 0) return true;
    }

    return false;
  }

  // ── Directory tree generation ───────────────────────────────────────

  private buildDirectoryTree(files: vscode.Uri[], workspaceUri: vscode.Uri): string {
    const basePath = workspaceUri.path;

    // Build directory set from ALL files — no depth limit
    const dirs = new Set<string>();
    for (const f of files) {
      const rel = f.path.slice(basePath.length + 1);
      const parts = rel.split('/');
      // Add every directory level
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join('/'));
      }
    }

    // Sort and format as indented tree
    const sortedDirs = [...dirs].sort();
    const lines: string[] = [];
    for (const dir of sortedDirs) {
      const depth = dir.split('/').length - 1;
      const name = dir.split('/').pop() || dir;
      lines.push(`${'  '.repeat(depth)}${name}/`);
    }

    // Smart truncation: if tree is too large, show directories that contain
    // manifest files (pyproject.toml, .csproj, package.json, README.md) fully,
    // collapse deep non-manifest directories
    if (lines.length > 600) {
      const manifestDirs = new Set<string>();
      for (const f of files) {
        const rel = f.path.slice(basePath.length + 1);
        const fileName = rel.split('/').pop() || '';
        if (/^(pyproject\.toml|package\.json|.*\.csproj|README\.md|Cargo\.toml|go\.mod)$/i.test(fileName)) {
          // Keep this dir and all its parents
          const parts = rel.split('/');
          for (let i = 1; i < parts.length; i++) {
            manifestDirs.add(parts.slice(0, i).join('/'));
          }
        }
      }

      const filtered = sortedDirs.filter(d => {
        // Always show top 2 levels
        if (d.split('/').length <= 2) return true;
        // Always show dirs containing manifests
        if (manifestDirs.has(d)) return true;
        // Show dirs that are parents of manifest dirs
        if ([...manifestDirs].some(m => m.startsWith(d + '/'))) return true;
        return false;
      });

      const smartLines: string[] = [];
      for (const dir of filtered) {
        const depth = dir.split('/').length - 1;
        const name = dir.split('/').pop() || dir;
        smartLines.push(`${'  '.repeat(depth)}${name}/`);
      }
      return smartLines.join('\n');
    }

    return lines.join('\n');
  }

  // ── Component detection ──────────────────────────────────────────────

  /** Directories to skip when scanning for components */
  private static readonly EXCLUDED_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'vendor', '__pycache__',
    '.venv', 'venv', 'target', 'coverage', '.next', '.nuxt', 'out',
    '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', 'egg-info',
    '.idea', '.vs', '.settings', '.eclipse', '.history',
  ]);

  /** Well-known directory names that often contain sub-components */
  private static readonly KEY_DIRS = new Set([
    'src', 'lib', 'apps', 'packages', 'components', 'services',
    'modules', 'infrastructure', 'deploy', 'detection', 'scripts',
    'tools', 'ci', 'functions', 'workers', 'lambdas', 'plugins',
    '.build', '.pipelines', 'pipelines', 'dashboards', 'tests',
  ]);

  /** Manifest files that signal a directory is its own component */
  private static readonly MANIFEST_FILES = [
    'package.json', 'pyproject.toml', 'setup.py', 'Cargo.toml',
    'go.mod', '*.csproj', '*.sln', 'pom.xml', 'build.gradle',
    'CMakeLists.txt', 'Makefile',
  ];

  private async detectComponents(
    relPattern: (glob: string) => vscode.RelativePattern,
    workspaceUri: vscode.Uri,
    allFiles: vscode.Uri[],
    languages: string[],
  ): Promise<ComponentInfo[]> {
    const components: ComponentInfo[] = [];
    const seenPaths = new Set<string>();
    const basePath = workspaceUri.path;

    // 1. Monorepo workspace members (package.json workspaces)
    const rootPkg = await this.readRootJson(relPattern, 'package.json');
    if (rootPkg?.workspaces) {
      const workspaceDirs = Array.isArray(rootPkg.workspaces)
        ? rootPkg.workspaces
        : (rootPkg.workspaces.packages ?? []);

      for (const wsGlob of workspaceDirs as string[]) {
        const pkgFiles = await vscode.workspace.findFiles(
          relPattern(`${wsGlob}/package.json`),
          EXCLUDE_GLOB,
        );

        for (const pkgUri of pkgFiles) {
          const pkg = await this.readJson(pkgUri);
          if (!pkg) continue;

          const pkgDir = pkgUri.path.replace(/\/package\.json$/, '');
          const relPath = pkgDir.startsWith(basePath) ? pkgDir.slice(basePath.length + 1) : pkgDir;
          if (seenPaths.has(relPath)) continue;
          seenPaths.add(relPath);

          const name = pkg.name ?? relPath.split('/').pop() ?? 'unknown';
          components.push({
            name,
            path: relPath,
            language: await this.detectDirLanguage(relPattern, relPath),
            type: this.classifyJSComponent(pkg),
          });
        }
      }
    }

    // 2. pnpm-workspace.yaml packages
    if (!rootPkg?.workspaces) {
      const pnpmWs = await vscode.workspace.findFiles(relPattern('pnpm-workspace.yaml'), EXCLUDE_GLOB, 1);
      if (pnpmWs.length > 0) {
        const content = await this.readText(pnpmWs[0]);
        if (content) {
          const packageGlobs = content
            .split('\n')
            .filter(line => line.trim().startsWith('-'))
            .map(line => line.replace(/^\s*-\s*['"]?/, '').replace(/['"]?\s*$/, ''))
            .filter(Boolean);

          for (const wsGlob of packageGlobs) {
            const pkgFiles = await vscode.workspace.findFiles(
              relPattern(`${wsGlob}/package.json`),
              EXCLUDE_GLOB,
            );

            for (const pkgUri of pkgFiles) {
              const pkg = await this.readJson(pkgUri);
              if (!pkg) continue;

              const pkgDir = pkgUri.path.replace(/\/package\.json$/, '');
              const relPath = pkgDir.startsWith(basePath) ? pkgDir.slice(basePath.length + 1) : pkgDir;
              if (seenPaths.has(relPath)) continue;
              seenPaths.add(relPath);

              const name = pkg.name ?? relPath.split('/').pop() ?? 'unknown';
              components.push({
                name,
                path: relPath,
                language: await this.detectDirLanguage(relPattern, relPath),
                type: this.classifyJSComponent(pkg),
              });
            }
          }
        }
      }
    }

    // 3. Cargo workspace members
    const cargoFiles = await vscode.workspace.findFiles(relPattern('Cargo.toml'), EXCLUDE_GLOB, 1);
    if (cargoFiles.length > 0) {
      const content = await this.readText(cargoFiles[0]);
      if (content && /\[workspace\]/i.test(content)) {
        const membersMatch = content.match(/members\s*=\s*\[([^\]]*)\]/);
        if (membersMatch) {
          const members = membersMatch[1]
            .split(',')
            .map(m => m.trim().replace(/['"]/g, ''))
            .filter(Boolean);

          for (const member of members) {
            const memberCargo = await vscode.workspace.findFiles(
              relPattern(`${member}/Cargo.toml`),
              EXCLUDE_GLOB,
              1,
            );
            if (memberCargo.length > 0) {
              const relPath = member;
              if (seenPaths.has(relPath)) continue;
              seenPaths.add(relPath);

              const memberContent = await this.readText(memberCargo[0]);
              const nameMatch = memberContent?.match(/name\s*=\s*"([^"]+)"/);
              const isLib = memberContent?.includes('[lib]') ?? false;

              components.push({
                name: nameMatch?.[1] ?? member,
                path: relPath,
                language: 'Rust',
                type: isLib ? 'library' : 'app',
              });
            }
          }
        }
      }
    }

    // 4. Directories with their own manifest files (scan depth 1-3, all parallel)
    const allManifestPromises: Thenable<vscode.Uri[]>[] = [];
    for (let depth = 1; depth <= 3; depth++) {
      const depthGlob = Array(depth).fill('*').join('/');
      for (const manifest of ComponentMapper.MANIFEST_FILES) {
        allManifestPromises.push(
          vscode.workspace.findFiles(relPattern(`${depthGlob}/${manifest}`), EXCLUDE_GLOB, 30)
        );
      }
    }
    const allManifestResults = await Promise.all(allManifestPromises);

    for (const manifestFiles of allManifestResults) {
        for (const uri of manifestFiles) {
          const dirPath = uri.path.replace(new RegExp(`/[^/]+$`), '');
          const relPath = dirPath.startsWith(basePath) ? dirPath.slice(basePath.length + 1) : dirPath;
          const dirName = relPath.split('/').pop() ?? '';
          if (seenPaths.has(relPath) || ComponentMapper.EXCLUDED_DIRS.has(dirName)) continue;
          seenPaths.add(relPath);

          components.push({
            name: dirName,
            path: relPath,
            language: 'unknown',
            type: this.classifyDirType(dirName, relPath),
          });
        }
      }

    // Batch-detect languages for all discovered components
    const langPromises = components
      .filter(c => c.language === 'unknown')
      .map(async (c) => {
        c.language = await this.detectDirLanguage(relPattern, c.path);
      });
    await Promise.all(langPromises);

    // 4b. Detect .sln files (C# solution roots)
    const slnFiles = await vscode.workspace.findFiles(relPattern('**/*.sln'), EXCLUDE_GLOB, 10);
    for (const slnUri of slnFiles) {
      const slnDir = slnUri.path.replace(/\/[^/]+\.sln$/, '');
      const relPath = slnDir.startsWith(basePath) ? slnDir.slice(basePath.length + 1) : slnDir;
      if (relPath === '' || relPath === '.' || seenPaths.has(relPath)) continue;
      const dirName = relPath.split('/').pop() ?? '';
      if (ComponentMapper.EXCLUDED_DIRS.has(dirName)) continue;
      seenPaths.add(relPath);
      components.push({
        name: dirName,
        path: relPath,
        language: 'C#',
        type: 'app',
      });
    }

    // 5. Key directories that contain source code but weren't caught above
    for (const keyDir of ComponentMapper.KEY_DIRS) {
      // Check top-level key dirs
      const dirFiles = await vscode.workspace.findFiles(
        relPattern(`${keyDir}/**/*`),
        EXCLUDE_GLOB,
        1,
      );
      if (dirFiles.length > 0 && !seenPaths.has(keyDir)) {
        // Check if this key dir has sub-directories that are components
        const subDirManifests = await vscode.workspace.findFiles(
          relPattern(`${keyDir}/*/package.json`),
          EXCLUDE_GLOB,
          50,
        );
        const subDirManifests2 = await vscode.workspace.findFiles(
          relPattern(`${keyDir}/*/{pyproject.toml,Cargo.toml,go.mod,*.csproj}`),
          EXCLUDE_GLOB,
          50,
        );

        const subManifests = [...subDirManifests, ...subDirManifests2];
        if (subManifests.length > 0) {
          // This key dir contains sub-components — add each
          for (const mUri of subManifests) {
            const subDirPath = mUri.path.replace(new RegExp(`/[^/]+$`), '');
            const relPath = subDirPath.startsWith(basePath) ? subDirPath.slice(basePath.length + 1) : subDirPath;
            const dirName = relPath.split('/').pop() ?? '';
            if (seenPaths.has(relPath) || ComponentMapper.EXCLUDED_DIRS.has(dirName)) continue;
            seenPaths.add(relPath);

            components.push({
              name: dirName,
              path: relPath,
              language: await this.detectDirLanguage(relPattern, relPath),
              type: this.classifyDirType(dirName, relPath),
            });
          }
        } else {
          // No manifests — check if subdirectories have source files (modules without package.json)
          const children = this.getDirectChildren(allFiles, basePath, keyDir);
          const sourceChildren = [];
          for (const child of children) {
            if (ComponentMapper.EXCLUDED_DIRS.has(child)) continue;
            if (child === 'test' || child === 'tests' || child === '__tests__') continue;
            const childPath = `${keyDir}/${child}`;
            const childFiles = allFiles.filter(f => {
              const rel = f.path.slice(basePath.length + 1);
              return rel.startsWith(childPath + '/');
            });
            if (childFiles.length >= 2) {
              sourceChildren.push({ name: child, path: childPath, fileCount: childFiles.length });
            }
          }

          if (sourceChildren.length >= 2) {
            // Multiple subdirs with source files → split into separate components
            for (const sc of sourceChildren) {
              if (seenPaths.has(sc.path)) continue;
              seenPaths.add(sc.path);
              components.push({
                name: sc.name,
                path: sc.path,
                language: await this.detectDirLanguage(relPattern, sc.path),
                type: this.classifyDirType(sc.name, sc.path),
              });
            }
            // Also add the parent as a group marker (for root-level files like extension.ts)
            const rootFiles = allFiles.filter(f => {
              const rel = f.path.slice(basePath.length + 1);
              return rel.startsWith(keyDir + '/') && !rel.slice(keyDir.length + 1).includes('/');
            });
            if (rootFiles.length > 0) {
              seenPaths.add(keyDir);
              components.push({
                name: keyDir,
                path: keyDir,
                language: await this.detectDirLanguage(relPattern, keyDir),
                type: this.classifyDirType(keyDir, keyDir),
              });
            }
          } else {
            // Key dir itself is a single component (no meaningful subdirs)
            seenPaths.add(keyDir);
            components.push({
              name: keyDir,
              path: keyDir,
              language: await this.detectDirLanguage(relPattern, keyDir),
              type: this.classifyDirType(keyDir, keyDir),
            });
          }
        }
      }
    }

    // 6. src/*/ pattern — each child of src/ may be a component
    const srcChildren = this.getDirectChildren(allFiles, basePath, 'src');
    for (const child of srcChildren) {
      const relPath = `src/${child}`;
      if (seenPaths.has(relPath) || ComponentMapper.EXCLUDED_DIRS.has(child)) continue;
      // Verify it has source files
      const childFiles = allFiles.filter(f => {
        const rel = f.path.slice(basePath.length + 1);
        return rel.startsWith(relPath + '/');
      });
      if (childFiles.length < 2) continue;
      seenPaths.add(relPath);
      components.push({
        name: child,
        path: relPath,
        language: await this.detectDirLanguage(relPattern, relPath),
        type: this.classifyDirType(child, relPath),
      });
    }

    // 7. Top-level and second-level directories with significant source code (>2 source files)
    const SOURCE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'kt', 'cs', 'rb', 'swift', 'c', 'cpp', 'h', 'kql', 'csl', 'bicep']);
    const topDirCounts = new Map<string, number>();
    for (const f of allFiles) {
      const rel = f.path.slice(basePath.length + 1);
      const parts = rel.split('/');
      if (parts.length < 2) continue;
      const topDir = parts[0];
      if (ComponentMapper.EXCLUDED_DIRS.has(topDir)) continue;
      const ext = rel.split('.').pop()?.toLowerCase() ?? '';
      if (SOURCE_EXTENSIONS.has(ext)) {
        topDirCounts.set(topDir, (topDirCounts.get(topDir) ?? 0) + 1);
      }
      // Also count second-level directories
      if (parts.length >= 3 && !ComponentMapper.EXCLUDED_DIRS.has(parts[1])) {
        const secondDir = parts[0] + '/' + parts[1];
        if (SOURCE_EXTENSIONS.has(ext)) {
          topDirCounts.set(secondDir, (topDirCounts.get(secondDir) ?? 0) + 1);
        }
      }
    }

    for (const [dir, count] of topDirCounts) {
      if (count > 2 && !seenPaths.has(dir)) {
        seenPaths.add(dir);
        components.push({
          name: dir.split('/').pop() ?? dir,
          path: dir,
          language: await this.detectDirLanguage(relPattern, dir),
          type: this.classifyDirType(dir.split('/').pop() ?? dir, dir),
        });
      }
    }

    // 8. Directories with their own README.md (indicates a documented component)
    const readmePatterns = ['*/README.md', '*/*/README.md', '*/*/*/README.md', '*/*/*/*/README.md'];
    const allReadmeFiles: vscode.Uri[] = [];
    for (const pattern of readmePatterns) {
      const found = await vscode.workspace.findFiles(relPattern(pattern), EXCLUDE_GLOB, 50);
      allReadmeFiles.push(...found);
    }
    for (const readmeUri of allReadmeFiles) {
      const dirPath = readmeUri.path.replace(/\/README\.md$/, '');
      const relPath = dirPath.startsWith(basePath) ? dirPath.slice(basePath.length + 1) : dirPath;
      const dirName = relPath.split('/').pop() ?? '';
      if (seenPaths.has(relPath) || ComponentMapper.EXCLUDED_DIRS.has(dirName) || relPath === '.') continue;
      // Verify it has source files
      const hasSourceFiles = allFiles.some(f => {
        const fRel = f.path.slice(basePath.length + 1);
        if (!fRel.startsWith(relPath + '/')) return false;
        const ext = fRel.split('.').pop()?.toLowerCase() ?? '';
        return SOURCE_EXTENSIONS.has(ext);
      });
      if (!hasSourceFiles) continue;
      seenPaths.add(relPath);
      components.push({
        name: dirName,
        path: relPath,
        language: await this.detectDirLanguage(relPattern, relPath),
        type: this.classifyDirType(dirName, relPath),
      });
    }

    // 9. Set parent-child relationships based on path nesting
    for (const comp of components) {
      let bestParent: ComponentInfo | undefined;
      let bestParentDepth = 0;
      for (const other of components) {
        if (other.path === comp.path) continue;
        if (comp.path.startsWith(other.path + '/')) {
          const depth = other.path.split('/').length;
          if (depth > bestParentDepth) {
            bestParent = other;
            bestParentDepth = depth;
          }
        }
      }
      if (bestParent) {
        comp.parentPath = bestParent.path;
        if (!bestParent.children) bestParent.children = [];
        bestParent.children.push(comp.path);
      }
    }

    return components;
  }

  /** Get direct child directory names under a given parent path */
  private getDirectChildren(files: vscode.Uri[], basePath: string, parentDir: string): string[] {
    const children = new Set<string>();
    const prefix = `${parentDir}/`;
    for (const f of files) {
      const rel = f.path.slice(basePath.length + 1);
      if (!rel.startsWith(prefix)) continue;
      const rest = rel.slice(prefix.length);
      const slashIdx = rest.indexOf('/');
      if (slashIdx > 0) {
        children.add(rest.slice(0, slashIdx));
      }
    }
    return [...children];
  }

  /** Classify directory type based on name and path conventions */
  private classifyDirType(dirName: string, dirPath: string): ComponentInfo['type'] {
    const lower = dirName.toLowerCase();
    const pathLower = dirPath.toLowerCase();

    if (['infrastructure', 'infra', 'deploy', 'deployment', 'terraform', 'bicep', 'cdk'].includes(lower)) return 'infra';
    if (['scripts', 'tools', 'ci', 'misc', 'utils', 'utilities'].includes(lower)) return 'script';
    if (['lib', 'libs', 'packages', 'shared', 'common', 'core'].includes(lower)) return 'library';
    if (['apps', 'services', 'workers', 'lambdas', 'functions'].includes(lower)) return 'service';
    if (['data', 'datasets', 'fixtures', 'samples'].includes(lower)) return 'data';
    if (['config', 'configs', 'configuration'].includes(lower)) return 'config';
    if (pathLower.includes('infra') || pathLower.includes('deploy') || pathLower.includes('terraform')) return 'infra';
    if (pathLower.includes('script') || pathLower.includes('ci/')) return 'script';

    return 'app';
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private classifyJSComponent(pkg: any): ComponentInfo['type'] {
    if (pkg.bin) return 'app';
    if (pkg.main || pkg.exports || pkg.module) return 'library';
    if (pkg.scripts?.start) return 'app';
    return 'unknown';
  }

  /** Detect primary language of a directory by checking for language markers and file extensions */
  private async detectDirLanguage(
    relPattern: (glob: string) => vscode.RelativePattern,
    dirPath: string,
  ): Promise<string> {
    // Check for language-specific markers first
    const langChecks: [string, string[]][] = [
      ['TypeScript', ['tsconfig.json']],
      ['Python', ['pyproject.toml', 'setup.py', 'requirements.txt']],
      ['Go', ['go.mod']],
      ['Rust', ['Cargo.toml']],
      ['C#', ['*.csproj', '*.sln']],
      ['Java', ['pom.xml', 'build.gradle']],
    ];

    for (const [lang, markers] of langChecks) {
      for (const marker of markers) {
        const found = await vscode.workspace.findFiles(
          relPattern(`${dirPath}/${marker}`),
          EXCLUDE_GLOB,
          1,
        );
        if (found.length > 0) return lang;
      }
    }

    // Fall back to file extension counts
    const extChecks: [string, string][] = [
      ['TypeScript', '**/*.{ts,tsx}'],
      ['Python', '**/*.py'],
      ['JavaScript', '**/*.{js,jsx}'],
      ['Go', '**/*.go'],
      ['Rust', '**/*.rs'],
      ['C#', '**/*.cs'],
      ['Java', '**/*.java'],
      ['KQL', '**/*.{kql,csl}'],
      ['Bicep', '**/*.bicep'],
      ['C++', '**/*.{cpp,hpp,cc,cxx}'],
      ['C', '**/*.{c,h}'],
    ];

    for (const [lang, extGlob] of extChecks) {
      const found = await vscode.workspace.findFiles(
        relPattern(`${dirPath}/${extGlob}`),
        EXCLUDE_GLOB,
        1,
      );
      if (found.length > 0) return lang;
    }

    return 'unknown';
  }


  // ── Deterministic Component Discovery + LLM Business Domain Naming ──

  private async deepMapComponents(
    workspaceUri: vscode.Uri,
    context: ProjectContext,
    token?: vscode.CancellationToken,
    semanticData?: { path: string; summary: string; dependencies: string[]; exports: string[]; complexity: string }[],
  ): Promise<ComponentInfo[]> {

    // ═══════════════════════════════════════════════════════════
    // PHASE 1: Deterministic discovery — find ALL manifest dirs
    // ═══════════════════════════════════════════════════════════
    logger.info('Deep map [deterministic]: scanning all manifest directories...');
    const discoveryTimer = logger.time('Deep map: deterministic discovery');

    const MANIFEST_NAMES = new Set(['pyproject.toml', 'package.json', 'Cargo.toml', 'go.mod']);
    const CSPROJ_RE = /\.(csproj|tproj)$/;
    const CONFIG_DIRS = new Set(['.vscode', 'vscode', '.devcontainer', '.dev-setup', '.clinerules',
      '.github', 'memory-bank', '.roo', '.config', '.azuredevops', '.idea']);
    const INFRA_DIRS = new Set(['deploy', 'infrastructure', '.release', '.release-fpa',
      '.release-manifestRollout', 'ci', '.pipelines', '.build', 'ev2']);
    const EXCLUDE = new Set([...ComponentMapper.EXCLUDED_DIRS, 'obj', 'bin']);

    // Walk workspace and find all dirs with manifests
    const manifestDirs = new Map<string, { manifests: string[]; hasReadme: boolean }>();
    const allFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceUri, '**/*'),
      '{**/node_modules/**,**/.git/**,**/obj/**,**/bin/**,**/.venv/**,**/venv/**,**/__pycache__/**,**/target/**,**/dist/**}',
      10000
    );

    for (const file of allFiles) {
      const rel = vscode.workspace.asRelativePath(file, false);
      const fileName = rel.split('/').pop() || '';
      const dirPath = rel.includes('/') ? rel.substring(0, rel.lastIndexOf('/')) : '.';
      if (dirPath === '.') continue;

      // Check if any part of path is excluded
      if (dirPath.split('/').some(p => EXCLUDE.has(p))) continue;

      const existing = manifestDirs.get(dirPath) || { manifests: [], hasReadme: false };

      if (MANIFEST_NAMES.has(fileName)) {
        existing.manifests.push(fileName);
        manifestDirs.set(dirPath, existing);
      } else if (CSPROJ_RE.test(fileName)) {
        existing.manifests.push('csproj');
        manifestDirs.set(dirPath, existing);
      } else if (fileName === 'README.md') {
        existing.hasReadme = true;
        manifestDirs.set(dirPath, existing);
      }
    }

    // Also ensure important top-level dirs are included even without manifests
    try {
      const topDirs = await vscode.workspace.fs.readDirectory(workspaceUri);
      for (const [name, type] of topDirs) {
        if (type !== vscode.FileType.Directory) continue;
        if (EXCLUDE.has(name) || name === '.') continue;
        if (!manifestDirs.has(name)) {
          // Check if it has any source files
          const sourceFiles = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspaceUri, `${name}/**/*.{py,cs,ts,js,kql,bicep,ps1}`),
            '{**/node_modules/**,**/.git/**,**/obj/**,**/bin/**,**/.venv/**}', 1
          );
          if (sourceFiles.length > 0 || CONFIG_DIRS.has(name) || INFRA_DIRS.has(name)) {
            manifestDirs.set(name, { manifests: [], hasReadme: false });
          }
        }
      }
    } catch { /* skip */ }

    // Build components from manifest dirs
    const components: ComponentInfo[] = [];
    const sortedDirs = [...manifestDirs.keys()].sort();

    for (const dirPath of sortedDirs) {
      const info = manifestDirs.get(dirPath)!;
      const name = dirPath.split('/').pop() || dirPath;
      const parts = dirPath.split('/');

      // Detect language from semantic data or file extension
      let language = 'Multi';
      const matchingSemantic = (semanticData || []).filter(s => s.path.startsWith(dirPath + '/'));
      if (matchingSemantic.length > 0) {
        language = matchingSemantic[0].path.endsWith('.py') ? 'Python' :
                   matchingSemantic[0].path.endsWith('.cs') ? 'C#' :
                   matchingSemantic[0].path.endsWith('.ts') ? 'TypeScript' : 'Multi';
      } else if (info.manifests.includes('pyproject.toml')) {
        language = 'Python';
      } else if (info.manifests.includes('csproj')) {
        language = 'C#';
      } else if (info.manifests.includes('package.json')) {
        language = 'TypeScript';
      }

      // Classify type
      let type: ComponentInfo['type'] = 'unknown';
      const pathLower = dirPath.toLowerCase();
      if (CONFIG_DIRS.has(parts[0]) || CONFIG_DIRS.has(name)) type = 'config';
      else if (parts.some(p => INFRA_DIRS.has(p))) type = 'infra';
      else if (parts.includes('apps') || parts.includes('app')) type = 'app';
      else if (parts.includes('test') || parts.includes('tests') || name.endsWith('.Tests') || name.endsWith('Tests')) type = 'app';
      else if (parts.includes('components') || parts.includes('common') || parts.includes('lib')) type = 'library';
      else if (pathLower.includes('script')) type = 'script';
      else if (info.manifests.includes('csproj') || info.manifests.includes('pyproject.toml')) type = 'library';
      else type = 'unknown';

      // Find parent
      let parentPath: string | undefined;
      for (let i = parts.length - 1; i > 0; i--) {
        const candidate = parts.slice(0, i).join('/');
        if (manifestDirs.has(candidate)) {
          parentPath = candidate;
          break;
        }
      }

      // Check generated
      const isGenerated = this.detectGenerated(dirPath, name, language, '');

      // Build description from semantic data — aggregate file summaries
      let description = '';
      if (matchingSemantic.length > 0) {
        const summaries = matchingSemantic.filter(s => s.summary && s.summary.length > 10).map(s => s.summary);
        const allExports = [...new Set(matchingSemantic.flatMap(s => s.exports))];
        const allDeps = [...new Set(matchingSemantic.flatMap(s => s.dependencies))];
        
        if (summaries.length > 0) {
          // Use most detailed summary (longest) as component description
          description = summaries.sort((a, b) => b.length - a.length)[0];
        }
        // Enrich: if we know exports and deps, append key info
        if (allExports.length > 0 && !description) {
          description = `Exports: ${allExports.slice(0, 5).join(', ')}`;
        }
      }

      components.push({
        name,
        path: dirPath,
        language,
        type,
        description,
        parentPath,
        children: [],
        isGenerated,
      });
    }

    // Fill children arrays
    for (const comp of components) {
      comp.children = components.filter(c => c.parentPath === comp.path).map(c => c.path);
    }

    // Create virtual parents for orphan components sharing a directory
    // e.g., detection/adf + detection/infra → create detection/ parent
    const orphans = components.filter(c => !c.parentPath);
    const orphanParents = new Map<string, ComponentInfo[]>();
    for (const o of orphans) {
      const parts = o.path.split('/');
      if (parts.length >= 2) {
        const parentDir = parts[0];
        if (!orphanParents.has(parentDir)) orphanParents.set(parentDir, []);
        orphanParents.get(parentDir)!.push(o);
      }
    }
    for (const [parentDir, children] of orphanParents) {
      if (children.length < 2) continue;
      if (components.some(c => c.path === parentDir)) continue; // already exists
      
      // Create virtual parent
      const parentLang = children[0].language;
      const parentType = children.some(c => c.type === 'infra') ? 'infra' : children[0].type;
      components.push({
        name: parentDir,
        path: parentDir,
        language: parentLang,
        type: parentType,
        description: `Contains ${children.length} sub-components`,
        children: children.map(c => c.path),
      });
      for (const c of children) {
        c.parentPath = parentDir;
      }
      logger.info(`Deep map: created virtual parent '${parentDir}/' for ${children.length} orphan children`);
    }

    // Also add standalone top-level dirs that have source files but no manifest
    try {
      const topDirs = await vscode.workspace.fs.readDirectory(workspaceUri);
      for (const [dirName, type] of topDirs) {
        if (type !== vscode.FileType.Directory) continue;
        if (EXCLUDE.has(dirName) || dirName.startsWith('.')) continue;
        if (components.some(c => c.path === dirName)) continue;
        
        const dirUri = vscode.Uri.joinPath(workspaceUri, dirName);
        const hasFiles = await vscode.workspace.findFiles(
          new vscode.RelativePattern(dirUri, '**/*.{py,ipynb,cs,ts,js,kql,bicep,ps1,sh,md}'),
          '{**/node_modules/**,**/.git/**,**/obj/**,**/bin/**,**/.venv/**}', 1
        );
        if (hasFiles.length > 0) {
          components.push({
            name: dirName,
            path: dirName,
            language: 'Multi',
            type: 'unknown',
            description: '',
            children: [],
          });
        }
      }
    } catch { /* skip */ }

    discoveryTimer?.end?.();
    logger.info(`Deep map [deterministic]: ${components.length} components discovered (${manifestDirs.size} manifest dirs)`);

    // ═══════════════════════════════════════════════════════════
    // PHASE 1b: Sub-group large parents by directory structure
    // ═══════════════════════════════════════════════════════════
    // If a parent has many direct children (e.g., src/common/ with 44 sub-projects),
    // group them by their intermediate directory (e.g., Hosting/, Storage/, Diagnostics/)
    const largeParents = components.filter(c => {
      const childCount = components.filter(x => x.parentPath === c.path).length;
      return childCount > 8; // only group if parent has many children
    });

    for (const parent of largeParents) {
      const children = components.filter(c => c.parentPath === parent.path);

      // Find natural sub-groups by common prefix in child paths
      // e.g., under src/common/: Hosting, Hosting.Tests, Hosting.Web → group "Hosting"
      const subGroups = new Map<string, ComponentInfo[]>();
      for (const child of children) {
        const relPath = child.path.slice(parent.path.length + 1); // relative to parent
        const prefix = relPath.split('/')[0].split('.')[0]; // first dir or project prefix before dot
        if (!prefix) continue;
        if (!subGroups.has(prefix)) subGroups.set(prefix, []);
        subGroups.get(prefix)!.push(child);
      }

      // Create sub-group nodes for prefixes with 2+ members
      for (const [prefix, members] of subGroups) {
        if (members.length < 2) continue;

        const groupPath = `${parent.path}/.group-${prefix}`;
        const groupLang = members[0].language;
        const groupType = members.some(m => m.type === 'app') ? 'app' : members[0].type;

        components.push({
          name: prefix,
          path: groupPath,
          language: groupLang,
          type: groupType,
          description: `${prefix} group (${members.length} projects)`,
          parentPath: parent.path,
          children: members.map(m => m.path),
        });

        // Reparent members under the group
        for (const m of members) {
          m.parentPath = groupPath;
        }
      }
    }

    // Refresh children arrays after sub-grouping
    for (const comp of components) {
      comp.children = components.filter(c => c.parentPath === comp.path).map(c => c.path);
    }

    // ═══════════════════════════════════════════════════════════
    // PHASE 2: LLM enrichment — rename, describe, reclassify
    // ═══════════════════════════════════════════════════════════
    if (this.copilotClient?.isAvailable() && components.length > 0) {
      logger.info('Deep map [LLM]: enriching component names and descriptions...');
      const namingTimer = logger.time('Deep map: LLM enrichment');

      // Select components needing enrichment: top-level + containers + those without descriptions
      const toEnrich = components.filter(c => {
        // Always enrich top-level and second-level
        if (!c.parentPath) return true;
        const parent = components.find(p => p.path === c.parentPath);
        if (parent && !parent.parentPath) return true;
        // Also enrich anything without a description
        if (!c.description) return true;
        return false;
      }).slice(0, 40);

      if (toEnrich.length > 0) {
        const compList = toEnrich.map(c => {
          const sem = (semanticData || []).filter(s => s.path.startsWith(c.path + '/'));
          const childCount = components.filter(x => x.parentPath === c.path).length;
          const imports = [...new Set(sem.flatMap(s => s.dependencies))].slice(0, 5);
          const exports = [...new Set(sem.flatMap(s => s.exports))].slice(0, 5);
          const summaries = sem.filter(s => s.summary).map(s => s.summary).slice(0, 2);
          return `- path: ${c.path} | name: ${c.name} | lang: ${c.language} | type: ${c.type} | children: ${childCount}${summaries.length ? `\n  file summaries: ${summaries.join('; ')}` : ''}${imports.length ? `\n  imports: ${imports.join(', ')}` : ''}${exports.length ? `\n  exports: ${exports.join(', ')}` : ''}${c.description ? `\n  current desc: ${c.description}` : ''}`;
        }).join('\n');

        try {
          const prompt = `You are enriching a component tree. For each component, provide:
1. A better display name (e.g., "src" → "Zero Trust Segmentation Services", "common" → "Platform Libraries")
2. A concise business-level description (one sentence)

Rules:
- Generic container names like "src", "common", "lib", "apps" should get meaningful business names
- Names should describe WHAT it does, not WHERE it is
- Descriptions should help a developer understand the business purpose
- Do NOT change names that are already meaningful (e.g., "auto_segmentation" is fine)

Components:
${compList}

Respond as JSON array: [{"path":"...","name":"Better Name","description":"one sentence business description"}]`;

          const response = await this.copilotClient!.analyzeFast(prompt);
          const match = response.match(/\[[\s\S]*\]/);
          if (match) {
            const enrichments = JSON.parse(match[0]) as { path: string; name?: string; description?: string }[];
            for (const e of enrichments) {
              const comp = components.find(c => c.path === e.path);
              if (comp) {
                if (e.name && e.name !== comp.name) comp.name = e.name;
                if (e.description) comp.description = e.description;
              }
            }
            logger.info(`Deep map [LLM]: enriched ${enrichments.length} components with names/descriptions`);
          }
        } catch (err) {
          logger.debug('Deep map [LLM]: enrichment failed, using defaults', { error: String(err) });
        }
      }
      namingTimer?.end?.();
    }

    // ═══════════════════════════════════════════════════════════
    // PHASE 3: Intelligent grouping — merge related dirs, create logical groups
    // ═══════════════════════════════════════════════════════════
    logger.info('Deep map [grouping]: creating logical domain groups...');

    // Helper to create a virtual group and reparent components
    const createGroup = (name: string, path: string, type: ComponentInfo['type'], description: string, memberPaths: string[]) => {
      if (memberPaths.length === 0) return;
      const group: ComponentInfo = { name, path, language: 'Multi', type, description, children: memberPaths };
      components.push(group);
      for (const c of components) {
        if (memberPaths.includes(c.path) && !c.parentPath) c.parentPath = path;
      }
    };

    // 3a. Group config dotfiles → "Developer Configuration"
    const configPaths = components.filter(c => c.type === 'config' && !c.parentPath).map(c => c.path);
    if (configPaths.length > 1) {
      createGroup('Developer Configuration', '.devconfig', 'config',
        'IDE settings, AI assistant rules, editor configuration, and repository metadata', configPaths);
    }

    // 3b. Group infra dirs → "Infrastructure & DevOps"
    const infraPaths = components.filter(c => c.type === 'infra' && !c.parentPath).map(c => c.path);
    if (infraPaths.length > 1) {
      createGroup('Infrastructure & DevOps', '.infrastructure', 'infra',
        'CI/CD pipelines, deployment, release management, and infrastructure-as-code', infraPaths);
    }

    // 3c. Group test projects → "Testing"
    const testPaths = components.filter(c =>
      !c.parentPath && (c.name.endsWith('.Tests') || c.name.endsWith('Tests') || c.name.startsWith('test') ||
        c.path.includes('.Tests/') || c.path.includes('/test/') || c.path.includes('/E2E/'))
    ).map(c => c.path);
    if (testPaths.length > 2) {
      createGroup('Testing', '.testing', 'app',
        'Unit tests, integration tests, E2E tests, and test utilities', testPaths);
    }

    // 3d. Group scripts → under Infrastructure if they exist standalone
    const scriptPaths = components.filter(c => c.type === 'script' && !c.parentPath).map(c => c.path);
    if (scriptPaths.length > 0) {
      const infraGroup = components.find(c => c.path === '.infrastructure');
      if (infraGroup) {
        for (const c of components) {
          if (scriptPaths.includes(c.path) && !c.parentPath) {
            c.parentPath = '.infrastructure';
            infraGroup.children = infraGroup.children || [];
            infraGroup.children.push(c.path);
          }
        }
      }
    }

    // 3e. Remove noise — standalone dotfiles, single-file components at root
    const NOISE_PATTERNS = [/^\.gitattributes$/, /^\.gitmodules$/, /^\.gitignore$/, /^\.editorconfig$/, /^\.npmrc$/, /^\.eslintrc/];
    const filtered = components.filter(c => !NOISE_PATTERNS.some(p => p.test(c.path)));

    // 3f. Generate descriptions for containers
    for (const c of filtered) {
      if (!c.description || c.description === `${c.language} ${c.type}`) {
        const childCount = filtered.filter(x => x.parentPath === c.path).length;
        if (childCount > 0) {
          c.description = `Contains ${childCount} sub-components`;
        }
      }
    }

    const topLevel = filtered.filter(c => !c.parentPath);
    logger.info(`Deep map: COMPLETE — ${filtered.length} components (${topLevel.length} top-level groups)`);
    return filtered;
  }

  private flattenComponents(components: unknown[], parentPath?: string): ComponentInfo[] {
    const result: ComponentInfo[] = [];

    for (const raw of components) {
      const comp = raw as Record<string, unknown>;
      const compPath = String(comp.path || '');
      if (!compPath) continue;

      const component: ComponentInfo = {
        name: String(comp.name || compPath.split('/').pop() || ''),
        path: compPath,
        language: String(comp.language || 'unknown'),
        type: this.normalizeType(comp.type),
        description: String(comp.description || ''),
        parentPath: parentPath,
        children: [],
        isGenerated: this.detectGenerated(compPath, String(comp.name || ''), String(comp.language || ''), String(comp.description || '')),
      };

      // Recursively flatten subComponents
      if (Array.isArray(comp.subComponents) && comp.subComponents.length > 0) {
        const childResults = this.flattenComponents(comp.subComponents, compPath);
        component.children = childResults.map(c => c.path);
        result.push(...childResults);
      }

      result.push(component);
    }

    // Deduplicate by path and filter excluded directories
    const seen = new Set<string>();
    return result.filter(c => {
      if (!c.path || seen.has(c.path)) { return false; }
      seen.add(c.path);
      // Filter out excluded directories that LLM may have included
      const topDir = c.path.split('/')[0]?.toLowerCase() || '';
      if (ComponentMapper.EXCLUDED_DIRS.has(topDir) || ComponentMapper.EXCLUDED_DIRS.has(c.path.toLowerCase())) return false;
      return true;
    });
  }

  private normalizeType(type: unknown): ComponentInfo['type'] {
    const valid: ComponentInfo['type'][] = ['app', 'library', 'service', 'script', 'config', 'infra', 'data', 'unknown'];
    const str = String(type || '').toLowerCase();
    return valid.includes(str as ComponentInfo['type']) ? str as ComponentInfo['type'] : 'unknown';
  }

  /** Detect if a component contains generated/exported/backup code */
  private detectGenerated(path: string, name: string, language: string, description: string): boolean {
    const pathLower = path.toLowerCase();
    const nameLower = name.toLowerCase();
    const descLower = description.toLowerCase();

    // Directory name patterns for clearly generated/exported code
    const GENERATED_DIR_PATTERNS = [
      /\bgenerated\b/i, /\bcompiled\b/i,
      /\bauto[-_]?gen/i, /\bstubs?\b/i, /\b_pb2/i, /\bproto[-_]?gen/i,
    ];
    if (GENERATED_DIR_PATTERNS.some(p => p.test(pathLower) || p.test(nameLower))) return true;

    // Description must explicitly say "backup" or "exported" — not just path heuristics
    // This avoids false positives on authored KQL functions in directories like KustoFunctions/
    if (/\b(auto[-\s]?generated|machine[-\s]?generated)\b/i.test(descLower)) return true;
    if (/\bbackup cop(y|ies)\b/i.test(descLower) || /\bexported?\s+(from|copy|copies|backup)\b/i.test(descLower)) return true;

    return false;
  }

  private async findComponentDescriptors(workspaceUri: vscode.Uri): Promise<FileContent[]> {
    const files: FileContent[] = [];
    const exclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.venv/**,**/target/**}';

    const patterns = [
      '*/README.md', '*/*/README.md',
      '*/pyproject.toml', '*/*/pyproject.toml',
      '*/package.json', '*/*/package.json',
      '*/Cargo.toml', '*/go.mod',
    ];

    for (const pattern of patterns) {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(workspaceUri, pattern), exclude, 20
      );
      for (const uri of uris) {
        try {
          const raw = await vscode.workspace.fs.readFile(uri);
          const content = Buffer.from(raw).toString('utf-8');
          files.push({
            path: uri.fsPath,
            content: content.split('\n').slice(0, 50).join('\n'),
            relativePath: vscode.workspace.asRelativePath(uri),
          });
        } catch (err) {
          logger.warn('Failed to read component descriptor file', { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    return files;
  }

  private async buildDeepTree(workspaceUri: vscode.Uri, maxDepth: number = 4): Promise<string> {
    const allFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceUri, '**/*'),
      EXCLUDE_GLOB,
      5000,
    );
    const basePath = workspaceUri.path;
    const relativePaths = allFiles
      .map(f => f.path.slice(basePath.length + 1))
      .filter(p => {
        const depth = p.split('/').length;
        return depth <= maxDepth;
      })
      .sort();

    const tree: string[] = [];
    const seen = new Set<string>();
    for (const p of relativePaths) {
      const parts = p.split('/');
      for (let i = 0; i < parts.length - 1; i++) {
        const dirPath = parts.slice(0, i + 1).join('/');
        if (!seen.has(dirPath)) {
          seen.add(dirPath);
          tree.push(`${'  '.repeat(i)}${parts[i]}/`);
        }
      }
    }
    if (tree.length > MAX_DEEP_TREE_LINES) {
      return tree.slice(0, MAX_DEEP_TREE_LINES).join('\n') + '\n... (truncated)';
    }
    return tree.join('\n');
  }

  // ── File reading helpers ────────────────────────────────────────────

  private async readText(uri: vscode.Uri): Promise<string | null> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(bytes).toString('utf-8');
    } catch (err) {
      logger.warn('Failed to read text file', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async readJson(uri: vscode.Uri): Promise<any | null> {
    const text = await this.readText(uri);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (err) {
      logger.warn('Failed to parse JSON file', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private async readRootJson(
    relPattern: (glob: string) => vscode.RelativePattern,
    filename: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any | null> {
    const files = await vscode.workspace.findFiles(relPattern(filename), EXCLUDE_GLOB, 1);
    if (files.length === 0) return null;
    return this.readJson(files[0]);
  }

  /** Read and summarize .vscode/tasks.json for project context */
  private async readBuildTasks(workspaceUri: vscode.Uri): Promise<string | undefined> {
    try {
      const tasksUri = vscode.Uri.joinPath(workspaceUri, '.vscode/tasks.json');
      const bytes = await vscode.workspace.fs.readFile(tasksUri);
      let content = Buffer.from(bytes).toString('utf-8');
      // Strip JSON comments and trailing commas (tasks.json is JSONC)
      content = content
        .replace(/\/\/.*$/gm, '')           // line comments
        .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
        .replace(/,(\s*[}\]])/g, '$1');     // trailing commas
      const parsed = JSON.parse(content);
      if (!parsed?.tasks || !Array.isArray(parsed.tasks)) return undefined;

      const summary = parsed.tasks.map((t: any) => {
        const label = t.label || 'unnamed';
        const cmd = t.command || '';
        const args = Array.isArray(t.args) ? t.args.join(' ') : '';
        const type = t.type || '';
        return `- ${label}: ${type ? `[${type}] ` : ''}${cmd} ${args}`.trim();
      }).join('\n');

      return summary || undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ENOENT')) {
        logger.debug('No .vscode/tasks.json found (optional)');
      } else {
        logger.warn(`Failed to parse .vscode/tasks.json (JSONC?)`, { error: msg });
      }
      return undefined;
    }
  }
}

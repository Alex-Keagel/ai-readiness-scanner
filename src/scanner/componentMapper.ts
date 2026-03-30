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

  async mapWorkspace(workspaceUri: vscode.Uri, deep: boolean = false, token?: vscode.CancellationToken): Promise<ProjectContext> {
    const context = await this.detectBasics(workspaceUri);

    if (deep && this.copilotClient?.isAvailable()) {
      logger.info(`Deep mapping ${context.components.length} components via LLM...`);
      const deepTimer = logger.time('Phase 2c: LLM deep component mapping');
      context.components = await this.deepMapComponents(workspaceUri, context, token);
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
    const relativePaths = files
      .map(f => f.path.slice(basePath.length + 1))
      .filter(p => {
        const depth = p.split('/').length;
        return depth <= 4;  // Show 4 levels deep for complete picture
      })
      .sort();

    const tree = this.formatAsTree(relativePaths);
    if (tree.length > MAX_TREE_LINES) {
      return tree.slice(0, MAX_TREE_LINES).join('\n') + '\n... (truncated)';
    }
    return tree.join('\n');
  }

  private formatAsTree(paths: string[]): string[] {
    const lines: string[] = [];
    const seen = new Set<string>();

    for (const p of paths) {
      const parts = p.split('/');
      // Show directory hierarchy with proper indentation
      for (let i = 0; i < parts.length - 1; i++) {
        const dirPath = parts.slice(0, i + 1).join('/');
        if (!seen.has(dirPath)) {
          seen.add(dirPath);
          lines.push(`${'  '.repeat(i)}${parts[i]}/`);
        }
      }
      // Show the file at proper depth
      const indent = '  '.repeat(Math.max(0, parts.length - 1));
      lines.push(`${indent}${parts[parts.length - 1]}`);
    }
    return lines;
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

  // ── LLM deep component mapping ──────────────────────────────────────

  // ── Multi-Agent Component Mapping Pipeline ──────────────────────

  private async deepMapComponents(
    workspaceUri: vscode.Uri,
    context: ProjectContext,
    token?: vscode.CancellationToken
  ): Promise<ComponentInfo[]> {
    const tree = context.directoryTree || '';
    
    // Find component descriptors
    const descTimer = logger.time('Deep map: descriptor discovery');
    const exclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.venv/**,**/target/**}';
    const descPatterns = [
      '*/README.md', '*/*/README.md', '*/*/*/README.md',
      '*/pyproject.toml', '*/*/pyproject.toml', '*/*/*/pyproject.toml',
      '*/package.json', '*/*/package.json',
      '*/*.csproj', '*/*/*.csproj',
      '*/Cargo.toml', '*/go.mod',
    ];
    const allDescUris = await Promise.all(descPatterns.map(p => vscode.workspace.findFiles(new vscode.RelativePattern(workspaceUri, p), exclude, 20)));
    const descriptorFiles = (await Promise.all(
      allDescUris.flat().slice(0, 30).map(async uri => {
        try {
          const raw = await vscode.workspace.fs.readFile(uri);
          return { content: Buffer.from(raw).toString('utf-8').split('\n').slice(0, 30).join('\n'), relativePath: vscode.workspace.asRelativePath(uri) };
        } catch { return null; }
      })
    )).filter((f): f is NonNullable<typeof f> => f !== null);
    descTimer?.end?.();

    const treeLines = tree.split('\n');
    const truncatedTree = treeLines.length > 400 ? treeLines.slice(0, 400).join('\n') + '\n...' : tree;
    const descriptorContext = descriptorFiles.slice(0, 15).map(f => `### ${f.relativePath}\n\`\`\`\n${f.content.slice(0, 500)}\n\`\`\``).join('\n\n');
    const originalPaths = new Set(context.components.map(c => c.path));

    // Discover deeper project paths (C# .csproj, Python pyproject.toml at 3+ levels)
    try {
      const deepProjects = await Promise.all([
        vscode.workspace.findFiles(new vscode.RelativePattern(workspaceUri, '{*/*/*.csproj,*/*/*/*.csproj}'), exclude, 40),
        vscode.workspace.findFiles(new vscode.RelativePattern(workspaceUri, '{*/*/*/pyproject.toml,*/*/*/*/pyproject.toml}'), exclude, 15),
      ]);
      for (const f of deepProjects.flat()) {
        const dir = vscode.workspace.asRelativePath(f, false).replace(/\/[^/]+\.(csproj|toml)$/, '');
        if (dir && !originalPaths.has(dir)) originalPaths.add(dir);
      }
      logger.info(`Deep map: ${originalPaths.size} known paths (including deep .csproj/.toml discovery)`);
    } catch { /* non-critical */ }

    const knownPathsList = [...originalPaths].slice(0, 60).join('\n');

    // ═══════════════════════════════════════════════════════════════
    // AGENT 1: Structure Analyst — flat list of all micro-components
    // ═══════════════════════════════════════════════════════════════
    logger.info('Deep map [Agent 1/3]: Structure Analyst — mapping all directories...');
    const agent1Prompt = `You are a **Structure Analyst** expert agent. Map EVERY directory to a typed component. Output a FLAT list — no grouping.

DIRECTORY STRUCTURE:
${truncatedTree}

DESCRIPTORS:
${descriptorContext}

LANGUAGES: ${context.languages.join(', ')}

RULES:
- ONE component per meaningful directory or standalone config file.
- EVERY path from the KNOWN PATHS list MUST appear in your output.
- Include CI/CD pipelines, release definitions, dev containers, dashboards, security configs, AI rules.
- Do NOT group or nest — output a flat array.
- Do NOT skip operational infrastructure.

KNOWN PATHS (ALL must appear):
${knownPathsList}

Respond as JSON: {"components":[{"name":"...","path":"...","language":"...","type":"app|library|service|script|config|infra|data","description":"one sentence"}]}`;

    let microComponents: ComponentInfo[] = [];
    try {
      const r = await this.copilotClient!.analyze(agent1Prompt, token, 90_000);
      const m = r.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        if (Array.isArray(parsed.components)) microComponents = this.flattenComponents(parsed.components);
      }
    } catch (err) { logger.warn('Deep map [Agent 1] failed', { error: String(err) }); }

    // Programmatic orphan injection — never trust the LLM to cover 100%
    const agent1Paths = new Set(microComponents.map(c => c.path));
    const orphans1 = context.components.filter(c =>
      !agent1Paths.has(c.path) && !microComponents.some(mc => c.path.startsWith(mc.path + '/') || mc.path.startsWith(c.path + '/'))
    );
    if (orphans1.length > 0) {
      logger.info(`Deep map [Agent 1]: injecting ${orphans1.length} missed paths`);
      microComponents.push(...orphans1);
    }
    logger.info(`Deep map [Agent 1]: ${microComponents.length} micro-components`);

    if (microComponents.length === 0) return context.components;

    // ═══════════════════════════════════════════════════════════════
    // AGENT 2: Domain Architect — groups into business + technical domains
    // ═══════════════════════════════════════════════════════════════
    logger.info('Deep map [Agent 2/3]: Domain Architect — grouping into domains...');

    // Group micro-components by top-level directory for batching
    const dirGroups = new Map<string, ComponentInfo[]>();
    for (const c of microComponents) {
      const topDir = c.path.split('/')[0] || c.path;
      if (!dirGroups.has(topDir)) dirGroups.set(topDir, []);
      dirGroups.get(topDir)!.push(c);
    }

    let domainComponents: ComponentInfo[] = [];

    if (microComponents.length > 40) {
      // ── PARALLEL BATCHED GROUPING for large repos ──
      // Split into batches of ~15-20 components, run in parallel, then merge
      const batches: ComponentInfo[][] = [];
      let currentBatch: ComponentInfo[] = [];
      for (const [, items] of dirGroups) {
        if (currentBatch.length + items.length > 20 && currentBatch.length > 0) {
          batches.push(currentBatch);
          currentBatch = [];
        }
        currentBatch.push(...items);
      }
      if (currentBatch.length > 0) batches.push(currentBatch);

      logger.info(`Deep map [Agent 2]: splitting ${microComponents.length} components into ${batches.length} parallel batches`);

      const batchPromises = batches.map(async (batch, idx) => {
        const batchList = batch.map(c => `- ${c.path} | ${c.name} | ${c.language} | ${c.type}`).join('\n');
        const batchPrompt = `You are a **Domain Architect**. Group these ${batch.length} components into 2-5 business or technical domains.

COMPONENTS (batch ${idx + 1}/${batches.length}):
${batchList}

Create domains like: "Data Processing", "Resource Provider", "Shared Libraries", "Infrastructure", "Testing", "Developer Experience", "Security", "Monitoring".

RULES:
- EVERY component MUST appear as a subComponent of exactly ONE domain.
- Do NOT merge components that serve different functions.
- subComponents can have their own subComponents (2 levels max).

Respond as JSON: {"components":[{"name":"Domain","path":"primary-path","language":"Multi","type":"service","description":"...","subComponents":[...]}]}`;

        try {
          const r = await this.copilotClient!.analyzeFast(batchPrompt);
          const m = r.match(/\{[\s\S]*\}/);
          if (m) {
            const parsed = JSON.parse(m[0]);
            if (Array.isArray(parsed.components)) return this.flattenComponents(parsed.components);
          }
        } catch (err) { logger.debug(`Deep map [Agent 2] batch ${idx} failed`, { error: String(err) }); }
        return batch; // fallback: return flat
      });

      const batchResults = await Promise.all(batchPromises);
      domainComponents = batchResults.flat();
      logger.info(`Deep map [Agent 2]: ${domainComponents.length} components from ${batches.length} parallel batches`);

    } else {
      // ── SINGLE CALL for smaller repos ──
      const microList = microComponents.map(c => `- ${c.path} | ${c.name} | ${c.language} | ${c.type}`).join('\n');
      const minDomains = Math.max(5, Math.min(10, Math.ceil(microComponents.length / 8)));

      const agent2Prompt = `You are a **Domain Architect** expert agent. Organize these ${microComponents.length} micro-components into a hierarchical domain structure.

MICRO-COMPONENTS:
${microList}

MANDATORY TOP-LEVEL DOMAINS — create AT LEAST ${minDomains} groups:
1. **[Business Domains]** — 2-4 based on business purpose
2. **Core Infrastructure** — CI/CD, deployment, releases, IaC
3. **Developer Experience** — dev containers, IDE settings, AI rules
4. **Shared Libraries** — common modules, utility packages
5. **Security & Compliance** — credential scan, policy checks
6. **Monitoring & Observability** — dashboards, alerts (if present)

RULES:
- EVERY micro-component MUST appear as a subComponent of exactly ONE domain.
- Do NOT merge components that serve different functions.
- subComponents can have their own subComponents (3 levels max).
- Cross-directory grouping allowed.

Respond as JSON:
{"components":[{"name":"Domain Name","path":"primary-path","language":"Multi","type":"service","description":"...","subComponents":[...]}]}`;

      try {
        const r = await this.copilotClient!.analyze(agent2Prompt, token, 90_000);
        const m = r.match(/\{[\s\S]*\}/);
        if (m) {
          const parsed = JSON.parse(m[0]);
          if (Array.isArray(parsed.components)) domainComponents = this.flattenComponents(parsed.components);
        }
      } catch (err) {
        logger.warn('Deep map [Agent 2] failed, using flat structure', { error: String(err) });
        return microComponents;
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // AGENT 3: Completeness Validator — checks, corrects, self-heals
    // ═══════════════════════════════════════════════════════════════
    logger.info('Deep map [Agent 3/3]: Completeness Validator — checking for gaps...');
    const domainPaths = new Set(domainComponents.map(c => c.path));
    const microPaths = new Set(microComponents.map(c => c.path));
    const droppedPaths = [...microPaths].filter(p =>
      !domainPaths.has(p) && !domainComponents.some(dc => p.startsWith(dc.path + '/') || dc.path.startsWith(p + '/'))
    );

    if (droppedPaths.length > 0) {
      logger.info(`Deep map [Agent 3]: ${droppedPaths.length} paths dropped, running validator...`);

      const agent3Prompt = `You are a **Completeness Validator** agent. The Domain Architect dropped ${droppedPaths.length} components. Classify each into the best existing domain.

DROPPED:
${droppedPaths.map(p => {
  const mc = microComponents.find(c => c.path === p);
  return `- ${p} | ${mc?.name || p} | ${mc?.type || '?'}`;
}).join('\n')}

EXISTING DOMAINS:
${domainComponents.filter(c => !c.parentPath).map(c => `- ${c.name}`).join('\n')}

Respond as JSON: [{"path":"...","assignTo":"Domain Name","name":"descriptive name"}]`;

      try {
        const r = await this.copilotClient!.analyzeFast(agent3Prompt);
        const m = r.match(/\[[\s\S]*\]/);
        if (m) {
          const assignments = JSON.parse(m[0]) as { path: string; assignTo?: string; name?: string }[];
          for (const a of assignments) {
            const original = microComponents.find(c => c.path === a.path);
            if (original) {
              const parent = domainComponents.find(dc => dc.name === a.assignTo);
              domainComponents.push({
                ...original,
                name: a.name || original.name,
                parentPath: parent?.path,
              });
              if (parent) { if (!parent.children) parent.children = []; parent.children.push(a.path); }
            }
          }
        }
      } catch (err) { logger.debug('Deep map [Agent 3] LLM failed', { error: String(err) }); }

      // Final deterministic safety net
      const finalPaths = new Set(domainComponents.map(c => c.path));
      for (const p of droppedPaths) {
        if (!finalPaths.has(p)) {
          const mc = microComponents.find(c => c.path === p);
          if (mc) domainComponents.push(mc);
        }
      }
    }

    const coverage = Math.round((domainComponents.length / Math.max(1, microComponents.length)) * 100);
    logger.info(`Deep map: DONE — ${domainComponents.length} components, ${coverage}% coverage, ${droppedPaths.length} recovered`);
    return domainComponents;
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

    const tree = this.formatAsTree(relativePaths);
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

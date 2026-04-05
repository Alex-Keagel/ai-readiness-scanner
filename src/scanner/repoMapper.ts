import * as vscode from 'vscode';
import { isVirtualEnvPath } from './componentMapper';

export interface RepoNode {
  name: string;
  path: string;
  type: 'directory' | 'file';
  language?: string;
  category?: 'source' | 'test' | 'config' | 'docs' | 'agent-instructions' | 'ci-cd' | 'infra' | 'scripts' | 'data';
  children?: RepoNode[];
  fileCount?: number;
  lineCount?: number;
  importance: 'critical' | 'high' | 'medium' | 'low';
}

export interface RepoMap {
  root: RepoNode;
  stats: {
    totalFiles: number;
    totalDirs: number;
    languages: { name: string; fileCount: number; percentage: number }[];
    agentFiles: { path: string; type: string }[];
    testDirs: string[];
    docFiles: string[];
  };
}

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.cs',
  '.rb', '.swift', '.c', '.cpp', '.h', '.hpp', '.kql', '.csl', '.bicep',
]);

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript',
  '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.cs': 'C#',
  '.rb': 'Ruby', '.swift': 'Swift', '.c': 'C', '.cpp': 'C++', '.h': 'C',
  '.hpp': 'C++', '.kql': 'KQL', '.csl': 'KQL', '.bicep': 'Bicep',
};

const CONFIG_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.toml', '.ini', '.cfg']);

const DATA_EXTENSIONS = new Set(['.csv', '.sql', '.parquet', '.tsv']);

const AGENT_INSTRUCTION_PATTERNS = [
  /^\.clinerules\//,
  /^\.cursorrules$/,
  /^\.roomodes$/,
  /^AGENTS\.md$/i,
  /^CLAUDE\.md$/i,
  /^\.github\/copilot-instructions\.md$/,
  /^\.github\/instructions\//,
  /^\.github\/agents\//,
  /^memory-bank\//,
  /^\.copilot\//,
];

const CI_CD_PATTERNS = [
  /^\.github\/workflows\//,
  /^\.build\/pipelines\//,
  /^\.pipelines\//,
  /^\.release\//,
  /^\.azuredevops\//,
];

const INFRA_PATTERNS = [
  /^Dockerfile/i,
  /^docker-compose/i,
  /^\.devcontainer\//,
];

const TEST_DIR_PATTERNS = [
  /(?:^|\/)(?:test|tests|__tests__|spec|e2e)(?:\/|$)/i,
];

const EXCLUDE_PATTERN = '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/vendor/**,**/__pycache__/**,**/.venv/**,**/venv/**,**/target/**,**/coverage/**,**/.next/**,**/site-packages/**,**/.tox/**,**/env/**}';

export class RepoMapper {
  async mapRepository(workspaceUri: vscode.Uri): Promise<RepoMap> {
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceUri, '**/*'),
      new vscode.RelativePattern(workspaceUri, EXCLUDE_PATTERN),
    );

    const relativePaths = files
      .filter(f => !isVirtualEnvPath(f.path))
      .map(f => vscode.workspace.asRelativePath(f, false))
      .sort();

    const rootName = vscode.workspace.workspaceFolders?.[0]?.name || 'root';
    const root: RepoNode = {
      name: rootName,
      path: '',
      type: 'directory',
      children: [],
      fileCount: 0,
      importance: 'high',
    };

    const languageCounts = new Map<string, number>();
    const agentFiles: { path: string; type: string }[] = [];
    const testDirSet = new Set<string>();
    const docFiles: string[] = [];
    let totalDirs = 0;

    // Build tree from sorted paths
    for (const relPath of relativePaths) {
      const parts = relPath.split('/');
      let current = root;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isFile = i === parts.length - 1;
        const partialPath = parts.slice(0, i + 1).join('/');

        if (isFile) {
          const category = classifyFile(relPath);
          const ext = getExtension(part);
          const language = LANGUAGE_MAP[ext];

          if (language) {
            languageCounts.set(language, (languageCounts.get(language) || 0) + 1);
          }

          if (category === 'agent-instructions') {
            agentFiles.push({ path: relPath, type: getAgentFileType(relPath) });
          }

          if (category === 'test') {
            const testDir = parts.slice(0, Math.max(1, parts.length - 1)).join('/');
            testDirSet.add(testDir);
          }

          if (category === 'docs') {
            docFiles.push(relPath);
          }

          const fileNode: RepoNode = {
            name: part,
            path: partialPath,
            type: 'file',
            language,
            category,
            importance: getImportance(relPath, category),
          };

          current.children!.push(fileNode);
        } else {
          let dirNode = current.children!.find(
            c => c.type === 'directory' && c.name === part,
          );
          if (!dirNode) {
            dirNode = {
              name: part,
              path: partialPath,
              type: 'directory',
              children: [],
              fileCount: 0,
              importance: 'medium',
            };
            current.children!.push(dirNode);
            totalDirs++;
          }
          current = dirNode;
        }
      }
    }

    // Post-process: compute fileCounts, directory categories, and collapse deep dirs
    computeFileCounts(root);
    assignDirectoryMetadata(root);
    collapseDeepDirectories(root, 0);

    // Build language stats
    const totalFiles = relativePaths.length;
    const languages = Array.from(languageCounts.entries())
      .map(([name, fileCount]) => ({
        name,
        fileCount,
        percentage: totalFiles > 0 ? Math.round((fileCount / totalFiles) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.fileCount - a.fileCount);

    return {
      root,
      stats: {
        totalFiles,
        totalDirs,
        languages,
        agentFiles,
        testDirs: Array.from(testDirSet).sort(),
        docFiles: docFiles.sort(),
      },
    };
  }
}

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

function classifyFile(relPath: string): RepoNode['category'] {
  // Agent instructions (check first — highest priority)
  for (const pattern of AGENT_INSTRUCTION_PATTERNS) {
    if (pattern.test(relPath)) { return 'agent-instructions'; }
  }

  // CI/CD
  for (const pattern of CI_CD_PATTERNS) {
    if (pattern.test(relPath)) { return 'ci-cd'; }
  }

  // Infra
  for (const pattern of INFRA_PATTERNS) {
    if (pattern.test(relPath)) { return 'infra'; }
  }
  const ext = getExtension(relPath.split('/').pop() || '');
  if (ext === '.bicep' || ext === '.tf' || ext === '.tfvars') { return 'infra'; }
  if (relPath.endsWith('.arm.json') || relPath.includes('azuredeploy')) { return 'infra'; }

  // Test files
  for (const pattern of TEST_DIR_PATTERNS) {
    if (pattern.test(relPath)) { return 'test'; }
  }
  const filename = relPath.split('/').pop() || '';
  if (/\.(test|spec)\./i.test(filename) || /^test_/i.test(filename)) { return 'test'; }

  // Scripts
  if (/^scripts\//i.test(relPath) || ext === '.sh' || ext === '.ps1' || ext === '.bat') {
    return 'scripts';
  }

  // Docs
  if (ext === '.md') { return 'docs'; }
  if (/^docs?\//i.test(relPath)) { return 'docs'; }

  // Config (at root or in config dirs)
  if (CONFIG_EXTENSIONS.has(ext)) {
    const depth = relPath.split('/').length;
    if (depth <= 2 || /^\.?config\//i.test(relPath)) { return 'config'; }
  }
  if (filename === '.editorconfig' || filename === '.gitignore' || filename === '.eslintrc') {
    return 'config';
  }

  // Data
  if (DATA_EXTENSIONS.has(ext)) { return 'data'; }

  // Source
  if (SOURCE_EXTENSIONS.has(ext)) { return 'source'; }

  return undefined;
}

function getAgentFileType(relPath: string): string {
  if (/^\.clinerules/i.test(relPath)) { return 'Cline Rules'; }
  if (/^\.cursorrules$/i.test(relPath)) { return 'Cursor Rules'; }
  if (/^\.roomodes$/i.test(relPath)) { return 'Roo Modes'; }
  if (/^AGENTS\.md$/i.test(relPath)) { return 'AGENTS.md'; }
  if (/^CLAUDE\.md$/i.test(relPath)) { return 'CLAUDE.md'; }
  if (/copilot-instructions/i.test(relPath)) { return 'Copilot Instructions'; }
  if (/^\.github\/instructions/i.test(relPath)) { return 'GitHub Instructions'; }
  if (/^\.github\/agents/i.test(relPath)) { return 'GitHub Agents'; }
  if (/^memory-bank/i.test(relPath)) { return 'Memory Bank'; }
  if (/^\.copilot/i.test(relPath)) { return 'Copilot Config'; }
  return 'Agent File';
}

function getImportance(relPath: string, category?: string): RepoNode['importance'] {
  if (category === 'agent-instructions') { return 'critical'; }

  const filename = relPath.split('/').pop() || '';
  if (/^README\.md$/i.test(filename) && relPath.split('/').length <= 2) { return 'critical'; }
  if (/^(index|main|app)\./i.test(filename) && /^src\//i.test(relPath)) { return 'critical'; }

  if (category === 'source') { return 'high'; }
  if (category === 'ci-cd') { return 'high'; }

  if (category === 'test' || category === 'docs' || category === 'config') { return 'medium'; }

  return 'low';
}

function computeFileCounts(node: RepoNode): number {
  if (node.type === 'file') { return 1; }
  let count = 0;
  for (const child of node.children || []) {
    count += computeFileCounts(child);
  }
  node.fileCount = count;
  return count;
}

function assignDirectoryMetadata(node: RepoNode): void {
  if (node.type !== 'directory' || !node.children) { return; }

  // Recurse first
  for (const child of node.children) {
    assignDirectoryMetadata(child);
  }

  // Determine dominant category and language for this directory
  const categoryCounts = new Map<string, number>();
  const langCounts = new Map<string, number>();

  for (const child of node.children) {
    if (child.category) {
      categoryCounts.set(child.category, (categoryCounts.get(child.category) || 0) + 1);
    }
    if (child.language) {
      langCounts.set(child.language, (langCounts.get(child.language) || 0) + 1);
    }
    // Propagate from subdirectories
    if (child.type === 'directory') {
      if (child.category) {
        categoryCounts.set(child.category, (categoryCounts.get(child.category) || 0) + (child.fileCount || 1));
      }
      if (child.language) {
        langCounts.set(child.language, (langCounts.get(child.language) || 0) + (child.fileCount || 1));
      }
    }
  }

  // Set dominant category
  if (categoryCounts.size > 0) {
    const sorted = Array.from(categoryCounts.entries()).sort((a, b) => b[1] - a[1]);
    node.category = sorted[0][0] as RepoNode['category'];
  }

  // Set dominant language
  if (langCounts.size > 0) {
    const sorted = Array.from(langCounts.entries()).sort((a, b) => b[1] - a[1]);
    node.language = sorted[0][0];
  }

  // Update importance based on category
  if (node.category === 'agent-instructions') { node.importance = 'critical'; }
  else if (node.category === 'source' || node.category === 'ci-cd') { node.importance = 'high'; }
  else if (node.category === 'test' || node.category === 'docs') { node.importance = 'medium'; }
}

function collapseDeepDirectories(node: RepoNode, depth: number): void {
  if (node.type !== 'directory' || !node.children) { return; }

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type === 'directory' && child.children) {
      if (depth >= 3) {
        // Collapse: remove children, keep fileCount
        delete child.children;
      } else {
        collapseDeepDirectories(child, depth + 1);
      }
    }
  }
}

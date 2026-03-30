import * as vscode from 'vscode';
import { ComponentScore } from '../scoring/types';
import { logger } from '../logging';

export class DependencyScanner {
  
  async scanDependencies(
    workspaceUri: vscode.Uri,
    components: ComponentScore[]
  ): Promise<Map<string, string[]>> {
    const deps = new Map<string, string[]>();
    const exclude = '**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.venv/**,**/target/**';
    
    for (const comp of components) {
      const compDeps: string[] = [];
      const compUri = vscode.Uri.joinPath(workspaceUri, comp.path);
      
      // Skip file-as-component (can't scan inside a file)
      try {
        const stat = await vscode.workspace.fs.stat(compUri);
        if (stat.type === vscode.FileType.File) {
          continue;
        }
      } catch { continue; }
      
      // Find source files in this component
      const sourcePatterns = ['**/*.py', '**/*.ts', '**/*.js', '**/*.go', '**/*.rs', '**/*.cs'];
      
      for (const pattern of sourcePatterns) {
        const files = await vscode.workspace.findFiles(
          new vscode.RelativePattern(compUri, pattern), exclude, 50
        );
        
        for (const file of files) {
          try {
            const raw = await vscode.workspace.fs.readFile(file);
            const content = Buffer.from(raw).toString('utf-8');
            const imports = this.extractImports(content, comp.language);
            
            // Match imports against other component paths
            for (const imp of imports) {
              for (const otherComp of components) {
                if (otherComp.path === comp.path) continue;
                if (!otherComp.path || otherComp.path === '.' || otherComp.path === '/') continue;
                const otherName = otherComp.path.split('/').pop() || '';
                if (!otherName) continue;
                // Normalize: Python packages use underscores, dirs use hyphens
                const otherNameNorm = otherName.replace(/-/g, '_');
                const impNorm = imp.replace(/-/g, '_');
                if (impNorm.includes(otherNameNorm) || impNorm.includes(otherComp.path.replace(/-/g, '_'))) {
                  if (!compDeps.includes(otherComp.path)) {
                    compDeps.push(otherComp.path);
                  }
                }
              }
            }
          } catch (err) { logger.warn('Failed to read file during dependency scan', { error: err instanceof Error ? err.message : String(err) }); }
        }
      }
      
      if (compDeps.length > 0) {
        deps.set(comp.path, compDeps);
      }
    }
    
    return deps;
  }
  
  private extractImports(content: string, _language: string): string[] {
    const imports: string[] = [];
    const lines = content.split('\n').slice(0, 200); // first 200 lines
    
    for (const line of lines) {
      // Python: from X import Y, import X
      const pyMatch = line.match(/(?:from|import)\s+([\w.]+)/);
      if (pyMatch) imports.push(pyMatch[1]);
      
      // TypeScript/JavaScript: import X from 'Y', require('Y')
      const tsMatch = line.match(/(?:import|require)\s*\(?['"]([^'"]+)['"]/);
      if (tsMatch) imports.push(tsMatch[1]);
      
      // Go: import "path"
      const goMatch = line.match(/import\s+"([^"]+)"/);
      if (goMatch) imports.push(goMatch[1]);
      
      // C#: using X;
      const csMatch = line.match(/using\s+([\w.]+)\s*;/);
      if (csMatch) imports.push(csMatch[1]);
      
      // Rust: use X;
      const rsMatch = line.match(/use\s+([\w:]+)/);
      if (rsMatch) imports.push(rsMatch[1]);

      // pyproject.toml: workspace = true dependencies
      const uvSourceMatch = line.match(/^(\w[\w-]*)\s*=\s*\{\s*workspace\s*=\s*true/);
      if (uvSourceMatch) imports.push(uvSourceMatch[1]);

      // pyproject.toml: dependencies = ["package-name"]
      const depMatch = line.match(/["'](\w[\w-]*)["']\s*(?:>=|==|,)/);
      if (depMatch) imports.push(depMatch[1]);
    }
    
    return imports;
  }
}

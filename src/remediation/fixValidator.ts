import * as path from 'path';

export function validateFixContent(
  filePath: string,
  content: string
): { valid: boolean; error?: string } {
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();

  // JSON files
  if (ext === '.json' || basename === 'devcontainer.json') {
    try {
      JSON.parse(content);
      return { valid: true };
    } catch (e) {
      return {
        valid: false,
        error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  // YAML files
  if (ext === '.yml' || ext === '.yaml') {
    return validateYaml(content);
  }

  // TOML files
  if (ext === '.toml') {
    return validateToml(content);
  }

  // Markdown and all other files are always valid
  return { valid: true };
}

function validateYaml(content: string): { valid: boolean; error?: string } {
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // YAML must not use tabs for indentation
    if (/^\t/.test(line)) {
      return {
        valid: false,
        error: `YAML indentation error at line ${i + 1}: tabs are not allowed, use spaces`,
      };
    }
  }

  // Must not be empty
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'YAML content is empty' };
  }

  // Basic structure check: should have at least one key-value or list item
  const hasContent = lines.some(
    (line) =>
      /^\s*\w[\w\s]*:/.test(line) || /^\s*-\s+/.test(line) || line.trim() === '---'
  );

  if (!hasContent) {
    return {
      valid: false,
      error: 'YAML content does not appear to have valid structure',
    };
  }

  return { valid: true };
}

function validateToml(content: string): { valid: boolean; error?: string } {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'TOML content is empty' };
  }

  const lines = trimmed.split('\n');
  const hasContent = lines.some(
    (line) =>
      /^\s*\[.*\]\s*$/.test(line) || // section headers
      /^\s*\w[\w.-]*\s*=/.test(line) // key-value pairs
  );

  if (!hasContent) {
    return {
      valid: false,
      error: 'TOML content does not appear to have valid structure',
    };
  }

  return { valid: true };
}

export function validateFixFiles(
  files: { path: string; content: string }[]
): { allValid: boolean; results: { path: string; valid: boolean; error?: string }[] } {
  const results = files.map((file) => {
    const validation = validateFixContent(file.path, file.content);
    return {
      path: file.path,
      valid: validation.valid,
      error: validation.error,
    };
  });

  return {
    allValid: results.every((r) => r.valid),
    results,
  };
}

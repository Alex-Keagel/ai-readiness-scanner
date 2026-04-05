export interface SignalScopeValidation {
  signalId: string;
  detectedFiles: string[];
  rootFiles: string[];
  subProjectFiles: string[];
  isRootDetected: boolean;
}

export function normalizeSignalScopePath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:/, '')
    .replace(/\/+/g, '/')
    .replace(/^\.?\//, '')
    .replace(/^\/+/, '')
    .replace(/\/$/, '');
}

export function isPathInSubProject(filePath: string, subProjectPaths: string[]): boolean {
  const normalizedFile = normalizeSignalScopePath(filePath);

  return subProjectPaths.some(subProjectPath => {
    const normalizedSubProject = normalizeSignalScopePath(subProjectPath);
    if (!normalizedSubProject) { return false; }

    return normalizedFile === normalizedSubProject ||
      normalizedFile.startsWith(`${normalizedSubProject}/`) ||
      normalizedFile.includes(`/${normalizedSubProject}/`) ||
      normalizedFile.endsWith(`/${normalizedSubProject}`);
  });
}

export function validateSignalScope(
  signalId: string,
  detectedFiles: string[],
  subProjectPaths: string[],
): SignalScopeValidation {
  if (subProjectPaths.length === 0) {
    return {
      signalId,
      detectedFiles: [...detectedFiles],
      rootFiles: [...detectedFiles],
      subProjectFiles: [],
      isRootDetected: detectedFiles.length > 0,
    };
  }

  const rootFiles: string[] = [];
  const subProjectFiles: string[] = [];

  for (const file of detectedFiles) {
    if (isPathInSubProject(file, subProjectPaths)) {
      subProjectFiles.push(file);
    } else {
      rootFiles.push(file);
    }
  }

  return {
    signalId,
    detectedFiles: [...detectedFiles],
    rootFiles,
    subProjectFiles,
    isRootDetected: rootFiles.length > 0,
  };
}

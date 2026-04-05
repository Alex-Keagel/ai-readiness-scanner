/**
 * Validates LLM-generated component names against actual directory paths.
 * Prevents hallucinated business names that don't help users find real code.
 */

export interface ComponentNameValidation {
  originalPath: string;
  proposedName: string;
  validatedName: string;
  changed: boolean;
  reason?: string;
}

/** Directories generic enough to warrant an enriched business name. */
export const GENERIC_DIRS = new Set([
  'src', 'source', 'lib', 'libs', 'common', 'core', 'shared',
  'app', 'apps', 'packages', 'services', 'modules',
  'infrastructure', 'infra', 'deploy', 'deployment',
  'scripts', 'tools', 'ci', 'pipelines', 'pipeline', 'functions',
  'utils', 'util', 'helpers', 'internal', 'pkg',
]);

/** Suffixes the LLM loves to append that rarely exist in real dir names. */
const NONSENSE_SUFFIXES = [
  'Platform', 'Engine', 'System', 'Framework', 'Suite', 'Hub', 'Portal',
  'Toolkit', 'Studio', 'Manager', 'Orchestrator', 'Gateway',
];

/**
 * Compute Levenshtein distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Extract the meaningful trailing directory segment(s) from a path.
 * For nested non-generic paths like "detection/bot_detection" returns both.
 */
function extractDirName(originalPath: string): string {
  const segments = originalPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.length === 0) return originalPath;
  return segments[segments.length - 1];
}

/**
 * Strip nonsensical suffixes the LLM appends (e.g. "Platform", "Engine")
 * only when the suffix doesn't appear in the actual directory name.
 */
function stripNonsenseSuffixes(name: string, dirName: string): string {
  const dirLower = dirName.toLowerCase();
  let cleaned = name;
  for (const suffix of NONSENSE_SUFFIXES) {
    const re = new RegExp(`\\s+${suffix}$`, 'i');
    if (re.test(cleaned) && !dirLower.includes(suffix.toLowerCase())) {
      cleaned = cleaned.replace(re, '');
    }
  }
  return cleaned.trim() || name;
}

/**
 * Check whether `proposedName` already contains the directory name
 * (case-insensitive substring match).
 */
function nameContainsDir(proposedName: string, dirName: string): boolean {
  return proposedName.toLowerCase().includes(dirName.toLowerCase());
}

/**
 * Validates an LLM-proposed component name against the real path.
 *
 * Rules:
 * 1. If the dir is NOT generic, the validated name = the real dir name (LLM name rejected).
 * 2. If the dir IS generic, the LLM name is kept but anchored with "(dirName/)".
 * 3. If the proposed name exactly matches the dir name, return as-is.
 * 4. Nonsensical suffixes are stripped when not present in the dir name.
 * 5. Levenshtein distance > 80% of the longer string → reject proposed name.
 */
export function validateComponentName(
  originalPath: string,
  proposedName: string,
  _language?: string,
): ComponentNameValidation {
  const dirName = extractDirName(originalPath);
  const normalizedDir = dirName.toLowerCase();
  const normalizedProposed = proposedName.trim();

  // Exact match — no change needed
  if (normalizedProposed.toLowerCase() === normalizedDir) {
    return {
      originalPath,
      proposedName,
      validatedName: dirName,
      changed: false,
    };
  }

  const isGeneric = GENERIC_DIRS.has(normalizedDir) || dirName.length <= 3;

  // Non-generic directories: keep the real dir name, reject the LLM name
  if (!isGeneric) {
    // Check Levenshtein: if proposed is very close to dir name, it's fine
    const dist = levenshtein(normalizedProposed.toLowerCase(), normalizedDir);
    const maxLen = Math.max(normalizedProposed.length, dirName.length);
    if (maxLen > 0 && dist <= Math.ceil(maxLen * 0.2)) {
      // Close enough — use the real dir name
      return {
        originalPath,
        proposedName,
        validatedName: dirName,
        changed: proposedName !== dirName,
        reason: 'Proposed name close to dir name; using exact dir name',
      };
    }

    return {
      originalPath,
      proposedName,
      validatedName: dirName,
      changed: true,
      reason: `Non-generic directory: keeping real name "${dirName}" (rejected LLM name "${proposedName}")`,
    };
  }

  // Generic directories: use LLM name but anchor with dir name
  let enrichedName = stripNonsenseSuffixes(normalizedProposed, dirName);

  // Truncate overly long names
  if (enrichedName.length > 50) {
    enrichedName = enrichedName.slice(0, 47) + '...';
  }

  // If the enriched name already contains the dir name, use it directly
  if (nameContainsDir(enrichedName, dirName)) {
    return {
      originalPath,
      proposedName,
      validatedName: enrichedName,
      changed: proposedName !== enrichedName,
      reason: 'Generic dir: LLM name already contains directory name',
    };
  }

  // Anchor with real dir name in parentheses
  const anchored = `${enrichedName} (${dirName}/)`;
  return {
    originalPath,
    proposedName,
    validatedName: anchored,
    changed: true,
    reason: `Generic dir: anchored LLM name with real path "${dirName}/"`,
  };
}

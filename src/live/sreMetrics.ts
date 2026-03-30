/**
 * SRE Metrics Engine — Pure computation functions for AI agent reliability scoring.
 * 
 * Inspired by azure-core/agent-sre metrics methodology.
 * All functions are pure (no I/O) — they operate on Turn[] or SessionSummary[] arrays.
 */

// ─── Types ────────────────────────────────────────────────────────

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  tokens?: number;
}

export interface SRESessionSummary {
  id: string;
  platform: string;
  project: string;
  startTime: string;
  turns: Turn[];
  toolCalls: number;
  toolSuccesses: number;
  toolFailures: number;
}

export interface SREMetrics {
  hallucinationIndex: number;     // 0-100 (lower = better)
  lazinessIndex: number;          // 0-100 (lower = better)
  firstTrySuccess: number;        // 0-100 (higher = better)
  flowScore: number;              // 0-100 (higher = better)
  contextRot: ContextRotResult;
  loops: LoopDetection[];
  sessionHealth: SessionHealthResult;
  promptEffectiveness: PromptEffectivenessResult;
  regression: RegressionResult;
  activityHeatmap: ActivityHeatmapResult;
  costEstimate: CostEstimateResult;
  codeChurn: CodeChurnResult;
  doraMetrics: DORAMetricsResult;
}

export interface ContextRotResult {
  rotScore: number;        // 0-100 (lower = better, high = degradation)
  firstHalfRate: number;   // corrections per turn in first half
  secondHalfRate: number;  // corrections per turn in second half
  shrinkage: number;       // % quality loss from first to second half
}

export interface LoopDetection {
  sessionId: string;
  startTurnIndex: number;
  length: number;           // how many consecutive corrections
  topic: string;            // extracted topic of the loop
}

export interface SessionHealthResult {
  clean: number;      // % of sessions
  bumpy: number;      // % of sessions
  troubled: number;   // % of sessions
  totalSessions: number;
  classifications: SessionClassification[];
}

export interface SessionClassification {
  sessionId: string;
  health: 'clean' | 'bumpy' | 'troubled';
  corrections: number;
  hasLoops: boolean;
}

export interface PromptEffectivenessResult {
  categories: PromptCategory[];
  overallSuccessRate: number;
}

export interface PromptCategory {
  name: string;
  totalPrompts: number;
  successfulPrompts: number;
  successRate: number;     // 0-100
  avgCorrections: number;  // avg corrections after this type of prompt
}

// ─── Regression Detection Types ──────────────────────────────────

export interface RegressionResult {
  alerts: RegressionAlert[];
  trend: 'improving' | 'stable' | 'degrading';
  recentWindow: SREWindowMetrics;
  previousWindow: SREWindowMetrics;
}

export interface RegressionAlert {
  metric: string;
  severity: 'warning' | 'critical';
  message: string;
  previousValue: number;
  currentValue: number;
  delta: number;
}

export interface SREWindowMetrics {
  hallucinationIndex: number;
  lazinessIndex: number;
  firstTrySuccess: number;
  flowScore: number;
  sessionCount: number;
}

// ─── Activity Heatmap Types ─────────────────────────────────────

export interface ActivityHeatmapResult {
  /** 7 rows (days) × 24 columns (hours), values = session count */
  grid: number[][];
  peakDay: string;
  peakHour: number;
  totalActiveDays: number;
  mostProductiveWindow: string;
}

// ─── Cost Estimate Types ────────────────────────────────────────

export interface CostEstimateResult {
  totalCost: number;
  costPerSession: number;
  costPerMessage: number;
  costPerToolCall: number;
  breakdown: { platform: string; cost: number; sessions: number }[];
  currency: string;
}

// ─── Code Churn Types ───────────────────────────────────────────

export interface CodeChurnResult {
  hotFiles: ChurnFile[];
  totalChurnEvents: number;
  instabilityScore: number;    // 0-100 (lower = more stable)
}

export interface ChurnFile {
  path: string;
  editCount: number;
  sessionCount: number;        // unique sessions that edited this file
  isUnstable: boolean;         // edited 3+ times
}

// ─── DORA Metrics Types ─────────────────────────────────────────

export interface DORAMetricsResult {
  deployFrequency: DORALevel;
  leadTime: DORALevel;
  changeFailureRate: DORALevel;
  mttr: DORALevel;
  overallRating: 'Elite' | 'High' | 'Medium' | 'Low';
}

export interface DORALevel {
  value: number;
  unit: string;
  rating: 'Elite' | 'High' | 'Medium' | 'Low';
  label: string;
}

// ─── Git Data Types (provided externally) ────────────────────────

export interface GitCommitInfo {
  hash: string;
  timestamp: string;
  message: string;
  filesChanged: string[];
  isRevert: boolean;
  isFix: boolean;
  isRelease: boolean;
}

// ─── Correction Detection ────────────────────────────────────────

/** Patterns indicating the user is correcting the agent */
const STRONG_CORRECTION_PATTERNS = [
  /\bthat'?s\s+(wrong|incorrect|not\s+right|not\s+what\s+i)/i,
  /\bno,?\s+(that|this)\s+(is|was)\s+(wrong|incorrect)/i,
  /\byou\s+(got|have)\s+(it|that|this)\s+wrong/i,
  /\bactually,?\s+(it|the|that|this)\s+(should|is|was)/i,
  /\bthat\s+file\s+(doesn'?t|does\s+not)\s+exist/i,
  /\bthat'?s\s+not\s+(how|what|where)/i,
  /\bwrong\s+(file|path|function|method|class|variable|approach)/i,
  /\byou\s+(broke|messed\s+up|deleted|removed)\s+(it|the|my)/i,
  /\brevert\s+(that|this|the\s+change|it|back)/i,
  /\bundo\s+(that|this|the\s+change|it)/i,
];

const MEDIUM_CORRECTION_PATTERNS = [
  /\bno,?\s+i\s+meant/i,
  /\binstead,?\s+(of|use|do|try)/i,
  /\bnot\s+that\b/i,
  /\bdon'?t\s+(do|use|change|modify|delete|remove)\s+that/i,
  /\btry\s+again/i,
  /\bthat'?s\s+not\s+it/i,
  /\bstop,?\s+(doing|changing|modifying)/i,
  /\bplease\s+(fix|correct|redo|undo)/i,
  /\byou\s+(missed|forgot|skipped|overlooked)/i,
  /\bstill\s+(wrong|broken|not\s+working|failing)/i,
];

const WEAK_CORRECTION_PATTERNS = [
  /\bi\s+meant\b/i,
  /\bspecifically\b/i,
  /\bto\s+clarify\b/i,
  /\blet\s+me\s+(rephrase|clarify|re-?explain)/i,
  /\bwhat\s+i\s+(actually|really)\s+(want|need|meant)/i,
  /\bmore\s+precisely\b/i,
];

export interface CorrectionResult {
  strong: number;
  medium: number;
  weak: number;
  total: number;
  /** Per-turn correction weights (0 if no correction, else weight sum) */
  perTurn: number[];
}

/**
 * Detect corrections in user messages within a turn sequence.
 * Only user messages are checked (corrections are always from user → agent).
 */
export function detectCorrections(turns: Turn[]): CorrectionResult {
  let strong = 0, medium = 0, weak = 0;
  const perTurn: number[] = [];

  for (const turn of turns) {
    if (turn.role !== 'user') {
      perTurn.push(0);
      continue;
    }

    let turnWeight = 0;
    const content = turn.content;

    for (const pattern of STRONG_CORRECTION_PATTERNS) {
      if (pattern.test(content)) { strong++; turnWeight += 3; break; }
    }
    if (turnWeight === 0) {
      for (const pattern of MEDIUM_CORRECTION_PATTERNS) {
        if (pattern.test(content)) { medium++; turnWeight += 2; break; }
      }
    }
    if (turnWeight === 0) {
      for (const pattern of WEAK_CORRECTION_PATTERNS) {
        if (pattern.test(content)) { weak++; turnWeight += 1; break; }
      }
    }

    perTurn.push(turnWeight);
  }

  return { strong, medium, weak, total: strong + medium + weak, perTurn };
}

// ─── Laziness Detection ──────────────────────────────────────────

const REFUSAL_PATTERNS = [
  /\bi\s+(can'?t|cannot|am\s+unable\s+to|won'?t)\s+(help|do|provide|generate|write|create)/i,
  /\bi'?m\s+(not\s+able|unable)\s+to/i,
  /\bthat'?s\s+(beyond|outside)\s+(my|the\s+scope)/i,
  /\bi\s+don'?t\s+have\s+(access|the\s+ability)/i,
];

const PLACEHOLDER_PATTERNS = [
  /\/\/\s*TODO/i,
  /\/\/\s*FIXME/i,
  /\/\/\s*implement\s+(this|here|logic)/i,
  /\/\/\s*add\s+(your|logic|code|implementation)/i,
  /\.\.\.\s*(rest|remaining|other|more)/i,
  /\/\*\s*\.\.\.\s*\*\//,
  /pass\s*#\s*(TODO|implement)/i,
  /raise\s+NotImplementedError/i,
];

interface LazinessDetail {
  shortResponses: number;
  refusals: number;
  placeholders: number;
  totalAssistantTurns: number;
}

/**
 * Detect lazy responses: short answers, refusals, placeholder code.
 */
export function detectLaziness(turns: Turn[]): LazinessDetail {
  let shortResponses = 0, refusals = 0, placeholders = 0, totalAssistantTurns = 0;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role !== 'assistant') { continue; }
    totalAssistantTurns++;

    const content = turn.content;
    const contentLength = content.trim().length;

    // Check if the preceding user message was non-trivial (>20 chars)
    const prevUser = i > 0 && turns[i - 1].role === 'user' ? turns[i - 1].content : '';
    const isNonTrivialQuestion = prevUser.length > 20;

    // Short response to non-trivial question
    if (isNonTrivialQuestion && contentLength < 50 && contentLength > 0) {
      shortResponses++;
    }

    for (const pattern of REFUSAL_PATTERNS) {
      if (pattern.test(content)) { refusals++; break; }
    }

    for (const pattern of PLACEHOLDER_PATTERNS) {
      if (pattern.test(content)) { placeholders++; break; }
    }
  }

  return { shortResponses, refusals, placeholders, totalAssistantTurns };
}

// ─── Prompt Categorization ──────────────────────────────────────

const PROMPT_CATEGORIES: { name: string; patterns: RegExp[] }[] = [
  { name: 'test', patterns: [
    /\b(write|add|create|generate|fix)\s+(a\s+)?tests?\b/i,
    /\btest(ing|s)?\s+(for|coverage|suite|cases?)\b/i,
    /\bunit\s+tests?\b/i,
    /\bintegration\s+tests?\b/i,
  ]},
  { name: 'fix', patterns: [
    /\bfix\b/i,
    /\bbug\b/i,
    /\berror\b/i,
    /\bnot\s+working\b/i,
    /\bbroken\b/i,
    /\bfailing\b/i,
    /\bcrash(es|ing)?\b/i,
    /\bdebug\b/i,
  ]},
  { name: 'refactor', patterns: [
    /\brefactor\b/i,
    /\bclean\s*up\b/i,
    /\brestructure\b/i,
    /\breorganize\b/i,
    /\bsimplify\b/i,
    /\boptimize\b/i,
    /\bimprove\b/i,
  ]},
  { name: 'create', patterns: [
    /\b(create|build|implement|add|write|make)\s+(a\s+)?(new\s+)?(file|module|component|function|class|feature|page|endpoint)/i,
    /\bscaffold\b/i,
    /\bbootstrap\b/i,
    /\binitialize\b/i,
  ]},
  { name: 'explain', patterns: [
    /\bexplain\b/i,
    /\bwhat\s+(is|does|are)\b/i,
    /\bhow\s+(does|do|is|can)\b/i,
    /\bwhy\s+(does|do|is|did)\b/i,
    /\bdescribe\b/i,
    /\bunderstand\b/i,
  ]},
  { name: 'docs', patterns: [
    /\bdocument(ation)?\b/i,
    /\breadme\b/i,
    /\bcomment(s|ing)?\b/i,
    /\bjsdoc\b/i,
    /\btypedoc\b/i,
  ]},
  { name: 'deploy', patterns: [
    /\bdeploy\b/i,
    /\brelease\b/i,
    /\bpackage\b/i,
    /\bpublish\b/i,
    /\bci\/?cd\b/i,
    /\bpipeline\b/i,
  ]},
  { name: 'config', patterns: [
    /\bconfig(ure|uration)?\b/i,
    /\bsetup\b/i,
    /\bsettings?\b/i,
    /\binstall\b/i,
    /\benvironment\b/i,
  ]},
];

/**
 * Categorize a user prompt into one of the predefined categories.
 * Returns 'other' if no category matches.
 */
export function categorizePrompt(content: string): string {
  for (const cat of PROMPT_CATEGORIES) {
    if (cat.patterns.some(p => p.test(content))) {
      return cat.name;
    }
  }
  return 'other';
}

// ─── Core SRE Metric Functions ───────────────────────────────────

/**
 * Hallucination Index (0-100, lower is better).
 * Weighted correction score normalized against total user turns.
 * 
 * Formula: min(100, (3×strong + 2×medium + 1×weak) / userTurns × 50)
 * The ×50 scaling means 2 strong corrections per user turn = 100 (worst).
 */
export function computeHallucinationIndex(turns: Turn[]): number {
  const userTurns = turns.filter(t => t.role === 'user').length;
  if (userTurns === 0) { return 0; }

  const corrections = detectCorrections(turns);
  const weightedScore = corrections.strong * 3 + corrections.medium * 2 + corrections.weak * 1;
  return Math.min(100, Math.round(weightedScore / userTurns * 50));
}

/**
 * Laziness Index (0-100, lower is better).
 * Percentage of assistant responses that are lazy (short, refusal, placeholder).
 */
export function computeLazinessIndex(turns: Turn[]): number {
  const detail = detectLaziness(turns);
  if (detail.totalAssistantTurns === 0) { return 0; }

  const lazyCount = detail.shortResponses + detail.refusals + detail.placeholders;
  return Math.min(100, Math.round(lazyCount / detail.totalAssistantTurns * 100));
}

/**
 * First-Try Success Rate (0-100, higher is better).
 * Percentage of sessions with zero corrections detected.
 */
export function computeFirstTrySuccess(sessions: SRESessionSummary[]): number {
  if (sessions.length === 0) { return 0; }

  let clean = 0;
  for (const session of sessions) {
    const corrections = detectCorrections(session.turns);
    if (corrections.total === 0) { clean++; }
  }

  return Math.round(clean / sessions.length * 100);
}

/**
 * Flow Score (0-100, higher is better).
 * Measures productive momentum:
 * - Streak bonus: longest consecutive productive exchanges
 * - Friction penalty: corrections + tool failures
 * - Completion factor: sessions reaching natural conclusion
 * 
 * Formula: (streakScore × 0.4) + (frictionScore × 0.35) + (completionScore × 0.25)
 */
export function computeFlowScore(sessions: SRESessionSummary[]): number {
  if (sessions.length === 0) { return 0; }

  let totalStreak = 0, totalFriction = 0, totalCompletion = 0;

  for (const session of sessions) {
    const turns = session.turns;
    const corrections = detectCorrections(turns);

    // Streak: longest run of user turns without corrections
    let currentStreak = 0, maxStreak = 0;
    for (const weight of corrections.perTurn) {
      if (weight === 0) {
        currentStreak++;
        maxStreak = Math.max(maxStreak, currentStreak);
      } else {
        currentStreak = 0;
      }
    }
    const userTurns = turns.filter(t => t.role === 'user').length;
    const streakScore = userTurns > 0 ? Math.min(100, maxStreak / userTurns * 100) : 0;

    // Friction: inverse of correction density
    const frictionRate = userTurns > 0 ? corrections.total / userTurns : 0;
    const frictionScore = Math.max(0, 100 - frictionRate * 200); // 50% corrections → 0

    // Completion: session length > 4 turns with < 25% correction rate
    const isComplete = turns.length >= 4 && (userTurns === 0 || corrections.total / userTurns < 0.25);
    const completionScore = isComplete ? 100 : 40;

    totalStreak += streakScore;
    totalFriction += frictionScore;
    totalCompletion += completionScore;
  }

  const avgStreak = totalStreak / sessions.length;
  const avgFriction = totalFriction / sessions.length;
  const avgCompletion = totalCompletion / sessions.length;

  return Math.round(avgStreak * 0.4 + avgFriction * 0.35 + avgCompletion * 0.25);
}

/**
 * Context Rot (quality degradation over session length).
 * Compares correction rate in first half vs second half of a session.
 * High rot = agent gets worse as context window fills up.
 */
export function computeContextRot(sessions: SRESessionSummary[]): ContextRotResult {
  if (sessions.length === 0) {
    return { rotScore: 0, firstHalfRate: 0, secondHalfRate: 0, shrinkage: 0 };
  }

  // Only analyze sessions with 6+ turns (need enough data for meaningful split)
  const longSessions = sessions.filter(s => s.turns.length >= 6);
  if (longSessions.length === 0) {
    return { rotScore: 0, firstHalfRate: 0, secondHalfRate: 0, shrinkage: 0 };
  }

  let totalFirstRate = 0, totalSecondRate = 0;

  for (const session of longSessions) {
    const turns = session.turns;
    const mid = Math.floor(turns.length / 2);
    const firstHalf = turns.slice(0, mid);
    const secondHalf = turns.slice(mid);

    const firstCorrections = detectCorrections(firstHalf);
    const secondCorrections = detectCorrections(secondHalf);

    const firstUserCount = firstHalf.filter(t => t.role === 'user').length;
    const secondUserCount = secondHalf.filter(t => t.role === 'user').length;

    const firstRate = firstUserCount > 0 ? firstCorrections.total / firstUserCount : 0;
    const secondRate = secondUserCount > 0 ? secondCorrections.total / secondUserCount : 0;

    totalFirstRate += firstRate;
    totalSecondRate += secondRate;
  }

  const avgFirstRate = totalFirstRate / longSessions.length;
  const avgSecondRate = totalSecondRate / longSessions.length;
  const shrinkage = avgFirstRate > 0
    ? Math.round((avgSecondRate - avgFirstRate) / avgFirstRate * 100)
    : avgSecondRate > 0 ? 100 : 0;

  // Rot score: 0-100 where 0 = no degradation, 100 = severe
  const rotScore = Math.min(100, Math.max(0, Math.round(
    avgSecondRate > avgFirstRate
      ? (avgSecondRate - avgFirstRate) * 200  // Scale: 0.5 rate difference = 100
      : 0
  )));

  return {
    rotScore,
    firstHalfRate: Math.round(avgFirstRate * 100) / 100,
    secondHalfRate: Math.round(avgSecondRate * 100) / 100,
    shrinkage,
  };
}

/**
 * Detect correction loops: 3+ consecutive user corrections on the same topic.
 * A loop indicates the agent is stuck and not learning from feedback.
 */
export function detectLoops(sessions: SRESessionSummary[]): LoopDetection[] {
  const loops: LoopDetection[] = [];

  for (const session of sessions) {
    const corrections = detectCorrections(session.turns);
    let consecutiveCorrections = 0;
    let loopStartIndex = -1;

    for (let i = 0; i < corrections.perTurn.length; i++) {
      if (corrections.perTurn[i] > 0 && session.turns[i].role === 'user') {
        if (consecutiveCorrections === 0) { loopStartIndex = i; }
        consecutiveCorrections++;
      } else if (session.turns[i].role === 'user') {
        // User turn without correction breaks the streak
        if (consecutiveCorrections >= 3) {
          loops.push({
            sessionId: session.id,
            startTurnIndex: loopStartIndex,
            length: consecutiveCorrections,
            topic: extractTopic(session.turns, loopStartIndex, i),
          });
        }
        consecutiveCorrections = 0;
      }
      // Assistant turns don't break the streak
    }

    // Check trailing loop
    if (consecutiveCorrections >= 3) {
      loops.push({
        sessionId: session.id,
        startTurnIndex: loopStartIndex,
        length: consecutiveCorrections,
        topic: extractTopic(session.turns, loopStartIndex, session.turns.length),
      });
    }
  }

  return loops;
}

/**
 * Extract a rough topic from a range of turns for loop identification.
 */
function extractTopic(turns: Turn[], startIdx: number, endIdx: number): string {
  const userMessages = turns
    .slice(startIdx, endIdx)
    .filter(t => t.role === 'user')
    .map(t => t.content)
    .join(' ');

  // Extract the most common nouns/verbs (simple heuristic)
  const words = userMessages.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w));

  const freq = new Map<string, number>();
  for (const w of words) {
    freq.set(w, (freq.get(w) || 0) + 1);
  }

  const topWords = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => w);

  return topWords.join(', ') || 'unknown';
}

const STOP_WORDS = new Set([
  'that', 'this', 'with', 'from', 'have', 'been', 'will', 'would', 'could',
  'should', 'there', 'their', 'about', 'which', 'when', 'what', 'where',
  'does', 'dont', 'just', 'like', 'also', 'than', 'them', 'then', 'some',
  'only', 'into', 'more', 'make', 'made', 'very', 'each', 'much', 'need',
  'want', 'please', 'instead', 'still', 'actually', 'meant',
]);

/**
 * Classify each session's health based on correction patterns.
 */
export function classifySessionHealth(sessions: SRESessionSummary[]): SessionHealthResult {
  if (sessions.length === 0) {
    return { clean: 0, bumpy: 0, troubled: 0, totalSessions: 0, classifications: [] };
  }

  const allLoops = detectLoops(sessions);
  const loopSessionIds = new Set(allLoops.map(l => l.sessionId));

  const classifications: SessionClassification[] = [];

  for (const session of sessions) {
    const corrections = detectCorrections(session.turns);
    const hasLoops = loopSessionIds.has(session.id);

    let health: 'clean' | 'bumpy' | 'troubled';
    if (hasLoops || corrections.total >= 4) {
      health = 'troubled';
    } else if (corrections.total >= 2) {
      health = 'bumpy';
    } else {
      health = 'clean';
    }

    classifications.push({
      sessionId: session.id,
      health,
      corrections: corrections.total,
      hasLoops,
    });
  }

  const cleanCount = classifications.filter(c => c.health === 'clean').length;
  const bumpyCount = classifications.filter(c => c.health === 'bumpy').length;
  const troubledCount = classifications.filter(c => c.health === 'troubled').length;

  return {
    clean: Math.round(cleanCount / sessions.length * 100),
    bumpy: Math.round(bumpyCount / sessions.length * 100),
    troubled: Math.round(troubledCount / sessions.length * 100),
    totalSessions: sessions.length,
    classifications,
  };
}

/**
 * Compute prompt effectiveness by category.
 * For each user prompt, check if the next interaction cycle includes corrections.
 * A "success" = user prompt → assistant response → next user message is NOT a correction.
 */
export function computePromptEffectiveness(sessions: SRESessionSummary[]): PromptEffectivenessResult {
  const categoryStats = new Map<string, { total: number; successful: number; corrections: number }>();

  for (const session of sessions) {
    const turns = session.turns;
    const corrections = detectCorrections(turns);

    for (let i = 0; i < turns.length; i++) {
      if (turns[i].role !== 'user') { continue; }

      const category = categorizePrompt(turns[i].content);
      const stats = categoryStats.get(category) || { total: 0, successful: 0, corrections: 0 };
      stats.total++;

      // Check if the NEXT user message (after assistant response) is a correction
      let nextUserIdx = -1;
      for (let j = i + 1; j < turns.length; j++) {
        if (turns[j].role === 'user') { nextUserIdx = j; break; }
      }

      if (nextUserIdx === -1) {
        // Last user message in session — assume success (no correction followed)
        stats.successful++;
      } else if (corrections.perTurn[nextUserIdx] === 0) {
        stats.successful++;
      } else {
        stats.corrections++;
      }

      categoryStats.set(category, stats);
    }
  }

  const categories: PromptCategory[] = [...categoryStats.entries()]
    .map(([name, stats]) => ({
      name,
      totalPrompts: stats.total,
      successfulPrompts: stats.successful,
      successRate: stats.total > 0 ? Math.round(stats.successful / stats.total * 100) : 0,
      avgCorrections: stats.total > 0 ? Math.round(stats.corrections / stats.total * 100) / 100 : 0,
    }))
    .sort((a, b) => b.totalPrompts - a.totalPrompts);

  const totalPrompts = categories.reduce((s, c) => s + c.totalPrompts, 0);
  const totalSuccessful = categories.reduce((s, c) => s + c.successfulPrompts, 0);

  return {
    categories,
    overallSuccessRate: totalPrompts > 0 ? Math.round(totalSuccessful / totalPrompts * 100) : 0,
  };
}

// ─── Regression Detection ────────────────────────────────────────

/**
 * Detect quality regression by comparing recent sessions against earlier ones.
 * Splits sessions chronologically: recent 25% vs previous 75%.
 * Alerts when key metrics degrade beyond thresholds.
 */
export function detectRegression(sessions: SRESessionSummary[]): RegressionResult {
  const empty: SREWindowMetrics = { hallucinationIndex: 0, lazinessIndex: 0, firstTrySuccess: 0, flowScore: 0, sessionCount: 0 };
  if (sessions.length < 4) {
    return { alerts: [], trend: 'stable', recentWindow: empty, previousWindow: empty };
  }

  // Sort by time and split
  const sorted = [...sessions].sort((a, b) => a.startTime.localeCompare(b.startTime));
  const splitIdx = Math.floor(sorted.length * 0.75);
  const previous = sorted.slice(0, splitIdx);
  const recent = sorted.slice(splitIdx);

  const prevTurns = previous.flatMap(s => s.turns);
  const recentTurns = recent.flatMap(s => s.turns);

  const previousWindow: SREWindowMetrics = {
    hallucinationIndex: computeHallucinationIndex(prevTurns),
    lazinessIndex: computeLazinessIndex(prevTurns),
    firstTrySuccess: computeFirstTrySuccess(previous),
    flowScore: computeFlowScore(previous),
    sessionCount: previous.length,
  };

  const recentWindow: SREWindowMetrics = {
    hallucinationIndex: computeHallucinationIndex(recentTurns),
    lazinessIndex: computeLazinessIndex(recentTurns),
    firstTrySuccess: computeFirstTrySuccess(recent),
    flowScore: computeFlowScore(recent),
    sessionCount: recent.length,
  };

  const alerts: RegressionAlert[] = [];

  // Lower-is-better metrics: alert when they increase
  const checkIncrease = (metric: string, prev: number, curr: number, critThresh: number, warnThresh: number) => {
    const delta = curr - prev;
    if (delta >= critThresh) {
      alerts.push({ metric, severity: 'critical', message: `${metric} spiked by +${delta}`, previousValue: prev, currentValue: curr, delta });
    } else if (delta >= warnThresh) {
      alerts.push({ metric, severity: 'warning', message: `${metric} increased by +${delta}`, previousValue: prev, currentValue: curr, delta });
    }
  };

  // Higher-is-better metrics: alert when they decrease
  const checkDecrease = (metric: string, prev: number, curr: number, critThresh: number, warnThresh: number) => {
    const delta = prev - curr;
    if (delta >= critThresh) {
      alerts.push({ metric, severity: 'critical', message: `${metric} dropped by -${delta}`, previousValue: prev, currentValue: curr, delta: -delta });
    } else if (delta >= warnThresh) {
      alerts.push({ metric, severity: 'warning', message: `${metric} declined by -${delta}`, previousValue: prev, currentValue: curr, delta: -delta });
    }
  };

  checkIncrease('Hallucination', previousWindow.hallucinationIndex, recentWindow.hallucinationIndex, 25, 15);
  checkIncrease('Laziness', previousWindow.lazinessIndex, recentWindow.lazinessIndex, 25, 15);
  checkDecrease('First-Try Success', previousWindow.firstTrySuccess, recentWindow.firstTrySuccess, 25, 15);
  checkDecrease('Flow', previousWindow.flowScore, recentWindow.flowScore, 20, 10);

  const critCount = alerts.filter(a => a.severity === 'critical').length;
  const warnCount = alerts.filter(a => a.severity === 'warning').length;
  const trend = critCount >= 2 ? 'degrading' : critCount >= 1 || warnCount >= 2 ? 'degrading' : warnCount >= 1 ? 'stable' : 'improving';

  return { alerts, trend, recentWindow, previousWindow };
}

// ─── Activity Heatmap ────────────────────────────────────────────

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Build an activity heatmap from session start times.
 * Returns a 7×24 grid (day-of-week × hour-of-day).
 */
export function computeActivityHeatmap(sessions: SRESessionSummary[]): ActivityHeatmapResult {
  // 7 days × 24 hours
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  const daySet = new Set<string>();

  for (const session of sessions) {
    try {
      const d = new Date(session.startTime);
      if (isNaN(d.getTime())) { continue; }
      grid[d.getDay()][d.getHours()]++;
      daySet.add(d.toISOString().slice(0, 10));
    } catch { /* skip invalid dates */ }
  }

  // Find peak
  let peakDay = 0, peakHour = 0, peakVal = 0;
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      if (grid[day][hour] > peakVal) {
        peakVal = grid[day][hour];
        peakDay = day;
        peakHour = hour;
      }
    }
  }

  // Most productive 3-hour window
  let bestWindowStart = 0, bestWindowSum = 0;
  for (let h = 0; h < 24; h++) {
    let windowSum = 0;
    for (let d = 0; d < 7; d++) {
      windowSum += grid[d][h] + grid[d][(h + 1) % 24] + grid[d][(h + 2) % 24];
    }
    if (windowSum > bestWindowSum) {
      bestWindowSum = windowSum;
      bestWindowStart = h;
    }
  }
  const fmtHour = (h: number) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
  const mostProductiveWindow = `${fmtHour(bestWindowStart)}–${fmtHour((bestWindowStart + 3) % 24)}`;

  return {
    grid,
    peakDay: DAY_NAMES[peakDay],
    peakHour,
    totalActiveDays: daySet.size,
    mostProductiveWindow,
  };
}

// ─── Cost Estimation ────────────────────────────────────────────

/** Approximate cost per 1M tokens by platform/model tier */
const TOKEN_PRICING: Record<string, { input: number; output: number }> = {
  copilot:  { input: 3.00, output: 15.00 },   // GPT-4 class pricing
  claude:   { input: 3.00, output: 15.00 },   // Claude Sonnet class
  cline:    { input: 3.00, output: 15.00 },
  roo:      { input: 3.00, output: 15.00 },
  default:  { input: 3.00, output: 15.00 },
};

/**
 * Estimate costs from token usage.
 * Uses approximate model pricing (configurable via customPricing).
 */
export function computeCostEstimate(
  sessions: SRESessionSummary[],
  inputTokens: Map<string, number>,   // sessionId → input tokens
  outputTokens: Map<string, number>,  // sessionId → output tokens
  customPricing?: Record<string, { input: number; output: number }>,
): CostEstimateResult {
  const pricing = { ...TOKEN_PRICING, ...(customPricing || {}) };
  const platformCosts = new Map<string, { cost: number; sessions: number }>();
  let totalCost = 0;
  let totalMessages = 0;
  let totalToolCalls = 0;

  for (const session of sessions) {
    const inTok = inputTokens.get(session.id) || 0;
    const outTok = outputTokens.get(session.id) || 0;
    const rates = pricing[session.platform] || pricing.default;

    const cost = (inTok / 1_000_000) * rates.input + (outTok / 1_000_000) * rates.output;
    totalCost += cost;
    totalMessages += session.turns.length;
    totalToolCalls += session.toolCalls;

    const existing = platformCosts.get(session.platform) || { cost: 0, sessions: 0 };
    existing.cost += cost;
    existing.sessions++;
    platformCosts.set(session.platform, existing);
  }

  return {
    totalCost: Math.round(totalCost * 100) / 100,
    costPerSession: sessions.length > 0 ? Math.round(totalCost / sessions.length * 100) / 100 : 0,
    costPerMessage: totalMessages > 0 ? Math.round(totalCost / totalMessages * 100) / 100 : 0,
    costPerToolCall: totalToolCalls > 0 ? Math.round(totalCost / totalToolCalls * 100) / 100 : 0,
    breakdown: [...platformCosts.entries()].map(([platform, data]) => ({
      platform,
      cost: Math.round(data.cost * 100) / 100,
      sessions: data.sessions,
    })),
    currency: 'USD',
  };
}

// ─── Code Churn Detection ───────────────────────────────────────

/**
 * Detect code churn from git commit data.
 * Files edited 3+ times across commits are flagged as unstable.
 */
export function computeCodeChurn(commits: GitCommitInfo[]): CodeChurnResult {
  if (commits.length === 0) {
    return { hotFiles: [], totalChurnEvents: 0, instabilityScore: 0 };
  }

  const fileEdits = new Map<string, { editCount: number; commitHashes: Set<string> }>();

  for (const commit of commits) {
    for (const file of commit.filesChanged) {
      const existing = fileEdits.get(file) || { editCount: 0, commitHashes: new Set() };
      existing.editCount++;
      existing.commitHashes.add(commit.hash);
      fileEdits.set(file, existing);
    }
  }

  const hotFiles: ChurnFile[] = [...fileEdits.entries()]
    .map(([filePath, data]) => ({
      path: filePath,
      editCount: data.editCount,
      sessionCount: data.commitHashes.size,
      isUnstable: data.editCount >= 3,
    }))
    .sort((a, b) => b.editCount - a.editCount)
    .slice(0, 20);

  const totalChurnEvents = hotFiles.filter(f => f.isUnstable).reduce((s, f) => s + f.editCount, 0);
  const totalFiles = fileEdits.size;
  const unstableFiles = hotFiles.filter(f => f.isUnstable).length;
  const instabilityScore = totalFiles > 0 ? Math.min(100, Math.round(unstableFiles / totalFiles * 200)) : 0;

  return { hotFiles, totalChurnEvents, instabilityScore };
}

// ─── DORA Metrics ───────────────────────────────────────────────

/**
 * Approximate DORA metrics from git commit history.
 * - Deploy frequency: releases/tags per week
 * - Lead time: avg time from first commit to release
 * - Change failure rate: % of commits that are reverts or fixes
 * - MTTR: avg time between a failure-inducing commit and its fix
 */
export function computeDORAMetrics(commits: GitCommitInfo[], daySpan: number): DORAMetricsResult {
  if (commits.length === 0 || daySpan === 0) {
    const noData: DORALevel = { value: 0, unit: 'N/A', rating: 'Low', label: 'No data' };
    return { deployFrequency: noData, leadTime: noData, changeFailureRate: noData, mttr: noData, overallRating: 'Low' };
  }

  const weeks = Math.max(1, daySpan / 7);

  // Deploy Frequency: releases per week
  const releases = commits.filter(c => c.isRelease);
  const deployPerWeek = releases.length / weeks;
  const deployFrequency = rateDORA('deployFrequency', deployPerWeek, '/week');

  // Lead Time: avg days between first non-release commit and next release
  let totalLeadTime = 0, leadTimeCount = 0;
  const sorted = [...commits].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  let lastNonRelease: Date | null = null;
  for (const c of sorted) {
    if (!c.isRelease && !lastNonRelease) {
      lastNonRelease = new Date(c.timestamp);
    }
    if (c.isRelease && lastNonRelease) {
      const days = (new Date(c.timestamp).getTime() - lastNonRelease.getTime()) / 86400000;
      totalLeadTime += days;
      leadTimeCount++;
      lastNonRelease = null;
    }
  }
  const avgLeadTimeDays = leadTimeCount > 0 ? totalLeadTime / leadTimeCount : daySpan;
  const leadTime = rateDORA('leadTime', avgLeadTimeDays, 'days');

  // Change Failure Rate: % of commits that are reverts or bug fixes
  const failureCommits = commits.filter(c => c.isRevert || c.isFix);
  const failureRate = commits.length > 0 ? (failureCommits.length / commits.length) * 100 : 0;
  const changeFailureRate = rateDORA('changeFailureRate', failureRate, '%');

  // MTTR: avg hours between a fix commit and the nearest preceding non-fix commit
  let totalMTTR = 0, mttrCount = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].isFix) {
      const fixTime = new Date(sorted[i].timestamp).getTime();
      const prevTime = new Date(sorted[i - 1].timestamp).getTime();
      const hours = (fixTime - prevTime) / 3600000;
      if (hours > 0 && hours < 168) { // cap at 1 week
        totalMTTR += hours;
        mttrCount++;
      }
    }
  }
  const avgMTTRHours = mttrCount > 0 ? totalMTTR / mttrCount : 24;
  const mttr = rateDORA('mttr', avgMTTRHours, 'hours');

  // Overall rating: worst of all 4
  const ratings = [deployFrequency.rating, leadTime.rating, changeFailureRate.rating, mttr.rating];
  const ratingOrder: DORALevel['rating'][] = ['Low', 'Medium', 'High', 'Elite'];
  const worstIdx = Math.min(...ratings.map(r => ratingOrder.indexOf(r)));
  const overallRating = ratingOrder[worstIdx];

  return { deployFrequency, leadTime, changeFailureRate, mttr, overallRating };
}

function rateDORA(metric: string, value: number, unit: string): DORALevel {
  const rounded = Math.round(value * 10) / 10;
  switch (metric) {
    case 'deployFrequency':
      if (value >= 1) { return { value: rounded, unit, rating: 'Elite', label: 'On-demand' }; }
      if (value >= 0.14) { return { value: rounded, unit, rating: 'High', label: 'Weekly' }; }
      if (value >= 0.03) { return { value: rounded, unit, rating: 'Medium', label: 'Monthly' }; }
      return { value: rounded, unit, rating: 'Low', label: 'Quarterly+' };

    case 'leadTime':
      if (value < 1) { return { value: rounded, unit, rating: 'Elite', label: 'Same day' }; }
      if (value < 7) { return { value: rounded, unit, rating: 'High', label: 'Within a week' }; }
      if (value < 30) { return { value: rounded, unit, rating: 'Medium', label: 'Within a month' }; }
      return { value: rounded, unit, rating: 'Low', label: 'Over a month' };

    case 'changeFailureRate':
      if (value <= 5) { return { value: rounded, unit, rating: 'Elite', label: 'Minimal rework' }; }
      if (value <= 15) { return { value: rounded, unit, rating: 'High', label: 'Low rework' }; }
      if (value <= 30) { return { value: rounded, unit, rating: 'Medium', label: 'Moderate rework' }; }
      return { value: rounded, unit, rating: 'Low', label: 'Frequent rework' };

    case 'mttr':
      if (value < 1) { return { value: rounded, unit, rating: 'Elite', label: 'Under an hour' }; }
      if (value < 24) { return { value: rounded, unit, rating: 'High', label: 'Within a day' }; }
      if (value < 168) { return { value: rounded, unit, rating: 'Medium', label: 'Within a week' }; }
      return { value: rounded, unit, rating: 'Low', label: 'Over a week' };

    default:
      return { value: rounded, unit, rating: 'Medium', label: '' };
  }
}

// ─── Unified Computation ────────────────────────────────────────

/**
 * Compute all SRE metrics for a set of sessions.
 * This is the main entry point.
 * 
 * @param gitCommits - optional git commit data for DORA + churn metrics
 * @param gitDaySpan - number of days the git history covers
 */
export function computeAllSREMetrics(
  sessions: SRESessionSummary[],
  gitCommits?: GitCommitInfo[],
  gitDaySpan?: number,
): SREMetrics {
  // Flatten all turns for aggregate metrics
  const allTurns = sessions.flatMap(s => s.turns);

  // Build token maps for cost estimation
  const inputTokens = new Map<string, number>();
  const outputTokens = new Map<string, number>();
  for (const s of sessions) {
    let inTok = 0, outTok = 0;
    for (const t of s.turns) {
      if (t.role === 'user') { inTok += t.tokens || Math.ceil(t.content.length / 4); }
      if (t.role === 'assistant') { outTok += t.tokens || Math.ceil(t.content.length / 4); }
    }
    inputTokens.set(s.id, inTok);
    outputTokens.set(s.id, outTok);
  }

  return {
    hallucinationIndex: computeHallucinationIndex(allTurns),
    lazinessIndex: computeLazinessIndex(allTurns),
    firstTrySuccess: computeFirstTrySuccess(sessions),
    flowScore: computeFlowScore(sessions),
    contextRot: computeContextRot(sessions),
    loops: detectLoops(sessions),
    sessionHealth: classifySessionHealth(sessions),
    promptEffectiveness: computePromptEffectiveness(sessions),
    regression: detectRegression(sessions),
    activityHeatmap: computeActivityHeatmap(sessions),
    costEstimate: computeCostEstimate(sessions, inputTokens, outputTokens),
    codeChurn: computeCodeChurn(gitCommits || []),
    doraMetrics: computeDORAMetrics(gitCommits || [], gitDaySpan || 0),
  };
}

/**
 * Format an SRE metric value for display with appropriate color coding.
 */
export function getSREMetricColor(metric: string, value: number): string {
  // For metrics where lower is better (hallucination, laziness, rot)
  if (metric === 'hallucinationIndex' || metric === 'lazinessIndex' || metric === 'contextRot') {
    if (value <= 10) { return 'var(--color-emerald)'; }
    if (value <= 30) { return 'var(--level-3)'; }
    if (value <= 50) { return 'var(--level-2)'; }
    return 'var(--color-crimson)';
  }

  // For metrics where higher is better (firstTry, flow)
  if (value >= 80) { return 'var(--color-emerald)'; }
  if (value >= 60) { return 'var(--level-3)'; }
  if (value >= 40) { return 'var(--level-2)'; }
  return 'var(--color-crimson)';
}

/**
 * Get a text label for a metric value.
 */
export function getSREMetricLabel(metric: string, value: number): string {
  const isLowerBetter = ['hallucinationIndex', 'lazinessIndex', 'contextRot'].includes(metric);

  if (isLowerBetter) {
    if (value <= 5) { return 'Excellent'; }
    if (value <= 15) { return 'Good'; }
    if (value <= 30) { return 'Fair'; }
    if (value <= 50) { return 'Needs Work'; }
    return 'Critical';
  }

  if (value >= 90) { return 'Excellent'; }
  if (value >= 70) { return 'Good'; }
  if (value >= 50) { return 'Fair'; }
  if (value >= 30) { return 'Needs Work'; }
  return 'Critical';
}

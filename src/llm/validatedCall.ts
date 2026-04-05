import { CopilotClient } from './copilotClient';
import { logger } from '../logging';

// ─── Types ──────────────────────────────────────────────────────

export type ValidationTier = 'critical' | 'important' | 'standard' | 'display';

export interface ValidatedResult<T> {
  result: T;
  confidence: number; // 0.0 - 1.0
  validatorAgreed: boolean;
  debateOutcome?: 'primary-wins' | 'validator-wins' | 'compromise' | 'tiebreaker';
  validatorFeedback?: string;
}

export interface ValidationConfig {
  tier: ValidationTier;
  agentName?: string; // e.g. 'platform-expert' — for prompt construction
  /** Custom validator prompt (if not provided, uses generic) */
  validatorPrompt?: (primaryResult: string) => string;
  /** Threshold for score disagreement that triggers debate (0-100 scale) */
  debateThreshold?: number;
}

// ─── Confidence Levels ──────────────────────────────────────────

const CONFIDENCE = {
  AGREED: 0.95,           // Validator fully agrees
  MOSTLY_AGREED: 0.85,    // Validator agrees with minor notes
  DEBATE_PRIMARY: 0.70,   // Debate resolved — primary wins
  DEBATE_VALIDATOR: 0.65, // Debate resolved — validator wins
  DEBATE_COMPROMISE: 0.60,// Debate resolved — compromise
  TIEBREAKER: 0.75,       // Tiebreaker model decided
  UNRESOLVED: 0.40,       // Could not resolve disagreement
  NO_VALIDATION: 0.50,    // No validation performed (display tier)
  VALIDATOR_FAILED: 0.55, // Validator errored — using primary
};

// ─── Validated LLM Call ─────────────────────────────────────────

/**
 * Wraps an LLM call with validation, optional debate, and confidence scoring.
 * 
 * Flow:
 * 1. Primary agent produces result
 * 2. Validator agent checks result
 * 3. If disagreement > threshold → debate
 * 4. If debate unresolved + critical tier → tiebreaker with different model
 * 5. Returns result + confidence score
 */
export async function validatedAnalyze(
  client: CopilotClient,
  primaryPrompt: string,
  config: ValidationConfig,
  cancellationToken?: import('vscode').CancellationToken,
  timeoutMs?: number
): Promise<ValidatedResult<string>> {
  // Display tier — no validation
  if (config.tier === 'display') {
    const result = await client.analyze(primaryPrompt, cancellationToken, timeoutMs);
    return { result, confidence: CONFIDENCE.NO_VALIDATION, validatorAgreed: true };
  }

  // Step 1: Primary call
  const primaryResult = await client.analyze(primaryPrompt, cancellationToken, timeoutMs);

  // Standard tier — quick validation only (no debate)
  if (config.tier === 'standard') {
    return quickValidate(client, primaryResult, primaryPrompt, config);
  }

  // Important/Critical tier — full validation + debate
  return fullValidate(client, primaryResult, primaryPrompt, config, cancellationToken);
}

/**
 * Same as validatedAnalyze but uses the fast model for the primary call.
 */
export async function validatedAnalyzeFast(
  client: CopilotClient,
  primaryPrompt: string,
  config: ValidationConfig,
  cancellationToken?: import('vscode').CancellationToken
): Promise<ValidatedResult<string>> {
  if (config.tier === 'display') {
    const result = await client.analyzeFast(primaryPrompt, cancellationToken);
    return { result, confidence: CONFIDENCE.NO_VALIDATION, validatorAgreed: true };
  }

  const primaryResult = await client.analyzeFast(primaryPrompt, cancellationToken);

  if (config.tier === 'standard') {
    return quickValidate(client, primaryResult, primaryPrompt, config);
  }

  return fullValidate(client, primaryResult, primaryPrompt, config, cancellationToken);
}

// ─── Quick Validation (standard tier) ───────────────────────────

async function quickValidate(
  client: CopilotClient,
  primaryResult: string,
  originalPrompt: string,
  config: ValidationConfig
): Promise<ValidatedResult<string>> {
  try {
    const validatorPrompt = config.validatorPrompt
      ? config.validatorPrompt(primaryResult)
      : buildGenericValidatorPrompt(primaryResult, originalPrompt);

    const validatorResponse = await client.analyzeFast(validatorPrompt);
    const assessment = parseValidatorResponse(validatorResponse);

    if (assessment.agrees) {
      return {
        result: primaryResult,
        confidence: assessment.score >= 80 ? CONFIDENCE.AGREED : CONFIDENCE.MOSTLY_AGREED,
        validatorAgreed: true,
        validatorFeedback: assessment.feedback,
      };
    }

    // Validator disagrees but no debate for standard tier
    return {
      result: primaryResult,
      confidence: Math.max(0.3, assessment.score / 100),
      validatorAgreed: false,
      validatorFeedback: assessment.feedback,
    };
  } catch (err) {
    logger.debug('ValidatedCall: quick validation failed', err);
    return { result: primaryResult, confidence: CONFIDENCE.VALIDATOR_FAILED, validatorAgreed: true };
  }
}

// ─── Full Validation + Debate (important/critical) ──────────────

async function fullValidate(
  client: CopilotClient,
  primaryResult: string,
  originalPrompt: string,
  config: ValidationConfig,
  cancellationToken?: import('vscode').CancellationToken
): Promise<ValidatedResult<string>> {
  try {
    // Step 2: Validator check
    const validatorPrompt = config.validatorPrompt
      ? config.validatorPrompt(primaryResult)
      : buildGenericValidatorPrompt(primaryResult, originalPrompt);

    const validatorResponse = await client.analyzeFast(validatorPrompt);
    const assessment = parseValidatorResponse(validatorResponse);

    if (assessment.agrees) {
      return {
        result: primaryResult,
        confidence: assessment.score >= 80 ? CONFIDENCE.AGREED : CONFIDENCE.MOSTLY_AGREED,
        validatorAgreed: true,
        validatorFeedback: assessment.feedback,
      };
    }

    const threshold = config.debateThreshold ?? 20;
    const disagreementLevel = 100 - assessment.score;

    // Minor disagreement — accept primary with lower confidence
    if (disagreementLevel < threshold) {
      return {
        result: primaryResult,
        confidence: CONFIDENCE.MOSTLY_AGREED,
        validatorAgreed: false,
        validatorFeedback: assessment.feedback,
      };
    }

    // Step 3: Debate
    logger.info(`ValidatedCall: debate triggered (disagreement ${disagreementLevel}%)`);
    const debateResult = await runDebate(
      client, primaryResult, assessment.feedback || 'Validator disagrees', originalPrompt
    );

    if (debateResult.resolved) {
      return {
        result: debateResult.finalResult || primaryResult,
        confidence: debateResult.outcome === 'primary-wins' ? CONFIDENCE.DEBATE_PRIMARY :
          debateResult.outcome === 'validator-wins' ? CONFIDENCE.DEBATE_VALIDATOR :
          CONFIDENCE.DEBATE_COMPROMISE,
        validatorAgreed: false,
        debateOutcome: debateResult.outcome,
        validatorFeedback: assessment.feedback,
      };
    }

    // Step 4: Tiebreaker (critical tier only)
    if (config.tier === 'critical') {
      logger.info('ValidatedCall: tiebreaker invoked (critical tier)');
      const tiebreakerResult = await runTiebreaker(
        client, primaryResult, debateResult.validatorPosition || assessment.feedback || '',
        originalPrompt, cancellationToken
      );

      return {
        result: tiebreakerResult.winner === 'primary' ? primaryResult :
          (tiebreakerResult.resolvedResult || primaryResult),
        confidence: CONFIDENCE.TIEBREAKER,
        validatorAgreed: false,
        debateOutcome: 'tiebreaker',
        validatorFeedback: `Tiebreaker (${tiebreakerResult.model}): ${tiebreakerResult.reasoning}`,
      };
    }

    // Important tier, unresolved — use primary with low confidence
    return {
      result: primaryResult,
      confidence: CONFIDENCE.UNRESOLVED,
      validatorAgreed: false,
      debateOutcome: 'compromise',
      validatorFeedback: assessment.feedback,
    };
  } catch (err) {
    logger.debug('ValidatedCall: full validation failed', err);
    return { result: primaryResult, confidence: CONFIDENCE.VALIDATOR_FAILED, validatorAgreed: true };
  }
}

// ─── Debate ─────────────────────────────────────────────────────

interface DebateResult {
  resolved: boolean;
  outcome: 'primary-wins' | 'validator-wins' | 'compromise';
  finalResult?: string;
  validatorPosition?: string;
}

async function runDebate(
  client: CopilotClient,
  primaryResult: string,
  validatorFeedback: string,
  originalTask: string
): Promise<DebateResult> {
  const prompt = `Two AI agents disagree about the correct output for a task. Resolve this debate.

ORIGINAL TASK:
${originalTask.slice(0, 500)}

AGENT A (Primary) produced:
${primaryResult.slice(0, 1000)}

AGENT B (Validator) objects:
${validatorFeedback.slice(0, 500)}

Analyze both positions. Who is more correct? Can they be reconciled?

Respond ONLY as JSON:
{
  "winner": "A" | "B" | "compromise",
  "reasoning": "1-2 sentences explaining why",
  "resolvedResult": "if compromise, the merged result (or null if winner takes all)"
}`;

  try {
    const response = await client.analyzeFast(prompt);
    const match = response.match(/\{[\s\S]*\}/);
    if (!match) return { resolved: false, outcome: 'compromise', validatorPosition: validatorFeedback };

    const parsed = JSON.parse(match[0]) as { winner: string; reasoning: string; resolvedResult?: string };

    const outcome: DebateResult['outcome'] =
      parsed.winner === 'A' ? 'primary-wins' :
      parsed.winner === 'B' ? 'validator-wins' : 'compromise';

    return {
      resolved: true,
      outcome,
      finalResult: parsed.resolvedResult || undefined,
      validatorPosition: validatorFeedback,
    };
  } catch {
    return { resolved: false, outcome: 'compromise', validatorPosition: validatorFeedback };
  }
}

// ─── Tiebreaker ─────────────────────────────────────────────────

interface TiebreakerResult {
  winner: 'primary' | 'validator';
  reasoning: string;
  resolvedResult?: string;
  model: string;
}

async function runTiebreaker(
  client: CopilotClient,
  primaryResult: string,
  validatorPosition: string,
  originalTask: string,
  cancellationToken?: import('vscode').CancellationToken
): Promise<TiebreakerResult> {
  // Use the main model (typically opus/gemini-pro) — different from analyzeFast
  const prompt = `You are the final arbiter in a disagreement between two AI agents. Your judgment is final.

TASK: ${originalTask.slice(0, 400)}

POSITION A: ${primaryResult.slice(0, 800)}

POSITION B: ${validatorPosition.slice(0, 400)}

Which position is more correct for this task? Respond ONLY as JSON:
{"winner": "A" | "B", "reasoning": "why", "correctedResult": "optional corrected output"}`;

  try {
    const response = await client.analyze(prompt, cancellationToken, 30_000);
    const match = response.match(/\{[\s\S]*\}/);
    if (!match) {
      return { winner: 'primary', reasoning: 'Tiebreaker parse failed', model: client.getModelName() };
    }

    const parsed = JSON.parse(match[0]) as { winner: string; reasoning: string; correctedResult?: string };
    return {
      winner: parsed.winner === 'B' ? 'validator' : 'primary',
      reasoning: parsed.reasoning || '',
      resolvedResult: parsed.correctedResult || undefined,
      model: client.getModelName(),
    };
  } catch {
    return { winner: 'primary', reasoning: 'Tiebreaker failed', model: client.getModelName() };
  }
}

// ─── Validator Prompt Builder ───────────────────────────────────

function buildGenericValidatorPrompt(primaryResult: string, originalPrompt: string): string {
  return `You are a validator agent. Check if this LLM output is accurate and appropriate for the task.

TASK: ${originalPrompt.slice(0, 500)}

OUTPUT TO VALIDATE:
${primaryResult.slice(0, 1500)}

Check for:
1. Factual accuracy — are claims verifiable and consistent?
2. Completeness — does the output fully address the task?
3. Hallucinations — are there references to things that likely don't exist?
4. Internal consistency — does the output contradict itself?
5. Format compliance — does it match the requested format?

Respond ONLY as JSON:
{"agrees": true|false, "score": 0-100, "feedback": "specific issues if any"}`;
}

// ─── Response Parser ────────────────────────────────────────────

interface ValidatorAssessment {
  agrees: boolean;
  score: number;
  feedback?: string;
}

function parseValidatorResponse(response: string): ValidatorAssessment {
  try {
    const match = response.match(/\{[\s\S]*\}/);
    if (!match) return { agrees: true, score: 50 };

    const parsed = JSON.parse(match[0]) as { agrees?: boolean; score?: number; feedback?: string };
    return {
      agrees: parsed.agrees !== false, // default to agree
      score: typeof parsed.score === 'number' ? Math.max(0, Math.min(100, parsed.score)) : 50,
      feedback: parsed.feedback,
    };
  } catch {
    return { agrees: true, score: 50 };
  }
}

// ─── Convenience: Extract JSON with confidence ──────────────────

/**
 * Validated JSON extraction — calls primary, validates, debates if needed.
 * Returns parsed JSON + confidence score.
 */
export async function validatedJsonCall<T>(
  client: CopilotClient,
  prompt: string,
  config: ValidationConfig,
  parser: (raw: string) => T | null,
  cancellationToken?: import('vscode').CancellationToken,
  timeoutMs?: number
): Promise<ValidatedResult<T | null>> {
  const useFast = config.tier === 'standard' || config.tier === 'display';
  const validated = useFast
    ? await validatedAnalyzeFast(client, prompt, config, cancellationToken)
    : await validatedAnalyze(client, prompt, config, cancellationToken, timeoutMs);

  const parsed = parser(validated.result);
  return {
    ...validated,
    result: parsed,
  };
}

import * as assert from 'assert';
import {
  Turn,
  SRESessionSummary,
  GitCommitInfo,
  detectCorrections,
  detectLaziness,
  categorizePrompt,
  computeHallucinationIndex,
  computeLazinessIndex,
  computeFirstTrySuccess,
  computeFlowScore,
  computeContextRot,
  detectLoops,
  classifySessionHealth,
  computePromptEffectiveness,
  detectRegression,
  computeActivityHeatmap,
  computeCostEstimate,
  computeCodeChurn,
  computeDORAMetrics,
  computeAllSREMetrics,
  getSREMetricColor,
  getSREMetricLabel,
} from '../../live/sreMetrics';

// ─── Test Helpers ─────────────────────────────────────────────────

function makeTurns(...messages: [role: 'user' | 'assistant', content: string][]): Turn[] {
  return messages.map(([role, content]) => ({ role, content }));
}

function makeSession(id: string, turns: Turn[], platform = 'copilot'): SRESessionSummary {
  return {
    id,
    platform,
    project: 'test-project',
    startTime: new Date().toISOString(),
    turns,
    toolCalls: 0,
    toolSuccesses: 0,
    toolFailures: 0,
  };
}

// ─── Correction Detection ────────────────────────────────────────

suite('SRE Metrics — Correction Detection', () => {
  test('detects no corrections in clean conversation', () => {
    const turns = makeTurns(
      ['user', 'Create a new file called utils.ts'],
      ['assistant', 'I created utils.ts with the following content...'],
      ['user', 'Now add a function to format dates'],
      ['assistant', 'I added the formatDate function...'],
    );
    const result = detectCorrections(turns);
    assert.strictEqual(result.total, 0);
    assert.strictEqual(result.strong, 0);
    assert.strictEqual(result.medium, 0);
    assert.strictEqual(result.weak, 0);
  });

  test('detects strong corrections', () => {
    const turns = makeTurns(
      ['user', 'Fix the login page'],
      ['assistant', 'I updated the login component...'],
      ['user', "That's wrong, the auth endpoint should be /api/auth"],
      ['assistant', 'Sorry, let me fix that...'],
    );
    const result = detectCorrections(turns);
    assert.strictEqual(result.strong, 1);
    assert.strictEqual(result.total, 1);
  });

  test('detects medium corrections', () => {
    const turns = makeTurns(
      ['user', 'Add error handling'],
      ['assistant', 'I added try-catch blocks...'],
      ['user', 'No, I meant the API error responses, try again'],
      ['assistant', 'OK, updating the API responses...'],
    );
    const result = detectCorrections(turns);
    assert.strictEqual(result.medium, 1);
  });

  test('detects weak corrections', () => {
    const turns = makeTurns(
      ['user', 'Update the config'],
      ['assistant', 'I updated the database config...'],
      ['user', 'I meant specifically the cache configuration'],
      ['assistant', 'Updating cache config...'],
    );
    const result = detectCorrections(turns);
    assert.strictEqual(result.weak, 1);
  });

  test('tracks per-turn correction weights', () => {
    const turns = makeTurns(
      ['user', 'Create a component'],                    // 0
      ['assistant', 'Done'],                              // 0
      ['user', "That's wrong, use functional component"], // 3 (strong)
      ['assistant', 'Fixed'],                             // 0
      ['user', 'Now add props'],                          // 0
    );
    const result = detectCorrections(turns);
    assert.deepStrictEqual(result.perTurn, [0, 0, 3, 0, 0]);
  });

  test('detects revert as strong correction', () => {
    const turns = makeTurns(
      ['user', 'Revert that change please'],
    );
    const result = detectCorrections(turns);
    assert.strictEqual(result.strong, 1);
  });

  test('detects "still wrong" as medium correction', () => {
    const turns = makeTurns(
      ['user', "It's still not working after your fix"],
    );
    const result = detectCorrections(turns);
    assert.strictEqual(result.medium, 1);
  });
});

// ─── Laziness Detection ──────────────────────────────────────────

suite('SRE Metrics — Laziness Detection', () => {
  test('no laziness in thorough responses', () => {
    const turns = makeTurns(
      ['user', 'Explain how the authentication middleware works in this project'],
      ['assistant', 'The authentication middleware uses JWT tokens validated against the /api/auth endpoint. It extracts the Bearer token from the Authorization header, verifies the signature, and attaches the decoded user to req.user.'],
    );
    const detail = detectLaziness(turns);
    assert.strictEqual(detail.shortResponses, 0);
    assert.strictEqual(detail.refusals, 0);
    assert.strictEqual(detail.placeholders, 0);
  });

  test('detects short response to non-trivial question', () => {
    const turns = makeTurns(
      ['user', 'Explain how the authentication middleware works in this project'],
      ['assistant', 'It uses JWT.'],
    );
    const detail = detectLaziness(turns);
    assert.strictEqual(detail.shortResponses, 1);
  });

  test('does not flag short response to trivial question', () => {
    const turns = makeTurns(
      ['user', 'What version?'],
      ['assistant', '3.2.1'],
    );
    const detail = detectLaziness(turns);
    assert.strictEqual(detail.shortResponses, 0);
  });

  test('detects refusals', () => {
    const turns = makeTurns(
      ['user', 'Write the implementation'],
      ['assistant', "I can't help with that specific request."],
    );
    const detail = detectLaziness(turns);
    assert.strictEqual(detail.refusals, 1);
  });

  test('detects placeholder code', () => {
    const turns = makeTurns(
      ['user', 'Implement the sort function'],
      ['assistant', 'function sort(arr) {\n  // TODO implement this\n  return arr;\n}'],
    );
    const detail = detectLaziness(turns);
    assert.strictEqual(detail.placeholders, 1);
  });

  test('detects NotImplementedError as placeholder', () => {
    const turns = makeTurns(
      ['user', 'Add the handler'],
      ['assistant', 'def handler():\n    raise NotImplementedError'],
    );
    const detail = detectLaziness(turns);
    assert.strictEqual(detail.placeholders, 1);
  });
});

// ─── Prompt Categorization ──────────────────────────────────────

suite('SRE Metrics — Prompt Categorization', () => {
  test('categorizes test prompts', () => {
    assert.strictEqual(categorizePrompt('Write unit tests for the auth module'), 'test');
    assert.strictEqual(categorizePrompt('Add tests for the new feature'), 'test');
  });

  test('categorizes fix prompts', () => {
    assert.strictEqual(categorizePrompt('Fix the login bug'), 'fix');
    assert.strictEqual(categorizePrompt('This is not working, debug it'), 'fix');
  });

  test('categorizes refactor prompts', () => {
    assert.strictEqual(categorizePrompt('Refactor the database module'), 'refactor');
    assert.strictEqual(categorizePrompt('Clean up the utility functions'), 'refactor');
  });

  test('categorizes create prompts', () => {
    assert.strictEqual(categorizePrompt('Create a new file for the API routes'), 'create');
    assert.strictEqual(categorizePrompt('Build a new component for the dashboard'), 'create');
  });

  test('categorizes explain prompts', () => {
    assert.strictEqual(categorizePrompt('What does this function do?'), 'explain');
    assert.strictEqual(categorizePrompt('How does the caching work?'), 'explain');
  });

  test('categorizes docs prompts', () => {
    assert.strictEqual(categorizePrompt('Add documentation for the API'), 'docs');
    assert.strictEqual(categorizePrompt('Update the README with installation steps'), 'docs');
  });

  test('returns other for unmatched prompts', () => {
    assert.strictEqual(categorizePrompt('lets continue'), 'other');
    assert.strictEqual(categorizePrompt('ok'), 'other');
  });
});

// ─── Hallucination Index ────────────────────────────────────────

suite('SRE Metrics — Hallucination Index', () => {
  test('returns 0 for clean conversation', () => {
    const turns = makeTurns(
      ['user', 'Create a file'],
      ['assistant', 'Done, created the file'],
      ['user', 'Add a function'],
      ['assistant', 'Added the function'],
    );
    assert.strictEqual(computeHallucinationIndex(turns), 0);
  });

  test('returns > 0 for corrective conversation', () => {
    const turns = makeTurns(
      ['user', 'Create a file'],
      ['assistant', 'Done'],
      ['user', "That's wrong, wrong file path"],
      ['assistant', 'Fixed'],
    );
    const index = computeHallucinationIndex(turns);
    assert.ok(index > 0, `Expected > 0, got ${index}`);
    assert.ok(index <= 100, `Expected <= 100, got ${index}`);
  });

  test('returns 0 for empty turns', () => {
    assert.strictEqual(computeHallucinationIndex([]), 0);
  });

  test('scales with correction severity', () => {
    const strongTurns = makeTurns(
      ['user', 'Do X'], ['assistant', 'Done'],
      ['user', "That's wrong, you got it wrong"], ['assistant', 'Fixed'],
    );
    const weakTurns = makeTurns(
      ['user', 'Do X'], ['assistant', 'Done'],
      ['user', 'I meant specifically the other one'], ['assistant', 'Fixed'],
    );
    const strongIdx = computeHallucinationIndex(strongTurns);
    const weakIdx = computeHallucinationIndex(weakTurns);
    assert.ok(strongIdx > weakIdx, `Strong (${strongIdx}) should > Weak (${weakIdx})`);
  });
});

// ─── Laziness Index ─────────────────────────────────────────────

suite('SRE Metrics — Laziness Index', () => {
  test('returns 0 for thorough responses', () => {
    const turns = makeTurns(
      ['user', 'Explain how the authentication middleware works in detail please'],
      ['assistant', 'The authentication middleware validates JWT tokens by extracting the Bearer token from headers, verifying the signature with the public key, and attaching the decoded payload to the request context.'],
    );
    assert.strictEqual(computeLazinessIndex(turns), 0);
  });

  test('returns > 0 for lazy responses', () => {
    const turns = makeTurns(
      ['user', 'Explain how the authentication middleware works in detail please'],
      ['assistant', 'It uses JWT.'],
    );
    const index = computeLazinessIndex(turns);
    assert.ok(index > 0, `Expected > 0, got ${index}`);
  });

  test('returns 0 for empty turns', () => {
    assert.strictEqual(computeLazinessIndex([]), 0);
  });
});

// ─── First-Try Success ─────────────────────────────────────────

suite('SRE Metrics — First-Try Success', () => {
  test('100% for all clean sessions', () => {
    const sessions = [
      makeSession('s1', makeTurns(['user', 'Do X'], ['assistant', 'Done'], ['user', 'Do Y'], ['assistant', 'Done'])),
      makeSession('s2', makeTurns(['user', 'Do Z'], ['assistant', 'Done'])),
    ];
    assert.strictEqual(computeFirstTrySuccess(sessions), 100);
  });

  test('0% for all corrective sessions', () => {
    const sessions = [
      makeSession('s1', makeTurns(['user', 'Do X'], ['assistant', 'Done'], ['user', "That's wrong"], ['assistant', 'Fixed'])),
      makeSession('s2', makeTurns(['user', 'Do Z'], ['assistant', 'Done'], ['user', 'No, I meant Y'], ['assistant', 'OK'])),
    ];
    assert.strictEqual(computeFirstTrySuccess(sessions), 0);
  });

  test('50% for mixed sessions', () => {
    const sessions = [
      makeSession('s1', makeTurns(['user', 'Do X'], ['assistant', 'Done'])),
      makeSession('s2', makeTurns(['user', 'Do Z'], ['assistant', 'Done'], ['user', "That's wrong"], ['assistant', 'Fixed'])),
    ];
    assert.strictEqual(computeFirstTrySuccess(sessions), 50);
  });

  test('returns 0 for empty sessions', () => {
    assert.strictEqual(computeFirstTrySuccess([]), 0);
  });
});

// ─── Flow Score ─────────────────────────────────────────────────

suite('SRE Metrics — Flow Score', () => {
  test('high flow for clean productive sessions', () => {
    const sessions = [
      makeSession('s1', makeTurns(
        ['user', 'Create the component'], ['assistant', 'Done, I created a React component with...'],
        ['user', 'Add error handling'], ['assistant', 'Added try-catch blocks and error boundary...'],
        ['user', 'Add tests'], ['assistant', 'Created test file with 5 test cases...'],
        ['user', 'Ship it'], ['assistant', 'All tests passing, ready to deploy.'],
      )),
    ];
    const score = computeFlowScore(sessions);
    assert.ok(score >= 70, `Expected >= 70, got ${score}`);
  });

  test('low flow for heavily corrected sessions', () => {
    const sessions = [
      makeSession('s1', makeTurns(
        ['user', 'Create the component'], ['assistant', 'Done'],
        ['user', "That's wrong, use TypeScript"], ['assistant', 'Fixed'],
        ['user', 'Still wrong, wrong props'], ['assistant', 'Fixed again'],
        ['user', 'You missed the types'], ['assistant', 'Added types'],
      )),
    ];
    const score = computeFlowScore(sessions);
    assert.ok(score < 50, `Expected < 50, got ${score}`);
  });

  test('returns 0 for empty sessions', () => {
    assert.strictEqual(computeFlowScore([]), 0);
  });
});

// ─── Context Rot ────────────────────────────────────────────────

suite('SRE Metrics — Context Rot', () => {
  test('no rot in clean session', () => {
    const sessions = [
      makeSession('s1', makeTurns(
        ['user', 'Step 1'], ['assistant', 'Done'],
        ['user', 'Step 2'], ['assistant', 'Done'],
        ['user', 'Step 3'], ['assistant', 'Done'],
        ['user', 'Step 4'], ['assistant', 'Done'],
      )),
    ];
    const result = computeContextRot(sessions);
    assert.strictEqual(result.rotScore, 0);
  });

  test('detects rot when corrections increase in second half', () => {
    const sessions = [
      makeSession('s1', makeTurns(
        ['user', 'Step 1'], ['assistant', 'Done'],
        ['user', 'Step 2'], ['assistant', 'Done'],
        ['user', 'Step 3'], ['assistant', 'Done'],
        // second half — corrections
        ['user', "That's wrong, fix step 4"], ['assistant', 'Fixed'],
        ['user', 'Still wrong on step 5'], ['assistant', 'Fixed'],
        ['user', 'You missed step 6'], ['assistant', 'Fixed'],
      )),
    ];
    const result = computeContextRot(sessions);
    assert.ok(result.rotScore > 0, `Expected rot > 0, got ${result.rotScore}`);
    assert.ok(result.secondHalfRate > result.firstHalfRate);
  });

  test('skips short sessions', () => {
    const sessions = [
      makeSession('s1', makeTurns(
        ['user', "That's wrong"], ['assistant', 'Fixed'],
      )),
    ];
    const result = computeContextRot(sessions);
    assert.strictEqual(result.rotScore, 0);
  });

  test('returns zeroes for empty sessions', () => {
    const result = computeContextRot([]);
    assert.strictEqual(result.rotScore, 0);
    assert.strictEqual(result.shrinkage, 0);
  });
});

// ─── Loop Detection ─────────────────────────────────────────────

suite('SRE Metrics — Loop Detection', () => {
  test('detects 3+ consecutive corrections', () => {
    const sessions = [
      makeSession('s1', makeTurns(
        ['user', 'Create the login page'], ['assistant', 'Done'],
        ['user', "That's wrong, use React"], ['assistant', 'Fixed'],
        ['user', 'Still wrong, wrong props'], ['assistant', 'Fixed'],
        ['user', 'You broke the layout'], ['assistant', 'Fixed'],
      )),
    ];
    const loops = detectLoops(sessions);
    assert.strictEqual(loops.length, 1);
    assert.strictEqual(loops[0].sessionId, 's1');
    assert.ok(loops[0].length >= 3);
  });

  test('no loops in clean conversation', () => {
    const sessions = [
      makeSession('s1', makeTurns(
        ['user', 'Create file'], ['assistant', 'Done'],
        ['user', 'Add function'], ['assistant', 'Done'],
        ['user', 'Add tests'], ['assistant', 'Done'],
      )),
    ];
    const loops = detectLoops(sessions);
    assert.strictEqual(loops.length, 0);
  });

  test('no loop for only 2 consecutive corrections', () => {
    const sessions = [
      makeSession('s1', makeTurns(
        ['user', 'Create file'], ['assistant', 'Done'],
        ['user', "That's wrong"], ['assistant', 'Fixed'],
        ['user', 'Still wrong'], ['assistant', 'Fixed'],
        ['user', 'Now add tests'], ['assistant', 'Done'],
      )),
    ];
    const loops = detectLoops(sessions);
    assert.strictEqual(loops.length, 0);
  });
});

// ─── Session Health ─────────────────────────────────────────────

suite('SRE Metrics — Session Health', () => {
  test('classifies clean sessions', () => {
    const sessions = [
      makeSession('s1', makeTurns(
        ['user', 'Do X'], ['assistant', 'Done'],
        ['user', 'Do Y'], ['assistant', 'Done'],
      )),
    ];
    const result = classifySessionHealth(sessions);
    assert.strictEqual(result.clean, 100);
    assert.strictEqual(result.bumpy, 0);
    assert.strictEqual(result.troubled, 0);
  });

  test('classifies bumpy sessions (2-3 corrections)', () => {
    const sessions = [
      makeSession('s1', makeTurns(
        ['user', 'Do X'], ['assistant', 'Done'],
        ['user', "That's wrong"], ['assistant', 'Fixed'],
        ['user', 'Also try again on that'], ['assistant', 'Fixed again'],
        ['user', 'Good, now do Y'], ['assistant', 'Done'],
      )),
    ];
    const result = classifySessionHealth(sessions);
    assert.strictEqual(result.bumpy, 100);
  });

  test('classifies troubled sessions (4+ corrections)', () => {
    const sessions = [
      makeSession('s1', makeTurns(
        ['user', 'Do X'], ['assistant', 'Done'],
        ['user', "That's wrong"], ['assistant', 'Fixed'],
        ['user', 'Still wrong'], ['assistant', 'Fixed'],
        ['user', 'You missed this'], ['assistant', 'Fixed'],
        ['user', 'Revert that please'], ['assistant', 'Reverted'],
      )),
    ];
    const result = classifySessionHealth(sessions);
    assert.strictEqual(result.troubled, 100);
  });

  test('returns zeroes for empty sessions', () => {
    const result = classifySessionHealth([]);
    assert.strictEqual(result.totalSessions, 0);
  });
});

// ─── Prompt Effectiveness ───────────────────────────────────────

suite('SRE Metrics — Prompt Effectiveness', () => {
  test('tracks success rate by category', () => {
    const sessions = [
      makeSession('s1', makeTurns(
        ['user', 'Fix the login bug'],                        // fix → success
        ['assistant', 'Fixed the authentication issue...'],
        ['user', 'Write tests for it'],                       // test → success
        ['assistant', 'Created 5 test cases...'],
        ['user', 'Create a new component for settings'],      // create → fail (correction follows)
        ['assistant', 'Created Settings component...'],
        ['user', "That's wrong, use functional component"],   // correction
        ['assistant', 'Fixed to functional...'],
      )),
    ];
    const result = computePromptEffectiveness(sessions);
    assert.ok(result.categories.length > 0);

    const fixCat = result.categories.find(c => c.name === 'fix');
    assert.ok(fixCat, 'Should have fix category');
    assert.strictEqual(fixCat!.successRate, 100);

    const createCat = result.categories.find(c => c.name === 'create');
    assert.ok(createCat, 'Should have create category');
    assert.strictEqual(createCat!.successRate, 0);
  });

  test('overall success rate computed', () => {
    const sessions = [
      makeSession('s1', makeTurns(
        ['user', 'Fix the bug'], ['assistant', 'Fixed'],
        ['user', 'Add tests'], ['assistant', 'Done'],
      )),
    ];
    const result = computePromptEffectiveness(sessions);
    assert.strictEqual(result.overallSuccessRate, 100);
  });

  test('returns 0 for empty sessions', () => {
    const result = computePromptEffectiveness([]);
    assert.strictEqual(result.overallSuccessRate, 0);
  });
});

// ─── computeAllSREMetrics ───────────────────────────────────────

suite('SRE Metrics — computeAllSREMetrics', () => {
  test('computes all metrics for clean sessions', () => {
    const sessions = [
      makeSession('s1', makeTurns(
        ['user', 'Create a React component for the user profile page'],
        ['assistant', 'I created a React functional component at src/components/UserProfile.tsx with TypeScript interfaces, error handling, and loading states.'],
        ['user', 'Add unit tests with Jest and React Testing Library'],
        ['assistant', 'Created comprehensive test suite with 8 test cases covering rendering, error states, and user interactions.'],
        ['user', 'Add the CSS module styles'],
        ['assistant', 'Created UserProfile.module.css with responsive design, dark mode support, and accessibility considerations.'],
      )),
    ];
    const metrics = computeAllSREMetrics(sessions);

    assert.strictEqual(metrics.hallucinationIndex, 0);
    assert.strictEqual(metrics.lazinessIndex, 0);
    assert.strictEqual(metrics.firstTrySuccess, 100);
    assert.ok(metrics.flowScore > 50, `Flow should be high, got ${metrics.flowScore}`);
    assert.strictEqual(metrics.contextRot.rotScore, 0);
    assert.strictEqual(metrics.loops.length, 0);
    assert.strictEqual(metrics.sessionHealth.clean, 100);
    assert.strictEqual(metrics.promptEffectiveness.overallSuccessRate, 100);
  });

  test('computes all metrics for troubled sessions', () => {
    const sessions = [
      makeSession('s1', makeTurns(
        ['user', 'Create the auth module'],
        ['assistant', 'Done'],
        ['user', "That's wrong, use JWT not sessions"],
        ['assistant', 'Fixed to use JWT'],
        ['user', "Still wrong, you're using the wrong library"],
        ['assistant', 'Switched library'],
        ['user', "You broke the existing tests, revert that"],
        ['assistant', 'Reverted'],
        ['user', "That's not right either, you missed the middleware"],
        ['assistant', 'Added middleware'],
      )),
    ];
    const metrics = computeAllSREMetrics(sessions);

    assert.ok(metrics.hallucinationIndex > 0, 'Should detect hallucinations');
    assert.ok(metrics.firstTrySuccess === 0, 'No first-try success');
    assert.ok(metrics.flowScore < 50, 'Flow should be low');
    assert.strictEqual(metrics.sessionHealth.troubled, 100);
  });

  test('handles empty sessions array', () => {
    const metrics = computeAllSREMetrics([]);
    assert.strictEqual(metrics.hallucinationIndex, 0);
    assert.strictEqual(metrics.lazinessIndex, 0);
    assert.strictEqual(metrics.firstTrySuccess, 0);
    assert.strictEqual(metrics.flowScore, 0);
    assert.strictEqual(metrics.loops.length, 0);
    // New fields
    assert.ok(metrics.regression !== undefined, 'Should have regression');
    assert.ok(metrics.activityHeatmap !== undefined, 'Should have heatmap');
    assert.ok(metrics.costEstimate !== undefined, 'Should have cost');
    assert.ok(metrics.codeChurn !== undefined, 'Should have churn');
    assert.ok(metrics.doraMetrics !== undefined, 'Should have DORA');
  });
});

// ─── Display Helpers ────────────────────────────────────────────

suite('SRE Metrics — Display Helpers', () => {
  test('getSREMetricColor for lower-is-better metrics', () => {
    assert.ok(getSREMetricColor('hallucinationIndex', 5).includes('emerald'));
    assert.ok(getSREMetricColor('hallucinationIndex', 60).includes('crimson'));
  });

  test('getSREMetricColor for higher-is-better metrics', () => {
    assert.ok(getSREMetricColor('firstTrySuccess', 90).includes('emerald'));
    assert.ok(getSREMetricColor('firstTrySuccess', 20).includes('crimson'));
  });

  test('getSREMetricLabel returns correct labels', () => {
    assert.strictEqual(getSREMetricLabel('hallucinationIndex', 3), 'Excellent');
    assert.strictEqual(getSREMetricLabel('hallucinationIndex', 60), 'Critical');
    assert.strictEqual(getSREMetricLabel('firstTrySuccess', 95), 'Excellent');
    assert.strictEqual(getSREMetricLabel('firstTrySuccess', 20), 'Critical');
  });
});

// ─── Regression Detection ───────────────────────────────────────

suite('SRE Metrics — Regression Detection', () => {
  test('no alerts for stable quality', () => {
    const sessions = Array.from({ length: 8 }, (_, i) =>
      makeSession(`s${i}`, makeTurns(
        ['user', 'Do task'], ['assistant', 'Done'],
        ['user', 'Next task'], ['assistant', 'Done'],
      ))
    );
    // Set times to simulate chronological order
    sessions.forEach((s, i) => { s.startTime = new Date(2024, 0, i + 1).toISOString(); });
    const result = detectRegression(sessions);
    assert.strictEqual(result.alerts.length, 0);
  });

  test('alerts when recent sessions have more corrections', () => {
    const cleanSessions = Array.from({ length: 6 }, (_, i) =>
      makeSession(`clean${i}`, makeTurns(
        ['user', 'Do task'], ['assistant', 'Done'],
      ))
    );
    cleanSessions.forEach((s, i) => { s.startTime = new Date(2024, 0, i + 1).toISOString(); });

    const badSessions = Array.from({ length: 3 }, (_, i) =>
      makeSession(`bad${i}`, makeTurns(
        ['user', 'Do X'], ['assistant', 'Done'],
        ['user', "That's wrong, fix it"], ['assistant', 'Fixed'],
        ['user', 'Still wrong'], ['assistant', 'Fixed'],
        ['user', 'You broke it'], ['assistant', 'Fixed'],
        ['user', 'Revert that'], ['assistant', 'Reverted'],
      ))
    );
    badSessions.forEach((s, i) => { s.startTime = new Date(2024, 0, 10 + i).toISOString(); });

    const result = detectRegression([...cleanSessions, ...badSessions]);
    assert.ok(result.alerts.length > 0, 'Should detect regression');
    assert.strictEqual(result.trend, 'degrading');
  });

  test('returns stable with < 4 sessions', () => {
    const sessions = [
      makeSession('s1', makeTurns(['user', 'Do X'], ['assistant', 'Done'])),
    ];
    const result = detectRegression(sessions);
    assert.strictEqual(result.trend, 'stable');
  });
});

// ─── Activity Heatmap ───────────────────────────────────────────

suite('SRE Metrics — Activity Heatmap', () => {
  test('builds 7×24 grid', () => {
    const sessions = [
      makeSession('s1', [], 'copilot'),
    ];
    // Monday at 10am
    sessions[0].startTime = new Date(2024, 0, 1, 10, 0).toISOString(); // Monday
    const result = computeActivityHeatmap(sessions);
    assert.strictEqual(result.grid.length, 7);
    assert.strictEqual(result.grid[0].length, 24);
    assert.strictEqual(result.totalActiveDays, 1);
  });

  test('finds peak day and hour', () => {
    const sessions = Array.from({ length: 5 }, (_, i) => {
      const s = makeSession(`s${i}`, []);
      s.startTime = new Date(2024, 0, 2, 14, 0).toISOString(); // Tuesday 2pm
      return s;
    });
    const result = computeActivityHeatmap(sessions);
    assert.strictEqual(result.peakDay, 'Tue');
    assert.strictEqual(result.peakHour, 14);
  });

  test('returns 0 active days for empty sessions', () => {
    const result = computeActivityHeatmap([]);
    assert.strictEqual(result.totalActiveDays, 0);
  });
});

// ─── Cost Estimation ────────────────────────────────────────────

suite('SRE Metrics — Cost Estimation', () => {
  test('estimates cost from tokens', () => {
    const sessions = [
      makeSession('s1', makeTurns(
        ['user', 'Write a function'],
        ['assistant', 'Here is the function with full implementation and documentation...'],
      )),
    ];
    const inputTokens = new Map([['s1', 1000000]]); // 1M input
    const outputTokens = new Map([['s1', 500000]]);  // 500K output

    const result = computeCostEstimate(sessions, inputTokens, outputTokens);
    // $3/M input + $15/M output = $3 + $7.5 = $10.5
    assert.ok(result.totalCost > 0, 'Total cost should be positive');
    assert.strictEqual(result.currency, 'USD');
    assert.ok(result.costPerSession > 0);
  });

  test('returns zero for no sessions', () => {
    const result = computeCostEstimate([], new Map(), new Map());
    assert.strictEqual(result.totalCost, 0);
  });

  test('breaks down by platform', () => {
    const sessions = [
      makeSession('s1', [], 'copilot'),
      makeSession('s2', [], 'claude'),
    ];
    const inputTokens = new Map([['s1', 100000], ['s2', 200000]]);
    const outputTokens = new Map([['s1', 50000], ['s2', 100000]]);
    const result = computeCostEstimate(sessions, inputTokens, outputTokens);
    assert.strictEqual(result.breakdown.length, 2);
  });
});

// ─── Code Churn ─────────────────────────────────────────────────

suite('SRE Metrics — Code Churn', () => {
  function makeCommit(hash: string, files: string[], message = 'update'): GitCommitInfo {
    return {
      hash, timestamp: new Date().toISOString(), message,
      filesChanged: files, isRevert: false, isFix: false, isRelease: false,
    };
  }

  test('detects hot files', () => {
    const commits = [
      makeCommit('a1', ['src/auth.ts', 'src/utils.ts']),
      makeCommit('a2', ['src/auth.ts', 'src/api.ts']),
      makeCommit('a3', ['src/auth.ts']),
    ];
    const result = computeCodeChurn(commits);
    assert.ok(result.hotFiles.length > 0);
    assert.strictEqual(result.hotFiles[0].path, 'src/auth.ts');
    assert.strictEqual(result.hotFiles[0].editCount, 3);
    assert.strictEqual(result.hotFiles[0].isUnstable, true);
  });

  test('non-hot files not flagged as unstable', () => {
    const commits = [
      makeCommit('a1', ['src/index.ts']),
      makeCommit('a2', ['src/index.ts']),
    ];
    const result = computeCodeChurn(commits);
    assert.strictEqual(result.hotFiles[0].isUnstable, false);
  });

  test('returns empty for no commits', () => {
    const result = computeCodeChurn([]);
    assert.strictEqual(result.hotFiles.length, 0);
    assert.strictEqual(result.instabilityScore, 0);
  });
});

// ─── DORA Metrics ───────────────────────────────────────────────

suite('SRE Metrics — DORA Metrics', () => {
  function makeCommit(hash: string, daysAgo: number, message: string): GitCommitInfo {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return {
      hash, timestamp: d.toISOString(), message,
      filesChanged: ['file.ts'],
      isRevert: message.toLowerCase().startsWith('revert'),
      isFix: /\bfix\b/i.test(message),
      isRelease: /v\d+\.\d+\.\d+/.test(message),
    };
  }

  test('computes deploy frequency', () => {
    const commits = [
      makeCommit('a1', 14, 'feat: new feature'),
      makeCommit('a2', 7, 'chore: release v1.0.0'),
      makeCommit('a3', 3, 'feat: another'),
      makeCommit('a4', 1, 'chore: release v1.1.0'),
    ];
    const result = computeDORAMetrics(commits, 14);
    assert.ok(result.deployFrequency.value > 0, 'Should have deployments');
    assert.ok(['Elite', 'High', 'Medium', 'Low'].includes(result.deployFrequency.rating));
  });

  test('detects change failure rate', () => {
    const commits = [
      makeCommit('a1', 10, 'feat: add login'),
      makeCommit('a2', 9, 'fix: login bug'),
      makeCommit('a3', 8, 'revert: login changes'),
      makeCommit('a4', 7, 'feat: add signup'),
      makeCommit('a5', 6, 'chore: release v1.0.0'),
    ];
    const result = computeDORAMetrics(commits, 10);
    assert.ok(result.changeFailureRate.value > 0, 'Should detect failures');
  });

  test('returns Low for no commits', () => {
    const result = computeDORAMetrics([], 0);
    assert.strictEqual(result.overallRating, 'Low');
  });

  test('overall rating is worst of all', () => {
    const commits = [
      makeCommit('a1', 90, 'feat: old feature'),
      makeCommit('a2', 1, 'chore: release v1.0.0'),
    ];
    const result = computeDORAMetrics(commits, 90);
    assert.ok(['Elite', 'High', 'Medium', 'Low'].includes(result.overallRating));
  });
});

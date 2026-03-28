import { describe, it, expect, beforeEach } from 'vitest';
import { LiveMetricsEngine } from '../../live/metricsEngine';
import type { AIEvent } from '../../live/sessionPoller';

function makeEvent(overrides: Partial<AIEvent> = {}): AIEvent {
  return {
    type: 'assistant',
    timestamp: Date.now(),
    sessionId: 'session-1',
    platform: 'copilot',
    outputTokens: 100,
    contentChars: 500,
    ...overrides,
  };
}

describe('LiveMetricsEngine', () => {
  let engine: LiveMetricsEngine;

  beforeEach(() => {
    engine = new LiveMetricsEngine();
  });

  // ── ingest & compute basics ────────────────────────────────────

  describe('ingest', () => {
    it('tracks assistant tokens', () => {
      engine.ingest([makeEvent({ type: 'assistant', outputTokens: 200 })]);
      const metrics = engine.compute();
      expect(metrics.sessionTokens).toBe(200);
    });

    it('tracks user prompts', () => {
      engine.ingest([makeEvent({ type: 'user', outputTokens: 0 })]);
      const metrics = engine.compute();
      expect(metrics.sessionPrompts).toBe(1);
    });

    it('tracks tool calls for tool_start', () => {
      engine.ingest([makeEvent({ type: 'tool_start', outputTokens: 0, toolName: 'edit' })]);
      const metrics = engine.compute();
      expect(metrics.sessionToolCalls).toBe(1);
    });

    it('tracks tool calls for tool_complete', () => {
      engine.ingest([makeEvent({ type: 'tool_complete', outputTokens: 0, toolName: 'edit' })]);
      const metrics = engine.compute();
      expect(metrics.sessionToolCalls).toBe(1);
    });

    it('handles multiple events in a batch', () => {
      engine.ingest([
        makeEvent({ type: 'assistant', outputTokens: 100 }),
        makeEvent({ type: 'user', outputTokens: 0 }),
        makeEvent({ type: 'tool_start', outputTokens: 0 }),
        makeEvent({ type: 'assistant', outputTokens: 50 }),
      ]);
      const metrics = engine.compute();
      expect(metrics.sessionTokens).toBe(150);
      expect(metrics.sessionPrompts).toBe(1);
      expect(metrics.sessionToolCalls).toBe(1);
    });
  });

  // ── AIPM computation ──────────────────────────────────────────

  describe('compute AIPM', () => {
    it('calculates AIPM for recent tokens within 30s window', () => {
      const now = Date.now();
      engine.ingest([
        makeEvent({ type: 'assistant', outputTokens: 1000, timestamp: now }),
      ]);
      const metrics = engine.compute();
      // 1000 tokens in 30s window → 1000 * (60000/30000) = 2000 AIPM
      expect(metrics.aipm).toBe(2000);
    });

    it('returns 0 AIPM when no recent tokens', () => {
      const staleTs = Date.now() - 60_000; // 60 seconds ago (outside 30s window)
      engine.ingest([
        makeEvent({ type: 'assistant', outputTokens: 500, timestamp: staleTs }),
      ]);
      const metrics = engine.compute();
      expect(metrics.aipm).toBe(0);
    });
  });

  // ── Sliding window ────────────────────────────────────────────

  describe('sliding window (30s)', () => {
    it('excludes events older than 30 seconds from current AIPM', () => {
      const now = Date.now();
      engine.ingest([
        makeEvent({ type: 'assistant', outputTokens: 500, timestamp: now - 35_000 }),
        makeEvent({ type: 'assistant', outputTokens: 300, timestamp: now }),
      ]);
      const metrics = engine.compute();
      // Only the 300-token event is in window
      expect(metrics.aipm).toBe(Math.round(300 * (60_000 / 30_000)));
    });
  });

  // ── Peak tracking ─────────────────────────────────────────────

  describe('peak tracking', () => {
    it('tracks peak AIPM', () => {
      const now = Date.now();
      engine.ingest([makeEvent({ type: 'assistant', outputTokens: 2000, timestamp: now })]);
      engine.compute();

      // Wait conceptually and compute again with lower value
      engine.ingest([makeEvent({ type: 'assistant', outputTokens: 0, timestamp: now + 20_000 })]);
      const metrics = engine.compute();
      expect(metrics.peakAipm).toBeGreaterThanOrEqual(Math.round(2000 * (60_000 / 30_000)));
    });
  });

  // ── Session duration ──────────────────────────────────────────

  describe('session duration formatting', () => {
    it('formats duration as seconds when under 1 minute', () => {
      const metrics = engine.compute();
      expect(metrics.sessionDuration).toMatch(/^\d+s$/);
    });
  });

  // ── Concurrency tracking ──────────────────────────────────────

  describe('concurrency', () => {
    it('counts active sessions within 30s threshold', () => {
      const now = Date.now();
      engine.ingest([
        makeEvent({ type: 'assistant', sessionId: 'a', outputTokens: 10, timestamp: now }),
        makeEvent({ type: 'assistant', sessionId: 'b', outputTokens: 10, timestamp: now }),
      ]);
      const metrics = engine.compute();
      expect(metrics.concurrency).toBe(2);
    });

    it('tracks subagent_start as additional concurrent session', () => {
      const now = Date.now();
      engine.ingest([
        makeEvent({ type: 'assistant', sessionId: 'main', outputTokens: 10, timestamp: now }),
        makeEvent({ type: 'subagent_start', sessionId: 'main', agentName: 'sub1', outputTokens: 0, timestamp: now }),
      ]);
      const metrics = engine.compute();
      // main + main:sub1 = 2
      expect(metrics.concurrency).toBe(2);
    });

    it('removes subagent on subagent_complete', () => {
      const now = Date.now();
      engine.ingest([
        makeEvent({ type: 'assistant', sessionId: 'main', outputTokens: 10, timestamp: now }),
        makeEvent({ type: 'subagent_start', sessionId: 'main', agentName: 'sub1', outputTokens: 0, timestamp: now }),
        makeEvent({ type: 'subagent_complete', sessionId: 'main', agentName: 'sub1', outputTokens: 0, timestamp: now }),
      ]);
      const metrics = engine.compute();
      // main:sub1 was deleted; only main remains
      expect(metrics.concurrency).toBe(1);
    });
  });

  // ── Color thresholds ──────────────────────────────────────────

  describe('color thresholds', () => {
    it('returns red for 0 AIPM', () => {
      expect(engine.getColor('aipm', 0)).toBe('red');
    });

    it('returns yellow for 100 AIPM', () => {
      expect(engine.getColor('aipm', 100)).toBe('yellow');
    });

    it('returns green for 1500 AIPM', () => {
      expect(engine.getColor('aipm', 1500)).toBe('green');
    });

    it('returns purple for 6000+ AIPM', () => {
      expect(engine.getColor('aipm', 6000)).toBe('purple');
    });
  });

  // ── Reset ─────────────────────────────────────────────────────

  describe('reset', () => {
    it('clears all state', () => {
      engine.ingest([
        makeEvent({ type: 'assistant', outputTokens: 500 }),
        makeEvent({ type: 'user', outputTokens: 0 }),
      ]);
      engine.compute();
      engine.reset();
      const metrics = engine.compute();
      expect(metrics.sessionTokens).toBe(0);
      expect(metrics.sessionPrompts).toBe(0);
      expect(metrics.peakAipm).toBe(0);
    });
  });

  // ── History ───────────────────────────────────────────────────

  describe('history', () => {
    it('appends to history on each compute call', () => {
      engine.compute();
      engine.compute();
      const metrics = engine.compute();
      expect(metrics.history.timestamps.length).toBe(3);
      expect(metrics.history.aipm.length).toBe(3);
    });
  });
});

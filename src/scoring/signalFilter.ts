import { AITool, AI_TOOLS, LevelSignal } from './types';
import { getAllSignals } from './levelSignals';

/**
 * Central signal filtering module. ALL consumers use this instead of
 * inline filtering. Ensures consistent platform-specific signal selection.
 */

// Signals that apply to ALL platforms regardless of selection
const SHARED_SIGNAL_IDS = new Set([
  'project_structure_doc',
  'conventions_documented',
  'ignore_files',
  'instruction_accuracy',
  'codebase_type_strictness',
  'codebase_semantic_density',
  'codebase_context_efficiency',
]);

// Signals that only apply to specific platform families
const PLATFORM_ONLY_SIGNALS: Record<string, Set<string>> = {
  memory_bank: new Set(['cline', 'roo']),
  memory_bank_accuracy: new Set(['cline', 'roo']),
  memory_bank_update: new Set(['cline', 'roo']),
  long_term_memory: new Set(['cline', 'roo']),
  short_term_memory: new Set(['cline', 'roo']),
};

// Dimension mapping (same logic previously scattered across files)
const OPERABILITY_SIGNAL_IDS = new Set([
  'safe_commands', 'tool_definitions', 'mcp_config', 'workflow_verification',
  'error_recovery', 'workflow_tool_refs', 'agent_governance',
]);

export interface PlatformSignalMap {
  platform: string;
  generatedAt: string;
  signals: {
    id: string;
    relevant: boolean;
    weight: number;
    dimension: 'presence' | 'quality' | 'operability' | 'breadth';
    description: string;
  }[];
}

export class PlatformSignalFilter {
  static readonly SHARED_SIGNALS = SHARED_SIGNAL_IDS;

  /**
   * Returns all signal IDs relevant for a platform.
   * Uses cached map if available, falls back to static signalIds.
   */
  static getSignalIds(tool: AITool, cachedMap?: PlatformSignalMap): string[] {
    if (cachedMap?.signals?.length) {
      return cachedMap.signals.filter(s => s.relevant).map(s => s.id);
    }

    const toolConfig = AI_TOOLS[tool];
    if (!toolConfig) return [...SHARED_SIGNAL_IDS];

    const platformIds = new Set(toolConfig.signalIds);

    // Add shared signals
    for (const id of SHARED_SIGNAL_IDS) {
      platformIds.add(id);
    }

    return [...platformIds];
  }

  /**
   * Check if a specific signal is relevant for a platform.
   */
  static isRelevant(signalId: string, tool: AITool, cachedMap?: PlatformSignalMap): boolean {
    if (cachedMap?.signals?.length) {
      const entry = cachedMap.signals.find(s => s.id === signalId);
      return entry?.relevant ?? false;
    }

    // Shared signals always relevant
    if (SHARED_SIGNAL_IDS.has(signalId)) return true;

    // Check platform-only signals: if listed, only allowed for specific platforms
    const restriction = PLATFORM_ONLY_SIGNALS[signalId];
    if (restriction) {
      return restriction.has(tool);
    }

    // Check platform's signalIds
    const toolConfig = AI_TOOLS[tool];
    if (!toolConfig) return false;
    return toolConfig.signalIds.includes(signalId);
  }

  /**
   * Get all signals grouped by EGDR dimension for a platform.
   * Used by sidebar scoring weights display.
   */
  static getByDimension(
    tool: AITool,
    cachedMap?: PlatformSignalMap
  ): Record<'presence' | 'quality' | 'operability' | 'breadth', LevelSignal[]> {
    const result: Record<string, LevelSignal[]> = {
      presence: [], quality: [], operability: [], breadth: [],
    };

    const relevantIds = new Set(this.getSignalIds(tool, cachedMap));
    const allSignals = getAllSignals();

    for (const s of allSignals) {
      if (!relevantIds.has(s.id)) continue;

      const dim = this.getSignalDimension(s.id, s.category);
      result[dim].push(s);
    }

    return result as Record<'presence' | 'quality' | 'operability' | 'breadth', LevelSignal[]>;
  }

  /**
   * Determine which EGDR dimension a signal belongs to.
   */
  static getSignalDimension(signalId: string, category: string): 'presence' | 'quality' | 'operability' | 'breadth' {
    if (OPERABILITY_SIGNAL_IDS.has(signalId)) return 'operability';
    if (signalId.includes('accuracy') || signalId.includes('conventions') || signalId.includes('structure_doc')) return 'quality';
    if (signalId.includes('memory') || signalId.includes('coverage')) return 'breadth';
    if (category === 'file-presence') return 'presence';
    if (category === 'content-quality') return 'quality';
    if (category === 'depth') return 'breadth';
    return 'presence';
  }

  /**
   * Get shared signals that should be evaluated for all platforms.
   * Used by maturityScanner Phase 3c.
   */
  static getSharedSignalIds(tool: AITool): string[] {
    const shared = ['project_structure_doc', 'conventions_documented', 'ignore_files', 'instruction_accuracy'];

    // Memory bank accuracy only for platforms that use memory banks
    if (PLATFORM_ONLY_SIGNALS['memory_bank_accuracy']?.has(tool)) {
      shared.push('memory_bank_accuracy');
    }

    return shared;
  }
}

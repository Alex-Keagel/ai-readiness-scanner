import { FailingSignal, ReadinessReport } from '../scoring/types';

// Signals that generate NEW files (safe — nothing modified)
const AUTO_FIX_SIGNALS = new Set([
  'agent_instructions',
  'security_md',
  'devcontainer',
  'env_template',
  'issue_templates',
  'pr_templates',
  'codeowners',
  'copilot_instructions',
  'skills',
  'runbooks_documented',
  'readme',
  'service_flow_documented',
  'memory_bank',
  'project_structure_doc',
  'conventions_documented',
  'multi_language_setup',
  'safe_operations_defined',
  'ignore_files',
  'copilot_domain_instructions',
  'copilot_agents',
  'copilot_skills',
  'cline_rules',
  'cline_domains',
  'cursor_rules',
  'claude_instructions',
  'roo_modes',
  'windsurf_rules',
  'aider_config',
  'safe_commands',
  'tool_definitions',
  'agent_personas',
  'agent_workflows',
  'agents_md',
  'mcp_config',
  'memory_bank_update',
  'post_task_instructions',
  'doc_update_instructions',
  'copilot_cli_instructions',
  'pattern_to_skill_pipeline',
]);

// Signals that MODIFY existing configs (need diff preview)
const GUIDED_FIX_SIGNALS = new Set([
  'instruction_accuracy',
  'memory_bank_accuracy',
  'gitignore_comprehensive',
  'dependency_update_automation',
  'pre_commit_hooks',
  'codebase_type_strictness',
  'codebase_semantic_density',
  'codebase_context_efficiency',
]);

export function getFixTier(signalId: string): 'auto' | 'guided' | 'recommend' {
  if (AUTO_FIX_SIGNALS.has(signalId)) {
    return 'auto';
  }
  if (GUIDED_FIX_SIGNALS.has(signalId)) {
    return 'guided';
  }

  // Dynamic: tool-level signals (copilot_l2_instructions, cline_l3_skills_and_tools, etc.)
  // These create new files → auto-fix
  const toolLevelMatch = signalId.match(/^[a-z]+_l(\d)_(.+)$/);
  if (toolLevelMatch) {
    return 'auto';
  }

  return 'recommend';
}

function getMissingSignals(report: ReadinessReport): FailingSignal[] {
  return report.levels.flatMap((ls) =>
    ls.signals
      .filter((s) => !s.detected)
      .map((s) => ({
        id: s.signalId,
        level: s.level,
        finding: s.finding,
        confidence: s.confidence,
        fixTier: getFixTier(s.signalId),
        modelUsed: s.modelUsed,
      }))
  );
}

export function classifyFixes(report: ReadinessReport): {
  auto: FailingSignal[];
  guided: FailingSignal[];
  recommend: FailingSignal[];
} {
  const failing = getMissingSignals(report);

  const auto: FailingSignal[] = [];
  const guided: FailingSignal[] = [];
  const recommend: FailingSignal[] = [];

  for (const signal of failing) {
    const tier = getFixTier(signal.id);
    switch (tier) {
      case 'auto':
        auto.push({ ...signal, fixTier: 'auto' });
        break;
      case 'guided':
        guided.push({ ...signal, fixTier: 'guided' });
        break;
      case 'recommend':
        recommend.push({ ...signal, fixTier: 'recommend' });
        break;
    }
  }

  return { auto, guided, recommend };
}

export function getFixableCount(report: ReadinessReport): {
  auto: number;
  guided: number;
  recommend: number;
  total: number;
} {
  const { auto, guided, recommend } = classifyFixes(report);
  return {
    auto: auto.length,
    guided: guided.length,
    recommend: recommend.length,
    total: auto.length + guided.length + recommend.length,
  };
}

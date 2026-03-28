/**
 * Converts a tool-specific signal ID (e.g., "cline_l2_instructions") or
 * a shared signal ID (e.g., "project_structure_doc") into a human-readable label.
 */
export function humanizeSignalId(id: string): string {
  if (!id) return 'Unknown Signal';
  // Tool-specific IDs: "cline_l2_instructions", "copilot_l3_skills_and_tools"
  const match = id.match(/^[a-z]+_l(\d)_(.+)$/);
  if (match) {
    const categories: Record<string, string> = {
      instructions: 'Instructions & Rules',
      skills_and_tools: 'Skills, Tools & MCP',
      workflows: 'Workflows & Playbooks',
      memory_feedback: 'Memory & Feedback',
    };
    return categories[match[2]] || match[2].replace(/_/g, ' ');
  }

  // Shared / legacy signal IDs
  const sharedNames: Record<string, string> = {
    project_structure_doc: 'Project Structure Documented',
    conventions_documented: 'Coding Conventions',
    instruction_accuracy: 'Content Accuracy',
    memory_bank_accuracy: 'Memory Bank Accuracy',
    ignore_files: 'Ignore Files',
    mcp_config: 'MCP Server Config',
    agents_md: 'AGENTS.md',
    copilot_instructions: 'Copilot Instructions',
    copilot_domain_instructions: 'Domain-Specific Instructions',
    copilot_agents: 'Copilot Agents',
    copilot_skills: 'Copilot Skills',
    cline_rules: 'Cline Rules',
    cline_domains: 'Cline Domain Rules',
    cursor_rules: 'Cursor Rules',
    claude_instructions: 'Claude Instructions',
    roo_modes: 'Roo Code Modes',
    windsurf_rules: 'Windsurf Rules',
    aider_config: 'Aider Config',
    safe_commands: 'Safe Commands',
    tool_definitions: 'Tool Definitions',
    memory_bank: 'Memory Bank',
    agent_personas: 'Agent Personas',
    agent_workflows: 'Agent Workflows',
    task_playbooks: 'Task Playbooks',
    workflow_verification: 'Workflow Verification',
    error_recovery: 'Error Recovery',
    workflow_tool_refs: 'Workflow Tool References',
    domain_workflows: 'Domain Workflows',
    memory_bank_update: 'Memory Bank Updates',
    agent_evals: 'Agent Evaluations',
    retrospectives: 'Retrospectives',
    self_improve_workflow: 'Self-Improvement Workflow',
    feedback_ci: 'Feedback CI/Automation',
    orchestrator_agents: 'Orchestrator Agents',
    multi_agent_framework: 'Multi-Agent Framework',
    cross_repo_triggers: 'Cross-Repo Triggers',
    autonomous_actions: 'Autonomous Actions',
    agent_governance: 'Agent Governance',
    agent_specialization: 'Agent Specialization',
    azdevops_copilot: 'Azure DevOps Copilot Config',
  };

  return sharedNames[id] || id.replace(/_/g, ' ');
}

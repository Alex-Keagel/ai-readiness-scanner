# Skill: AI Platform Expert

Deep knowledge of AI coding assistant platforms — when to use each, strengths, weaknesses, architecture.

## Platforms Compared

### GitHub Copilot
- **Architecture**: Cloud-based, integrated into VS Code/JetBrains/CLI
- **Strengths**: Deepest IDE integration, agent mode with tools, skill system, prompt files
- **Best for**: Teams already on GitHub, enterprise orgs needing SSO/policy controls
- **Instruction system**: `.github/copilot-instructions.md` (always-on) + scoped `.instructions.md` files
- **Unique**: Agent definitions (`.agent.md`), skills (`SKILL.md`), prompt files (`.prompt.md`)
- **Community says**: Best autocomplete, agent mode catching up to Cline/Cursor

### Cline
- **Architecture**: VS Code extension, uses external LLM providers (Anthropic, OpenAI, etc.)
- **Strengths**: Most powerful rule system, memory banks for persistent context, safe-commands
- **Best for**: Power users who want full control, projects needing persistent memory across sessions
- **Instruction system**: `.clinerules/` hierarchy with core/, domains/, workflows/, tools/
- **Unique**: Memory bank system, memoryBankManagement.md domain mapping, session startup sequences
- **Community says**: Most configurable, best for complex multi-domain projects

### Cursor
- **Architecture**: Fork of VS Code with built-in AI, cloud-based models
- **Strengths**: Fastest iteration, inline editing, multi-file editing, composer mode
- **Best for**: Rapid prototyping, individual developers, frontend/fullstack work
- **Instruction system**: `.cursor/rules/` with `paths:` frontmatter scoping
- **Unique**: 12K char rule limit, globs-based scoping, built-in codebase indexing
- **Community says**: Best UX for quick edits, less configurable than Cline

### Claude Code
- **Architecture**: CLI-based, runs in terminal, uses Claude models
- **Strengths**: Simplest config (one CLAUDE.md file), great for terminal workflows
- **Best for**: CLI-first developers, monorepo navigation, rapid prototyping
- **Instruction system**: CLAUDE.md (under 200 lines!) + `.claude/rules/`
- **Unique**: @import syntax, subdirectory CLAUDE.md for component context, fresh sessions
- **Community says**: Most powerful reasoning, context-efficient, great for complex refactors

### Roo Code
- **Architecture**: VS Code extension, fork of Cline with multi-mode architecture
- **Strengths**: Mode-specific rules (code/architect/debug), custom modes
- **Best for**: Projects needing different AI behaviors for different tasks
- **Instruction system**: `.roo/rules-{mode}/` with numbered file ordering
- **Unique**: Custom modes in `.roomodes`, mode-switching during conversation
- **Community says**: Best for architecture-heavy work, good Cline alternative

### Windsurf
- **Architecture**: Fork of VS Code (Cascade), cloud-based with Flows
- **Strengths**: Trigger-based rules, AGENTS.md location scoping, workflow activation
- **Best for**: Teams wanting structured rule activation, cross-tool compatibility
- **Instruction system**: `.windsurf/rules/` with trigger modes (always_on/glob/model_decision/manual)
- **Unique**: 4 trigger modes, skills with supporting files, slash-command workflows
- **Community says**: Clean UX, less mature ecosystem than Cursor/Cline

### Aider
- **Architecture**: CLI-based, model-agnostic, git-integrated
- **Strengths**: Works with any LLM, automatic git commits, minimal config
- **Best for**: Open-source contributors, git-centric workflows, model flexibility
- **Instruction system**: `.aider.conf.yml` + `.aiderignore`
- **Unique**: Auto-commits, diff-based editing, works with local models
- **Community says**: Best for open-source, least overhead, great diff editing

## Decision Framework

| Need | Best Choice |
|------|-------------|
| Enterprise/team with GitHub | GitHub Copilot |
| Maximum configurability + memory | Cline |
| Fastest editing UX | Cursor |
| CLI-first + complex reasoning | Claude Code |
| Multi-mode (code vs architect) | Roo Code |
| Structured trigger rules | Windsurf |
| Model flexibility + git workflow | Aider |

## Multi-Tool Strategy
Many teams use 2-3 tools together:
- **Copilot + Cline**: Copilot for autocomplete, Cline for agentic tasks
- **Cursor + Claude Code**: Cursor for editing, Claude for complex refactors
- **Copilot + Claude Code**: Copilot in IDE, Claude in terminal

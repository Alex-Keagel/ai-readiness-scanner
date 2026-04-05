import { ReadinessReport, MATURITY_LEVELS, MaturityLevel, AI_TOOLS, AITool, RealityCheckRef, StructureComparison } from '../scoring/types';
import { humanizeSignalId } from '../utils';

export class MarkdownReportGenerator {
  generate(report: ReadinessReport): string {
    const lines: string[] = [];
    const depthPct = report.depth;
    const toolMeta = AI_TOOLS[report.selectedTool as AITool];
    const toolName = toolMeta?.name ?? report.selectedTool;

    // ── Title & score badge ──────────────────────────────────
    lines.push(`# AI Readiness Report — ${report.projectName}`);
    lines.push('');
    lines.push(
      `**Level ${report.primaryLevel} — ${report.levelName}** | ` +
      `Depth: ${depthPct}% | Overall Score: ${report.overallScore}/100 | ` +
      `Scanned: ${new Date(report.scannedAt).toLocaleString()}`
    );
    lines.push('');
    lines.push(
      `> **Evaluated for**: ${toolName} | **Model**: ${report.modelUsed} | **Mode**: ${report.scanMode} | ` +
      `**Languages**: ${report.projectContext.languages.join(', ') || 'none detected'}`
    );
    lines.push('');

    // ── Platform Guide ───────────────────────────────────────
    if (toolMeta?.reasoningContext) {
      const rc = toolMeta.reasoningContext;
      lines.push(`## 📚 ${toolName} — Expected Setup`);
      lines.push('');

      // Doc links
      if (toolMeta.docUrls?.main) {
        lines.push('### 📖 References');
        if (toolMeta.docUrls.main) { lines.push(`- [📄 Main Documentation](${toolMeta.docUrls.main})`); }
        if (toolMeta.docUrls.rules) { lines.push(`- [📋 Rules & Instructions](${toolMeta.docUrls.rules})`); }
        if (toolMeta.docUrls.memory) { lines.push(`- [🧠 Memory & Context](${toolMeta.docUrls.memory})`); }
        if (toolMeta.docUrls.bestPractices) { lines.push(`- [⭐ Best Practices](${toolMeta.docUrls.bestPractices})`); }
        lines.push('');
      }

      lines.push('### Expected File Structure');
      lines.push(rc.structureExpectations);
      lines.push('');
      lines.push('### Quality Markers');
      lines.push(rc.qualityMarkers);
      lines.push('');
      lines.push('### Anti-Patterns');
      lines.push(rc.antiPatterns);
      lines.push('');
    }

    // ── Structure Comparison ─────────────────────────────────
    if (report.structureComparison && report.structureComparison.expected.length > 0) {
      const sc = report.structureComparison;
      lines.push(`## 📁 Expected vs Actual Structure (${sc.completeness}% complete)`);
      lines.push('');
      lines.push(`> ✅ ${sc.presentCount} present · ❌ ${sc.missingCount} missing · ${sc.expected.length} total expected files`);
      lines.push('');
      lines.push('| Status | Path | Description | Required | Level |');
      lines.push('|--------|------|-------------|----------|-------|');
      const sorted = [...sc.expected].sort((a, b) => a.path.localeCompare(b.path));
      for (const f of sorted) {
        const icon = f.exists ? '✅' : (f.required ? '❌' : '⬜');
        const req = f.required ? 'Yes' : 'No';
        lines.push(`| ${icon} | \`${f.path}\` | ${f.description} | ${req} | L${f.level} |`);
      }
      lines.push('');
    }

    // ── Maturity Ladder ──────────────────────────────────────
    lines.push('## Maturity Ladder');
    lines.push('');
    for (const ls of report.levels) {
      const pct = ls.rawScore;
      const icon = ls.qualified ? '✅' : '❌';
      const signalInfo = `${ls.signalsDetected}/${ls.signalsTotal} signals`;
      let line = `- ${icon} **Level ${ls.level} — ${ls.name}**: ${pct}% (${signalInfo})`;
      if (!ls.qualified && ls.level > 1) {
        const prev = report.levels.find(l => l.level === (ls.level - 1) as MaturityLevel);
        if (prev && !prev.qualified) {
          line += ' *(requires previous level)*';
        }
      }
      lines.push(line);
    }
    lines.push('');

    // ── Repository Structure & Readiness ─────────────────────
    if (report.componentScores.length > 0) {
      lines.push('## 🕸️ Repository Structure & Readiness');
      lines.push('');

      // Group components by parent
      const rootComponents = report.componentScores.filter(c => !c.parentPath);
      const childMap = new Map<string, typeof report.componentScores>();
      for (const comp of report.componentScores) {
        if (comp.parentPath) {
          if (!childMap.has(comp.parentPath)) { childMap.set(comp.parentPath, []); }
          childMap.get(comp.parentPath)!.push(comp);
        }
      }

      for (const comp of rootComponents) {
        const dp = comp.depth;
        lines.push(`### ${comp.name}/ — ${comp.language} — L${comp.primaryLevel} (${dp}%)`);
        if (comp.description) {
          lines.push(`> "${comp.description}"`);
        }
        lines.push('');
        const signalSummary = comp.signals
          .map(s => s.present ? `✅ ${s.signal}` : `❌ ${s.signal}`)
          .join(' | ');
        lines.push(`Signals: ${signalSummary}`);
        lines.push('');

        const children = childMap.get(comp.path) || [];
        if (children.length > 0) {
          lines.push('#### Sub-components');
          lines.push('| Component | Language | Level | Signals |');
          lines.push('|-----------|----------|-------|---------|');
          for (const child of children) {
            const childSignals = child.signals
              .map(s => s.present ? `✅ ${s.signal}` : `❌ ${s.signal}`)
              .join(' ');
            lines.push(`| ${child.name}/ | ${child.language} | L${child.primaryLevel} | ${childSignals} |`);
          }
          lines.push('');
        }
      }

      // AI Platform Coverage
      const platformEntries = (Object.entries(AI_TOOLS) as [string, (typeof AI_TOOLS)[AITool]][]);
      if (platformEntries.length > 0) {
        lines.push('### AI Platform Coverage');
        lines.push('| Platform | Status | Files |');
        lines.push('|----------|--------|-------|');
        for (const [toolId, config] of platformEntries) {
          const { PlatformSignalFilter } = require('../scoring/signalFilter');
          const isConfigured = report.levels.some(l => l.signals.some(s => s.detected && !PlatformSignalFilter.SHARED_SIGNALS.has(s.signalId) && PlatformSignalFilter.isRelevant(s.signalId, toolId as AITool)));
          const platformFiles = report.levels.flatMap(l => l.signals)
            .filter(s => s.detected && !PlatformSignalFilter.SHARED_SIGNALS.has(s.signalId) && PlatformSignalFilter.isRelevant(s.signalId, toolId as AITool))
            .flatMap(s => s.files);
          const fileCount = new Set(platformFiles).size;
          const status = isConfigured ? '✅' : '❌';
          lines.push(`| ${config.icon} ${config.name} | ${status} | ${fileCount} |`);
        }
        lines.push('');
      }
    }

    // ── Level-by-Level Signal Details ────────────────────────
    lines.push('## Signal Details');
    lines.push('');
    for (const ls of report.levels) {
      const pct = ls.rawScore;
      lines.push(`### Level ${ls.level}: ${ls.name} (${pct}% — ${ls.signalsDetected}/${ls.signalsTotal})`);
      lines.push('');
      lines.push(`> ${MATURITY_LEVELS[ls.level].description}`);
      lines.push('');
      if (ls.signals.length === 0) {
        lines.push('_No signals evaluated for this level._');
        lines.push('');
        continue;
      }
      for (const signal of ls.signals) {
        const icon = signal.detected ? '✅' : '❌';
        const displayName = humanizeSignalId(signal.signalId);
        const scoreLabel = signal.detected ? ` (${signal.score}/100)` : '';
        const model = signal.modelUsed ? ` *(${signal.modelUsed})*` : '';
        const filesLabel = signal.files.length > 0 ? ` — Files: ${signal.files.join(', ')}` : '';

        // Reality check summary
        let realitySuffix = '';
        if (signal.realityChecks && signal.realityChecks.length > 0) {
          const valid = signal.realityChecks.filter(c => c.status === 'valid').length;
          const invalid = signal.realityChecks.filter(c => c.status === 'invalid').length;
          const warns = signal.realityChecks.filter(c => c.status === 'warning').length;
          realitySuffix = ` — ${valid}/${signal.realityChecks.length} reality checks valid`;
          if (invalid > 0) { realitySuffix += `, ${invalid} invalid`; }
          if (warns > 0) { realitySuffix += `, ${warns} stale`; }
        }

        lines.push(`- ${icon} **${displayName}**${scoreLabel}: ${signal.finding}${filesLabel}${model}${realitySuffix}`);

        // Inline reality check warnings
        if (signal.realityChecks) {
          for (const check of signal.realityChecks) {
            if (check.status === 'invalid' && check.category === 'command') {
              lines.push(`  ⚠️ Command "${check.claim}" in ${check.file} but ${check.reality}`);
            } else if (check.status === 'invalid') {
              lines.push(`  ⚠️ Path "${check.claim}" referenced in ${check.file} not found`);
            } else if (check.status === 'warning' && check.category === 'stale') {
              lines.push(`  ⚠️ Stale marker "${check.claim}" in ${check.file}: ${check.reality}`);
            }
          }
        }

        // Business logic validation findings
        if (signal.businessFindings && signal.businessFindings.length > 0) {
          for (const finding of signal.businessFindings) {
            lines.push(`  - ${finding}`);
          }
        }
      }
      lines.push('');
    }

    // ── Next Steps ───────────────────────────────────────────
    const nextLevel = this.getNextUnqualifiedLevel(report);
    if (nextLevel) {
      lines.push('## Next Steps');
      lines.push('');
      const toolLevelFiles = this.getToolLevelFiles(report.selectedTool, nextLevel.level);
      lines.push(
        `To improve your **${toolName}** readiness to **Level ${nextLevel.level}: ${nextLevel.name}**, ` +
        `address these missing signals:`
      );
      lines.push('');
      const missing = nextLevel.signals.filter(s => !s.detected);
      for (const s of missing) {
        const displayName = humanizeSignalId(s.signalId);
        let line = `1. **${displayName}** — ${s.finding}`;
        if (toolLevelFiles && toolLevelFiles.length > 0) {
          line += `\n   - Target files: ${toolLevelFiles.map(f => `\`${f}\``).join(', ')}`;
        }
        lines.push(line);
      }
      lines.push('');
    } else {
      lines.push('## 🎉 Congratulations!');
      lines.push('');
      lines.push('All maturity levels have been achieved. Your project has reached full AI readiness.');
      lines.push('');
    }

    // ── Scoring Methodology ────────────────────────────────
    lines.push('## 📐 How Scoring Works');
    lines.push('');
    lines.push('### The 6-Level AI Maturity Ladder');
    lines.push('');
    lines.push('| Level | Name | What It Means |');
    lines.push('|-------|------|--------------|');
    for (let l = 1; l <= 6; l++) {
      const info = MATURITY_LEVELS[l as MaturityLevel];
      lines.push(`| ${l} | **${info.name}** | ${info.description} |`);
    }
    lines.push('');
    lines.push('### Scoring Formula');
    lines.push('');
    lines.push('Each level is scored 0-100 based on **signals** detected in the repository:');
    lines.push('');
    lines.push('1. **Signal Detection** — The scanner searches for specific files and content patterns per level');
    lines.push('2. **Quality Evaluation** — An LLM reads the actual file content and scores it 0-100 based on:');
    lines.push('   - **Accuracy**: Do paths/commands/claims match the real project? (cross-referenced against source code)');
    lines.push('   - **Specificity**: Is this project-specific or generic boilerplate?');
    lines.push('   - **Completeness**: Does it cover all major components?');
    lines.push('   - **Platform conformance**: Does it follow the selected AI tool\'s expected structure?');
    lines.push('3. **Reality Check** — Paths mentioned in docs are verified on disk, commands are checked against the actual package manager');
    lines.push('4. **Business Logic Validation** — Claims about what the code does are verified against actual source files');
    lines.push('');
    lines.push('### Level Qualification (Gated Progression)');
    lines.push('');
    lines.push('| Level | Minimum Score | Also Requires |');
    lines.push('|-------|--------------|---------------|');
    lines.push('| L1 | Baseline | — |');
    lines.push('| L2 | ≥ 40% | — |');
    lines.push('| L3 | ≥ 45% | L2 ≥ 30% |');
    lines.push('| L4 | ≥ 50% | L3 ≥ 35% |');
    lines.push('| L5 | ≥ 55% | L4 ≥ 40% |');
    lines.push('| L6 | ≥ 60% | L5 ≥ 45% |');
    lines.push('');
    lines.push('**Primary Level** = highest qualified level. **Depth** = score within that level (0-100%).');
    lines.push('');
    lines.push(`**Overall Score** = \`((Level - 1 + Depth/100) / 6) * 100\` = **${report.overallScore}/100**`);
    lines.push('');
    if (toolMeta) {
      lines.push(`### Platform-Specific Evaluation: ${toolName}`);
      lines.push('');
      lines.push(`This report evaluates readiness specifically for **${toolName}**. Only signals relevant to ${toolName} are scored. ` +
        `Other AI tools may have different file structures and requirements.`);
      lines.push('');
    }

    return lines.join('\n');
  }

  private getNextUnqualifiedLevel(report: ReadinessReport) {
    return report.levels.find(ls => !ls.qualified);
  }

  private getToolLevelFiles(selectedTool: string, level: MaturityLevel): string[] | undefined {
    const tool = AI_TOOLS[selectedTool as AITool];
    if (!tool) { return undefined; }
    switch (level) {
      case 2: return tool.level2Files;
      case 3: return tool.level3Files;
      case 4: return tool.level4Files;
      case 5: return tool.level5Files;
      default: return undefined;
    }
  }
}

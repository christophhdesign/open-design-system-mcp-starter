// Writes or updates the adopting team's AGENTS.md (and CLAUDE.md, when it already exists)
// with a fenced section naming the system, the MCP server and how to start it, the tool
// routine, the never-invent rule, and any team aliases. Re-running replaces only the text
// between this system's `<!-- ds-mcp:begin <id> -->` / `<!-- ds-mcp:end <id> -->` markers;
// everything else in the file, including the team's own text above and below, is untouched.
// AGENTS.md is created when missing; CLAUDE.md is only ever updated, never created.

import { resolve } from 'node:path';
import type { SystemData } from '../types.ts';
import {
  beginMarker,
  consumptionLine,
  derivedDoDont,
  endMarker,
  NEVER_INVENT_RULE,
  routineSteps,
  teamAliasRows,
  writeMarkedFile,
} from './shared.ts';

export function buildAgentsMdSection(data: SystemData, serverCommand: string): string {
  const name = data.cfg.name ?? data.id;
  const lines: string[] = [];

  lines.push(beginMarker(data.id));
  lines.push(`## ${name} (design system)`);
  lines.push('');
  lines.push(data.cfg.description ?? `${name} is this project's design system.`);
  lines.push('');
  lines.push(`Consumption: ${consumptionLine(data)}`);
  lines.push('');
  lines.push('### MCP server');
  lines.push('');
  lines.push(
    `This project has an MCP server for ${name} (system id \`${data.id}\`). It answers what components exist, what props they take, which token to write, and whether a name you are about to use is real, instead of you guessing from memory. A lookup miss returns the nearest real thing and why, never a fabricated answer.`,
  );
  lines.push('');
  lines.push('Start it with:');
  lines.push('');
  lines.push('```');
  lines.push(serverCommand);
  lines.push('```');
  lines.push('');
  lines.push('### Routine');
  lines.push('');
  lines.push('Follow this order when building or changing UI with this system:');
  lines.push('');
  routineSteps(data).forEach((step, i) => {
    lines.push(`${i + 1}. **${step.tool}** -- ${step.when}`);
  });
  lines.push('');
  lines.push('### Never invent');
  lines.push('');
  lines.push(NEVER_INVENT_RULE);

  const aliasRows = teamAliasRows(data);
  if (aliasRows.length > 0) {
    lines.push('');
    lines.push('### This system calls it');
    lines.push('');
    lines.push('| you might write | this system calls it |');
    lines.push('| --- | --- |');
    for (const row of aliasRows) {
      lines.push(`| ${row.alias} | ${row.target}${row.note ? ` (${row.note})` : ''} |`);
    }
  }

  const doDont = derivedDoDont(data);
  if (doDont.length > 0) {
    lines.push('');
    lines.push('### From this catalog');
    lines.push('');
    for (const d of doDont) {
      lines.push(`- ${d.kind === 'do' ? 'Do' : "Don't"} ${d.text}`);
    }
  }

  lines.push('');
  lines.push(endMarker(data.id));
  return lines.join('\n');
}

export interface AgentsMdResult {
  written: string[];
  skipped: string[];
  notes: string[];
}

export function writeAgentsMd(data: SystemData, outDir: string, serverCommand: string): AgentsMdResult {
  const written: string[] = [];
  const notes: string[] = [];
  const section = buildAgentsMdSection(data, serverCommand);

  const agentsPath = resolve(outDir, 'AGENTS.md');
  writeMarkedFile(agentsPath, data.id, section, { createIfMissing: true });
  written.push(agentsPath);

  const claudePath = resolve(outDir, 'CLAUDE.md');
  const claudeAction = writeMarkedFile(claudePath, data.id, section, { createIfMissing: false });
  if (claudeAction === 'written') {
    written.push(claudePath);
  } else {
    notes.push(`CLAUDE.md not found at ${claudePath}; left alone (only updated when the team already has one).`);
  }

  return { written, skipped: [], notes };
}

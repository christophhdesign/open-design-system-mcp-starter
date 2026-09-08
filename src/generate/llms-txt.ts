// Writes llms.txt (a short index) and llms-full.txt (the full per-component and per-token
// reference) from the same data the tools serve. Both are fully-generated files: an existing
// hand-authored file at the same path is left alone unless `force` is set (see
// `writeGenerated` in shared.ts), and their sizes are always reported so context cost stays
// visible before anyone attaches them.

import { resolve } from 'node:path';
import type { CatalogExport, SystemData, Token, TokenCategory } from '../types.ts';
import { GENERATED_SIGNATURE, consumptionLine, formatSize, writeGenerated } from './shared.ts';

function isGenerated(content: string): boolean {
  return content.includes(GENERATED_SIGNATURE);
}

function tokenCounts(data: SystemData): Array<[TokenCategory, number]> {
  const counts = new Map<TokenCategory, number>();
  for (const t of data.tokens?.tokens ?? []) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export function buildLlmsTxt(data: SystemData): string {
  const name = data.cfg.name ?? data.id;
  const lines: string[] = [
    `<!-- ${GENERATED_SIGNATURE}: llms-txt for ${data.id} -->`,
    `# ${name}`,
    '',
    consumptionLine(data),
    '',
    `Full reference: ds://${data.id}/llms.txt (this file); per-component detail at ds://${data.id}/components/<name>.`,
    '',
    '## Components',
    '',
  ];

  for (const c of data.catalog.components) {
    for (const exp of c.exports) {
      const dep = exp.deprecated ? ' (deprecated)' : '';
      lines.push(`- ${exp.displayName}${dep}: ${exp.description} [ds://${data.id}/components/${exp.displayName}]`);
    }
  }

  lines.push('', '## Tokens', '');
  const counts = tokenCounts(data);
  if (counts.length === 0) {
    lines.push('(no tokens configured)');
  } else {
    for (const [category, count] of counts) {
      lines.push(`- ${category}: ${count} token${count === 1 ? '' : 's'} [ds://${data.id}/tokens]`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function propsTable(exp: CatalogExport): string[] {
  if (exp.props.length === 0) return ['(no props)'];
  const rows = exp.props.map((p) => {
    const desc = `${p.deprecated ? `DEPRECATED: ${p.deprecated}. ` : ''}${p.description ?? ''}`;
    return `| ${p.name} | \`${p.type}\` | ${p.required ? 'yes' : 'no'} | ${p.defaultValue ?? ''} | ${desc} |`;
  });
  return ['| name | type | required | default | description |', '| --- | --- | --- | --- | --- |', ...rows];
}

function tokenLine(t: Token): string {
  const write = t.cssVar ? `var(${t.cssVar})` : t.name;
  const themes = t.valuesByTheme ? ` (${Object.entries(t.valuesByTheme).map(([k, v]) => `${k}: ${v}`).join(', ')})` : '';
  return `- ${t.name} -- write \`${write}\`${t.value ? `, value ${t.value}` : ''}${themes}`;
}

export function buildLlmsFullTxt(data: SystemData): string {
  const name = data.cfg.name ?? data.id;
  const lines: string[] = [
    `<!-- ${GENERATED_SIGNATURE}: llms-full-txt for ${data.id} -->`,
    `# ${name} -- full reference`,
    '',
    consumptionLine(data),
    '',
    '## Components',
    '',
  ];

  for (const c of data.catalog.components) {
    for (const exp of c.exports) {
      lines.push(`### ${exp.displayName}${exp.tagName ? ` (\`${exp.tagName}\`)` : ''}`);
      lines.push(exp.description);
      if (exp.deprecated) {
        const since = exp.deprecated.since ? ` since ${exp.deprecated.since}` : '';
        const repl = exp.deprecated.replacement ? `, use ${exp.deprecated.replacement}` : '';
        lines.push(`DEPRECATED${since}${repl}. ${exp.deprecated.note ?? ''}`.trim());
      }
      lines.push('', 'Props:', ...propsTable(exp));
      // Inherited DOM props are hundreds of names per component and identical across
      // them; listing them would multiply the file for no information an agent lacks.
      if (exp.inheritedProps?.length) lines.push('', `Also accepts ${exp.inheritedProps.length} inherited props (standard DOM and library attributes).`);
      if (exp.events?.length) {
        lines.push('', 'Events:');
        for (const e of exp.events) lines.push(`- ${e.name}${e.type ? `: ${e.type}` : ''}${e.description ? ` -- ${e.description}` : ''}`);
      }
      if (exp.slots?.length) {
        lines.push('', 'Slots:');
        for (const s of exp.slots) lines.push(`- ${s.name === '' ? '(default)' : s.name}${s.description ? ` -- ${s.description}` : ''}`);
      }
      if (exp.a11y?.accessibleName || exp.a11y?.notes?.length) {
        lines.push('', 'Accessibility:');
        if (exp.a11y.accessibleName) lines.push(`- accessible name: ${exp.a11y.accessibleName}`);
        for (const n of exp.a11y.notes ?? []) lines.push(`- ${n}`);
      }
      lines.push('', '---', '');
    }
  }

  lines.push('## Tokens', '');
  if (!data.tokens || data.tokens.tokens.length === 0) {
    lines.push('(no tokens configured)');
  } else {
    const byCategory = new Map<TokenCategory, Token[]>();
    for (const t of data.tokens.tokens) {
      const list = byCategory.get(t.category) ?? [];
      list.push(t);
      byCategory.set(t.category, list);
    }
    for (const [category, tokens] of [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`### ${category}`, '');
      for (const t of tokens) lines.push(tokenLine(t));
      lines.push('');
    }
  }

  return `${lines.join('\n')}\n`;
}

export interface LlmsTxtResult {
  written: string[];
  skipped: string[];
  notes: string[];
}

export function writeLlmsTxt(data: SystemData, outDir: string, opts?: { force?: boolean }): LlmsTxtResult {
  const written: string[] = [];
  const skipped: string[] = [];
  const notes: string[] = [];

  const shortText = buildLlmsTxt(data);
  const fullText = buildLlmsFullTxt(data);
  const shortPath = resolve(outDir, 'llms.txt');
  const fullPath = resolve(outDir, 'llms-full.txt');

  const shortAction = writeGenerated(shortPath, shortText, { force: opts?.force, isGenerated });
  (shortAction === 'written' ? written : skipped).push(shortPath);

  const fullAction = writeGenerated(fullPath, fullText, { force: opts?.force, isGenerated });
  (fullAction === 'written' ? written : skipped).push(fullPath);

  notes.push(`llms.txt ${formatSize(shortText)}, llms-full.txt ${formatSize(fullText)}`);
  if (skipped.length > 0) {
    notes.push(`Left alone, not generated by this tool before (pass force to overwrite): ${skipped.join(', ')}`);
  }

  return { written, skipped, notes };
}

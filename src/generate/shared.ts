// Shared building blocks for every generator: the fixed agent routine (tied to exact tool
// names), the consumption rule, small derived facts (team aliases, do/don't lines), and the
// two file-write idioms every generator reuses -- a fenced marker section that is safe to
// re-render in place, and a fully-generated file that is safe to regenerate but never
// clobbers hand-written content at the same path. No I/O beyond those two write helpers;
// everything else here is pure text over already-loaded SystemData.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SystemData } from '../types.ts';
import { undocumentedValueExports } from '../data/undocumented.ts';

// ---------------------------------------------------------------------------
// The consumption rule
// ---------------------------------------------------------------------------

function firstExport(data: SystemData) {
  for (const c of data.catalog.components) {
    if (c.exports.length > 0) return c.exports[0];
  }
  return undefined;
}

/** The exact import-or-tag rule for this system, in one sentence. */
export function consumptionLine(data: SystemData): string {
  const pkg = data.cfg.componentsPkg ?? data.id;
  const example = firstExport(data);
  if (data.cfg.componentModel === 'custom-elements') {
    const tag = example?.tagName ?? example?.displayName ?? 'tag';
    return `Register once by importing '${pkg}', then use its elements as HTML tags, e.g. <${tag}>...</${tag}> (no per-component import).`;
  }
  const name = example?.displayName ?? 'Component';
  return `Import components by name from '${pkg}', e.g. import { ${name} } from '${pkg}'.`;
}

// ---------------------------------------------------------------------------
// The routine: tied to exact tool names, in a fixed order
// ---------------------------------------------------------------------------

export interface RoutineStep {
  tool: string;
  when: string;
  example: string;
}

/** The fixed agent routine. Order matters: it is the order a build task should reach for each tool. */
export function routineSteps(data: SystemData): RoutineStep[] {
  const example = firstExport(data);
  const exampleName = example?.tagName ?? example?.displayName ?? 'ComponentName';
  return [
    {
      tool: 'search_components',
      when: "Before writing any UI, when you don't know the exact component name.",
      example: `search_components({ query: 'dismissible notice' })`,
    },
    {
      tool: 'resolve_component',
      when: 'Before importing or writing a component name, to confirm it is real.',
      example: `resolve_component({ name: '${exampleName}' })`,
    },
    {
      tool: 'get_component',
      when: 'Before writing any props, for the real prop names, types and allowed values.',
      example: `get_component({ name: '${exampleName}' })`,
    },
    {
      tool: 'find_token',
      when: 'Before writing any color or length value, instead of a raw hex code or px value.',
      example: `find_token({ query: '#1a1a1a' })`,
    },
    {
      tool: 'check_usage',
      when: 'On every file that uses the system, before treating it as done.',
      example: `check_usage({ code: '<snippet>', language: 'tsx' })`,
    },
    {
      tool: 'get_pattern',
      when: 'Before composing a multi-component layout from scratch.',
      example: `get_pattern({ query: 'labeled field with error' })`,
    },
    {
      tool: 'get_guidance',
      when: 'For a when-to-use judgment call the API surface alone does not answer.',
      example: `get_guidance({ topic: 'when not to use a modal' })`,
    },
    {
      tool: 'get_migration',
      when: 'When a component or prop turns out to be deprecated.',
      example: `get_migration({ name: '<deprecated export>' })`,
    },
  ];
}

export const NEVER_INVENT_RULE =
  'Never invent a component name, a prop, or a raw color or length value. A lookup miss is not permission to guess -- it means the concept does not exist here, or needs a different name. Ask the server, not memory.';

// ---------------------------------------------------------------------------
// Derived facts: team aliases and do/don't lines, from real data only
// ---------------------------------------------------------------------------

export interface AliasRow {
  alias: string;
  target: string;
  note?: string;
}

/** Team aliases that resolve to a real target, for a short "this system calls it" table. Empty when the team has not mapped any yet. */
export function teamAliasRows(data: SystemData, kind: 'components' | 'props' = 'components'): AliasRow[] {
  const list = kind === 'components' ? data.aliases.components : data.aliases.props;
  return list
    .filter((a) => a.source === 'team' && a.target)
    .map((a) => ({ alias: a.alias, target: a.target as string, note: a.note }));
}

export interface DoDontLine {
  kind: 'do' | 'dont';
  text: string;
}

/** A handful of concrete do/don't lines derived from this system's own catalog: never a generic placeholder. */
export function derivedDoDont(data: SystemData): DoDontLine[] {
  const lines: DoDontLine[] = [];
  const allExports = data.catalog.components.flatMap((c) => c.exports);

  const deprecatedExport = allExports.find((e) => e.deprecated);
  if (deprecatedExport) {
    const repl = deprecatedExport.deprecated?.replacement ? `, use ${deprecatedExport.deprecated.replacement} instead` : '';
    const note = deprecatedExport.deprecated?.note ? ` (${deprecatedExport.deprecated.note})` : '';
    lines.push({ kind: 'dont', text: `use ${deprecatedExport.displayName}${repl}: it is deprecated${note}.` });
  }

  const deprecatedProp = allExports
    .map((e) => ({ e, p: e.props.find((p) => p.deprecated) }))
    .find((x) => x.p);
  if (deprecatedProp?.p) {
    const note = (deprecatedProp.p.deprecated as string).trim().replace(/\.+$/, '');
    lines.push({ kind: 'dont', text: `set ${deprecatedProp.e.displayName}.${deprecatedProp.p.name}: ${note}.` });
  }

  const needsName = allExports.find((e) => e.a11y?.accessibleName === 'required');
  if (needsName) {
    lines.push({ kind: 'do', text: `give every ${needsName.displayName} an accessible name (label, aria-label, or aria-labelledby) -- get_component reports this as required.` });
  }

  // Props agents commonly misname, from the team alias file: the single most useful
  // correction a skill can carry, because it fires before the model has written anything.
  const propAliases = teamAliasRows(data, 'props').slice(0, 3);
  if (propAliases.length > 0) {
    const pairs = propAliases.map((a) => `${a.target} (not ${a.alias})`).join(', ');
    lines.push({ kind: 'do', text: `write ${pairs}; see the alias table.` });
  }

  // Exports the catalog could not document: real, but check_usage cannot verify their props.
  const undocumented = undocumentedValueExports(data.catalog);
  if (undocumented.length > 0) {
    const sample = undocumented.slice(0, 4).join(', ');
    lines.push({
      kind: 'do',
      text: `read the declaration file before using ${sample}${undocumented.length > 4 ? ` and ${undocumented.length - 4} more` : ''}: they are real exports whose props the catalog could not document, so check_usage cannot verify them.`,
    });
  }

  lines.push({ kind: 'do', text: 'call find_token for every raw color or length before writing it; never hardcode a hex code or px value.' });

  return lines.slice(0, 6);
}

// ---------------------------------------------------------------------------
// Fenced marker sections: AGENTS.md, CLAUDE.md, copilot-instructions.md
// ---------------------------------------------------------------------------

export function beginMarker(systemId: string): string {
  return `<!-- ds-mcp:begin ${systemId} -->`;
}

export function endMarker(systemId: string): string {
  return `<!-- ds-mcp:end ${systemId} -->`;
}

/**
 * Replaces the text between this system's begin/end markers with `section` (which must
 * itself include the markers). Appends a new fenced block when the file has none yet for
 * this system; leaves every other line of the file untouched.
 */
export function upsertMarkedSection(existing: string | undefined, systemId: string, section: string): string {
  const begin = beginMarker(systemId);
  const end = endMarker(systemId);
  if (existing === undefined || existing.length === 0) {
    return `${section}\n`;
  }
  const beginIdx = existing.indexOf(begin);
  const endIdx = existing.indexOf(end);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + end.length);
    return `${before}${section}${after}`;
  }
  const sep = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${sep}${section}\n`;
}

/** Writes (or updates) a marker-fenced file. Creates the file when `createIfMissing`; otherwise a no-op when it does not exist. */
export function writeMarkedFile(path: string, systemId: string, section: string, opts: { createIfMissing: boolean }): 'written' | 'unchanged-missing' {
  const exists = existsSync(path);
  if (!exists && !opts.createIfMissing) return 'unchanged-missing';
  mkdirSync(dirname(path), { recursive: true });
  const existing = exists ? readFileSync(path, 'utf8') : undefined;
  writeFileSync(path, upsertMarkedSection(existing, systemId, section), 'utf8');
  return 'written';
}

// ---------------------------------------------------------------------------
// Fully-generated files: llms.txt, skills, editor rules, .well-known
// ---------------------------------------------------------------------------

/** Embedded in every fully-generated file so a re-run can tell "we wrote this before" apart from a hand-authored file already sitting at the same path. */
export const GENERATED_SIGNATURE = 'ds-mcp:generated';

/**
 * Writes a fully-generated file (no in-place markers, the whole file is ours). An existing
 * file is left alone -- and reported by the caller as skipped -- unless it was generated by
 * this tool before (per `isGenerated`) or `force` is set.
 */
export function writeGenerated(path: string, content: string, opts: { force?: boolean; isGenerated: (existing: string) => boolean }): 'written' | 'skipped' {
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8');
    if (!opts.force && !opts.isGenerated(existing)) {
      return 'skipped';
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return 'written';
}

// ---------------------------------------------------------------------------
// Front matter (SKILL.md, .cursor/rules/*.mdc)
// ---------------------------------------------------------------------------

function yamlScalar(value: string | string[]): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
  }
  // A flat, always-double-quoted scalar is valid YAML and sidesteps every edge case
  // (colons, quotes, leading/trailing space) a generated sentence might contain.
  return JSON.stringify(value);
}

/** A simple `---\nkey: value\n---` front-matter block. Values are always quoted so generated prose (which may contain colons) parses safely. */
export function frontMatterBlock(fields: Record<string, string | string[]>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${yamlScalar(value)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function formatSize(text: string): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  return `${(bytes / 1024).toFixed(1)} KB`;
}

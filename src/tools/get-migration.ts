import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { getComponentDetail } from '../search/index.ts';
import type { CatalogExport, ComponentDetail, SystemId, SystemRegistry } from '../types.ts';
import { resolveSystem, truncate } from './index.ts';

export interface GetMigrationArgs {
  system?: string;
  name: string;
}

export interface ChangelogMention {
  /** Nearest preceding ## / ### heading, usually the version. Empty when the mention precedes any heading. */
  heading: string;
  /** 1-based line number in the file. */
  line: number;
  text: string;
}

export interface GetMigrationResult {
  system: SystemId;
  name: string;
  deprecated: NonNullable<CatalogExport['deprecated']> | null;
  changelog: ChangelogMention[];
  codemods: string[];
}

const inputShape = {
  system: z.string().optional().describe('System id to look up. Optional when only one system is configured.'),
  name: z.string().describe("A component name, or 'Component.prop' to check one prop specifically (e.g. 'Button' or 'Button.type')."),
};

const MAX_CHANGELOG_MENTIONS = 8;

function escapeRegExpChars(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitName(name: string): { component: string; prop?: string } {
  const trimmed = name.trim();
  const dot = trimmed.indexOf('.');
  if (dot === -1) return { component: trimmed };
  return { component: trimmed.slice(0, dot).trim(), prop: trimmed.slice(dot + 1).trim() };
}

function findProp(detail: ComponentDetail, propName: string) {
  const exact = detail.props.find((p) => p.name === propName);
  if (exact) return exact;
  const lc = propName.toLowerCase();
  return detail.props.find((p) => p.name.toLowerCase() === lc);
}

/** CHANGELOG.md preferred, else the first CHANGELOG* file at root (alphabetical), else none. */
function findChangelogFiles(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const matches = entries.filter((f) => /^CHANGELOG(\..+)?$/i.test(f));
  matches.sort((a, b) => {
    const aExact = a.toLowerCase() === 'changelog.md';
    const bExact = b.toLowerCase() === 'changelog.md';
    if (aExact !== bExact) return aExact ? -1 : 1;
    return a.localeCompare(b);
  });
  return matches;
}

/** Up to MAX_CHANGELOG_MENTIONS lines across the matched changelog file(s) that case-sensitively word-match any of `terms`. */
function scanChangelog(root: string, terms: string[]): ChangelogMention[] {
  const patterns = [...new Set(terms.filter((t) => t.length > 0))].map((t) => new RegExp(`\\b${escapeRegExpChars(t)}\\b`));
  if (patterns.length === 0) return [];

  const results: ChangelogMention[] = [];
  for (const file of findChangelogFiles(root)) {
    if (results.length >= MAX_CHANGELOG_MENTIONS) break;
    let content: string;
    try {
      content = readFileSync(resolve(root, file), 'utf8');
    } catch {
      continue;
    }
    let heading = '';
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const headingMatch = /^(#{2,3})\s+(.*?)\s*#*\s*$/.exec(line);
      if (headingMatch) {
        heading = headingMatch[2]!.trim();
        continue;
      }
      if (patterns.some((re) => re.test(line))) {
        results.push({ heading, line: i + 1, text: line.trim() });
        if (results.length >= MAX_CHANGELOG_MENTIONS) break;
      }
    }
  }
  return results;
}

const CODEMOD_DIRS = ['codemods', 'scripts/codemods'];

/** Which of codemods/ and scripts/codemods/ exist at root, and files in them whose lowercased name mentions `component`. */
function scanCodemods(root: string, component: string): { dirsFound: string[]; files: string[] } {
  const dirsFound: string[] = [];
  const files: string[] = [];
  const needle = component.toLowerCase();
  for (const rel of CODEMOD_DIRS) {
    const abs = resolve(root, rel);
    if (!existsSync(abs)) continue;
    dirsFound.push(rel);
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (f.toLowerCase().includes(needle)) files.push(`${rel}/${f}`);
    }
  }
  return { dirsFound, files };
}

function renderText(
  system: SystemId,
  name: string,
  result: Omit<GetMigrationResult, 'system' | 'name'>,
  componentFound: boolean,
  codemodDirsWithNoMatch: string[],
): string {
  const nothingFound = !result.deprecated && result.changelog.length === 0 && result.codemods.length === 0;

  const lines: string[] = [];

  if (result.deprecated) {
    const since = result.deprecated.since ? ` since ${result.deprecated.since}` : '';
    const replacement = result.deprecated.replacement ? `: use ${result.deprecated.replacement} instead` : '';
    lines.push(`${name} is deprecated${since}${replacement}.`.trim());
    if (result.deprecated.note) lines.push(result.deprecated.note);
  } else if (nothingFound) {
    return (
      `Nothing found for '${name}' in ${system}: not marked deprecated, no CHANGELOG mentions, no matching codemods.` +
      (componentFound ? '' : ` (note: '${name}' is not a component in the current catalog -- this only checked text mentions.)`)
    );
  } else {
    lines.push(`${name} is not currently marked deprecated.`);
  }

  if (result.changelog.length > 0) {
    lines.push('\n## Changelog mentions');
    for (const m of result.changelog) {
      const headingPrefix = m.heading ? `${m.heading}: ` : '';
      lines.push(`- ${headingPrefix}${m.text} (line ${m.line})`);
    }
  }

  if (result.codemods.length > 0) {
    lines.push('\n## Codemods');
    for (const c of result.codemods) lines.push(`- ${c}`);
  } else if (codemodDirsWithNoMatch.length > 0) {
    lines.push(`\nA codemods directory exists (${codemodDirsWithNoMatch.join(', ')}) but no file name mentions '${name}'.`);
  }

  return lines.join('\n');
}

export function run(registry: SystemRegistry, args: GetMigrationArgs): { text: string; structured: GetMigrationResult; isError?: true } {
  const resolved = resolveSystem(registry, args.system);
  if ('error' in resolved) {
    return {
      text: resolved.error,
      structured: { system: args.system ?? '', name: args.name, deprecated: null, changelog: [], codemods: [] },
      isError: true,
    };
  }
  const { data } = resolved;

  const { component, prop } = splitName(args.name);
  const detail = getComponentDetail(data, component);

  let deprecated: GetMigrationResult['deprecated'] = null;
  if (prop && detail) {
    const propMatch = findProp(detail, prop);
    if (propMatch?.deprecated) deprecated = { note: propMatch.deprecated };
  }
  if (!deprecated && detail?.deprecated) {
    deprecated = detail.deprecated;
  }

  let changelog: ChangelogMention[] = [];
  let codemods: string[] = [];
  let codemodDirsWithNoMatch: string[] = [];
  if (data.root) {
    const terms = [component, ...(prop ? [prop] : [])];
    changelog = scanChangelog(data.root, terms);
    const codemodResult = scanCodemods(data.root, component);
    codemods = codemodResult.files;
    if (codemodResult.files.length === 0) codemodDirsWithNoMatch = codemodResult.dirsFound;
  }

  const structured: GetMigrationResult = { system: data.id, name: args.name, deprecated, changelog, codemods };
  const text = truncate(renderText(data.id, args.name, { deprecated, changelog, codemods }, Boolean(detail), codemodDirsWithNoMatch));
  return { text, structured };
}

export function register(server: McpServer, registry: SystemRegistry): void {
  server.registerTool(
    'get_migration',
    {
      title: 'Get deprecation and migration info',
      description:
        "Get deprecation and migration information for a component or a specific prop ('Component' or 'Component.prop'): the catalog's own deprecated field, matching CHANGELOG entries, and any codemod that can automate the change. Call this before writing a component or prop that might already be legacy, or when a user says something 'used to work'.",
      inputSchema: inputShape,
    },
    async (args): Promise<CallToolResult> => {
      const result = run(registry, args);
      return {
        content: [{ type: 'text', text: result.text }],
        structuredContent: result.structured as unknown as Record<string, unknown>,
        isError: result.isError,
      };
    },
  );
}

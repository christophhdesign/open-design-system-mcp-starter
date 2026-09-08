// Alias loading and merging: the ecosystem lexicon (never hand-edited) plus a team file that
// maps those aliases, and any others, to a system's real names.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AliasEntry, AliasMap } from '../types.ts';

const LEXICON_URL = new URL('./convention-lexicon.json', import.meta.url);

interface LexiconEntry {
  expected: string;
  occurrences?: number;
  concept?: string;
  note?: string;
}

interface LexiconFile {
  components: LexiconEntry[];
  props: LexiconEntry[];
}

/** Loads the shipped ecosystem lexicon (src/data/convention-lexicon.json) as an AliasMap. */
export function loadLexicon(): AliasMap {
  const raw = readFileSync(LEXICON_URL, 'utf8');
  const json = JSON.parse(raw) as LexiconFile;

  const toEntries = (list: LexiconEntry[] | undefined): AliasEntry[] =>
    (list ?? []).map((e) => ({
      alias: e.expected,
      concept: e.concept,
      note: e.note,
      occurrences: e.occurrences,
      source: 'lexicon',
    }));

  return {
    components: toEntries(json.components),
    props: toEntries(json.props),
  };
}

/**
 * Loads a team-maintained alias file (AliasMap shape). Entries missing `source` default to
 * 'team'. Returns undefined when the file cannot be read.
 */
export function loadTeamAliases(path: string): AliasMap | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }

  let json: Partial<AliasMap>;
  try {
    json = JSON.parse(raw) as Partial<AliasMap>;
  } catch (err) {
    throw new Error(`Team alias file ${path} is not valid JSON: ${(err as Error).message}`);
  }

  const toEntries = (list: unknown): AliasEntry[] => {
    if (!Array.isArray(list)) return [];
    return list.map((e: any) => ({
      alias: String(e?.alias ?? ''),
      concept: typeof e?.concept === 'string' ? e.concept : undefined,
      target: typeof e?.target === 'string' ? e.target : undefined,
      note: typeof e?.note === 'string' ? e.note : undefined,
      occurrences: typeof e?.occurrences === 'number' ? e.occurrences : undefined,
      source: e?.source === 'lexicon' ? 'lexicon' : 'team',
    }));
  };

  return {
    components: toEntries(json.components),
    props: toEntries(json.props),
  };
}

/**
 * Loads `<dataDir>/aliases.code-connect.json` (an AliasMap written at extract time from Figma
 * enum maps). Mirrors loadTeamAliases's not-found/parse-error handling. Returns undefined when
 * the file cannot be read.
 */
export function loadCodeConnectAliases(dataDir: string): AliasMap | undefined {
  const path = join(dataDir, 'aliases.code-connect.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }

  let json: Partial<AliasMap>;
  try {
    json = JSON.parse(raw) as Partial<AliasMap>;
  } catch (err) {
    throw new Error(`Code Connect alias file ${path} is not valid JSON: ${(err as Error).message}`);
  }

  const toEntries = (list: unknown): AliasEntry[] => {
    if (!Array.isArray(list)) return [];
    return list.map((e: any) => ({
      alias: String(e?.alias ?? ''),
      concept: typeof e?.concept === 'string' ? e.concept : undefined,
      target: typeof e?.target === 'string' ? e.target : undefined,
      note: typeof e?.note === 'string' ? e.note : undefined,
      occurrences: typeof e?.occurrences === 'number' ? e.occurrences : undefined,
      source: 'code-connect' as const,
    }));
  };

  return {
    components: toEntries(json.components),
    props: toEntries(json.props),
  };
}

/**
 * Merges the lexicon, an optional Code Connect alias map, and an optional team alias map, in
 * that precedence: team overrides code-connect overrides lexicon on the same alias key.
 */
export function mergeAliases(lexicon: AliasMap, team?: AliasMap, codeConnect?: AliasMap): AliasMap {
  return {
    components: mergeList(lexicon.components, team?.components, codeConnect?.components),
    props: mergeList(lexicon.props, team?.props, codeConnect?.props),
  };
}

function mergeList(lexicon: AliasEntry[], team: AliasEntry[] | undefined, codeConnect: AliasEntry[] | undefined): AliasEntry[] {
  const teamByAlias = new Map((team ?? []).map((e) => [e.alias, e] as const));
  const codeConnectByAlias = new Map((codeConnect ?? []).map((e) => [e.alias, e] as const));
  const merged: AliasEntry[] = [];
  const seen = new Set<string>();

  const resolve = (alias: string, fallback: AliasEntry): AliasEntry => teamByAlias.get(alias) ?? codeConnectByAlias.get(alias) ?? fallback;

  for (const entry of lexicon) {
    merged.push(resolve(entry.alias, entry));
    seen.add(entry.alias);
  }
  for (const entry of codeConnect ?? []) {
    if (seen.has(entry.alias)) continue;
    merged.push(teamByAlias.get(entry.alias) ?? entry);
    seen.add(entry.alias);
  }
  for (const entry of team ?? []) {
    if (!seen.has(entry.alias)) merged.push(entry);
  }
  return merged;
}

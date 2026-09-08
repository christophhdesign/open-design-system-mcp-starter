// dtcg adapter: parses Design Tokens Community Group (DTCG) JSON files into SystemTokens,
// for cfg.tokens = { adapter: 'dtcg', files }.
//
// A token is any object carrying `$value` (or the legacy, pre-spec `value`); everything
// else is a group. `$type` is inherited from the nearest ancestor group when a token or
// group doesn't declare its own. `$description` and `$deprecated` are read when present;
// since the shared Token contract has no deprecated field of its own, a `$deprecated` tag
// is folded into `description` as a trailing note rather than dropped.
//
// Convention: cssVar is '--' plus the dotted path's segments joined with '-'
// ('color.text.muted' -> '--color-text-muted'), the common Style Dictionary default for
// turning a DTCG path into a custom property name.

import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { SystemConfig, SystemId, SystemTokens, Token, TokenCategory } from '../types.ts';
import { sha256 } from './index.ts';

interface FlatToken {
  path: string[];
  type?: string;
  rawValue: unknown;
  description?: string;
  deprecated?: string;
}

interface TokenEntry {
  type?: string;
  description?: string;
  deprecated?: string;
  references: Set<string>;
  /** Insertion-ordered; 'light' (or the first file seen) wins as the default value. */
  valuesByTheme: Map<string, unknown>;
}

// ---------------------------------------------------------------------------------------
// Group walk
// ---------------------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function normalizeDeprecated(raw: unknown): string | undefined {
  if (raw === true) return 'deprecated';
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return undefined;
}

/** Recursively flattens a DTCG group tree into leaf tokens, threading $type inheritance down through ancestor groups. */
function walkGroup(node: unknown, path: string[], inheritedType: string | undefined, out: FlatToken[]): void {
  if (!isPlainObject(node)) return;

  const ownType = typeof node.$type === 'string' ? node.$type : undefined;
  const type = ownType ?? inheritedType;
  const hasValue = Object.prototype.hasOwnProperty.call(node, '$value') || Object.prototype.hasOwnProperty.call(node, 'value');

  if (hasValue) {
    const rawValue = node.$value !== undefined ? node.$value : node.value;
    out.push({
      path,
      type,
      rawValue,
      description: typeof node.$description === 'string' ? node.$description : undefined,
      deprecated: normalizeDeprecated(node.$deprecated),
    });
    return;
  }

  for (const key of Object.keys(node)) {
    if (key.startsWith('$')) continue; // group-level metadata ($type, $description, ...) already consumed above
    walkGroup(node[key], [...path, key], type, out);
  }
}

// ---------------------------------------------------------------------------------------
// Value formatting and references
// ---------------------------------------------------------------------------------------

/** Strings as-is; `{ value, unit }` dimensions as `${value}${unit}`; anything else (composite shadows, typography, arrays) as compact JSON. */
function formatValue(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (isPlainObject(raw) && 'value' in raw && 'unit' in raw) {
    return `${raw.value}${raw.unit}`;
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return JSON.stringify(raw);
}

/** Every `{a.b.c}` reference inside a value, string or composite, scanning the formatted/serialized text catches references nested in composite (shadow, typography) values too. */
function extractReferences(raw: unknown): string[] {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const refs = new Set<string>();
  const re = /\{([a-zA-Z0-9_.-]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) refs.add(m[1]);
  return [...refs];
}

// ---------------------------------------------------------------------------------------
// Category classification
// ---------------------------------------------------------------------------------------

const TYPOGRAPHY_TYPES = new Set(['fontFamily', 'fontWeight', 'fontSize', 'lineHeight', 'letterSpacing', 'typography']);
const MOTION_TYPES = new Set(['duration', 'cubicBezier', 'transition']);
const BORDER_TYPES = new Set(['border', 'strokeStyle']);

/** Splits a path segment on camelCase and kebab/snake/dot boundaries into lowercase words, so a whole-word match ('z') doesn't false-positive inside an unrelated segment ('size'). */
function segmentWords(seg: string): string[] {
  return seg
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .split(/[-_.\s]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

function pathHasWord(path: string[], words: string[]): boolean {
  const all = path.flatMap(segmentWords);
  return all.some((w) => words.includes(w));
}

function classifyCategory(type: string | undefined, path: string[]): TokenCategory {
  if (type === 'color') return 'color';
  if (type === 'dimension') {
    if (pathHasWord(path, ['space', 'spacing', 'gap', 'inset', 'padding', 'margin'])) return 'space';
    if (pathHasWord(path, ['radius', 'rounded'])) return 'radius';
    return 'size';
  }
  if (type && TYPOGRAPHY_TYPES.has(type)) return 'typography';
  if (type === 'shadow') return 'shadow';
  if (type && MOTION_TYPES.has(type)) return 'motion';
  if (type && BORDER_TYPES.has(type)) return 'border';
  if (type === 'number') {
    if (pathHasWord(path, ['opacity', 'alpha'])) return 'opacity';
    if (pathHasWord(path, ['z', 'layer', 'elevation'])) return 'z-index';
    return 'other';
  }
  return 'other';
}

// ---------------------------------------------------------------------------------------
// Theme detection
// ---------------------------------------------------------------------------------------

/** Only meaningful with more than one file: basename match wins over an explicit $theme/theme field. Undefined means "not a theme-specific file". */
function inferTheme(filePath: string, data: unknown, fileCount: number): string | undefined {
  if (fileCount <= 1) return undefined;
  const base = basename(filePath).toLowerCase();
  if (base.includes('high-contrast')) return 'high-contrast';
  if (base.includes('hc')) return 'hc';
  if (base.includes('dark')) return 'dark';
  if (base.includes('light')) return 'light';
  if (isPlainObject(data)) {
    const explicit = typeof data.$theme === 'string' ? data.$theme : typeof data.theme === 'string' ? (data.theme as string) : undefined;
    if (explicit) return explicit;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------
// extractTokens
// ---------------------------------------------------------------------------------------

export function extractTokens(id: SystemId, cfg: SystemConfig, root: string): SystemTokens {
  if (!cfg.tokens || cfg.tokens.adapter !== 'dtcg') {
    throw new Error(`dtcg adapter called with tokens.adapter = '${cfg.tokens?.adapter}'`);
  }

  const filePaths = cfg.tokens.files.map((f) => resolve(root, f));
  const fileContents: string[] = [];
  const parsedFiles: Array<{ path: string; theme?: string; data: unknown }> = [];

  for (const p of filePaths) {
    let raw: string;
    try {
      raw = readFileSync(p, 'utf8');
    } catch (err) {
      throw new Error(`dtcg: could not read ${p}: ${(err as Error).message}`);
    }
    fileContents.push(raw);

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new Error(`dtcg: ${p} is not valid JSON: ${(err as Error).message}`);
    }

    parsedFiles.push({ path: p, theme: inferTheme(p, data, filePaths.length), data });
  }

  const hash = sha256(fileContents.join(''));

  const perName = new Map<string, TokenEntry>();
  const themesSeen = new Set<string>();

  for (const { theme, data } of parsedFiles) {
    if (theme) themesSeen.add(theme);

    const flat: FlatToken[] = [];
    if (isPlainObject(data)) {
      const rootType = typeof data.$type === 'string' ? data.$type : undefined;
      for (const key of Object.keys(data)) {
        if (key.startsWith('$') || key === 'theme') continue;
        walkGroup(data[key], [key], rootType, flat);
      }
    }

    for (const ft of flat) {
      const name = ft.path.join('.');
      let entry = perName.get(name);
      if (!entry) {
        entry = {
          type: ft.type,
          description: ft.description,
          deprecated: ft.deprecated,
          references: new Set(),
          valuesByTheme: new Map(),
        };
        perName.set(name, entry);
      }
      const themeKey = theme ?? 'default';
      if (!entry.valuesByTheme.has(themeKey)) entry.valuesByTheme.set(themeKey, ft.rawValue);
      if (entry.description === undefined && ft.description) entry.description = ft.description;
      if (entry.deprecated === undefined && ft.deprecated) entry.deprecated = ft.deprecated;
      for (const ref of extractReferences(ft.rawValue)) entry.references.add(ref);
    }
  }

  const tokens: Token[] = [];
  for (const [name, entry] of perName) {
    const path = name.split('.');
    const rawDefault = entry.valuesByTheme.get('light') ?? entry.valuesByTheme.values().next().value;
    const value = rawDefault !== undefined ? formatValue(rawDefault) : undefined;

    let valuesByTheme: Record<string, string> | undefined;
    if (entry.valuesByTheme.size > 1) {
      valuesByTheme = {};
      for (const [theme, raw] of entry.valuesByTheme) valuesByTheme[theme] = formatValue(raw);
    }

    const description = entry.deprecated
      ? [entry.description, `Deprecated: ${entry.deprecated}`].filter(Boolean).join(' ')
      : entry.description;

    tokens.push({
      name,
      cssVar: `--${path.join('-')}`,
      value,
      valuesByTheme,
      category: classifyCategory(entry.type, path),
      references: entry.references.size > 0 ? [...entry.references] : undefined,
      description,
    });
  }

  tokens.sort((a, b) => a.name.localeCompare(b.name));

  return {
    system: id,
    generatedAt: new Date().toISOString(),
    source: { root, files: filePaths, adapter: 'dtcg', hash },
    tokens,
    cssVars: tokens.map((t) => t.cssVar!).sort(),
    themes: themesSeen.size ? Array.from(themesSeen).sort() : undefined,
  };
}

/** Same hash extractTokens stamps into source.hash, recomputed from current on-disk source without re-parsing groups. Used for freshness checks. */
export function sourceHash(cfg: SystemConfig, root: string): string {
  if (!cfg.tokens || cfg.tokens.adapter !== 'dtcg') {
    throw new Error(`dtcg adapter called with tokens.adapter = '${cfg.tokens?.adapter}'`);
  }
  const contents = cfg.tokens.files.map((f) => readFileSync(resolve(root, f), 'utf8'));
  return sha256(contents.join(''));
}

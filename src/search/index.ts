// Pure, synchronous search/resolve/detail/token functions over SystemData.
// No I/O: everything here operates on data already loaded into memory.
// This is the layer the tools wrap; keep every function testable without
// the MCP SDK.

import type {
  CatalogExport,
  ComponentDetail,
  ComponentSummary,
  DocChunk,
  Pattern,
  ResolveResult,
  SearchHit,
  SystemData,
  Token,
  TokenCategory,
  TokenHit,
} from '../types.ts';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface ExportRef {
  dir: string;
  exp: CatalogExport;
}

function flattenExports(data: SystemData): ExportRef[] {
  const out: ExportRef[] = [];
  for (const c of data.catalog.components) {
    for (const exp of c.exports) {
      out.push({ dir: c.dir, exp });
    }
  }
  return out;
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function splitSegments(name: string): string[] {
  return name
    .split(/[-_.]+/)
    .flatMap((part) => part.split(/(?=[A-Z])/))
    .map((s) => s.toLowerCase())
    .filter(Boolean);
}

function findExportLoose(data: SystemData, name: string): ExportRef | undefined {
  const trimmed = name.trim();
  const all = flattenExports(data);
  const exact = all.find(({ exp }) => exp.displayName === trimmed || exp.tagName === trimmed);
  if (exact) return exact;
  const lc = trimmed.toLowerCase();
  return all.find(({ exp }) => exp.displayName.toLowerCase() === lc || exp.tagName?.toLowerCase() === lc);
}

// ---------------------------------------------------------------------------
// componentSummary
// ---------------------------------------------------------------------------

export function componentSummary(data: SystemData, exp: CatalogExport): ComponentSummary {
  const pkg = data.cfg.componentsPkg ?? data.id;
  const usage =
    data.cfg.componentModel === 'custom-elements'
      ? (() => {
          const tag = exp.tagName ?? exp.displayName;
          return `<${tag}>...</${tag}> (elements are registered by importing '${pkg}' once; no per-component import)`;
        })()
      : `import { ${exp.displayName} } from '${pkg}'`;
  return {
    name: exp.displayName,
    tagName: exp.tagName,
    description: exp.description,
    usage,
    deprecated: exp.deprecated,
  };
}

// ---------------------------------------------------------------------------
// searchComponents
// ---------------------------------------------------------------------------

interface MatchAccumulator {
  dir: string;
  exp: CatalogExport;
  score: number;
  matchedOn: string[];
}

const SCORE_NAME = 100;
const SCORE_ALIAS = 80;
const SCORE_CONCEPT = 60;
const SCORE_PROP = 40;
const SCORE_DESCRIPTION = 20;
const SCORE_DOCS = 10;

export function searchComponents(data: SystemData, query: string, opts?: { limit?: number }): SearchHit[] {
  const limit = opts?.limit ?? 8;
  const tokens = tokenize(query);
  const normalizedQuery = query.trim().toLowerCase();
  const all = flattenExports(data);

  const acc = new Map<string, MatchAccumulator>();
  const keyOf = (ref: ExportRef) => `${ref.dir}::${ref.exp.displayName}`;
  const add = (ref: ExportRef, score: number, reason: string) => {
    const key = keyOf(ref);
    const entry = acc.get(key) ?? { dir: ref.dir, exp: ref.exp, score: 0, matchedOn: [] };
    entry.score = Math.max(entry.score, score);
    if (!entry.matchedOn.includes(reason)) entry.matchedOn.push(reason);
    acc.set(key, entry);
  };

  if (normalizedQuery.length > 0) {
    // 1. Exact name (tag or class spelling).
    for (const ref of all) {
      const nameLc = ref.exp.displayName.toLowerCase();
      const tagLc = ref.exp.tagName?.toLowerCase();
      if (normalizedQuery === nameLc || (tagLc !== undefined && normalizedQuery === tagLc) || tokens.includes(nameLc) || (tagLc !== undefined && tokens.includes(tagLc))) {
        add(ref, SCORE_NAME, 'name');
      }
    }

    // 2. Team alias with a target.
    for (const alias of data.aliases.components) {
      if (!alias.target) continue;
      const aliasLc = alias.alias.toLowerCase();
      if (normalizedQuery !== aliasLc && !tokens.includes(aliasLc)) continue;
      const target = findExportLoose(data, alias.target);
      if (target) add(target, SCORE_ALIAS, `alias:${alias.alias}`);
    }

    // 3. Lexicon alias without a target: search descriptions by concept words.
    for (const alias of data.aliases.components) {
      if (alias.target || !alias.concept) continue;
      const aliasLc = alias.alias.toLowerCase();
      if (normalizedQuery !== aliasLc && !tokens.includes(aliasLc)) continue;
      const conceptWords = tokenize(alias.concept);
      for (const ref of all) {
        // Match the concept against the description and the name's own segments: a
        // system with no JSDoc still has names, and "form-text-input" should land on
        // TextInput even when its description is empty.
        const words = new Set([...tokenize(ref.exp.description), ...splitSegments(ref.exp.displayName), ...(ref.exp.tagName ? splitSegments(ref.exp.tagName) : [])]);
        const hits = conceptWords.filter((w) => words.has(w)).length;
        if (hits > 0) add(ref, SCORE_CONCEPT + hits, `concept:${alias.concept}`);
      }
    }

    // 4. Prop-name match.
    for (const ref of all) {
      const propNames = [...ref.exp.props.map((p) => p.name), ...(ref.exp.inheritedProps ?? [])];
      for (const p of propNames) {
        if (tokens.includes(p.toLowerCase())) add(ref, SCORE_PROP, `prop:${p}`);
      }
    }

    // 5. Description word overlap.
    for (const ref of all) {
      const descWords = new Set(tokenize(ref.exp.description));
      const overlap = tokens.filter((t) => descWords.has(t)).length;
      if (overlap > 0) add(ref, SCORE_DESCRIPTION + overlap, 'description');
    }

    // 6. Docs mentions.
    if (data.docs) {
      for (const chunk of data.docs.chunks) {
        const chunkWords = new Set(tokenize(`${chunk.heading} ${chunk.text}`));
        if (!tokens.some((t) => chunkWords.has(t))) continue;
        for (const mention of chunk.mentions) {
          const target = findExportLoose(data, mention);
          if (target) add(target, SCORE_DOCS, 'docs');
        }
      }
    }
  }

  const hits: SearchHit[] = [...acc.values()]
    .sort((a, b) => b.score - a.score || a.exp.displayName.localeCompare(b.exp.displayName))
    .slice(0, limit)
    .map((entry) => ({ ...componentSummary(data, entry.exp), score: entry.score, matchedOn: entry.matchedOn }));

  return hits;
}

// ---------------------------------------------------------------------------
// resolveComponent
// ---------------------------------------------------------------------------

function describeMatch(hit: SearchHit): string {
  const reason = hit.matchedOn[0];
  if (!reason) return 'match';
  if (reason === 'name') return 'name match';
  if (reason.startsWith('alias:')) return `alias ${reason.slice('alias:'.length)}`;
  if (reason.startsWith('concept:')) return 'concept';
  if (reason.startsWith('prop:')) return `prop ${reason.slice('prop:'.length)}`;
  return reason;
}

export function resolveComponent(data: SystemData, name: string): ResolveResult {
  const trimmed = name.trim();
  const systemName = data.cfg.name ?? data.id;

  const exact = findExportLoose(data, trimmed);
  if (exact) {
    const caseMatched = exact.exp.displayName === trimmed || exact.exp.tagName === trimmed;
    const summary = componentSummary(data, exact.exp);
    if (caseMatched) {
      return { status: 'exact', system: data.id, component: summary };
    }
    return {
      status: 'exact',
      system: data.id,
      component: {
        ...summary,
        description: `${summary.description} (note: matched case-insensitively; this system spells it "${exact.exp.displayName}".)`,
      },
    };
  }

  const lc = trimmed.toLowerCase();
  const aliasHit = data.aliases.components.find((a) => a.target && a.alias.toLowerCase() === lc);
  if (aliasHit && aliasHit.target) {
    const target = findExportLoose(data, aliasHit.target);
    if (target) {
      return {
        status: 'alias',
        system: data.id,
        alias: aliasHit.alias,
        concept: aliasHit.concept,
        target: componentSummary(data, target.exp),
        note: aliasHit.note,
      };
    }
  }

  const nearest = searchComponents(data, trimmed, { limit: 3 });
  const conceptEntry = data.aliases.components.find((a) => a.alias.toLowerCase() === lc && a.concept);
  const conceptHint = conceptEntry?.concept ? ` Elsewhere '${trimmed}' usually means "${conceptEntry.concept}".` : '';
  const message =
    nearest.length > 0
      ? `'${trimmed}' is not a component in ${systemName}.${conceptHint} Nearest: ${nearest.map((h) => `${h.tagName ?? h.name} (${describeMatch(h)})`).join(', ')}.`
      : `'${trimmed}' is not a component in ${systemName}, and nothing similar was found.${conceptHint} Do not write it. Use search_components with what you need it to do, or compose from existing components.`;

  return { status: 'missing', system: data.id, query: trimmed, message, nearest, concept: conceptEntry?.concept };
}

// ---------------------------------------------------------------------------
// getComponentDetail
// ---------------------------------------------------------------------------

function buildCommonMistakes(data: SystemData, exp: CatalogExport): ComponentDetail['commonMistakes'] {
  const propNames = new Set([...exp.props.map((p) => p.name), ...(exp.inheritedProps ?? [])]);
  const mistakes: NonNullable<ComponentDetail['commonMistakes']> = [];
  for (const alias of data.aliases.props) {
    if (alias.source !== 'team' || !alias.target) continue;
    if (!propNames.has(alias.target)) continue;
    let note = alias.note;
    const lexiconMatch = data.aliases.props.find((a) => a.source === 'lexicon' && a.alias.toLowerCase() === alias.alias.toLowerCase());
    if (lexiconMatch?.occurrences) {
      const seen = `invented ${lexiconMatch.occurrences}x in mined evidence`;
      note = note ? `${note} (${seen})` : `Invented ${lexiconMatch.occurrences}x in mined evidence.`;
    }
    mistakes.push({ wrote: alias.alias, use: alias.target, note });
  }
  return mistakes;
}

export function getComponentDetail(data: SystemData, name: string): ComponentDetail | undefined {
  const found = findExportLoose(data, name);
  if (!found) return undefined;
  const summary = componentSummary(data, found.exp);
  return {
    ...summary,
    props: found.exp.props,
    inheritedProps: found.exp.inheritedProps,
    events: found.exp.events,
    slots: found.exp.slots,
    examples: found.exp.examples ?? [],
    a11y: found.exp.a11y,
    guidance: found.exp.guidance,
    docs: found.exp.docs,
    commonMistakes: buildCommonMistakes(data, found.exp),
  };
}

// ---------------------------------------------------------------------------
// findTokens
// ---------------------------------------------------------------------------

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lN - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

function parseColor(input: string): Rgb | undefined {
  const s = input.trim();
  let m = /^#([0-9a-fA-F]{3})$/.exec(s);
  if (m) {
    const [r, g, b] = m[1]!.split('').map((c) => parseInt(c + c, 16));
    return { r: r!, g: g!, b: b! };
  }
  m = /^#([0-9a-fA-F]{6})$/.exec(s) ?? /^#([0-9a-fA-F]{8})$/.exec(s);
  if (m) {
    const hex = m[1]!;
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
  }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)$/i.exec(s);
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
  m = /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*[\d.]+\s*)?\)$/i.exec(s);
  if (m) return hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
  return undefined;
}

function colorDistance(a: Rgb, b: Rgb): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

function parseLengthPx(input: string): number | undefined {
  const s = input.trim();
  let m = /^(-?\d*\.?\d+)px$/i.exec(s);
  if (m) return parseFloat(m[1]!);
  m = /^(-?\d*\.?\d+)rem$/i.exec(s);
  if (m) return parseFloat(m[1]!) * 16;
  m = /^(-?\d*\.?\d+)$/.exec(s);
  if (m) return parseFloat(m[1]!);
  return undefined;
}

/** Resolves a token's value in a theme, following var(--x) chains up to depth 5. */
function resolveTokenValue(all: Token[], token: Token, theme: string | undefined, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  const raw = (theme !== undefined ? token.valuesByTheme?.[theme] : undefined) ?? token.value;
  if (raw === undefined) return undefined;
  const varMatch = /^var\((--[\w-]+)\)$/.exec(raw.trim());
  if (varMatch) {
    const next = all.find((t) => t.cssVar === varMatch[1]);
    if (!next || next === token) return undefined;
    return resolveTokenValue(all, next, theme, depth + 1);
  }
  return raw;
}

function resolvedCandidates(all: Token[], token: Token): Array<{ theme: string | undefined; value: string }> {
  const themes = new Set<string | undefined>([undefined, ...Object.keys(token.valuesByTheme ?? {})]);
  const out: Array<{ theme: string | undefined; value: string }> = [];
  for (const theme of themes) {
    const v = resolveTokenValue(all, token, theme);
    if (v !== undefined) out.push({ theme, value: v });
  }
  return out;
}

function writeFor(token: Token): string {
  return token.cssVar ? `var(${token.cssVar})` : token.name;
}

export function findTokens(data: SystemData, query: string, opts?: { category?: TokenCategory; limit?: number }): TokenHit[] {
  const limit = opts?.limit ?? 6;
  if (!data.tokens) return [];
  const all = data.tokens.tokens;
  const pool = opts?.category ? all.filter((t) => t.category === opts.category) : all;

  const color = parseColor(query);
  if (color) {
    const hits: TokenHit[] = [];
    for (const t of pool.filter((t) => t.category === 'color')) {
      const candidates = resolvedCandidates(all, t)
        .map(({ theme, value }) => ({ theme, rgb: parseColor(value) }))
        .filter((c): c is { theme: string | undefined; rgb: Rgb } => Boolean(c.rgb));
      if (!candidates.length) continue;
      let best = candidates[0]!;
      let dist = colorDistance(best.rgb, color);
      for (const c of candidates.slice(1)) {
        const d = colorDistance(c.rgb, color);
        if (d < dist) {
          dist = d;
          best = c;
        }
      }
      const where = best.theme ? ` (${best.theme})` : '';
      hits.push({ token: t, score: dist, matchedOn: [`color-distance:${Math.round(dist)}${where}`], write: writeFor(t) });
    }
    hits.sort((a, b) => a.score - b.score);
    return hits.slice(0, limit);
  }

  const px = parseLengthPx(query.trim());
  if (px !== undefined) {
    const hits: TokenHit[] = [];
    for (const t of pool.filter((t) => t.category === 'space' || t.category === 'size' || t.category === 'radius')) {
      const resolved = resolveTokenValue(all, t, undefined);
      const val = resolved !== undefined ? parseLengthPx(resolved) : undefined;
      if (val === undefined) continue;
      const dist = Math.abs(val - px);
      // 'value' is an exact match; anything else says how far off it is, so a
      // model never mistakes the nearest step on a scale for the value it asked for.
      hits.push({ token: t, score: dist, matchedOn: [dist === 0 ? 'value' : `value-nearest:${dist}px`], write: writeFor(t) });
    }
    hits.sort((a, b) => a.score - b.score);
    return hits.slice(0, limit);
  }

  const tokens = tokenize(query);
  const hits: TokenHit[] = [];
  for (const t of pool) {
    const segments = splitSegments(t.name);
    const matchedOn: string[] = [];
    let score = 0;
    for (const seg of segments) {
      if (tokens.includes(seg)) {
        matchedOn.push(`name:${seg}`);
        score += 30;
      }
    }
    if (tokens.includes(t.category)) {
      matchedOn.push('category');
      score += 15;
    }
    if (t.description) {
      const descWords = tokenize(t.description);
      if (tokens.some((tk) => descWords.includes(tk))) {
        matchedOn.push('description');
        score += 10;
      }
    }
    if (score > 0) hits.push({ token: t, score, matchedOn, write: writeFor(t) });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

// ---------------------------------------------------------------------------
// searchDocs
// ---------------------------------------------------------------------------

const DOC_SCORE_HEADING = 100;
const DOC_SCORE_COMPONENT = 90;
const DOC_SCORE_TRAIL = 50;
const DOC_SCORE_BODY = 10;

/** Ranked doc chunks for a topic/question, optionally narrowed to chunks mentioning `component`. Empty when the system has no docs index. */
const DOC_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'be', 'it', 'this', 'that',
  'i', 'we', 'you', 'my', 'our', 'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'when', 'how',
  'what', 'which', 'why', 'where', 'use', 'using', 'used', 'not', 'no', 'if', 'as', 'at', 'by', 'from', 'about',
]);

export function searchDocs(data: SystemData, query: string, opts?: { component?: string; limit?: number }): Array<DocChunk & { score: number; matchedOn: string[] }> {
  const limit = opts?.limit ?? 5;
  if (!data.docs) return [];

  // Questions arrive as prose ("when should I use an alert"); the function
  // words would otherwise match every chunk and drown the real signal.
  const raw = tokenize(query);
  const meaningful = raw.filter((t) => !DOC_STOPWORDS.has(t));
  const tokens = meaningful.length > 0 ? meaningful : raw;
  const wantedComponent = opts?.component?.trim().toLowerCase();

  const results: Array<DocChunk & { score: number; matchedOn: string[] }> = [];
  for (const chunk of data.docs.chunks) {
    let score = 0;
    const matchedOn: string[] = [];

    const headingWords = new Set(tokenize(chunk.heading));
    if (tokens.some((t) => headingWords.has(t))) {
      score += DOC_SCORE_HEADING;
      matchedOn.push('heading');
    }

    if (wantedComponent && chunk.mentions.some((m) => m.toLowerCase() === wantedComponent)) {
      score += DOC_SCORE_COMPONENT;
      matchedOn.push(`component:${opts!.component}`);
    }

    const trailWords = new Set(chunk.trail.flatMap((t) => tokenize(t)));
    if (tokens.some((t) => trailWords.has(t))) {
      score += DOC_SCORE_TRAIL;
      matchedOn.push('trail');
    }

    const bodyWords = new Set(tokenize(chunk.text));
    const overlap = tokens.filter((t) => bodyWords.has(t)).length;
    if (overlap > 0) {
      score += DOC_SCORE_BODY + overlap;
      matchedOn.push('body');
    }

    if (score > 0) results.push({ ...chunk, score, matchedOn });
  }

  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.heading.localeCompare(b.heading));
  return results.slice(0, limit);
}

// ---------------------------------------------------------------------------
// listTokens
// ---------------------------------------------------------------------------

/** Tokens filtered by category and/or query words, sorted by name with numeric-aware ordering ('space-2' before 'space-10'). */
export function listTokens(data: SystemData, opts?: { category?: TokenCategory; query?: string; limit?: number }): Token[] {
  const limit = opts?.limit ?? 40;
  if (!data.tokens) return [];

  let pool = data.tokens.tokens;
  if (opts?.category) pool = pool.filter((t) => t.category === opts.category);

  const query = opts?.query?.trim();
  if (query) {
    const words = tokenize(query);
    pool = pool.filter((t) => {
      const segments = splitSegments(t.name);
      if (words.some((w) => segments.includes(w))) return true;
      if (t.description) {
        const descWords = tokenize(t.description);
        if (words.some((w) => descWords.includes(w))) return true;
      }
      return false;
    });
  }

  const sorted = [...pool].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return sorted.slice(0, limit);
}

// ---------------------------------------------------------------------------
// searchPatterns
// ---------------------------------------------------------------------------

const PATTERN_SCORE_TITLE = 100;
const PATTERN_SCORE_TAG = 60;
const PATTERN_SCORE_COMPONENT = 50;
const PATTERN_SCORE_DESCRIPTION = 10;

/** Ranked authored patterns for a plain-words need ('labeled field with error', 'confirm dialog'). Empty when the system has none. */
export function searchPatterns(data: SystemData, query: string, opts?: { limit?: number }): Array<Pattern & { score: number; matchedOn: string[] }> {
  const limit = opts?.limit ?? 5;
  if (!data.patterns || data.patterns.length === 0) return [];

  // Reuse searchDocs's stopword filtering: prose questions shouldn't let function words drown
  // the real signal.
  const raw = tokenize(query);
  const meaningful = raw.filter((t) => !DOC_STOPWORDS.has(t));
  const tokens = meaningful.length > 0 ? meaningful : raw;

  const results: Array<Pattern & { score: number; matchedOn: string[] }> = [];
  for (const p of data.patterns) {
    let score = 0;
    const matchedOn: string[] = [];

    const titleWords = new Set(tokenize(p.title));
    const titleOverlap = tokens.filter((t) => titleWords.has(t)).length;
    if (titleOverlap > 0) {
      score += PATTERN_SCORE_TITLE + titleOverlap;
      matchedOn.push('title');
    }

    for (const tag of p.tags) {
      const tagWords = tokenize(tag);
      if (tagWords.some((w) => tokens.includes(w))) {
        score += PATTERN_SCORE_TAG;
        matchedOn.push(`tag:${tag}`);
      }
    }

    for (const c of p.components) {
      const segments = splitSegments(c);
      const hits = tokens.filter((t) => segments.includes(t)).length;
      if (hits > 0) {
        score += PATTERN_SCORE_COMPONENT + hits;
        matchedOn.push(`component:${c}`);
      }
    }

    const descWords = new Set(tokenize(p.description));
    const descOverlap = tokens.filter((t) => descWords.has(t)).length;
    if (descOverlap > 0) {
      score += PATTERN_SCORE_DESCRIPTION + descOverlap;
      matchedOn.push('description');
    }

    if (score > 0) results.push({ ...p, score, matchedOn });
  }

  results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return results.slice(0, limit);
}

// Loads one system's data dir into memory (SystemData), builds the multi-system registry, and
// checks committed data against source for staleness.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DocsIndex, Pattern, SystemCatalog, SystemConfig, SystemData, SystemId, SystemRegistry, SystemTokens } from '../types.ts';
import { resolveDataDir, resolveRoot, type LoadedConfig } from '../config.ts';
import { currentSourceHashes, sha256 } from '../adapters/index.ts';
import { loadCodeConnectAliases, loadLexicon, loadTeamAliases, mergeAliases } from './aliases.ts';
import { applyOverlay, loadOverlay } from './overlay.ts';

/**
 * Reads catalog.json (required), tokens.json and docs-index.json (optional), and aliases
 * (lexicon merged with the team file), for one configured system.
 */
export function loadSystemData(id: SystemId, cfg: SystemConfig, configDir: string): SystemData {
  const dataDir = resolveDataDir(id, cfg, configDir);
  const root = resolveRoot(cfg, configDir);

  const catalogPath = resolve(dataDir, 'catalog.json');
  if (!existsSync(catalogPath)) {
    throw new Error(
      `System '${id}' has no catalog at ${catalogPath}. Run: npx tsx src/cli.ts extract --system ${id}`
    );
  }
  let catalog = readJson<SystemCatalog>(catalogPath, `catalog for '${id}'`);
  assertCatalogShape(catalog, catalogPath);

  const overlayPath = resolve(dataDir, 'overlay.json');
  if (existsSync(overlayPath)) {
    const overlay = loadOverlay(overlayPath);
    if (overlay) {
      const hash = sha256(readFileSync(overlayPath, 'utf8'));
      catalog = applyOverlay(catalog, overlay, { path: overlayPath, hash, componentModel: cfg.componentModel }).catalog;
    }
  }

  let tokens: SystemTokens | undefined;
  const tokensPath = resolve(dataDir, 'tokens.json');
  if (existsSync(tokensPath)) {
    tokens = readJson<SystemTokens>(tokensPath, `tokens for '${id}'`);
  }

  let docs: DocsIndex | undefined;
  const docsPath = resolve(dataDir, 'docs-index.json');
  if (existsSync(docsPath)) {
    docs = readJson<DocsIndex>(docsPath, `docs index for '${id}'`);
  }

  const lexicon = loadLexicon();
  const teamAliasPath = cfg.aliases ? resolve(configDir, cfg.aliases) : resolve(dataDir, 'aliases.json');
  const team = existsSync(teamAliasPath) ? loadTeamAliases(teamAliasPath) : undefined;
  const aliases = mergeAliases(lexicon, team, loadCodeConnectAliases(dataDir));

  const patterns = loadPatterns(dataDir, catalog, cfg);

  return { id, cfg, root, dataDir, catalog, tokens, docs, patterns, aliases };
}

// ---------------------------------------------------------------------------
// Patterns: authored recipes at <dataDir>/patterns/*.md
// ---------------------------------------------------------------------------

/** What parsePatternFile needs from the loaded catalog to detect which components a pattern uses. */
export interface PatternParseContext {
  componentModel?: 'react' | 'custom-elements';
  /** Catalog displayName values (react: PascalCase export; custom-elements: usually the dashed tag). */
  exportNames: string[];
  /** Catalog tagName values, when the system declares them separately from displayName. */
  tagNames: string[];
}

interface PatternFrontMatter {
  title?: string;
  description?: string;
  tags?: string[];
  language?: string;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseTagsValue(value: string): string[] {
  let inner = value.trim();
  if (inner.startsWith('[') && inner.endsWith(']')) inner = inner.slice(1, -1);
  return inner
    .split(',')
    .map((t) => stripQuotes(t))
    .filter((t) => t.length > 0);
}

/** Splits optional `---`-delimited YAML-ish front matter (title/description/tags/language) from the markdown body. */
function parseFrontMatter(text: string): { meta: PatternFrontMatter; body: string } {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { meta: {}, body: text };

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { meta: {}, body: text };

  const meta: PatternFrontMatter = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!;
    if (key === 'title') meta.title = stripQuotes(value);
    else if (key === 'description') meta.description = stripQuotes(value);
    else if (key === 'language') meta.language = stripQuotes(value);
    else if (key === 'tags') meta.tags = parseTagsValue(value);
  }

  return { meta, body: lines.slice(end + 1).join('\n') };
}

function firstH1(body: string): string | undefined {
  const m = /^#\s+(.+?)\s*$/m.exec(body);
  return m?.[1]?.trim();
}

/** First run of non-empty, non-heading, non-fenced lines in the body. */
function firstParagraph(body: string): string | undefined {
  const lines = body.split(/\r?\n/);
  let inFence = false;
  const collected: string[] = [];
  for (const line of lines) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^#{1,6}\s+/.test(line)) {
      if (collected.length > 0) break;
      continue;
    }
    if (line.trim() === '') {
      if (collected.length > 0) break;
      continue;
    }
    collected.push(line.trim());
  }
  return collected.length > 0 ? collected.join(' ') : undefined;
}

/** The first fenced code block in the body: its info string (language) and content. */
function firstFencedBlock(body: string): { lang?: string; code: string } | undefined {
  const m = /```([^\n`]*)\n([\s\S]*?)```/.exec(body);
  if (!m) return undefined;
  const lang = m[1]?.trim();
  return { lang: lang && lang.length > 0 ? lang : undefined, code: m[2]!.replace(/\n$/, '') };
}

function escapeRegExpChars(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Catalog export/tag names that appear in `code` as a JSX tag (`<Name`) or a dashed tag (`<name-x`), open or close. */
function detectComponents(code: string, exportNames: string[], tagNames: string[]): string[] {
  const candidates = new Set([...exportNames, ...tagNames].filter(Boolean));
  const found = new Set<string>();
  for (const name of candidates) {
    const re = new RegExp(`</?${escapeRegExpChars(name)}(?=[\\s/>])`);
    if (re.test(code)) found.add(name);
  }
  return [...found].sort();
}

/**
 * Parses one pattern markdown file into a Pattern. Pure and filesystem-free so it is directly
 * unit-testable: front matter (title/description/tags/language) wins when present, otherwise the
 * first H1 is the title, the first paragraph is the description, and the first fenced code block
 * is the code (its info string is the language, defaulting to tsx for react / html for
 * custom-elements when neither front matter nor the fence say).
 */
export function parsePatternFile(id: string, text: string, ctx: PatternParseContext): Pattern {
  const { meta, body } = parseFrontMatter(text);
  const fence = firstFencedBlock(body);
  const defaultLanguage = ctx.componentModel === 'custom-elements' ? 'html' : 'tsx';
  const code = fence?.code ?? '';

  return {
    id,
    title: meta.title ?? firstH1(body) ?? id,
    description: meta.description ?? firstParagraph(body) ?? '',
    code,
    language: meta.language ?? fence?.lang ?? defaultLanguage,
    components: detectComponents(code, ctx.exportNames, ctx.tagNames),
    tags: meta.tags ?? [],
  };
}

/** Reads every `<dataDir>/patterns/*.md` file, when the directory exists. Undefined when it doesn't. */
function loadPatterns(dataDir: string, catalog: SystemCatalog, cfg: SystemConfig): Pattern[] | undefined {
  const dir = resolve(dataDir, 'patterns');
  if (!existsSync(dir)) return undefined;

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort();
  } catch {
    return undefined;
  }

  const exportNames = catalog.allExports;
  const tagNames = catalog.components.flatMap((c) => c.exports.map((e) => e.tagName).filter((t): t is string => Boolean(t)));

  const patterns: Pattern[] = [];
  for (const file of files) {
    const id = file.replace(/\.md$/i, '');
    let text: string;
    try {
      text = readFileSync(resolve(dir, file), 'utf8');
    } catch {
      continue;
    }
    patterns.push(parsePatternFile(id, text, { componentModel: cfg.componentModel, exportNames, tagNames }));
  }
  return patterns;
}

function readJson<T>(path: string, label: string): T {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Could not read ${label} at ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${label} at ${path} is not valid JSON: ${(err as Error).message}`);
  }
}

function assertCatalogShape(catalog: unknown, path: string): asserts catalog is SystemCatalog {
  if (!catalog || typeof catalog !== 'object') {
    throw new Error(`Catalog at ${path} is not a JSON object.`);
  }
  const c = catalog as Record<string, unknown>;
  if (!Array.isArray(c.components)) {
    throw new Error(`Catalog at ${path} is missing a "components" array.`);
  }
  if (!Array.isArray(c.allExports)) {
    throw new Error(`Catalog at ${path} is missing an "allExports" array.`);
  }
  if (!c.allPropsByExport || typeof c.allPropsByExport !== 'object') {
    throw new Error(`Catalog at ${path} is missing an "allPropsByExport" object.`);
  }
}

/**
 * Recomputes what `loadSystemData` did with `<dataDir>/overlay.json`, without re-loading
 * anything else, so `doctor` can report which overlay names did not resolve to a real export
 * (a typo, or a name that stopped being real) without the SystemData shape carrying that around.
 * Undefined when the system has no overlay file.
 */
export function overlayReport(dataDir: string, catalog: SystemCatalog): { path: string; touched: number; unknown: string[] } | undefined {
  const overlayPath = resolve(dataDir, 'overlay.json');
  if (!existsSync(overlayPath)) return undefined;
  const overlay = loadOverlay(overlayPath);
  if (!overlay) return undefined;

  const hash = sha256(readFileSync(overlayPath, 'utf8'));
  const { touched, unknown } = applyOverlay(catalog, overlay, { path: overlayPath, hash });
  return { path: overlayPath, touched: touched.length, unknown };
}

/** Loads every configured system and builds the registry `get()`/`ids()` resolve through. */
export function buildRegistry(loaded: LoadedConfig): SystemRegistry {
  const systems = new Map<SystemId, SystemData>();
  for (const [id, cfg] of Object.entries(loaded.config.systems)) {
    systems.set(id, loadSystemData(id, cfg, loaded.configDir));
  }
  const ids = Array.from(systems.keys());

  return {
    systems,
    ids: () => ids.slice(),
    get(id?: SystemId): SystemData {
      if (id !== undefined) {
        const found = systems.get(id);
        if (!found) {
          throw new Error(
            `Unknown system '${id}'. Configured systems: ${ids.length ? ids.join(', ') : '(none)'}`
          );
        }
        return found;
      }
      if (ids.length === 1) return systems.get(ids[0])!;
      if (ids.length === 0) {
        throw new Error('No systems configured.');
      }
      throw new Error(
        `Multiple systems configured (${ids.join(', ')}); pass a "system" argument to disambiguate.`
      );
    },
  };
}

export interface FreshnessReport {
  system: SystemId;
  catalog: 'fresh' | 'stale' | 'unknown';
  tokens: 'fresh' | 'stale' | 'unknown' | 'none';
  docs: 'fresh' | 'stale' | 'unknown' | 'none';
  codeConnect: 'fresh' | 'stale' | 'unknown' | 'none';
  details: string[];
}

/** Compares a loaded system's stamped source hashes against the current on-disk source. */
export function checkFreshness(data: SystemData): FreshnessReport {
  const details: string[] = [];

  if (!data.root) {
    return {
      system: data.id,
      catalog: 'unknown',
      tokens: data.tokens ? 'unknown' : 'none',
      docs: data.docs ? 'unknown' : 'none',
      codeConnect: data.catalog.source.codeConnect ? 'unknown' : 'none',
      details: [
        `No root resolved for '${data.id}' (set "root" or the rootEnv-named env var in ds.config.json); cannot check freshness.`,
      ],
    };
  }

  const current = currentSourceHashes(data.cfg, data.root);

  let catalogStatus: FreshnessReport['catalog'] = 'unknown';
  const stampedCatalogHash = data.catalog.source?.srcHash;
  if (current.catalog === undefined || stampedCatalogHash === undefined) {
    details.push('Catalog freshness could not be determined (no source hash available).');
  } else if (current.catalog === stampedCatalogHash) {
    catalogStatus = 'fresh';
  } else {
    catalogStatus = 'stale';
    details.push('Catalog is stale: the source has changed since the last extract.');
  }

  let tokensStatus: FreshnessReport['tokens'] = data.tokens ? 'unknown' : 'none';
  if (data.tokens) {
    const stampedTokensHash = data.tokens.source?.hash;
    if (current.tokens === undefined || stampedTokensHash === undefined) {
      details.push('Tokens freshness could not be determined (no source hash available).');
    } else if (current.tokens === stampedTokensHash) {
      tokensStatus = 'fresh';
    } else {
      tokensStatus = 'stale';
      details.push('Tokens are stale: the source has changed since the last extract.');
    }
  }

  let docsStatus: FreshnessReport['docs'] = data.docs ? 'unknown' : 'none';
  if (data.docs) {
    const stamped = data.docs.sourceHash;
    if (!stamped || !current.docs) {
      details.push('Docs freshness could not be determined (no source hash available).');
    } else if (stamped === current.docs) {
      docsStatus = 'fresh';
    } else {
      docsStatus = 'stale';
      details.push('Docs index is stale: the markdown has changed since the last extract.');
    }
  }

  let codeConnectStatus: FreshnessReport['codeConnect'] = data.catalog.source.codeConnect ? 'unknown' : 'none';
  if (data.catalog.source.codeConnect) {
    const stamped = data.catalog.source.codeConnect.hash;
    if (!stamped || !current.codeConnect) {
      details.push('Code Connect freshness could not be determined (no source hash available).');
    } else if (stamped === current.codeConnect) {
      codeConnectStatus = 'fresh';
    } else {
      codeConnectStatus = 'stale';
      details.push('Code Connect mappings changed since the last extract.');
    }
  }

  return { system: data.id, catalog: catalogStatus, tokens: tokensStatus, docs: docsStatus, codeConnect: codeConnectStatus, details };
}

// Adapter dispatch: picks the right catalog/tokens adapter from a SystemConfig, writes
// catalog.json / tokens.json into the system's data dir, and recomputes source hashes for
// freshness checks without re-extracting.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AliasMap, DocsIndex, SystemCatalog, SystemConfig, SystemId, SystemTokens } from '../types.ts';
import { resolveDataDir, resolveRoot } from '../config.ts';
import { extractCatalog as extractCatalogJson } from './catalog-json.ts';
import { extractCatalog as extractCatalogCem } from './custom-elements-manifest.ts';
import { extractTokens as extractTokensCssVars } from './css-vars-tokens.ts';
import { buildDocsIndex, docsSourceHash } from './markdown-docs.ts';
import { extractCatalog as extractCatalogDocgen, sourceHash as docgenSourceHash } from './react-docgen.ts';
import { extractTokens as extractTokensDtcg, sourceHash as dtcgSourceHash } from './dtcg-tokens.ts';
import { codeConnectSourceHash, collectCodeConnectFiles, enrichFromCodeConnect, parseCodeConnectFile } from './code-connect.ts';

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export interface ExtractResult {
  catalog: SystemCatalog;
  tokens?: SystemTokens;
  /** Present when cfg.docs is set: the heading-chunked markdown index. */
  docs?: DocsIndex;
  /** Present when cfg.codeConnect is set: how the Code Connect files matched the catalog. */
  codeConnect?: { files: number; mapped: number; unmatched: string[] };
  /** Absolute paths of every file written. */
  written: string[];
}

function unimplementedAdapterError(adapter: string): Error {
  return new Error(
    `adapter '${adapter}' is not implemented. ` +
      `Use 'catalog-json' or 'custom-elements-manifest' for the catalog, or 'css-vars' for tokens.`
  );
}

function requireRoot(id: SystemId, adapter: string, root: string | undefined): string {
  if (!root) {
    throw new Error(
      `System '${id}' has no resolvable root for the '${adapter}' adapter. ` +
        `Set "root" (or the env var named by "rootEnv") in ds.config.json.`
    );
  }
  return root;
}

/** `codeConnect.root`, relative to configDir when set; otherwise the system root itself. */
function resolveCodeConnectRoot(cfg: SystemConfig, configDir: string, systemRoot: string | undefined): string | undefined {
  const ccRoot = cfg.codeConnect?.root;
  if (!ccRoot) return systemRoot;
  return isAbsolute(ccRoot) ? ccRoot : resolve(configDir, ccRoot);
}

/**
 * Writes pretty JSON, but keeps the previous file's generatedAt when nothing
 * else changed. The data dir is committed on purpose, and a timestamp that
 * moves on every extract would turn every run into a meaningless diff.
 */
function writeStamped(path: string, next: { generatedAt: string } & Record<string, unknown>): void {
  let out = next;
  try {
    const prev = JSON.parse(readFileSync(path, 'utf8')) as { generatedAt?: string } & Record<string, unknown>;
    if (typeof prev.generatedAt === 'string') {
      const a = JSON.stringify({ ...prev, generatedAt: '' });
      const b = JSON.stringify({ ...next, generatedAt: '' });
      if (a === b) out = { ...next, generatedAt: prev.generatedAt };
    }
  } catch {
    // no previous file, or unreadable: write fresh
  }
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
}

/**
 * Committed data must not carry one machine's absolute paths: they leak a username and
 * make the same extract differ from clone to clone. Source roots and file lists are
 * stored relative to the config directory (posix separators); freshness never reads
 * them back, it recomputes from the config.
 */
function relativizeSources(configDir: string, catalog: SystemCatalog, tokens: SystemTokens | undefined): void {
  const rel = (p: string) => {
    if (!isAbsolute(p)) return p;
    const r = relative(configDir, p).split(sep).join('/');
    return r === '' ? '.' : r;
  };
  catalog.source.root = rel(catalog.source.root);
  if (tokens) {
    tokens.source.root = rel(tokens.source.root);
    tokens.source.files = tokens.source.files.map(rel);
  }
}

export function runExtract(
  id: SystemId,
  cfg: SystemConfig,
  configDir: string,
  opts?: { dataDir?: string }
): ExtractResult {
  const root = resolveRoot(cfg, configDir);

  let catalog: SystemCatalog;
  switch (cfg.catalog.adapter) {
    case 'catalog-json':
      catalog = extractCatalogJson(id, cfg, requireRoot(id, cfg.catalog.adapter, root));
      break;
    case 'custom-elements-manifest':
      catalog = extractCatalogCem(id, cfg, requireRoot(id, cfg.catalog.adapter, root));
      break;
    case 'react-docgen':
      catalog = extractCatalogDocgen(id, cfg, requireRoot(id, cfg.catalog.adapter, root));
      break;
    default:
      throw unimplementedAdapterError((cfg.catalog as { adapter: string }).adapter);
  }

  let tokens: SystemTokens | undefined;
  if (cfg.tokens) {
    switch (cfg.tokens.adapter) {
      case 'css-vars':
        tokens = extractTokensCssVars(id, cfg, requireRoot(id, cfg.tokens.adapter, root));
        break;
      case 'dtcg':
        tokens = extractTokensDtcg(id, cfg, requireRoot(id, cfg.tokens.adapter, root));
        break;
      default:
        throw unimplementedAdapterError((cfg.tokens as { adapter: string }).adapter);
    }
  }

  relativizeSources(configDir, catalog, tokens);

  const dataDir = opts?.dataDir ?? resolveDataDir(id, cfg, configDir);
  mkdirSync(dataDir, { recursive: true });

  const written: string[] = [];

  let codeConnectResult: { files: number; mapped: number; unmatched: string[] } | undefined;
  if (cfg.codeConnect) {
    const ccRoot = requireRoot(id, 'code-connect', resolveCodeConnectRoot(cfg, configDir, root));
    const files = collectCodeConnectFiles(ccRoot, cfg.codeConnect.include);
    const mappings = files.flatMap((f) => {
      try {
        return parseCodeConnectFile(relative(ccRoot, f), readFileSync(f, 'utf8'));
      } catch {
        return [];
      }
    });
    const hash = codeConnectSourceHash(ccRoot, cfg.codeConnect.include);
    const enriched = enrichFromCodeConnect(catalog, mappings, { files: files.length, hash });
    catalog = enriched.catalog;
    codeConnectResult = { files: files.length, mapped: enriched.mapped.length, unmatched: enriched.unmatched };

    const aliasPath = join(dataDir, 'aliases.code-connect.json');
    if (enriched.aliases.length > 0) {
      const aliasMap: AliasMap = { components: [], props: enriched.aliases };
      writeFileSync(aliasPath, `${JSON.stringify(aliasMap, null, 2)}\n`, 'utf8');
      written.push(aliasPath);
    } else if (existsSync(aliasPath)) {
      // No aliases this run: delete a stale file from a previous run rather than leaving it
      // to linger with mappings that no longer exist.
      unlinkSync(aliasPath);
    }
  }

  const catalogPath = join(dataDir, 'catalog.json');
  writeStamped(catalogPath, catalog as unknown as { generatedAt: string } & Record<string, unknown>);
  written.push(catalogPath);

  if (tokens) {
    const tokensPath = join(dataDir, 'tokens.json');
    writeStamped(tokensPath, tokens as unknown as { generatedAt: string } & Record<string, unknown>);
    written.push(tokensPath);
  }

  let docs: DocsIndex | undefined;
  if (cfg.docs) {
    const docsRoot = requireRoot(id, 'markdown-docs', root);
    docs = { ...buildDocsIndex(id, cfg, docsRoot, catalog), sourceHash: docsSourceHash(cfg, docsRoot) };
    const docsPath = join(dataDir, 'docs-index.json');
    writeStamped(docsPath, docs as unknown as { generatedAt: string } & Record<string, unknown>);
    written.push(docsPath);
  }

  return { catalog, tokens, docs, codeConnect: codeConnectResult, written };
}

/**
 * Recomputes the same hashes the adapters stamp into source.srcHash / source.hash, from the
 * current on-disk source, without running a full extract. Used by `doctor` / checkFreshness.
 */
export function currentSourceHashes(
  cfg: SystemConfig,
  root: string | undefined
): { catalog?: string; tokens?: string; docs?: string; codeConnect?: string } {
  const result: { catalog?: string; tokens?: string; docs?: string; codeConnect?: string } = {};
  if (!root) return result;

  try {
    if (cfg.docs) result.docs = docsSourceHash(cfg, root);
  } catch {
    // leave undefined
  }

  try {
    if (cfg.codeConnect) {
      // No configDir is available here (this recomputes from on-disk source only), so a
      // relative codeConnect.root resolves against the system root rather than the config
      // file's directory. This matches runExtract when codeConnect.root is unset (the common
      // case); a codeConnect.root pointing at a sibling checkout still hashes, just resolved
      // relative to root instead of configDir.
      const ccRoot = cfg.codeConnect.root
        ? (isAbsolute(cfg.codeConnect.root) ? cfg.codeConnect.root : resolve(root, cfg.codeConnect.root))
        : root;
      result.codeConnect = codeConnectSourceHash(ccRoot, cfg.codeConnect.include);
    }
  } catch {
    // leave undefined
  }

  try {
    if (cfg.catalog.adapter === 'catalog-json' || cfg.catalog.adapter === 'custom-elements-manifest') {
      const p = resolve(root, cfg.catalog.path);
      result.catalog = sha256(readFileSync(p, 'utf8'));
    } else if (cfg.catalog.adapter === 'react-docgen') {
      result.catalog = docgenSourceHash(cfg, root);
    }
  } catch {
    // leave undefined: unreadable source means "unknown", not "stale"
  }

  try {
    if (cfg.tokens?.adapter === 'css-vars') {
      const contents = cfg.tokens.files.map((f) => readFileSync(resolve(root, f), 'utf8'));
      result.tokens = sha256(contents.join(''));
    } else if (cfg.tokens?.adapter === 'dtcg') {
      result.tokens = dtcgSourceHash(cfg, root);
    }
  } catch {
    // leave undefined
  }

  return result;
}

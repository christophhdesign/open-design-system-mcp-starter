// markdown-docs adapter: walks `cfg.docs.include` (minus `cfg.docs.exclude`) globs relative to
// `root`, chunks every matched markdown file by heading, and records which catalog exports each
// chunk mentions. No dependency on node's experimental fs.globSync: a small walker plus a
// hand-rolled glob matcher (supporting `**`, `*`, `?`, `{a,b}`) does the matching so nothing
// prints an experimental-API warning.

import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import type { DocChunk, DocsIndex, SystemCatalog, SystemConfig, SystemId } from '../types.ts';
import { sha256 } from './index.ts';

const MAX_CHUNK_CHARS = 1200;

// ---------------------------------------------------------------------------
// Glob matching: walk the tree once, then test each relative path against
// compiled include/exclude patterns.
// ---------------------------------------------------------------------------

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

function relPosix(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join('/');
}

/** Expands one level of `{a,b,c}` alternation (possibly several groups in one pattern). */
function expandBraces(pattern: string): string[] {
  const start = pattern.indexOf('{');
  if (start === -1) return [pattern];
  const end = pattern.indexOf('}', start);
  if (end === -1) return [pattern];
  const prefix = pattern.slice(0, start);
  const options = pattern.slice(start + 1, end).split(',');
  const suffix = pattern.slice(end + 1);
  const suffixes = expandBraces(suffix);
  const out: string[] = [];
  for (const opt of options) {
    for (const rest of suffixes) {
      out.push(`${prefix}${opt}${rest}`);
    }
  }
  return out;
}

function escapeRegexChar(c: string): string {
  return /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

/** Translates one (brace-free) glob into a regex source matching a `/`-joined relative path. */
function globToRegexSource(glob: string): string {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
          continue;
        }
        out += '.*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    out += escapeRegexChar(c);
    i += 1;
  }
  return out;
}

function compileGlobs(patterns: string[]): RegExp[] {
  return patterns.flatMap((p) => expandBraces(p)).map((p) => new RegExp(`^${globToRegexSource(p)}$`));
}

/** Absolute paths of every file under `root` matching `docs.include` and not `docs.exclude`, sorted by relative path. */
const GLOB_CHARS = /[*?{[]/;

function matchedFiles(root: string, docs: { include: string[]; exclude?: string[] }): string[] {
  // A literal path (no glob characters) is taken as an explicit request and read
  // even where the walker would not look, such as a README shipped inside
  // node_modules by a system consumed from npm. Globs still go through the walker,
  // which skips node_modules and dot-directories.
  const literal = docs.include.filter((p) => !GLOB_CHARS.test(p));
  const globs = docs.include.filter((p) => GLOB_CHARS.test(p));
  const excludeRes = compileGlobs(docs.exclude ?? []);
  const found = new Set<string>();
  for (const rel of literal) {
    const abs = resolve(root, rel);
    if (existsSync(abs) && statSync(abs).isFile() && !excludeRes.some((re) => re.test(relPosix(root, abs)))) found.add(abs);
  }
  if (globs.length > 0) {
    const includeRes = compileGlobs(globs);
    for (const f of walkFiles(root)) {
      const rel = relPosix(root, f);
      if (!includeRes.some((re) => re.test(rel))) continue;
      if (excludeRes.some((re) => re.test(rel))) continue;
      found.add(f);
    }
  }
  const matches = [...found];
  matches.sort((a, b) => relPosix(root, a).localeCompare(relPosix(root, b)));
  return matches;
}

// ---------------------------------------------------------------------------
// Heading chunking
// ---------------------------------------------------------------------------

interface Section {
  level: number;
  heading: string;
  bodyLines: string[];
}

function isFenceLine(line: string): string | undefined {
  const m = /^\s*(`{3,}|~{3,})/.exec(line);
  return m ? m[1]![0] : undefined;
}

function truncateText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_CHUNK_CHARS ? trimmed.slice(0, MAX_CHUNK_CHARS) : trimmed;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Catalog export names (displayName + tagName) appearing as a whole word (plain or backticked) in `text`. */
function findMentions(exportNames: string[], text: string): string[] {
  const found: string[] = [];
  for (const name of exportNames) {
    if (!name) continue;
    const re = new RegExp(`\\b${escapeRegExp(name)}\\b`);
    if (re.test(text)) found.push(name);
  }
  return found;
}

function catalogExportNames(catalog: SystemCatalog): string[] {
  const names = new Set<string>();
  for (const c of catalog.components) {
    for (const exp of c.exports) {
      names.add(exp.displayName);
      if (exp.tagName) names.add(exp.tagName);
    }
  }
  return [...names];
}

function basenameNoExt(relPath: string): string {
  const b = basename(relPath);
  const dot = b.lastIndexOf('.');
  return dot > 0 ? b.slice(0, dot) : b;
}

function chunkMarkdownFile(relPath: string, content: string, exportNames: string[]): DocChunk[] {
  const lines = content.split(/\r?\n/);
  const preambleLines: string[] = [];
  const sections: Section[] = [];
  let current: Section | undefined;
  let inFence = false;
  let fenceChar = '';
  let firstH1: string | undefined;

  const pushLine = (line: string) => {
    if (current) current.bodyLines.push(line);
    else preambleLines.push(line);
  };

  for (const line of lines) {
    const fence = isFenceLine(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceChar = fence;
      } else if (fence === fenceChar) {
        inFence = false;
      }
      pushLine(line);
      continue;
    }
    if (inFence) {
      pushLine(line);
      continue;
    }
    const headingMatch = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const heading = headingMatch[2]!.trim();
      if (level === 1 && firstH1 === undefined) firstH1 = heading;
      current = { level, heading, bodyLines: [] };
      sections.push(current);
      continue;
    }
    pushLine(line);
  }

  const chunks: DocChunk[] = [];

  const preambleText = preambleLines.join('\n').trim();
  if (preambleText.length > 0) {
    const title = firstH1 ?? basenameNoExt(relPath);
    chunks.push({
      path: relPath,
      heading: title,
      trail: [title],
      text: truncateText(preambleText),
      mentions: findMentions(exportNames, `${title}\n${preambleText}`),
    });
  }

  const stack: Array<{ level: number; text: string }> = [];
  for (const s of sections) {
    while (stack.length > 0 && stack[stack.length - 1]!.level >= s.level) stack.pop();
    stack.push({ level: s.level, text: s.heading });
    const trail = stack.map((e) => e.text);
    const bodyText = s.bodyLines.join('\n').trim();
    chunks.push({
      path: relPath,
      heading: s.heading,
      trail,
      text: truncateText(bodyText),
      mentions: findMentions(exportNames, `${s.heading}\n${bodyText}`),
    });
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildDocsIndex(id: SystemId, cfg: SystemConfig, root: string, catalog: SystemCatalog): DocsIndex {
  const generatedAt = new Date().toISOString();
  if (!cfg.docs || cfg.docs.include.length === 0) {
    return { system: id, generatedAt, chunks: [] };
  }

  const exportNames = catalogExportNames(catalog);
  const files = matchedFiles(root, cfg.docs);
  const chunks: DocChunk[] = [];
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    chunks.push(...chunkMarkdownFile(relPosix(root, f), content, exportNames));
  }

  return { system: id, generatedAt, chunks };
}

/** sha256 over sorted relative paths plus contents of every file `cfg.docs` matches, for freshness checks. */
export function docsSourceHash(cfg: SystemConfig, root: string): string {
  if (!cfg.docs || cfg.docs.include.length === 0) return sha256('');
  const files = matchedFiles(root, cfg.docs);
  const parts: string[] = [];
  for (const f of files) {
    const rel = relPosix(root, f);
    let content = '';
    try {
      content = readFileSync(f, 'utf8');
    } catch {
      // unreadable file: still fold its path in so a permissions change shows up
    }
    parts.push(rel, content);
  }
  return sha256(parts.join('\n'));
}

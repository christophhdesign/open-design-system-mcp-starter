// Scans a design system checkout and reports what the wizard can infer about it: a Custom
// Elements Manifest, a React source tree with a barrel, CSS custom-property files, DTCG token
// files, docs globs, the likely package name, and which component model fits best.
//
// Read-only, offline, no dependency on ds.config.json: `wizard.ts` is the only caller and turns
// this into default answers. Never reads node_modules or dot-directories; scans at most 4 levels
// deep from `root` so the wizard stays fast even on a large monorepo.
//
// `detectPackage` below is the package-mode counterpart: instead of scanning a checkout, it reads
// one already-installed package's own node_modules/<pkg>/package.json (and, deliberately, does
// walk into that package's own directory for a compiled CSS fallback).

import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

export interface ReactSrcCandidate {
  /** Relative to root, e.g. 'src' or 'packages/ui/src'. */
  dir: string;
  /** Count of .tsx files under dir, capped for performance. */
  tsxCount: number;
}

export interface CssTokenFile {
  /** Relative to root. */
  path: string;
  /** Count of `--custom-property:` declarations found in the file. */
  count: number;
}

export interface Detection {
  /** Paths (relative to root) of any custom-elements.json found. */
  manifests: string[];
  /** Candidate React source dirs, ranked by .tsx file count (highest first). */
  reactSrc: ReactSrcCandidate[];
  /** index.ts / index.tsx found directly inside a candidate reactSrc dir, relative to root. */
  barrels: string[];
  /** .css/.scss files that look like a token sheet, ranked (name hint, then count). */
  cssTokenFiles: CssTokenFile[];
  /** .json files that look like DTCG tokens, relative to root. */
  dtcgFiles: string[];
  /** Suggested docs include globs, relative to root. */
  docsGlobs: string[];
  /** Count of .mdx files found. Reported only: mdx is not a supported docs source yet. */
  mdxCount: number;
  /** Likely package name for componentsPkg, from the root or the top reactSrc candidate's package.json. */
  packageName?: string;
  componentModel: 'react' | 'custom-elements';
}

const MAX_DEPTH = 4;
const TSX_COUNT_CAP = 500;
const TSX_SCAN_DEPTH = 6;

interface Entry {
  /** Relative to the scan root. */
  rel: string;
  abs: string;
  isDir: boolean;
}

function readEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isIgnored(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

/** Depth-limited (<= MAX_DEPTH), skipping node_modules and dot-entries. */
function scan(root: string): Entry[] {
  const out: Entry[] = [];
  function recurse(dir: string, depth: number): void {
    for (const entry of readEntries(dir)) {
      if (isIgnored(entry.name)) continue;
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);
      const isDir = entry.isDirectory();
      out.push({ rel, abs, isDir });
      if (isDir && depth < MAX_DEPTH) recurse(abs, depth + 1);
    }
  }
  recurse(root, 1);
  return out;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function topSegment(rel: string): string {
  return rel.split(/[\\/]/)[0] ?? '';
}

function detectManifests(files: Entry[]): string[] {
  return files.filter((f) => basename(f.rel) === 'custom-elements.json').map((f) => f.rel);
}

function detectCssTokenFiles(files: Entry[]): CssTokenFile[] {
  const nameHint = /token|variable|theme/i;
  const results: CssTokenFile[] = [];
  for (const f of files) {
    if (!/\.(css|scss)$/i.test(f.rel)) continue;
    let content: string;
    try {
      content = readFileSync(f.abs, 'utf8');
    } catch {
      continue;
    }
    const matches = content.match(/--[a-zA-Z0-9_-]+\s*:/g);
    const count = matches ? matches.length : 0;
    if (count >= 5) results.push({ path: f.rel, count });
  }
  results.sort((a, b) => {
    const aHint = nameHint.test(a.path) ? 1 : 0;
    const bHint = nameHint.test(b.path) ? 1 : 0;
    if (aHint !== bHint) return bHint - aHint;
    return b.count - a.count;
  });
  return results;
}

function detectDtcgFiles(files: Entry[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (!/\.json$/i.test(f.rel)) continue;
    if (/\.tokens\.json$/i.test(f.rel)) {
      out.push(f.rel);
      continue;
    }
    let content: string;
    try {
      content = readFileSync(f.abs, 'utf8');
    } catch {
      continue;
    }
    if (content.includes('"$value"')) out.push(f.rel);
  }
  return out;
}

function detectDocs(files: Entry[]): { docsGlobs: string[]; mdxCount: number } {
  const globs: string[] = [];

  const hasDocsMd = files.some((f) => topSegment(f.rel) === 'docs' && /\.md$/i.test(f.rel));
  if (hasDocsMd) globs.push('docs/**/*.md');

  const hasPackageReadme = files.some((f) => {
    const segs = f.rel.split(/[\\/]/);
    return segs.length === 3 && segs[0] === 'packages' && segs[2] === 'README.md';
  });
  if (hasPackageReadme) globs.push('packages/*/README.md');

  const mdxCount = files.filter((f) => /\.mdx$/i.test(f.rel)).length;

  return { docsGlobs: globs, mdxCount };
}

function hasReactDependency(pkgJsonAbs: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonAbs, 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    return Boolean(pkg.dependencies?.react || pkg.peerDependencies?.react);
  } catch {
    return false;
  }
}

function readPackageName(pkgJsonAbs: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonAbs, 'utf8')) as { name?: string };
    return typeof pkg.name === 'string' && pkg.name.length > 0 ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

function countTsxFiles(dirAbs: string): number {
  let count = 0;
  function recurse(dir: string, depth: number): void {
    if (count >= TSX_COUNT_CAP || depth > TSX_SCAN_DEPTH) return;
    for (const entry of readEntries(dir)) {
      if (count >= TSX_COUNT_CAP) return;
      if (isIgnored(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) recurse(abs, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.tsx')) count += 1;
    }
  }
  recurse(dirAbs, 1);
  return count;
}

function detectReactSrc(root: string): ReactSrcCandidate[] {
  const candidates: ReactSrcCandidate[] = [];

  const rootPkgJson = join(root, 'package.json');
  const rootHasReact = existsSync(rootPkgJson) && hasReactDependency(rootPkgJson);
  if (rootHasReact) {
    for (const dirName of ['src', 'components']) {
      const abs = join(root, dirName);
      if (isDirectory(abs)) candidates.push({ dir: dirName, tsxCount: countTsxFiles(abs) });
    }
  }

  const packagesDir = join(root, 'packages');
  if (isDirectory(packagesDir)) {
    for (const name of readEntries(packagesDir)) {
      if (isIgnored(name.name) || !name.isDirectory()) continue;
      const pkgDir = join(packagesDir, name.name);
      const pkgJson = join(pkgDir, 'package.json');
      if (!existsSync(pkgJson) || !hasReactDependency(pkgJson)) continue;
      const srcAbs = join(pkgDir, 'src');
      if (isDirectory(srcAbs)) {
        candidates.push({ dir: `packages/${name.name}/src`, tsxCount: countTsxFiles(srcAbs) });
      }
    }
  }

  candidates.sort((a, b) => b.tsxCount - a.tsxCount);
  return candidates;
}

function detectBarrels(root: string, reactSrc: ReactSrcCandidate[]): string[] {
  const out: string[] = [];
  for (const c of reactSrc) {
    for (const name of ['index.ts', 'index.tsx']) {
      const abs = join(root, c.dir, name);
      if (isFile(abs)) out.push(`${c.dir}/${name}`);
    }
  }
  return out;
}

function detectPackageName(root: string, reactSrc: ReactSrcCandidate[]): string | undefined {
  const rootPkgJson = join(root, 'package.json');
  if (existsSync(rootPkgJson)) {
    const name = readPackageName(rootPkgJson);
    if (name) return name;
  }
  const top = reactSrc[0];
  if (top) {
    const pkgDir = dirname(join(root, top.dir));
    const name = readPackageName(join(pkgDir, 'package.json'));
    if (name) return name;
  }
  return undefined;
}

export function detectSystem(root: string): Detection {
  const entries = scan(root);
  const files = entries.filter((e) => !e.isDir);

  const manifests = detectManifests(files);
  const cssTokenFiles = detectCssTokenFiles(files);
  const dtcgFiles = detectDtcgFiles(files);
  const { docsGlobs, mdxCount } = detectDocs(files);
  const reactSrc = detectReactSrc(root);
  const barrels = detectBarrels(root, reactSrc);
  const packageName = detectPackageName(root, reactSrc);

  // A manifest is a strong, unambiguous signal; a React source dir only outweighs it when it
  // actually contains components. Neither present: 'react' is the SystemConfig default.
  const cemScore = manifests.length > 0 ? 10 : 0;
  const reactScore = reactSrc[0]?.tsxCount ?? 0;
  const componentModel: 'react' | 'custom-elements' =
    reactScore > cemScore ? 'react' : manifests.length > 0 ? 'custom-elements' : 'react';

  return { manifests, reactSrc, barrels, cssTokenFiles, dtcgFiles, docsGlobs, mdxCount, packageName, componentModel };
}

// ---------------------------------------------------------------------------
// Package mode: a system that is only ever `npm install`ed, never checked out. Detects the
// installed package's shape from its own node_modules/<pkg>/package.json instead of scanning a
// source tree.
// ---------------------------------------------------------------------------

export interface PackageDetection {
  pkg: string;
  /** node_modules/<pkg>, relative to appDir. */
  pkgDir: string;
  version?: string;
  /** The package's .d.ts barrel, relative to appDir, when one could be resolved. */
  barrel?: string;
  /** Directory the barrel lives in, relative to appDir. */
  src?: string;
  /** Compiled CSS files (components package, plus the foundations package when given), relative to appDir. */
  cssFiles: string[];
  /** README.md paths for both packages, relative to appDir. */
  readmes: string[];
  /** Whether node_modules/@types/react is installed under appDir. */
  hasReactTypes: boolean;
  /** A peerDependency of the components package that looks like a tokens/foundations package, when `foundations` was not given. */
  peerFoundations?: string;
}

function toAppRel(appDir: string, abs: string): string {
  return relative(appDir, abs).split(sep).join('/');
}

function readPackageJson(pkgJsonAbs: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(pkgJsonAbs, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** `exports['.'].types`, in either the flat form or the nested `{ import, require, default }` form. */
function typesFromExportsDot(exportsField: unknown): string | undefined {
  if (!exportsField || typeof exportsField !== 'object') return undefined;
  const dot = (exportsField as Record<string, unknown>)['.'];
  if (!dot || typeof dot !== 'object') return undefined;
  const dotObj = dot as Record<string, unknown>;
  if (typeof dotObj.types === 'string') return dotObj.types;
  for (const key of ['import', 'require', 'default']) {
    const nested = dotObj[key];
    if (nested && typeof nested === 'object' && typeof (nested as Record<string, unknown>).types === 'string') {
      return (nested as Record<string, unknown>).types as string;
    }
  }
  return undefined;
}

/** `types`, then `typings`, then `exports['.'].types`. */
function resolveBarrelField(pkgJson: Record<string, unknown>): string | undefined {
  if (typeof pkgJson.types === 'string') return pkgJson.types;
  if (typeof pkgJson.typings === 'string') return pkgJson.typings;
  return typesFromExportsDot(pkgJson.exports);
}

function findPeerFoundations(pkgJson: Record<string, unknown>): string | undefined {
  const peers = pkgJson.peerDependencies;
  if (!peers || typeof peers !== 'object') return undefined;
  return Object.keys(peers as Record<string, unknown>).find((name) => /foundation|token/i.test(name));
}

/** `main`/`style`/`exports` entries that point straight at a `.css` file. */
function cssFromManifestFields(pkgJson: Record<string, unknown>, pkgDirAbs: string, appDir: string): string[] {
  const out: string[] = [];
  const addIfCss = (value: unknown): void => {
    if (typeof value !== 'string' || !/\.css$/i.test(value)) return;
    const abs = join(pkgDirAbs, value);
    if (isFile(abs)) out.push(toAppRel(appDir, abs));
  };
  addIfCss(pkgJson.main);
  addIfCss(pkgJson.style);
  const exportsField = pkgJson.exports;
  if (exportsField && typeof exportsField === 'object') {
    for (const value of Object.values(exportsField as Record<string, unknown>)) {
      if (typeof value === 'string') {
        addIfCss(value);
      } else if (value && typeof value === 'object') {
        for (const nested of Object.values(value as Record<string, unknown>)) addIfCss(nested);
      }
    }
  }
  return Array.from(new Set(out));
}

/**
 * CSS files for one installed package: manifest fields first (`main`/`style`/`exports`); when
 * none point at CSS, falls back to walking the package dir (reusing `detectCssTokenFiles`, so the
 * same >= 5 custom-property threshold and name-hint ranking apply).
 */
function cssFilesForPackageDir(pkgDirAbs: string, appDir: string): string[] {
  const pkgJson = readPackageJson(join(pkgDirAbs, 'package.json')) ?? {};
  const manifest = cssFromManifestFields(pkgJson, pkgDirAbs, appDir);
  if (manifest.length > 0) return manifest;

  const entries = scan(pkgDirAbs).filter((e) => !e.isDir);
  return detectCssTokenFiles(entries).map((f) => toAppRel(appDir, join(pkgDirAbs, f.path)));
}

function readmeFor(pkgDirAbs: string, appDir: string): string[] {
  const match = readEntries(pkgDirAbs).find((e) => e.isFile() && /^readme\.md$/i.test(e.name));
  return match ? [toAppRel(appDir, join(pkgDirAbs, match.name))] : [];
}

/**
 * Detects a published package's shape from `node_modules/<pkg>` under `appDir` (the app that has
 * it installed, not the design system's own checkout): the .d.ts barrel, compiled CSS, READMEs,
 * whether `@types/react` is present, and a likely foundations/tokens peer dependency.
 */
export function detectPackage(appDir: string, pkg: string, foundations?: string): PackageDetection {
  const pkgDirAbs = join(appDir, 'node_modules', pkg);
  const pkgJsonAbs = join(pkgDirAbs, 'package.json');
  if (!isFile(pkgJsonAbs)) {
    throw new Error(`${pkg} is not installed under ${appDir}. Run: npm install ${pkg} first.`);
  }
  const pkgJson = readPackageJson(pkgJsonAbs)!;

  const barrelField = resolveBarrelField(pkgJson);
  let barrel: string | undefined;
  let src: string | undefined;
  if (barrelField) {
    const barrelAbs = join(pkgDirAbs, barrelField);
    barrel = toAppRel(appDir, barrelAbs);
    src = toAppRel(appDir, dirname(barrelAbs));
  }

  const cssFiles = cssFilesForPackageDir(pkgDirAbs, appDir);
  const readmes = readmeFor(pkgDirAbs, appDir);

  const peerFoundations = foundations ? undefined : findPeerFoundations(pkgJson);

  if (foundations) {
    const foundationsDirAbs = join(appDir, 'node_modules', foundations);
    if (isDirectory(foundationsDirAbs)) {
      cssFiles.push(...cssFilesForPackageDir(foundationsDirAbs, appDir));
      readmes.push(...readmeFor(foundationsDirAbs, appDir));
    }
  }

  const hasReactTypes = isFile(join(appDir, 'node_modules/@types/react/package.json'));
  const version = typeof pkgJson.version === 'string' ? pkgJson.version : undefined;

  return {
    pkg,
    pkgDir: toAppRel(appDir, pkgDirAbs),
    version,
    barrel,
    src,
    cssFiles: Array.from(new Set(cssFiles)),
    readmes: Array.from(new Set(readmes)),
    hasReactTypes,
    peerFoundations,
  };
}

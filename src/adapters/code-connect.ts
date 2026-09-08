// code-connect adapter: parses Figma Code Connect files (`*.figma.tsx` / `*.figma.ts`) for
// `figma.connect(Component, url, { props, example })` calls, and enriches an already-extracted
// catalog with the Figma node link, a team-written example, and enum-derived aliases.
//
// Code Connect files are TypeScript/TSX source a design-systems team writes and maintains by
// hand, not something this repo generates, so parsing never trusts the shape: a call that
// doesn't match the expected pattern is skipped rather than aborting the whole file, and one bad
// file never aborts extraction.

import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import type { AliasEntry, CatalogExample, CatalogExport, SystemCatalog } from '../types.ts';
import { sha256 } from './index.ts';

export interface CodeConnectMapping {
  component: string;
  nodeId: string;
  url: string;
  source: string;
  props: Array<{
    figma: string;
    kind: 'boolean' | 'string' | 'enum' | 'instance' | 'children' | 'textContent' | 'nestedProps' | 'other';
    prop: string;
    values?: Record<string, string>;
  }>;
  example?: string;
}

type PropKind = CodeConnectMapping['props'][number]['kind'];
const KNOWN_PROP_KINDS: readonly string[] = ['boolean', 'string', 'enum', 'instance', 'children', 'textContent', 'nestedProps'];

// ---------------------------------------------------------------------------
// File collection: a walker + glob matcher, mirroring markdown-docs.ts (skip node_modules and
// dot-directories; a literal, glob-character-free include entry is read as an explicit path).
// ---------------------------------------------------------------------------

const DEFAULT_INCLUDE = ['**/*.figma.tsx', '**/*.figma.ts'];
const GLOB_CHARS = /[*?{[]/;

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
    for (const rest of suffixes) out.push(`${prefix}${opt}${rest}`);
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

/**
 * Absolute paths of every file under `root` matching `include`, sorted by relative path. An
 * empty or undefined `include` falls back to `**\/*.figma.tsx` and `**\/*.figma.ts`.
 */
export function collectCodeConnectFiles(root: string, include: string[] | undefined): string[] {
  const patterns = include && include.length > 0 ? include : DEFAULT_INCLUDE;
  const literal = patterns.filter((p) => !GLOB_CHARS.test(p));
  const globs = patterns.filter((p) => GLOB_CHARS.test(p));
  const found = new Set<string>();

  for (const rel of literal) {
    const abs = resolve(root, rel);
    try {
      if (statSync(abs).isFile()) found.add(abs);
    } catch {
      // missing literal path: skip
    }
  }

  if (globs.length > 0) {
    const includeRes = compileGlobs(globs);
    for (const f of walkFiles(root)) {
      const rel = relPosix(root, f);
      if (includeRes.some((re) => re.test(rel))) found.add(f);
    }
  }

  const matches = [...found];
  matches.sort((a, b) => relPosix(root, a).localeCompare(relPosix(root, b)));
  return matches;
}

/** sha256 over sorted relative paths plus contents of every file `collectCodeConnectFiles` matches. */
export function codeConnectSourceHash(root: string, include: string[] | undefined): string {
  const files = collectCodeConnectFiles(root, include);
  const parts: string[] = [];
  for (const f of files) {
    let content = '';
    try {
      content = readFileSync(f, 'utf8');
    } catch {
      // unreadable file: still fold its path in so a permissions change shows up
    }
    parts.push(relPosix(root, f), '\n', content, '\n');
  }
  return sha256(parts.join(''));
}

// ---------------------------------------------------------------------------
// Parsing figma.connect(...) calls
// ---------------------------------------------------------------------------

function isFigmaConnectCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const expr = node.expression;
  if (!ts.isPropertyAccessExpression(expr)) return false;
  if (expr.name.text !== 'connect') return false;
  return ts.isIdentifier(expr.expression) && expr.expression.text === 'figma';
}

/** The component argument is usually an identifier (`Button`), sometimes a namespaced access
 *  (`Foo.Bar`), sometimes a plain string when a team names an unimported component by hand. */
function componentNameFromArg(arg: ts.Expression): string | undefined {
  if (ts.isStringLiteral(arg)) return arg.text;
  if (ts.isIdentifier(arg)) return arg.text;
  if (ts.isPropertyAccessExpression(arg)) return arg.getText();
  return undefined;
}

/** Reads the `node-id` query param and normalises both URL-encoded and dashed separators to `:`. */
function normalizeNodeId(url: string): string {
  const m = /[?&]node-id=([^&]+)/.exec(url);
  if (!m) return '';
  let raw = m[1]!;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // leave as-is if not validly encoded
  }
  return raw.replace(/-/g, ':');
}

function kindFromMethodName(name: string): PropKind {
  return KNOWN_PROP_KINDS.includes(name) ? (name as PropKind) : 'other';
}

function stringifyPropKey(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function stringifyPropValue(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isNumericLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (node.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  return undefined;
}

/** Parses the `props: { ... }` object literal into one entry per `key: figma.<kind>(...)` assignment. */
function parsePropsObject(obj: ts.ObjectLiteralExpression): CodeConnectMapping['props'] {
  const out: CodeConnectMapping['props'] = [];
  for (const prop of obj.properties) {
    try {
      if (!ts.isPropertyAssignment(prop)) continue;
      const propName = stringifyPropKey(prop.name);
      if (!propName) continue;

      const value = prop.initializer;
      if (!ts.isCallExpression(value)) continue;
      const callee = value.expression;
      if (!ts.isPropertyAccessExpression(callee)) continue;

      const args = value.arguments;
      const figmaNameArg = args[0];
      const figmaName = figmaNameArg && ts.isStringLiteral(figmaNameArg) ? figmaNameArg.text : undefined;
      if (!figmaName) continue;

      const kind = kindFromMethodName(callee.name.text);
      let values: Record<string, string> | undefined;
      if (kind === 'enum' && args[1] && ts.isObjectLiteralExpression(args[1])) {
        values = {};
        for (const entry of args[1].properties) {
          if (!ts.isPropertyAssignment(entry)) continue;
          const k = stringifyPropKey(entry.name);
          const v = stringifyPropValue(entry.initializer);
          if (k !== undefined && v !== undefined) values[k] = v;
        }
      }

      out.push({ figma: figmaName, kind, prop: propName, values });
    } catch {
      // one malformed prop entry never aborts the rest
    }
  }
  return out;
}

function unwrapParens(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

/**
 * Pulls the JSX out of `example: (props) => (<X .../>)` or a block-bodied function's `return`
 * statement, then replaces `props.<name>` occurrences with `{<name>}` placeholders.
 */
function extractExampleSource(fnNode: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  if (!ts.isArrowFunction(fnNode) && !ts.isFunctionExpression(fnNode)) return undefined;
  const body = fnNode.body;

  let jsxNode: ts.Node | undefined;
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      if (ts.isReturnStatement(stmt) && stmt.expression) {
        jsxNode = unwrapParens(stmt.expression);
        break;
      }
    }
  } else {
    jsxNode = unwrapParens(body);
  }
  if (!jsxNode) return undefined;

  const raw = jsxNode.getText(sourceFile);
  const withPlaceholders = raw
    .replace(/\{\s*props\.(\w+)\s*\}/g, '{$1}')
    .replace(/props\.(\w+)/g, '{$1}');
  return withPlaceholders.trim();
}

/**
 * Finds every `figma.connect(Component, url, { props, example })` call in `text` and returns one
 * mapping per call. Never throws: a call, or a file, that doesn't match the expected shape is
 * skipped rather than aborting extraction.
 */
export function parseCodeConnectFile(relPath: string, text: string): CodeConnectMapping[] {
  const mappings: CodeConnectMapping[] = [];

  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  } catch {
    return mappings;
  }

  const visit = (node: ts.Node): void => {
    try {
      if (isFigmaConnectCall(node)) {
        const [componentArg, urlArg, configArg] = node.arguments;
        if (componentArg && urlArg && ts.isStringLiteral(urlArg)) {
          const component = componentNameFromArg(componentArg);
          if (component) {
            const url = urlArg.text;
            const nodeId = normalizeNodeId(url);

            let props: CodeConnectMapping['props'] = [];
            let example: string | undefined;
            if (configArg && ts.isObjectLiteralExpression(configArg)) {
              for (const field of configArg.properties) {
                if (!ts.isPropertyAssignment(field)) continue;
                const key = stringifyPropKey(field.name);
                if (key === 'props' && ts.isObjectLiteralExpression(field.initializer)) {
                  props = parsePropsObject(field.initializer);
                } else if (key === 'example') {
                  example = extractExampleSource(field.initializer, sourceFile);
                }
              }
            }

            mappings.push({ component, nodeId, url, source: relPath, props, example });
          }
        }
      }
    } catch {
      // one malformed call never aborts the rest of the file
    }
    ts.forEachChild(node, visit);
  };

  try {
    visit(sourceFile);
  } catch {
    // return whatever was collected before the walk broke
  }
  return mappings;
}

// ---------------------------------------------------------------------------
// Enrichment: merge mappings over an already-extracted catalog
// ---------------------------------------------------------------------------

function findExport(components: Array<{ dir: string; exports: CatalogExport[] }>, displayName: string): CatalogExport | undefined {
  for (const c of components) {
    const found = c.exports.find((e) => e.displayName === displayName);
    if (found) return found;
  }
  return undefined;
}

export interface EnrichFromCodeConnectMeta {
  /** How many Code Connect files were matched, stamped into catalog.source.codeConnect.files. */
  files: number;
  /** Hash of the matched files, stamped into catalog.source.codeConnect.hash (computed by the caller). */
  hash: string;
}

/**
 * Merges `mappings` over `catalog`: sets `figma` on the matching export (creating a bare
 * `code-connect`-dir stub when docgen produced none), appends the Code Connect example, and
 * derives component-value aliases from differing enum maps. Returns a new catalog; the input is
 * never mutated.
 */
export function enrichFromCodeConnect(
  catalog: SystemCatalog,
  mappings: CodeConnectMapping[],
  meta: EnrichFromCodeConnectMeta
): { catalog: SystemCatalog; mapped: string[]; unmatched: string[]; aliases: AliasEntry[] } {
  const mapped: string[] = [];
  const unmatched: string[] = [];
  const aliases: AliasEntry[] = [];
  const allExportsSet = new Set(catalog.allExports);

  // Clone components/exports/props so nothing in the input catalog is mutated, mirroring
  // src/data/overlay.ts's applyOverlay.
  const components = catalog.components.map((c) => ({
    dir: c.dir,
    exports: c.exports.map((e) => ({ ...e, props: e.props.map((p) => ({ ...p })) })),
  }));

  for (const mapping of mappings) {
    if (!allExportsSet.has(mapping.component)) {
      unmatched.push(mapping.component);
      continue;
    }
    mapped.push(mapping.component);

    let target = findExport(components, mapping.component);
    if (!target) {
      // The symbol is real (allExports confirms it) but docgen produced no CatalogExport for
      // it; create a bare stub so the figma link/example still surface.
      target = {
        displayName: mapping.component,
        description: '',
        props: [],
        docSource: 'code-connect',
      };
      let group = components.find((c) => c.dir === 'code-connect');
      if (!group) {
        group = { dir: 'code-connect', exports: [] };
        components.push(group);
      }
      group.exports.push(target);
    }

    target.figma = { nodeId: mapping.nodeId, url: mapping.url, source: mapping.source };

    if (mapping.example) {
      const example: CatalogExample = {
        title: 'Code Connect example',
        code: mapping.example,
        language: 'tsx',
        source: mapping.source,
      };
      const existing = target.examples ?? [];
      if (!existing.some((e) => e.code === example.code)) {
        target.examples = [...existing, example];
      }
    }

    for (const prop of mapping.props) {
      if (prop.kind !== 'enum' || !prop.values) continue;
      for (const [figmaValue, codeValue] of Object.entries(prop.values)) {
        if (figmaValue === codeValue) continue;
        aliases.push({
          alias: figmaValue,
          target: codeValue,
          concept: `${mapping.component}.${prop.prop}`,
          source: 'code-connect',
          note: 'Figma property value',
        });
      }
    }
  }

  const nextCatalog: SystemCatalog = {
    ...catalog,
    components,
    source: {
      ...catalog.source,
      codeConnect: { files: meta.files, mapped: mapped.length, hash: meta.hash },
    },
  };

  return { catalog: nextCatalog, mapped, unmatched, aliases };
}

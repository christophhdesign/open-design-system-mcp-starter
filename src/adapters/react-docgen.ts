// react-docgen adapter: extracts a SystemCatalog from a typed React source tree, for
// cfg.catalog = { adapter: 'react-docgen', src, barrel? }.
//
// Public API discovery is independent of docgen: the barrel (`<src>/index.ts` or
// `index.tsx` by default, or `barrel` when set, resolved relative to root) is parsed with
// the TypeScript compiler API for `export { A, B as C } from './x'` (including
// `export { default as X } from './x'`), `export * from './x'` (followed one level into
// that module's own barrel or file, recursing for nested `export *` up to depth 6), and
// local `export const/function/class X`. `export type` in any form is skipped. The result
// is `allExports`, the hallucination check set, which deliberately includes hooks and
// helpers, not only components.
//
// react-docgen-typescript then runs once over every `*.tsx` file under `src` (excluding
// test/story/spec files and `__tests__`); a docgen result is kept as a full CatalogExport
// only when its displayName is in the barrel set, an internal, unexported component that
// happens to live under src is not part of the public API. A barrel export docgen never
// documented (a hook, a helper, a component docgen could not parse) still gets a
// `[]`-props entry in allPropsByExport: it's a confirmed real symbol, just not
// independently prop-verified.
//
// Some published packages declare components in shapes react-docgen-typescript's own
// name-based detection does not recognise: a callable object (`declare const X: { (props):
// JSX.Element; displayName: string }`) or a props type that is an intersection with a union
// (`type XProps = A & (B | C)`). For every barrel export docgen left undocumented (or
// documented with zero props at all), a second pass (see "props-type fallback" below) builds
// one `ts.Program` over the exports' declaring files and reads a `<Name>Props` (or
// `<Name>BaseProps`) type, or failing that the first parameter type of the exported value's
// call signature, straight off the type checker. It never throws: a failure just leaves the
// export exactly as docgen left it.
//
// --- TypeScript 7 compatibility -------------------------------------------------------
// This adapter needs the classic TypeScript Compiler API (ts.createSourceFile,
// ts.SyntaxKind, ...) for its own barrel walk, and react-docgen-typescript needs it
// internally too (it reads `ts.JsxEmit`, builds a `ts.Program`, walks the type checker).
// The `typescript` package installed in this repo (v7.x) is the native/preview rewrite:
// its default export is just `{ version, versionMajorMinor }`, with none of the classic
// API surface. Two consequences:
//   - `ts` below is cast through ClassicTsApi rather than typed from the installed
//     package, so `tsc --noEmit` stays green regardless of which `typescript` flavor is
//     present. classicTsApiAvailable() is the real, runtime capability check.
//   - `react-docgen-typescript` throws at MODULE LOAD (`ts.JsxEmit.React` is read at the
//     top of its parser.js) under this typescript, not merely when called. Loading it
//     eagerly would crash this whole file, so it's require()'d lazily, inside
//     extractCatalog, via a Node-native `require`, see loadReactDocgenTypescript below.
// See loadReactDocgenTypescript's comment for the concrete fix (a nested typescript@5).

import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import type { ComponentDoc, ParserOptions, PropItem } from 'react-docgen-typescript';
import type { CatalogExport, CatalogProp, SystemCatalog, SystemConfig, SystemId } from '../types.ts';
import { sha256 } from './index.ts';

const require = createRequire(import.meta.url);

// Narrow surface of the classic TypeScript Compiler API this file needs. Nodes are `any`
// on purpose: we're deliberately not trusting the installed package's own `.d.ts` (see the
// module comment), so there is nothing to gain from re-typing the whole AST.
interface ClassicTsApi {
  createSourceFile(fileName: string, sourceText: string, languageVersion: number, setParentNodes?: boolean, scriptKind?: number): any;
  createProgram(fileNames: string[], options: any): any;
  ScriptTarget: { Latest: number };
  ScriptKind: { TS: number; TSX: number };
  SyntaxKind: { ExportKeyword: number };
  ModuleKind: { ESNext: number };
  ModuleResolutionKind: { Bundler: number };
  JsxEmit: { ReactJSX: number };
  SignatureKind: { Call: number };
  SymbolFlags: { Optional: number; Value: number; Alias: number; Type: number; Interface: number; TypeAlias: number };
  TypeFormatFlags: { NoTruncation: number; UseAliasDefinedOutsideCurrentScope: number };
  isExportDeclaration(node: any): boolean;
  isNamedExports(node: any): boolean;
  isNamespaceExport(node: any): boolean;
  isStringLiteral(node: any): boolean;
  isVariableStatement(node: any): boolean;
  isFunctionDeclaration(node: any): boolean;
  isClassDeclaration(node: any): boolean;
  isTypeAliasDeclaration(node: any): boolean;
  isInterfaceDeclaration(node: any): boolean;
  isIdentifier(node: any): boolean;
  displayPartsToString(parts: any): string;
  version?: string;
  sys: any;
  readConfigFile(path: string, readFile: (p: string) => string | undefined): { config?: any; error?: any };
  parseJsonConfigFileContent(json: any, host: any, basePath: string, existing: any, configFileName: string): { options: any; errors: any[] };
  flattenDiagnosticMessageText(text: any, newline: string): string;
}

const classicTs = ts as unknown as ClassicTsApi;

/**
 * True when the installed `typescript` package exposes the classic Compiler API this
 * adapter (and react-docgen-typescript) needs. Exported so callers and tests can decide
 * what to run without tripping the cryptic TypeError this package throws when it's missing.
 */
export function classicTsApiAvailable(): boolean {
  return typeof classicTs.createSourceFile === 'function' && typeof classicTs.SyntaxKind === 'object';
}

function assertClassicTsApiAvailable(): void {
  if (classicTsApiAvailable()) return;
  throw new Error(
    `react-docgen: the installed 'typescript' package (v${classicTs.version ?? 'unknown'}) does not expose the ` +
      `classic Compiler API (ts.createSourceFile is undefined) that this adapter's barrel parser, and ` +
      `react-docgen-typescript itself, need. This looks like TypeScript's native/preview rewrite rather than ` +
      `classic tsc. This project pins typescript@5 for exactly this reason; run npm install, or if you upgraded ` +
      `TypeScript deliberately, install typescript@5 as a nested dependency of react-docgen-typescript instead.`
  );
}

interface ReactDocgenTypescriptModule {
  withCustomConfig(tsconfigPath: string, opts: ParserOptions): { parse(files: string[]): ComponentDoc[] };
  withCompilerOptions(options: any, opts: ParserOptions): { parse(files: string[]): ComponentDoc[] };
  withDefaultConfig(opts: ParserOptions): { parse(files: string[]): ComponentDoc[] };
}

/**
 * Loads a tsconfig the way withCustomConfig would (readConfigFile + parseJsonConfigFileContent,
 * so `extends` chains resolve identically), but tolerates version skew: a design system
 * written for a newer TypeScript than this project pins may use a compiler option this
 * version does not know (TS5023, or TS5025 with a did-you-mean). withCustomConfig throws on
 * the first diagnostic; here those two codes are dropped with a warning and every other
 * diagnostic still fails loudly.
 */
function loadCompilerOptions(tsconfigPath: string): unknown {
  const basePath = dirname(tsconfigPath);
  const { config, error } = classicTs.readConfigFile(tsconfigPath, classicTs.sys.readFile);
  if (error) {
    const message = typeof error.messageText === 'string' ? error.messageText : classicTs.flattenDiagnosticMessageText(error.messageText, '\n');
    throw new Error(`react-docgen: cannot load ${tsconfigPath}: ${message}`);
  }
  const parsed = classicTs.parseJsonConfigFileContent(config, classicTs.sys, basePath, {}, tsconfigPath);
  const ignored: string[] = [];
  const hard: any[] = [];
  for (const d of parsed.errors) {
    if (d.code === 5023 || d.code === 5025) {
      const text = typeof d.messageText === 'string' ? d.messageText : classicTs.flattenDiagnosticMessageText(d.messageText, ' ');
      const m = /Unknown compiler option '([^']+)'/.exec(text);
      ignored.push(m ? m[1]! : text);
      continue;
    }
    hard.push(d);
  }
  if (ignored.length > 0) {
    process.stderr.write(
      `[extract] ${tsconfigPath}: ignoring unknown compiler option(s) ${ignored.join(', ')} (written for a newer TypeScript than ${classicTs.version ?? 'this one'})\n`,
    );
  }
  if (hard.length > 0) {
    const first = hard[0];
    const text = typeof first.messageText === 'string' ? first.messageText : classicTs.flattenDiagnosticMessageText(first.messageText, '\n');
    throw new Error(`react-docgen: invalid ${tsconfigPath}: TS${first.code}: ${text}`);
  }
  return parsed.options;
}

/**
 * Lazily require()s 'react-docgen-typescript'. Must not be a static top-level import: under
 * this repo's typescript@7, the package throws at require-time (parser.js reads
 * `ts.JsxEmit.React` while building its module-level defaultOptions), and a static import
 * would crash this whole file, including for callers who never call extractCatalog.
 */
function loadReactDocgenTypescript(): ReactDocgenTypescriptModule {
  try {
    return require('react-docgen-typescript') as ReactDocgenTypescriptModule;
  } catch (err) {
    throw new Error(
      `react-docgen: could not load 'react-docgen-typescript': ${(err as Error).message}. ` +
        `This is the same typescript@7 incompatibility described in this adapter's module comment ` +
        `(src/adapters/react-docgen.ts), a nested typescript@5 under react-docgen-typescript is the suggested fix.`
    );
  }
}

// ---------------------------------------------------------------------------------------
// Barrel resolution and file walking
// ---------------------------------------------------------------------------------------

function resolveBarrelPath(root: string, srcDir: string, barrel?: string): string {
  if (barrel) return resolve(root, barrel);
  const candidateTs = join(srcDir, 'index.ts');
  if (existsSync(candidateTs)) return candidateTs;
  const candidateTsx = join(srcDir, 'index.tsx');
  if (existsSync(candidateTsx)) return candidateTsx;
  // A published package consumed from node_modules has only declaration files.
  const candidateDts = join(srcDir, 'index.d.ts');
  if (existsSync(candidateDts)) return candidateDts;
  throw new Error(
    `react-docgen: no barrel found at ${candidateTs}, ${candidateTsx} or ${candidateDts}, set "barrel" in ds.config.json`
  );
}

const SKIP_NAME_PATTERNS = [/\.test\./, /\.stories\./, /\.spec\./];

function isSkippedEntryName(name: string): boolean {
  return name === 'node_modules' || name === '__tests__';
}

/** Every file under `dir` (relative to `rootDir`) whose name ends with one of `exts`, skipping node_modules/__tests__ dirs and *.test./*.stories./*.spec. files. */
function walkSourceFiles(dir: string, rootDir: string, exts: string[], out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (isSkippedEntryName(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(abs, rootDir, exts, out);
    } else if (entry.isFile()) {
      if (SKIP_NAME_PATTERNS.some((re) => re.test(entry.name))) continue;
      if (exts.some((ext) => entry.name.endsWith(ext))) out.push(relative(rootDir, abs));
    }
  }
}

// ---------------------------------------------------------------------------------------
// Barrel walk: the public API, independent of what docgen can document
// ---------------------------------------------------------------------------------------

function parseSourceFile(filePath: string): any | undefined {
  let code: string;
  try {
    code = readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  const scriptKind = filePath.endsWith('.tsx') ? classicTs.ScriptKind.TSX : classicTs.ScriptKind.TS;
  return classicTs.createSourceFile(filePath, code, classicTs.ScriptTarget.Latest, true, scriptKind);
}

/** Resolves a relative `export ... from '<spec>'` target: `<spec>.ts(x)`, `<spec>.d.ts`, or `<spec>/index.ts(x)`/`index.d.ts`. */
function resolveRelativeModule(fromDir: string, spec: string): string | undefined {
  // ESM-style specifiers point at the emitted file ('./core/index.js'); the source is
  // the same path with a TypeScript extension, so drop the JS extension before probing.
  const base = join(fromDir, spec).replace(/\.(m|c)?jsx?$/, '');
  const candidates = [`${base}.ts`, `${base}.tsx`, `${base}.d.ts`, join(base, 'index.ts'), join(base, 'index.tsx'), join(base, 'index.d.ts')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function hasExportModifier(stmt: any): boolean {
  const modifiers = stmt.modifiers as any[] | undefined;
  return !!modifiers?.some((m) => m.kind === classicTs.SyntaxKind.ExportKeyword);
}

/**
 * Every value name a barrel (and, through `export *`, its targets) makes public: named
 * re-exports (`export { A, B as C } from './x'`, including `export { default as X }`),
 * `export * as X from './x'`, local `export const/function/class X`, and `export * from
 * './x'` followed recursively up to `depth` hops. Type-only exports (`export type ...`,
 * `export type { X }`, individual `type` specifiers in a mixed list) are skipped , 
 * allExports is the hallucination check set for values, not types.
 */
/** Barrel walk result: every public value name, plus (best-effort) the absolute file that declares each one. */
interface BarrelWalkResult {
  names: Set<string>;
  /**
   * name -> absolute path of the file whose own declaration, or bare `export { X }` (no
   * module specifier), puts that name into the barrel. For a name that only ever arrives via
   * `export { X } from './y'` / `export * from './y'`, this is `y`'s own declaring file
   * (found by recursing into `y`), not the barrel statement's file, so the props-type fallback
   * can go straight to where `X` (and its `<X>Props` type, if any) is actually written.
   */
  files: Map<string, string>;
}

function collectBarrelExports(filePath: string, depth: number, visited: Set<string>): Set<string> {
  return collectBarrelExportsWithFiles(filePath, depth, visited).names;
}

function collectBarrelExportsWithFiles(filePath: string, depth: number, visited: Set<string>): BarrelWalkResult {
  const names = new Set<string>();
  const files = new Map<string, string>();
  if (visited.has(filePath)) return { names, files };
  visited.add(filePath);

  const sf = parseSourceFile(filePath);
  if (!sf) return { names, files };
  const dir = dirname(filePath);

  for (const stmt of sf.statements as any[]) {
    if (classicTs.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly) continue;
      const spec =
        stmt.moduleSpecifier && classicTs.isStringLiteral(stmt.moduleSpecifier) ? (stmt.moduleSpecifier.text as string) : undefined;

      if (!stmt.exportClause) {
        // export * from './x'
        if (!spec || !spec.startsWith('.') || depth <= 0) continue;
        const target = resolveRelativeModule(dir, spec);
        if (target) {
          const child = collectBarrelExportsWithFiles(target, depth - 1, visited);
          for (const n of child.names) names.add(n);
          for (const [n, f] of child.files) files.set(n, f);
        }
        continue;
      }

      if (classicTs.isNamespaceExport(stmt.exportClause)) {
        // export * as X from './x'
        names.add(stmt.exportClause.name.text);
        files.set(stmt.exportClause.name.text, filePath);
        continue;
      }

      if (classicTs.isNamedExports(stmt.exportClause)) {
        // export { A, B as C } [from './x'], including `export { default as X } from './x'`.
        // Resolve the target once so every element can look up its own (pre-alias) local name.
        const target = spec && spec.startsWith('.') && depth > 0 ? resolveRelativeModule(dir, spec) : undefined;
        const child = target ? collectBarrelExportsWithFiles(target, depth - 1, visited) : undefined;
        for (const el of stmt.exportClause.elements as any[]) {
          if (el.isTypeOnly) continue;
          const localName = (el.propertyName ?? el.name).text as string;
          const publicName = el.name.text as string;
          names.add(publicName);
          let declaringFile = child?.files.get(localName);
          if (!declaringFile && target) declaringFile = target; // declared directly in the target, or hidden past `depth`/a cycle
          if (!declaringFile && !spec) declaringFile = filePath; // local `export { X }`, no module specifier
          if (declaringFile) files.set(publicName, declaringFile);
        }
      }
      continue;
    }

    if (!hasExportModifier(stmt)) continue;

    if (classicTs.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations as any[]) {
        if (classicTs.isIdentifier(decl.name)) {
          names.add(decl.name.text);
          files.set(decl.name.text, filePath);
        }
      }
    } else if ((classicTs.isFunctionDeclaration(stmt) || classicTs.isClassDeclaration(stmt)) && stmt.name) {
      names.add(stmt.name.text);
      files.set(stmt.name.text, filePath);
    }
    // `export type X = ...` / `export interface X { ... }`: intentionally ignored.
  }

  return { names, files };
}

// ---------------------------------------------------------------------------------------
// Own vs inherited props
// ---------------------------------------------------------------------------------------

/**
 * react-docgen-typescript reports a prop's declaring type's `fileName` through its own
 * trimFileName() (see node_modules/react-docgen-typescript/lib/trimFileName.js): when
 * `fileName` shares a filesystem ancestor with process.cwd() it's rewritten relative to
 * that ancestor's parent, otherwise it's left absolute. To decide "inside src or not" we
 * need the real path either way, mirror the same upward walk from cwd and take the first
 * candidate that exists on disk, starting from the system's own source dir and then cwd.
 */
function resolveParentFileName(fileName: string, srcDir: string): string | undefined {
  if (isAbsolute(fileName)) return fileName;
  // trimFileName is relative to an ancestor of process.cwd(), but the design system
  // usually lives somewhere else entirely; try the system's own ancestors first.
  for (const start of [srcDir, process.cwd()]) {
    let dir = start;
    for (;;) {
      const candidate = resolve(dir, fileName);
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

/** A declaring file that is clearly third party: a dependency or the TypeScript lib typings. */
function looksThirdParty(fileName: string): boolean {
  return /(^|[\\/])node_modules[\\/]/.test(fileName) || /[\\/]typescript[\\/]lib[\\/]/.test(fileName);
}

function isInside(root: string, absPath: string): boolean {
  const rel = relative(resolve(root), resolve(absPath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Splits one component's raw docgen props (run WITHOUT a propFilter, so both own and
 * inherited props are present) into own (full metadata) and inherited (name only). A prop
 * with no `parent` is declared directly on the component's own props type: own. Otherwise
 * own when the parent's declaring file resolves inside `srcDir`, inherited otherwise (DOM
 * attrs, node_modules, a sibling package outside src).
 */
function splitOwnInherited(props: PropItem[], srcDir: string): { own: PropItem[]; inheritedNames: string[] } {
  const own: PropItem[] = [];
  const inherited = new Set<string>();
  for (const prop of props) {
    if (!prop.parent) {
      own.push(prop);
      continue;
    }
    const resolved = resolveParentFileName(prop.parent.fileName, srcDir);
    // Resolved: decide by location. Unresolved: a path that names node_modules or the
    // TS lib is inherited; anything else is the system's own file we could not locate
    // on disk, and withholding a real prop would hide API from the agent.
    const inheritedProp = resolved ? !isInside(srcDir, resolved) : looksThirdParty(prop.parent.fileName);
    if (inheritedProp) inherited.add(prop.name);
    else own.push(prop);
  }
  return { own, inheritedNames: [...inherited].sort() };
}

// ---------------------------------------------------------------------------------------
// docgen -> CatalogProp / CatalogExport mapping
// ---------------------------------------------------------------------------------------

function flattenDefaultValue(defaultValue: unknown): string | undefined {
  if (defaultValue == null) return undefined;
  if (typeof defaultValue === 'object' && 'value' in (defaultValue as Record<string, unknown>)) {
    const v = (defaultValue as { value?: unknown }).value;
    return v == null ? undefined : String(v);
  }
  return String(defaultValue);
}

function propDeprecatedTag(prop: PropItem): string | undefined {
  const tags = (prop as unknown as { tags?: Record<string, string> }).tags;
  const tag = tags?.deprecated;
  if (tag === undefined) return undefined;
  return tag.length > 0 ? tag : 'deprecated';
}

function toCatalogProp(prop: PropItem): CatalogProp {
  // With shouldExtractLiteralValuesFromEnum, a literal union arrives as docgen's
  // synthetic 'enum' shape: type.name is 'enum', type.raw is the source text (which
  // is just the alias name when the union was declared via `type Variant = ...`),
  // and type.value lists the members. The members are what an agent needs, so
  // rebuild the union from them; fall back to raw, then name.
  const t = prop.type as { name?: string; raw?: string; value?: Array<{ value: string }> } | undefined;
  let typeName = t?.raw ?? t?.name ?? '';
  if (t?.name === 'enum' && Array.isArray(t.value) && t.value.length > 0) {
    typeName = t.value.map((v) => v.value).join(' | ');
  }
  return {
    name: prop.name,
    type: typeName,
    required: !!prop.required,
    defaultValue: flattenDefaultValue(prop.defaultValue),
    description: prop.description ? prop.description.trim() : undefined,
    deprecated: propDeprecatedTag(prop),
  };
}

function exportDeprecated(comp: ComponentDoc): CatalogExport['deprecated'] {
  const tag = comp.tags?.deprecated;
  if (tag === undefined) return undefined;
  return tag.length > 0 ? { note: tag } : {};
}

// ---------------------------------------------------------------------------------------
// props-type fallback: components docgen could not document
// ---------------------------------------------------------------------------------------
//
// react-docgen-typescript's component detection is name/shape based (see parser.js's
// extractPropsFromTypeIfStatelessComponent and friends) and misses a callable object
// (`declare const X: { (props): JSX.Element; displayName: string }`) or a props type that is
// an intersection with a union (`type XProps = A & (B | C)`). Both shapes are perfectly
// ordinary to the type checker, so for every barrel export docgen left undocumented (or
// documented with zero props at all), this reads the export's `<Name>Props` (or
// `<Name>BaseProps`) type, or failing that the first parameter type of the exported value's
// call signature, straight off a `ts.Program` built over the exports' declaring files.

const CLASSIC_TS_DEFAULT_FALLBACK_OPTIONS = (): any => ({
  target: classicTs.ScriptTarget.Latest,
  module: classicTs.ModuleKind.ESNext,
  moduleResolution: classicTs.ModuleResolutionKind.Bundler,
  jsx: classicTs.JsxEmit.ReactJSX,
  skipLibCheck: true,
  allowJs: false,
});

/** Any exported type alias or interface in `sourceFile` named exactly `name` (declaration merging, if any, is not resolved: the first match wins). */
function findTypeDeclaration(sourceFile: any, name: string): any | undefined {
  for (const stmt of sourceFile.statements as any[]) {
    if ((classicTs.isTypeAliasDeclaration(stmt) || classicTs.isInterfaceDeclaration(stmt)) && stmt.name?.text === name) {
      return stmt;
    }
  }
  return undefined;
}

/**
 * A top-level `const`/`function`/`class` declaration named `name` in `sourceFile`, regardless
 * of whether the statement itself carries the `export` modifier: the real-world shape this
 * fallback targets (`declare const Stack: {...}; export { Stack };`) declares and exports the
 * value in two separate statements. Callers only look here for a name `collectBarrelExports`
 * already confirmed is public in this exact file, so the export modifier is not re-checked.
 */
function findValueDeclaration(sourceFile: any, name: string): any | undefined {
  for (const stmt of sourceFile.statements as any[]) {
    if (classicTs.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations as any[]) {
        if (classicTs.isIdentifier(decl.name) && decl.name.text === name) return decl;
      }
    } else if ((classicTs.isFunctionDeclaration(stmt) || classicTs.isClassDeclaration(stmt)) && stmt.name?.text === name) {
      return stmt;
    }
  }
  return undefined;
}

/** `"a" | "b"` when `type` is a union whose members are all string literals once `undefined` is removed; undefined otherwise. */
function stringLiteralUnionText(type: any, checker: any): string | undefined {
  if (typeof type.isUnion !== 'function' || !type.isUnion()) return undefined;
  const members = (type.types as any[]).filter((t) => checker.typeToString(t) !== 'undefined');
  if (members.length === 0) return undefined;
  if (!members.every((t) => typeof t.isLiteral === 'function' && t.isLiteral() && typeof t.value === 'string')) return undefined;
  return members.map((t) => JSON.stringify(t.value)).join(' | ');
}

/** True when `sym`'s declaration lives inside `srcDir`; a symbol with no declaration at all counts as own iff `propsFile` (the `<Name>Props` type or value declaration this property came from) is itself in src. */
function isOwnPropsTypeMember(sym: any, propsFile: string, srcDir: string): boolean {
  const decl = sym.valueDeclaration ?? (sym.declarations && sym.declarations[0]);
  if (!decl) return isInside(srcDir, propsFile);
  const fileName = decl.getSourceFile().fileName as string;
  // Inside the system's own source dir is own, even when that dir lives under
  // node_modules (a package consumed from npm); everything else is inherited.
  return isInside(srcDir, fileName);
}

function propsTypeFallbackProp(sym: any, checker: any, locationForType: any): CatalogProp {
  const decl = sym.valueDeclaration ?? (sym.declarations && sym.declarations[0]);
  const type = checker.getTypeOfSymbolAtLocation(sym, decl ?? locationForType);
  const rawTypeText =
    stringLiteralUnionText(type, checker) ??
    checker.typeToString(type, undefined, classicTs.TypeFormatFlags.NoTruncation | classicTs.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);
  // An optional prop's type carries `| undefined`; docgen strips it and so do we, so
  // `boolean | undefined` reads as `boolean` the way the author wrote it.
  const optional = (sym.flags & classicTs.SymbolFlags.Optional) !== 0;
  const typeText = optional ? rawTypeText.replace(/\s*\|\s*undefined\b/g, '').replace(/^undefined\s*\|\s*/, '') : rawTypeText;
  let defaultValue: string | undefined;
  let deprecated: string | undefined;
  for (const tag of sym.getJsDocTags(checker) as any[]) {
    const text = tag.text ? classicTs.displayPartsToString(tag.text).trim() : '';
    if (tag.name === 'default') defaultValue = text.length > 0 ? text : undefined;
    if (tag.name === 'deprecated') deprecated = text.length > 0 ? text : 'deprecated';
  }
  const description = classicTs.displayPartsToString(sym.getDocumentationComment(checker)).trim();
  return {
    name: sym.getName(),
    type: typeText,
    required: !(sym.flags & classicTs.SymbolFlags.Optional),
    defaultValue,
    description: description.length > 0 ? description : undefined,
    deprecated,
  };
}

interface PropsTypeFallbackResult {
  props: CatalogProp[];
  inheritedNames: string[];
  description: string;
}

/**
 * Resolves one barrel export's props the way docgen could not: `<Name>Props`/`<Name>BaseProps`
 * when the file exports one, else the first parameter type of `<Name>`'s call signature
 * (`getPropertiesOfType` on that parameter type already flattens `PropsWithChildren<T>` and any
 * other intersection, since the checker resolves apparent members regardless of how the type
 * was built). Returns undefined when nothing resolvable is found; never throws.
 */
function resolvePropsTypeFallback(name: string, file: string, program: any, checker: any, srcDir: string): PropsTypeFallbackResult | undefined {
  const sourceFile = program.getSourceFile(file);
  if (!sourceFile) return undefined;

  let type: any | undefined;
  const propsDecl = findTypeDeclaration(sourceFile, `${name}Props`) ?? findTypeDeclaration(sourceFile, `${name}BaseProps`);
  if (propsDecl) {
    const sym = checker.getSymbolAtLocation(propsDecl.name);
    if (sym) type = checker.getDeclaredTypeOfSymbol(sym);
  }

  const valueDecl = findValueDeclaration(sourceFile, name);

  if (!type) {
    if (!valueDecl) return undefined;
    const valueSym = checker.getSymbolAtLocation(valueDecl.name);
    if (!valueSym) return undefined;
    const valueType = checker.getTypeOfSymbolAtLocation(valueSym, valueDecl);
    const signatures = checker.getSignaturesOfType(valueType, classicTs.SignatureKind.Call);
    if (!signatures || signatures.length === 0) return undefined;
    const params = signatures[0].getParameters();
    if (!params || params.length === 0) return undefined;
    const firstParam = params[0];
    type = checker.getTypeOfSymbolAtLocation(firstParam, firstParam.valueDeclaration ?? valueDecl);
  }
  if (!type) return undefined;

  const props: CatalogProp[] = [];
  const inheritedNames: string[] = [];
  for (const sym of checker.getPropertiesOfType(type) as any[]) {
    if (sym.getName() === 'ref') continue; // the forwardRef/callable-object ref parameter, not a real prop
    if (isOwnPropsTypeMember(sym, file, srcDir)) {
      props.push(propsTypeFallbackProp(sym, checker, sourceFile));
    } else {
      inheritedNames.push(sym.getName());
    }
  }
  inheritedNames.sort();

  let description = '';
  if (valueDecl) {
    const valueSym = checker.getSymbolAtLocation(valueDecl.name);
    if (valueSym) description = classicTs.displayPartsToString(valueSym.getDocumentationComment(checker)).trim();
  }

  return { props, inheritedNames, description };
}

/**
 * Runs resolvePropsTypeFallback for every name in `undocumented` and applies the results to
 * `byDir`/`exportEntryByName`/`allPropsByExport` in place. Building one `ts.Program` over every
 * declaring file (rather than one per export) is what makes this affordable to run for an
 * entire catalog. Never throws: `ts.createProgram` or a single export's resolution failing
 * just leaves that export (or all of them) exactly as docgen left it.
 */
function applyPropsTypeFallback(
  undocumented: string[],
  barrelFiles: Map<string, string>,
  srcDir: string,
  compilerOptions: any,
  byDir: Map<string, CatalogExport[]>,
  exportEntryByName: Map<string, CatalogExport>,
  allPropsByExport: Record<string, string[]>
): number {
  let documented = 0;
  const files = Array.from(new Set(undocumented.map((n) => barrelFiles.get(n)).filter((f): f is string => !!f)));
  if (files.length === 0) return documented;

  let program: any;
  try {
    program = classicTs.createProgram(files, compilerOptions);
  } catch {
    return documented;
  }
  const checker = program.getTypeChecker();

  for (const name of undocumented) {
    const file = barrelFiles.get(name);
    if (!file) continue;
    try {
      const resolved = resolvePropsTypeFallback(name, file, program, checker, srcDir);
      if (!resolved) continue;

      const existing = exportEntryByName.get(name);
      if (existing) {
        existing.description = resolved.description.length > 0 ? resolved.description : existing.description;
        existing.props = resolved.props;
        existing.docSource = 'props-type';
        if (resolved.inheritedNames.length > 0) existing.inheritedProps = resolved.inheritedNames;
        else delete existing.inheritedProps;
      } else {
        const exportEntry: CatalogExport = {
          displayName: name,
          description: resolved.description,
          props: resolved.props,
          docSource: 'props-type',
        };
        if (resolved.inheritedNames.length > 0) exportEntry.inheritedProps = resolved.inheritedNames;

        const relDir = relative(srcDir, dirname(file));
        const dirKey = relDir === '.' ? '' : relDir;
        const list = byDir.get(dirKey) ?? [];
        list.push(exportEntry);
        byDir.set(dirKey, list);
        exportEntryByName.set(name, exportEntry);
      }

      allPropsByExport[name] = [...resolved.props.map((p) => p.name), ...resolved.inheritedNames];
      documented++;
    } catch {
      // Never throw from the fallback: leave this export exactly as docgen left it.
    }
  }

  return documented;
}

// ---------------------------------------------------------------------------------------
// typeOnlyExports: names in allExports that are types, never values
// ---------------------------------------------------------------------------------------
//
// A .d.ts barrel lists types and values in the same export clause
// (`export { Badge, BadgeAppearance, BadgeProps }`), so the barrel walk above puts type
// names into allExports too -- correctly, since importing a type is legitimate. But a name
// that can never be a value should never be reported as an "undocumented component" either
// (src/data/undocumented.ts). Resolving this needs the type checker: build a `ts.Program`
// rooted at the barrel file (module resolution pulls in everything the barrel re-exports
// from), read the barrel module's own export symbols, and follow re-export aliases to the
// declaration that actually decides value-vs-type. Never throws: a barrel the checker can't
// resolve just means no type-only names are known, not a crash.

/** Follows `sym` through `checker.getAliasedSymbol` while it's a re-export alias, to the symbol whose flags describe the real declaration (interface, type alias, function, variable, ...). Guards against alias cycles. */
function resolveAliasedSymbol(sym: any, checker: any): any {
  let resolved = sym;
  for (let i = 0; i < 10 && (resolved.flags & classicTs.SymbolFlags.Alias) !== 0; i++) {
    let next: any;
    try {
      next = checker.getAliasedSymbol(resolved);
    } catch {
      break;
    }
    if (!next || next === resolved) break;
    resolved = next;
  }
  return resolved;
}

/**
 * Names in `allExports` whose exported symbol, once alias chains are followed, has only type
 * meanings (an interface or type alias, never a variable/function/class/value module). Returns
 * undefined when the barrel module's exports can't be resolved through the checker at all;
 * returns an (possibly empty) Set otherwise.
 */
function computeTypeOnlyExports(allExports: Set<string>, barrelPath: string, compilerOptions: any): Set<string> | undefined {
  try {
    const program = classicTs.createProgram([barrelPath], compilerOptions);
    const sourceFile = program.getSourceFile(barrelPath);
    if (!sourceFile) return undefined;
    const checker = program.getTypeChecker();
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) return undefined;

    const typeOnly = new Set<string>();
    for (const sym of checker.getExportsOfModule(moduleSymbol) as any[]) {
      const name = sym.getName();
      if (!allExports.has(name)) continue; // not a name the value-barrel-walk considers public
      const resolved = resolveAliasedSymbol(sym, checker);
      const flags = resolved.flags as number;
      const isValue = (flags & classicTs.SymbolFlags.Value) !== 0;
      const isTypeLike = (flags & (classicTs.SymbolFlags.Type | classicTs.SymbolFlags.Interface | classicTs.SymbolFlags.TypeAlias)) !== 0;
      if (!isValue && isTypeLike) typeOnly.add(name);
    }
    return typeOnly;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------
// srcHash
// ---------------------------------------------------------------------------------------

function computeSrcHash(srcDir: string): string {
  const relFiles: string[] = [];
  walkSourceFiles(srcDir, srcDir, ['.ts', '.tsx'], relFiles);
  relFiles.sort();
  const parts: string[] = [];
  for (const rel of relFiles) {
    parts.push(rel, '\n', readFileSync(join(srcDir, rel), 'utf8'), '\n');
  }
  return sha256(parts.join(''));
}

/** Same hash extractCatalog stamps into source.srcHash, recomputed from current on-disk source without running a full extract. Used for freshness checks. */
export function sourceHash(cfg: SystemConfig, root: string): string {
  if (cfg.catalog.adapter !== 'react-docgen') {
    throw new Error(`react-docgen adapter called with catalog.adapter = '${cfg.catalog.adapter}'`);
  }
  const srcDir = resolve(root, cfg.catalog.src);
  return computeSrcHash(srcDir);
}

// ---------------------------------------------------------------------------------------
// extractCatalog
// ---------------------------------------------------------------------------------------

export function extractCatalog(id: SystemId, cfg: SystemConfig, root: string): SystemCatalog {
  if (cfg.catalog.adapter !== 'react-docgen') {
    throw new Error(`react-docgen adapter called with catalog.adapter = '${cfg.catalog.adapter}'`);
  }
  assertClassicTsApiAvailable();

  const srcDir = resolve(root, cfg.catalog.src);
  const barrelPath = resolveBarrelPath(root, srcDir, cfg.catalog.barrel);
  const barrelWalk = collectBarrelExportsWithFiles(barrelPath, 6, new Set());
  const allExports = barrelWalk.names;
  const barrelFiles = barrelWalk.files;

  const tsxRelFiles: string[] = [];
  // Source trees declare components in .tsx; a published package declares them in .d.ts
  // (react-docgen-typescript documents both, via the type checker). Skip .d.mts/.d.cts
  // duplicates of the same declarations.
  walkSourceFiles(srcDir, srcDir, ['.tsx', '.d.ts'], tsxRelFiles);
  tsxRelFiles.sort();
  const tsxFiles = tsxRelFiles.map((rel) => join(srcDir, rel));

  const docgenModule = loadReactDocgenTypescript();
  const tsconfigPath = findTsconfigUpward(srcDir, root);
  const parserOptions: ParserOptions = {
    shouldExtractLiteralValuesFromEnum: true,
    shouldRemoveUndefinedFromOptional: true,
    savePropValueAsString: true,
    // Needed to read a per-prop @deprecated tag (see propDeprecatedTag); without it
    // react-docgen-typescript folds tag lines into `description` as plain text instead.
    shouldIncludePropTagMap: true,
  } as ParserOptions;
  const parser = tsconfigPath
    ? docgenModule.withCompilerOptions(loadCompilerOptions(tsconfigPath), parserOptions)
    : docgenModule.withDefaultConfig(parserOptions);

  // One parse() call over every file, react-docgen-typescript builds a single ts.Program
  // for the whole list, so calling it per-file would rebuild that program every time.
  const docs: ComponentDoc[] = tsxFiles.length > 0 ? parser.parse(tsxFiles) : [];

  const byDir = new Map<string, CatalogExport[]>();
  const allPropsByExport: Record<string, string[]> = {};
  const exportEntryByName = new Map<string, CatalogExport>();

  // A barrel that re-exports components (always the case for a published package's
  // dist/index.d.ts) makes docgen document each component twice: once from its own file
  // and once from the barrel. Keep one doc per public name, preferring the deepest file
  // path (the component's own) and, at equal depth, the doc with more props.
  const bestByName = new Map<string, ComponentDoc>();
  for (const comp of docs) {
    if (!allExports.has(comp.displayName)) continue; // internal/unexported, not public API
    const prev = bestByName.get(comp.displayName);
    if (!prev) {
      bestByName.set(comp.displayName, comp);
      continue;
    }
    const depth = (c: ComponentDoc) => c.filePath.split(/[\\/]/).length;
    const propCount = (c: ComponentDoc) => Object.keys(c.props ?? {}).length;
    if (depth(comp) > depth(prev) || (depth(comp) === depth(prev) && propCount(comp) > propCount(prev))) {
      bestByName.set(comp.displayName, comp);
    }
  }

  for (const comp of bestByName.values()) {

    const rawProps = Object.values(comp.props ?? {});
    const { own, inheritedNames } = splitOwnInherited(rawProps, srcDir);

    const exportEntry: CatalogExport = {
      displayName: comp.displayName,
      description: (comp.description || '').trim(),
      props: own.map(toCatalogProp),
    };
    if (inheritedNames.length > 0) exportEntry.inheritedProps = inheritedNames;
    const deprecated = exportDeprecated(comp);
    if (deprecated !== undefined) exportEntry.deprecated = deprecated;

    const relDir = relative(srcDir, dirname(comp.filePath));
    const dirKey = relDir === '.' ? '' : relDir;
    const list = byDir.get(dirKey) ?? [];
    list.push(exportEntry);
    byDir.set(dirKey, list);
    exportEntryByName.set(comp.displayName, exportEntry);

    allPropsByExport[comp.displayName] = [...own.map((p) => p.name), ...inheritedNames];
  }

  // Every barrel export docgen left undocumented, or documented with zero props at all
  // (own and inherited both empty): try the props-type fallback before giving up on it.
  // Never throws; a name it can't resolve just falls through to the `[]` loop below exactly
  // as before.
  const undocumented = Array.from(allExports).filter((name) => {
    const doc = bestByName.get(name);
    return !doc || Object.keys(doc.props ?? {}).length === 0;
  });
  let fallbackDocumented = 0;
  if (undocumented.length > 0) {
    try {
      const fallbackOptions = tsconfigPath ? loadCompilerOptions(tsconfigPath) : CLASSIC_TS_DEFAULT_FALLBACK_OPTIONS();
      fallbackDocumented = applyPropsTypeFallback(
        undocumented,
        barrelFiles,
        srcDir,
        fallbackOptions,
        byDir,
        exportEntryByName,
        allPropsByExport
      );
    } catch {
      // Never throw from the fallback: every undocumented export just falls through below.
    }
  }
  process.stderr.write(`[extract] props-type fallback documented ${fallbackDocumented} of ${undocumented.length} undocumented exports\n`);

  // Barrel exports docgen never touched, hooks, helpers, non-.tsx exports, or a .tsx
  // export docgen couldn't turn into a component, are still real, confirmed symbols.
  for (const name of allExports) {
    if (!(name in allPropsByExport)) allPropsByExport[name] = [];
  }

  const components: SystemCatalog['components'] = Array.from(byDir.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, exports]) => ({ dir, exports }));

  // Which of allExports are types only (never values): see computeTypeOnlyExports's own
  // comment. Best-effort and never fatal -- an unresolved barrel just leaves this undefined.
  let typeOnlyExports: string[] | undefined;
  try {
    const typeOnlyOptions = tsconfigPath ? loadCompilerOptions(tsconfigPath) : CLASSIC_TS_DEFAULT_FALLBACK_OPTIONS();
    const typeOnly = computeTypeOnlyExports(allExports, barrelPath, typeOnlyOptions);
    if (typeOnly) typeOnlyExports = Array.from(typeOnly).sort();
  } catch {
    // Never throw: leave typeOnlyExports undefined.
  }

  const catalog: SystemCatalog = {
    system: id,
    generatedAt: new Date().toISOString(),
    source: { root, adapter: 'react-docgen', srcHash: computeSrcHash(srcDir) },
    components,
    allExports: Array.from(allExports).sort(),
    allPropsByExport,
  };
  if (typeOnlyExports) catalog.typeOnlyExports = typeOnlyExports;
  return catalog;
}

/** Nearest tsconfig.json walking upward from `startDir` through its ancestors, up to and including `stopAt`. Undefined when none exists in range (withDefaultConfig is the caller's fallback). */
function findTsconfigUpward(startDir: string, stopAt: string): string | undefined {
  const stop = resolve(stopAt);
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, 'tsconfig.json');
    if (existsSync(candidate)) return candidate;
    if (dir === stop) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

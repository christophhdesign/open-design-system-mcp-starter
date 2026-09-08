// Static usage checker: grades a JSX/TSX or HTML snippet against a loaded SystemData,
// the same way the sibling bench's apiFidelity grader checks generated code, but as a
// tool an agent can call on its own draft before committing it.
//
// TSX is parsed with the TypeScript compiler API (classic, available because this repo
// pins `typescript` to ^5 -- see the react-docgen adapter's module comment for why that
// pin matters). HTML (custom-element systems written as plain markup, or JSX-free
// snippets) gets a small regex tag scanner instead; no parser dependency is worth adding
// for that.

import ts from 'typescript';

import { findTokens } from '../search/index.ts';
import type { CatalogExport, CatalogProp, SystemCatalog, SystemData, UsageFinding, UsageReport } from '../types.ts';

// ---------------------------------------------------------------------------
// Shared element/attribute model: both parsers (TSX, HTML) fill this in, so
// every check below runs once, independent of source language.
// ---------------------------------------------------------------------------

interface ParsedAttr {
  name: string;
  /** Statically known string value (string literal, template with no substitutions, or a plain HTML attribute value). */
  stringValue?: string;
  /** Present only for a `style` attribute whose value is resolvable to CSS declarations. */
  styleEntries?: Array<{ prop: string; value: string }>;
}

interface ParsedElement {
  /** As written: 'Modal.Footer', 'acme-button', 'div'. */
  rawName: string;
  /** For a member expression, the leftmost identifier ('Modal' in 'Modal.Footer'); otherwise rawName. */
  baseIdentifier: string;
  line: number;
  attrs: ParsedAttr[];
  hasSpread: boolean;
  hasNonWhitespaceChildren: boolean;
}

interface ImportBinding {
  /** The name the module actually exports (resolves `import { Button as Btn }` to 'Button'). */
  realName: string;
  moduleSpecifier: string;
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

function detectLanguage(code: string, explicit: 'tsx' | 'html' | 'auto' | undefined): 'tsx' | 'html' {
  if (explicit === 'tsx' || explicit === 'html') return explicit;
  const hasCodeKeyword = /\bimport\b/.test(code) || /\bexport\b/.test(code) || /=>/.test(code) || /\bfunction\b/.test(code);
  const hasBraceExpression = code.includes('{');
  const hasTag = /<[a-zA-Z]/.test(code);
  if (!hasCodeKeyword && !hasBraceExpression && hasTag) return 'html';
  return 'tsx';
}

// ---------------------------------------------------------------------------
// TSX parsing (TypeScript compiler API)
// ---------------------------------------------------------------------------

interface TsxParseResult {
  imports: Map<string, ImportBinding>;
  importDecls: Array<{ specifier: string; line: number }>;
  /** Named imports only (default and namespace imports are excluded: they aren't statically verifiable). */
  namedImports: Array<{ realName: string; moduleSpecifier: string; line: number }>;
  elements: ParsedElement[];
}

function baseIdentifierOf(node: ts.JsxTagNameExpression): string {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return baseIdentifierOf(node.expression as ts.JsxTagNameExpression);
  return node.getText();
}

function parseTsxAttrValue(name: string, attr: ts.JsxAttribute): { stringValue?: string; styleEntries?: Array<{ prop: string; value: string }> } {
  const init = attr.initializer;
  if (!init) return {};
  if (ts.isStringLiteral(init)) return { stringValue: init.text };
  if (ts.isJsxExpression(init) && init.expression) {
    const expr = init.expression;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      return { stringValue: expr.text };
    }
    if (name === 'style' && ts.isObjectLiteralExpression(expr)) {
      const entries: Array<{ prop: string; value: string }> = [];
      for (const p of expr.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const propName = ts.isIdentifier(p.name) ? p.name.text : ts.isStringLiteral(p.name) ? p.name.text : undefined;
        if (!propName) continue;
        let value: string | undefined;
        if (ts.isStringLiteral(p.initializer) || ts.isNoSubstitutionTemplateLiteral(p.initializer)) value = p.initializer.text;
        else if (ts.isNumericLiteral(p.initializer)) value = `${p.initializer.text}px`;
        if (value !== undefined) entries.push({ prop: propName, value });
      }
      return { styleEntries: entries };
    }
  }
  return {};
}

function parseTsx(code: string, filename: string): TsxParseResult {
  const sourceFile = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = new Map<string, ImportBinding>();
  const importDecls: Array<{ specifier: string; line: number }> = [];
  const namedImports: Array<{ realName: string; moduleSpecifier: string; line: number }> = [];
  const elements: ParsedElement[] = [];

  const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const collectOpening = (opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement, node: ts.Node): void => {
    const rawName = opening.tagName.getText(sourceFile);
    const baseIdentifier = baseIdentifierOf(opening.tagName);
    const attrs: ParsedAttr[] = [];
    let hasSpread = false;
    for (const prop of opening.attributes.properties) {
      if (ts.isJsxSpreadAttribute(prop)) {
        hasSpread = true;
        continue;
      }
      if (ts.isJsxAttribute(prop)) {
        const name = prop.name.getText(sourceFile);
        attrs.push({ name, ...parseTsxAttrValue(name, prop) });
      }
    }
    let hasNonWhitespaceChildren = false;
    if (ts.isJsxElement(node)) {
      for (const child of node.children) {
        if (ts.isJsxText(child)) {
          if (child.text.trim().length > 0) hasNonWhitespaceChildren = true;
        } else if (ts.isJsxExpression(child)) {
          if (child.expression) hasNonWhitespaceChildren = true;
        } else {
          hasNonWhitespaceChildren = true;
        }
      }
    }
    elements.push({ rawName, baseIdentifier, line: lineOf(opening), attrs, hasSpread, hasNonWhitespaceChildren });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : '';
      importDecls.push({ specifier, line: lineOf(node) });
      const clause = node.importClause;
      if (clause) {
        if (clause.name) imports.set(clause.name.text, { realName: clause.name.text, moduleSpecifier: specifier });
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            const localName = el.name.text;
            const realName = el.propertyName ? el.propertyName.text : el.name.text;
            imports.set(localName, { realName, moduleSpecifier: specifier });
            namedImports.push({ realName, moduleSpecifier: specifier, line: lineOf(node) });
          }
        }
      }
    } else if (ts.isJsxElement(node)) {
      collectOpening(node.openingElement, node);
    } else if (ts.isJsxSelfClosingElement(node)) {
      collectOpening(node, node);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { imports, importDecls, namedImports, elements };
}

// ---------------------------------------------------------------------------
// HTML parsing (regex tag scanner)
// ---------------------------------------------------------------------------

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Blanks out (preserving length and newlines) comments and script/style contents so they never parse as tags. */
function stripCommentsAndRawText(code: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return code.replace(/<!--[\s\S]*?-->/g, blank).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, blank);
}

function parseCssDeclarations(css: string): Array<{ prop: string; value: string }> {
  const out: Array<{ prop: string; value: string }> = [];
  for (const decl of css.split(';')) {
    const trimmed = decl.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    out.push({ prop: trimmed.slice(0, idx).trim(), value: trimmed.slice(idx + 1).trim() });
  }
  return out;
}

function parseHtmlAttrs(attrsStr: string): ParsedAttr[] {
  const attrs: ParsedAttr[] = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrsStr))) {
    const name = m[1]!;
    const value = m[2] ?? m[3] ?? m[4];
    if (value === undefined) {
      attrs.push({ name });
      continue;
    }
    if (name.toLowerCase() === 'style') {
      attrs.push({ name, stringValue: value, styleEntries: parseCssDeclarations(value) });
    } else {
      attrs.push({ name, stringValue: value });
    }
  }
  return attrs;
}

/** Finds the index of the `</tagName>` that closes the tag opened at `fromIndex`, tracking same-tag nesting depth. */
function findMatchingCloseIndex(text: string, tagName: string, fromIndex: number): number | undefined {
  const openRe = new RegExp(`<${tagName}(?=[\\s/>])`, 'gi');
  const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi');
  let depth = 1;
  let pos = fromIndex;
  while (depth > 0) {
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;
    const om = openRe.exec(text);
    const cm = closeRe.exec(text);
    if (!cm) return undefined;
    if (om && om.index < cm.index) {
      depth++;
      pos = om.index + om[0].length;
    } else {
      depth--;
      pos = cm.index + cm[0].length;
      if (depth === 0) return cm.index;
    }
  }
  return undefined;
}

function parseHtml(code: string): ParsedElement[] {
  const cleaned = stripCommentsAndRawText(code);
  const elements: ParsedElement[] = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*?)?)\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(cleaned))) {
    const closingSlash = m[1];
    const tagName = m[2]!;
    const attrsStr = m[3] ?? '';
    const selfClosingSlash = m[4];
    if (closingSlash) continue;
    const line = lineAt(cleaned, m.index);
    const attrs = parseHtmlAttrs(attrsStr);
    const isVoid = VOID_ELEMENTS.has(tagName.toLowerCase());
    let hasNonWhitespaceChildren = false;
    if (!isVoid && !selfClosingSlash) {
      const closeIdx = findMatchingCloseIndex(cleaned, tagName, tagRe.lastIndex);
      if (closeIdx !== undefined) {
        const inner = cleaned.slice(tagRe.lastIndex, closeIdx).replace(/<[^>]*>/g, '');
        hasNonWhitespaceChildren = inner.trim().length > 0;
      }
    }
    elements.push({ rawName: tagName, baseIdentifier: tagName, line, attrs, hasSpread: false, hasNonWhitespaceChildren });
  }
  return elements;
}

// ---------------------------------------------------------------------------
// Component resolution
// ---------------------------------------------------------------------------

function findExportExact(catalog: SystemCatalog, name: string): CatalogExport | undefined {
  for (const c of catalog.components) {
    for (const exp of c.exports) {
      if (exp.displayName === name || exp.tagName === name) return exp;
    }
  }
  return undefined;
}

type Resolved =
  | { kind: 'resolved'; exp: CatalogExport }
  /** In allExports (so it is a real, public component) but no CatalogExport documents it: props cannot be checked. */
  | { kind: 'undocumented'; name: string }
  | { kind: 'unknown'; attemptedName: string; via?: string }
  | { kind: 'unresolved' };

/** Membership in `allExports` is the only test for "does this component exist" -- a name absent from
 * the docgen'd components list (undocumented) still resolves as real, just without a props table. */
function resolveByName(data: SystemData, exp: CatalogExport | undefined, name: string, attemptedVia: { attemptedName: string; via?: string }): Resolved {
  if (exp) return { kind: 'resolved', exp };
  if (data.catalog.allExports.includes(name)) return { kind: 'undocumented', name };
  return { kind: 'unknown', ...attemptedVia };
}

function resolveElement(data: SystemData, el: ParsedElement, imports: Map<string, ImportBinding> | undefined): Resolved {
  const model = data.cfg.componentModel ?? 'react';

  if (model === 'custom-elements') {
    // PascalCase tags in a custom-elements system are local React components, not this
    // system's -- only a dashed tag is ever this system's own.
    if (!el.rawName.includes('-')) return { kind: 'unresolved' };
    const exp = findExportExact(data.catalog, el.rawName);
    return resolveByName(data, exp, el.rawName, { attemptedName: el.rawName });
  }

  if (!imports) return { kind: 'unresolved' };
  const binding = imports.get(el.baseIdentifier);
  if (!binding) return { kind: 'unresolved' };
  const pkg = data.cfg.componentsPkg;
  if (!pkg || (binding.moduleSpecifier !== pkg && !binding.moduleSpecifier.startsWith(`${pkg}/`))) return { kind: 'unresolved' };
  const exp = findExportExact(data.catalog, binding.realName);
  return resolveByName(data, exp, binding.realName, { attemptedName: binding.realName, via: binding.moduleSpecifier });
}

// ---------------------------------------------------------------------------
// Universally allowed attributes/props
// ---------------------------------------------------------------------------

const UNIVERSAL_EXACT = new Set(['key', 'ref', 'children', 'className', 'style', 'id', 'slot', 'hidden', 'title', 'role', 'tabIndex', 'tabindex', 'lang', 'dir', 'part']);

function isUniversallyAllowed(name: string, model: 'react' | 'custom-elements' | undefined): boolean {
  if (UNIVERSAL_EXACT.has(name)) return true;
  if (name === 'class' && model === 'custom-elements') return true;
  if (name.startsWith('data-') || name.startsWith('aria-')) return true;
  if (/^on[A-Z]/.test(name)) return true; // react: onClick, onChange, ...
  if (/^on-/.test(name)) return true; // custom elements: on-click
  if (name.startsWith('@')) return true; // custom elements: @click
  return false;
}

function toCamel(s: string): string {
  return s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function toKebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function findCasingMatch(pool: Set<string>, name: string): string | undefined {
  if (pool.has(name)) return name;
  const lc = name.toLowerCase();
  for (const p of pool) if (p.toLowerCase() === lc) return p;
  const camel = toCamel(name);
  if (pool.has(camel)) return camel;
  const kebab = toKebab(name);
  if (pool.has(kebab)) return kebab;
  return undefined;
}

function closestRealProp(data: SystemData, allowed: Set<string>, attrName: string): string | undefined {
  const teamAlias = data.aliases.props.find((a) => a.source === 'team' && a.alias.toLowerCase() === attrName.toLowerCase());
  if (teamAlias?.target) {
    const match = findCasingMatch(allowed, teamAlias.target);
    if (match) return `use '${match}' instead`;
  }
  const match = findCasingMatch(allowed, attrName);
  return match ? `use '${match}' instead` : undefined;
}

function findCatalogProp(exp: CatalogExport, attrName: string): CatalogProp | undefined {
  const camel = toCamel(attrName);
  const kebab = toKebab(attrName);
  return exp.props.find((p) => p.name === attrName || p.name === camel || p.name === kebab);
}

// ---------------------------------------------------------------------------
// Raw value detection
// ---------------------------------------------------------------------------

const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
const COLOR_FN_RE = /\b(?:rgba?|hsla?)\([^)]*\)/gi;
const BRACKET_PX_RE = /\[[^\]]*?(-?\d*\.?\d+px)[^\]]*?\]/g;

const FULL_HEX_RE = /^#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})$/;
const FULL_COLOR_FN_RE = /^(?:rgba?|hsla?)\([^)]*\)$/i;
const FULL_PX_RE = /^-?\d*\.?\d+px$/;

/** Raw color/length substrings found in a free-form string (a className or a style-attribute string). */
function findRawValuesInText(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const pushUnique = (v: string) => {
    if (!seen.has(v)) {
      seen.add(v);
      found.push(v);
    }
  };
  for (const m of text.matchAll(HEX_RE)) pushUnique(m[0]);
  for (const m of text.matchAll(COLOR_FN_RE)) pushUnique(m[0]);
  for (const m of text.matchAll(BRACKET_PX_RE)) pushUnique(m[1]!);
  return found;
}

/** A single CSS-declaration value (e.g. one `style` object property), when it IS a raw color or pixel length. */
function rawValueInSingleValue(value: string): string | undefined {
  const v = value.trim();
  if (FULL_HEX_RE.test(v) || FULL_COLOR_FN_RE.test(v) || FULL_PX_RE.test(v)) return v;
  return undefined;
}

function pushRawValueFinding(data: SystemData, findings: UsageFinding[], el: ParsedElement, raw: string, where: string): void {
  const hits = findTokens(data, raw);
  const fix = hits[0] ? `use ${hits[0].write}` : 'use a design token';
  findings.push({ kind: 'raw-value', severity: 'warning', message: `Raw value '${raw}' in ${where}`, fix, line: el.line, subject: el.rawName });
}

function checkRawValues(data: SystemData, el: ParsedElement, findings: UsageFinding[]): void {
  for (const attr of el.attrs) {
    if ((attr.name === 'className' || attr.name === 'class') && attr.stringValue) {
      for (const raw of findRawValuesInText(attr.stringValue)) pushRawValueFinding(data, findings, el, raw, attr.name);
    }
    if (attr.name === 'style') {
      if (attr.styleEntries) {
        for (const entry of attr.styleEntries) {
          const raw = rawValueInSingleValue(entry.value);
          if (raw) pushRawValueFinding(data, findings, el, raw, `style.${entry.prop}`);
        }
      } else if (attr.stringValue) {
        for (const raw of findRawValuesInText(attr.stringValue)) pushRawValueFinding(data, findings, el, raw, 'style');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Literal-value checking
// ---------------------------------------------------------------------------

/**
 * Parses a catalog prop `type` string as a self-contained string-literal union
 * ("'primary' | 'secondary'", `"a" | "b"`, an optional trailing `| undefined`),
 * returning its members. Returns undefined for anything that isn't purely a
 * union of quoted string literals (`boolean`, `string`, a type alias, a union
 * that mixes in another symbol) -- those are not ours to validate.
 */
export function parseLiteralUnion(type: string): string[] | undefined {
  const parts = type.split('|').map((p) => p.trim());
  const members: string[] = [];
  for (const part of parts) {
    if (part === 'undefined') continue;
    const m = /^(['"])(.*)\1$/.exec(part);
    if (!m) return undefined;
    members.push(m[2]!);
  }
  return members.length > 0 ? members : undefined;
}

/** Closest allowed literal for a rejected value: an exact case-insensitive match, then a team prop-alias whose target is a member, else the full list. */
function closestLiteralValue(data: SystemData, members: string[], value: string): string {
  const lc = value.toLowerCase();
  const ciMatch = members.find((m) => m.toLowerCase() === lc);
  if (ciMatch) return `use '${ciMatch}' instead`;
  const teamAlias = data.aliases.props.find((a) => a.source === 'team' && a.alias.toLowerCase() === lc && a.target && members.some((m) => m.toLowerCase() === a.target!.toLowerCase()));
  if (teamAlias) {
    const match = members.find((m) => m.toLowerCase() === teamAlias.target!.toLowerCase())!;
    return `use '${match}' instead`;
  }
  return `one of ${members.join(', ')}`;
}

/** Checks a resolved attribute's statically-known string value against its catalog prop's type, when that type is checkable. */
function checkLiteralValue(data: SystemData, catProp: CatalogProp, attr: ParsedAttr, realName: string, el: ParsedElement, findings: UsageFinding[]): void {
  // Only a plain string literal (or a quoted-literal expression, e.g. `foo={'bar'}`) is checkable;
  // anything else (a variable, a call, no value at all) is skipped -- we cannot see its value statically.
  if (attr.stringValue === undefined) return;
  const value = attr.stringValue;
  const type = catProp.type.trim();
  const subject = `${realName}.${attr.name}`;

  if (type === 'boolean') {
    if (value !== 'true' && value !== 'false') {
      findings.push({ kind: 'invalid-value', severity: 'warning', message: `Invalid value '${value}' for ${attr.name} on <${realName}>: expected true or false`, line: el.line, subject });
    }
    return;
  }

  if (type === 'number') {
    if (value.trim() === '' || Number.isNaN(Number(value))) {
      findings.push({ kind: 'invalid-value', severity: 'warning', message: `Invalid value '${value}' for ${attr.name} on <${realName}>: expected a number`, line: el.line, subject });
    }
    return;
  }

  const members = parseLiteralUnion(type);
  if (!members || members.includes(value)) return;

  findings.push({
    kind: 'invalid-value',
    severity: 'error',
    message: `Invalid value '${value}' for ${attr.name} on <${realName}>: expected one of ${members.join(', ')}`,
    fix: closestLiteralValue(data, members, value),
    line: el.line,
    subject,
  });
}

// ---------------------------------------------------------------------------
// Props, deprecation, accessible name
// ---------------------------------------------------------------------------

function checkProps(data: SystemData, exp: CatalogExport, realName: string, el: ParsedElement, findings: UsageFinding[]): void {
  const own = new Set<string>(data.catalog.allPropsByExport[realName] ?? exp.props.map((p) => p.name));
  for (const n of exp.inheritedProps ?? []) own.add(n);

  for (const attr of el.attrs) {
    if (isUniversallyAllowed(attr.name, data.cfg.componentModel)) continue;
    if (own.has(attr.name)) {
      const catProp = findCatalogProp(exp, attr.name);
      if (catProp?.deprecated) {
        findings.push({
          kind: 'deprecated',
          severity: 'warning',
          message: `'${attr.name}' on ${realName} is deprecated: ${catProp.deprecated}`,
          fix: catProp.deprecated,
          line: el.line,
          subject: `${realName}.${attr.name}`,
        });
      }
      if (catProp) checkLiteralValue(data, catProp, attr, realName, el, findings);
      continue;
    }
    findings.push({
      kind: 'invented-prop',
      severity: 'warning',
      message: `Invented prop '${attr.name}' on ${realName}`,
      fix: closestRealProp(data, own, attr.name),
      line: el.line,
      subject: `${realName}.${attr.name}`,
    });
  }
}

function attrNonEmpty(el: ParsedElement, name: string): boolean {
  return el.attrs.some((a) => a.name === name && (a.stringValue?.trim().length ?? 0) > 0);
}

function accessibleNameRequired(exp: CatalogExport, realName: string): boolean {
  if (exp.a11y) return exp.a11y.accessibleName === 'required';
  return /IconButton|Icon-only|icon-button/i.test(realName);
}

function checkAccessibleName(exp: CatalogExport, realName: string, el: ParsedElement, findings: UsageFinding[]): void {
  if (!accessibleNameRequired(exp, realName)) return;
  if (attrNonEmpty(el, 'aria-label') || attrNonEmpty(el, 'aria-labelledby') || attrNonEmpty(el, 'title') || attrNonEmpty(el, 'label') || el.hasNonWhitespaceChildren) {
    return;
  }
  findings.push({
    kind: 'missing-accessible-name',
    severity: 'error',
    message: `'${realName}' needs an accessible name: set aria-label, aria-labelledby, a label prop, title, or non-empty text content.`,
    line: el.line,
    subject: realName,
  });
}

// ---------------------------------------------------------------------------
// Disallowed imports (TSX only)
// ---------------------------------------------------------------------------

function matchesPkg(spec: string, pkg: string | undefined): boolean {
  if (!pkg) return false;
  return spec === pkg || spec.startsWith(`${pkg}/`);
}

function isAllowedSpecifier(spec: string, data: SystemData, extra: string[]): boolean {
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') return true;
  if (matchesPkg(spec, data.cfg.componentsPkg)) return true;
  if (matchesPkg(spec, data.cfg.foundationsPkg)) return true;
  if (spec === 'react' || spec.startsWith('react/')) return true;
  if (spec === 'react-dom' || spec.startsWith('react-dom/')) return true;
  for (const e of extra) if (matchesPkg(spec, e)) return true;
  return false;
}

function checkDisallowedImports(data: SystemData, importDecls: Array<{ specifier: string; line: number }>, extraAllowedImports: string[] | undefined, findings: UsageFinding[]): void {
  const extra = extraAllowedImports ?? [];
  for (const imp of importDecls) {
    if (!imp.specifier) continue;
    if (isAllowedSpecifier(imp.specifier, data, extra)) continue;
    findings.push({ kind: 'disallowed-import', severity: 'error', message: `Disallowed import '${imp.specifier}'`, line: imp.line, subject: imp.specifier });
  }
}

/**
 * Named imports from componentsPkg (or a subpath) are checked against `allExports`
 * regardless of component model: a custom-elements system's own components are never
 * resolved through JSX (only dashed tags are), so without this an agent importing a
 * name that doesn't exist there would sail through unflagged. Default and namespace
 * imports are skipped -- there is no name to check statically.
 */
function checkHallucinatedImports(data: SystemData, namedImports: Array<{ realName: string; moduleSpecifier: string; line: number }>, findings: UsageFinding[]): void {
  const pkg = data.cfg.componentsPkg;
  if (!pkg) return;
  for (const imp of namedImports) {
    if (!matchesPkg(imp.moduleSpecifier, pkg)) continue;
    if (data.catalog.allExports.includes(imp.realName)) continue;
    findings.push({
      kind: 'unknown-component',
      severity: 'error',
      message: `Hallucinated component '${imp.realName}' imported from '${imp.moduleSpecifier}'`,
      line: imp.line,
      subject: imp.realName,
    });
  }
}

// ---------------------------------------------------------------------------
// Element pipeline
// ---------------------------------------------------------------------------

function checkElement(data: SystemData, el: ParsedElement, imports: Map<string, ImportBinding> | undefined, findings: UsageFinding[], usedComponents: Set<string>): void {
  // Raw-value hygiene applies to every element, DS component or not: a hardcoded
  // hex in a plain <div className> is exactly what this check exists to catch.
  checkRawValues(data, el, findings);

  const resolved = resolveElement(data, el, imports);
  if (resolved.kind === 'unresolved') return;
  if (resolved.kind === 'undocumented') {
    // A real, public export -- just one docgen never documented. Record the usage;
    // there is no props table to check invented-prop or invalid-value against.
    usedComponents.add(resolved.name);
    return;
  }
  if (resolved.kind === 'unknown') {
    // Import-anchored hallucinations (a named import from componentsPkg not in allExports)
    // are reported once, at the import declaration, by checkHallucinatedImports -- not
    // re-reported here per JSX usage.
    if (!resolved.via) {
      findings.push({ kind: 'unknown-component', severity: 'error', message: `Hallucinated component '${resolved.attemptedName}'`, line: el.line, subject: resolved.attemptedName });
    }
    return;
  }

  const exp = resolved.exp;
  const realName = exp.displayName;
  usedComponents.add(realName);

  if (exp.deprecated) {
    const parts: string[] = [];
    if (exp.deprecated.since) parts.push(`since ${exp.deprecated.since}`);
    if (exp.deprecated.replacement) parts.push(`use ${exp.deprecated.replacement}`);
    if (exp.deprecated.note) parts.push(exp.deprecated.note);
    findings.push({
      kind: 'deprecated',
      severity: 'warning',
      message: `'${realName}' is deprecated${parts.length ? `: ${parts.join(', ')}` : ''}.`,
      fix: exp.deprecated.replacement,
      line: el.line,
      subject: realName,
    });
  }

  // A spread attribute suppresses invented-prop checks for the whole element: we
  // cannot see what it carries, so we cannot call any of it invented.
  if (!el.hasSpread) checkProps(data, exp, realName, el, findings);

  checkAccessibleName(exp, realName, el, findings);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function checkUsage(data: SystemData, code: string, opts?: { language?: 'tsx' | 'html' | 'auto'; filename?: string; extraAllowedImports?: string[] }): UsageReport {
  const language = detectLanguage(code, opts?.language);
  const findings: UsageFinding[] = [];
  const usedComponents = new Set<string>();

  if (language === 'tsx') {
    const parsed = parseTsx(code, opts?.filename ?? 'snippet.tsx');
    checkDisallowedImports(data, parsed.importDecls, opts?.extraAllowedImports, findings);
    checkHallucinatedImports(data, parsed.namedImports, findings);
    for (const el of parsed.elements) checkElement(data, el, parsed.imports, findings, usedComponents);
  } else {
    for (const el of parseHtml(code)) checkElement(data, el, undefined, findings, usedComponents);
  }

  findings.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || a.kind.localeCompare(b.kind));
  return { system: data.id, language, findings, usedComponents: [...usedComponents].sort() };
}

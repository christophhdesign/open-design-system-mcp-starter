// css-vars adapter: parses `--name: value;` custom-property declarations out of plain CSS files.
// Recognizes theme-bearing selectors (:root/html/body as the default "light" theme,
// [data-theme="x"] / .x-theme / .dark / .light classes, and
// @media (prefers-color-scheme: dark)) and builds one Token per custom-property name.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SystemConfig, SystemId, SystemTokens, Token, TokenCategory } from '../types.ts';
import { sha256 } from './index.ts';

interface PerTokenData {
  valuesByTheme: Map<string, string>;
  firstSeen?: string;
}

export function extractTokens(id: SystemId, cfg: SystemConfig, root: string): SystemTokens {
  if (!cfg.tokens || cfg.tokens.adapter !== 'css-vars') {
    throw new Error(`css-vars adapter called with tokens.adapter = '${cfg.tokens?.adapter}'`);
  }

  const filePaths = cfg.tokens.files.map((f) => resolve(root, f));
  const fileContents: string[] = [];
  for (const p of filePaths) {
    try {
      fileContents.push(readFileSync(p, 'utf8'));
    } catch (err) {
      throw new Error(`css-vars: could not read ${p}: ${(err as Error).message}`);
    }
  }

  const hash = sha256(fileContents.join(''));

  const perName = new Map<string, PerTokenData>();
  const themesSeen = new Set<string>();

  for (const content of fileContents) {
    processCss(stripComments(content), undefined, perName, themesSeen);
  }

  const tokens: Token[] = [];
  for (const [varName, data] of perName) {
    const canonical = `--${varName}`;
    const value = data.valuesByTheme.get('light') ?? data.firstSeen;
    const valuesByTheme =
      data.valuesByTheme.size > 1 ? Object.fromEntries(data.valuesByTheme) : undefined;
    const references = value ? extractReferences(value) : [];

    tokens.push({
      name: canonical,
      cssVar: canonical,
      value,
      valuesByTheme,
      category: classifyCategory(varName, value ?? ''),
      references: references.length ? references : undefined,
    });
  }

  tokens.sort((a, b) => a.name.localeCompare(b.name));

  return {
    system: id,
    generatedAt: new Date().toISOString(),
    source: { root, files: filePaths, adapter: 'css-vars', hash },
    tokens,
    cssVars: tokens.map((t) => t.name),
    themes: themesSeen.size ? Array.from(themesSeen).sort() : undefined,
  };
}

// ---------------------------------------------------------------------------
// Tiny brace-aware CSS walker: no nested-rule library, just enough to find
// `selector { ... }` blocks (including one level of @media nesting) without
// getting confused by braces inside a media query.
// ---------------------------------------------------------------------------

interface CssBlock {
  header: string;
  body: string;
}

function extractTopLevelBlocks(css: string): CssBlock[] {
  const blocks: CssBlock[] = [];
  let depth = 0;
  let headerStart = 0;
  let openIndex = -1;

  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0) {
        openIndex = i;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && openIndex !== -1) {
        // Brace-less statements before a block (`@import ...;`, Tailwind's
        // `@custom-variant dark (...);`) would otherwise become part of the next
        // header and, when they mention .dark, mislabel a :root block as the dark
        // theme. The header is only what follows the last top-level semicolon.
        const rawHeader = css.slice(headerStart, openIndex);
        const lastStatementEnd = rawHeader.lastIndexOf(';');
        blocks.push({
          header: (lastStatementEnd === -1 ? rawHeader : rawHeader.slice(lastStatementEnd + 1)).trim(),
          body: css.slice(openIndex + 1, i),
        });
        headerStart = i + 1;
        openIndex = -1;
      }
    }
  }
  return blocks;
}

function processCss(
  css: string,
  mediaTheme: string | undefined,
  perName: Map<string, PerTokenData>,
  themesSeen: Set<string>
): void {
  for (const block of extractTopLevelBlocks(css)) {
    const header = block.header;

    if (/^@media/i.test(header)) {
      const nextMediaTheme = /prefers-color-scheme\s*:\s*dark/i.test(header) ? 'dark' : mediaTheme;
      processCss(block.body, nextMediaTheme, perName, themesSeen);
      continue;
    }

    // Cascade layers and Tailwind 4's `@theme` directive both wrap ordinary blocks or
    // declarations. `@layer x { :root { ... } }` recurses; `@theme inline { --x: ... }`
    // declares default-theme tokens directly, so treat its body like a :root block.
    if (/^@layer/i.test(header)) {
      processCss(block.body, mediaTheme, perName, themesSeen);
      continue;
    }
    if (/^@theme/i.test(header)) {
      processCss(`:root { ${block.body} }`, mediaTheme, perName, themesSeen);
      continue;
    }

    const theme = themeForSelector(header, mediaTheme);
    if (!theme) continue;
    themesSeen.add(theme);

    for (const [varName, rawValue] of extractDeclarations(block.body)) {
      let entry = perName.get(varName);
      if (!entry) {
        entry = { valuesByTheme: new Map() };
        perName.set(varName, entry);
      }
      if (entry.firstSeen === undefined) entry.firstSeen = rawValue;
      if (!entry.valuesByTheme.has(theme)) entry.valuesByTheme.set(theme, rawValue);
    }
  }
}

function themeForSelector(header: string, mediaTheme: string | undefined): string | undefined {
  const selectors = header.split(',').map((s) => s.trim());
  for (const sel of selectors) {
    const dataTheme = sel.match(/\[data-theme\s*=\s*["']?([\w-]+)["']?\]/i);
    if (dataTheme) return dataTheme[1];

    const xTheme = sel.match(/\.([\w-]+)-theme\b/i);
    if (xTheme) return xTheme[1];

    if (/^\.dark\b/.test(sel)) return 'dark';
    if (/^\.light\b/.test(sel)) return 'light';

    if (/^:root\b/.test(sel) || /^html\b/i.test(sel) || /^body\b/i.test(sel)) {
      return mediaTheme ?? 'light';
    }
  }
  return undefined;
}

function extractDeclarations(body: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    out.push([m[1], m[2].trim()]);
  }
  return out;
}

function extractReferences(value: string): string[] {
  const out = new Set<string>();
  const re = /var\(\s*(--[a-zA-Z0-9_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    out.add(m[1]);
  }
  return Array.from(out);
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function classifyCategory(name: string, value: string): TokenCategory {
  // Match whole name segments (split on -, _, . and camelCase), not substrings:
  // "letterSpacing" is typography, not space, and "shadow-focus-inset" is a shadow.
  const segments = name
    .replace(/^--/, '')
    .split(/[-_.]+/)
    .flatMap((part) => part.split(/(?=[A-Z])/))
    .map((x) => x.toLowerCase())
    .filter(Boolean);
  const has = (...words: string[]) => words.some((w) => segments.includes(w));
  const hasPair = (a: string, b: string) => segments.some((x, i) => x === a && segments[i + 1] === b);

  if (has('shadow', 'elevation')) return 'shadow';
  if (has('font', 'letter', 'leading', 'tracking', 'weight', 'type', 'typography', 'text') && !has('color')) {
    if (has('font', 'letter', 'leading', 'tracking', 'weight', 'type', 'typography')) return 'typography';
  }
  if (hasPair('line', 'height')) return 'typography';
  if (hasPair('border', 'width') || hasPair('stroke', 'width')) return 'border';
  if (has('radius', 'rounded')) return 'radius';
  if (has('duration', 'easing', 'ease', 'transition', 'motion', 'animate', 'animation')) return 'motion';
  if (has('opacity', 'alpha')) return 'opacity';
  if (hasPair('z', 'index') || has('zindex', 'layer')) return 'z-index';
  if (has('color', 'bg', 'background', 'fill', 'stroke', 'border', 'text')) return 'color';
  if (has('space', 'spacing', 'gap', 'inset', 'padding', 'margin')) return 'space';
  if (has('size', 'width', 'height', 'breakpoint', 'container')) return 'size';

  const v = value.trim().toLowerCase();
  if (
    /^#[0-9a-f]{3,8}$/.test(v) ||
    /^(rgb|rgba|hsl|hsla|oklch|oklab)\(/.test(v) ||
    ['black', 'white', 'transparent', 'currentcolor'].includes(v)
  ) {
    return 'color';
  }

  return 'other';
}

// See src/adapters/react-docgen.ts's module comment: react-docgen-typescript needs the
// classic TypeScript Compiler API, and the 'typescript' package installed in this repo
// (v7.x) doesn't expose it. classicTsApiAvailable() is the real capability probe; the
// docgen-dependent tests below skip themselves (with a clear reason) rather than fail when
// it's unavailable, so a broken environment doesn't turn into a red shared test suite. The
// srcHash tests don't touch docgen or the barrel walker at all, so they always run for real.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SystemConfig } from '../types.ts';
import { undocumentedValueExports } from '../data/undocumented.ts';
import { classicTsApiAvailable, extractCatalog, sourceHash } from './react-docgen.ts';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ds-mcp-react-docgen-test-'));
}

/**
 * A tiny React-shaped source tree, deliberately free of any @types/react dependency (this
 * repo may not have it installed):
 *   - Button.tsx: a literal-union prop and a @deprecated prop.
 *   - stack/Stack.tsx: props extend a locally-declared HTMLAttributes-shaped interface kept
 *     OUTSIDE src, so its className/id land in inheritedProps rather than own props.
 *   - useThing.ts: a plain hook (not a component) with no props to document.
 *   - index.ts: named exports plus `export * from './stack'` through a nested barrel, so
 *     both barrel shapes and the depth-4 recursion get exercised.
 */
function writeFixture(dir: string): void {
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          jsx: 'react-jsx',
          strict: true,
          skipLibCheck: true,
          esModuleInterop: true,
        },
      },
      null,
      2
    )
  );

  mkdirSync(join(dir, 'types'), { recursive: true });
  writeFileSync(
    join(dir, 'types', 'dom-attrs.ts'),
    [
      '// Kept outside src on purpose: Stack.tsx extends this, so its fields resolve outside',
      "// src and land in inheritedProps rather than Stack's own props.",
      'export interface HTMLAttributes {',
      '  className?: string;',
      '  id?: string;',
      '}',
      '',
    ].join('\n')
  );

  mkdirSync(join(dir, 'src', 'stack'), { recursive: true });

  writeFileSync(
    join(dir, 'src', 'Button.tsx'),
    [
      "export type ButtonVariant = 'primary' | 'secondary' | 'ghost';",
      '',
      'export interface ButtonProps {',
      '  /** Visual style of the button. */',
      '  variant?: ButtonVariant;',
      '  /**',
      '   * Disables interaction.',
      '   * @deprecated use `isDisabled` instead',
      '   */',
      '  disabled?: boolean;',
      '  onClick?: () => void;',
      '}',
      '',
      '/** A clickable button. */',
      'export function Button(props: ButtonProps) {',
      '  return null;',
      '}',
      '',
    ].join('\n')
  );

  writeFileSync(
    join(dir, 'src', 'useThing.ts'),
    ['export function useThing(): number {', '  return 1;', '}', ''].join('\n')
  );

  writeFileSync(
    join(dir, 'src', 'stack', 'Stack.tsx'),
    [
      "import type { HTMLAttributes } from '../../types/dom-attrs';",
      '',
      'export interface StackProps extends HTMLAttributes {',
      '  /** Gap between children, in spacing units. */',
      '  gap?: number;',
      '}',
      '',
      'export function Stack(props: StackProps) {',
      '  return null;',
      '}',
      '',
    ].join('\n')
  );

  writeFileSync(join(dir, 'src', 'stack', 'index.ts'), "export * from './Stack';\n");

  writeFileSync(
    join(dir, 'src', 'index.ts'),
    ["export { Button } from './Button';", "export { useThing } from './useThing';", "export * from './stack';", ''].join('\n')
  );
}

test('react-docgen: sourceHash is stable across runs and changes when a file changes', () => {
  const dir = makeTempDir();
  try {
    writeFixture(dir);
    const cfg: SystemConfig = { catalog: { adapter: 'react-docgen', src: 'src' } };

    const first = sourceHash(cfg, dir);
    const second = sourceHash(cfg, dir);
    assert.equal(first, second);

    writeFileSync(join(dir, 'src', 'Button.tsx'), 'export function Button() { return null; }\n');
    const third = sourceHash(cfg, dir);
    assert.notEqual(first, third);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('react-docgen: rejects a non-react-docgen catalog config', () => {
  const dir = makeTempDir();
  try {
    const cfg: SystemConfig = { catalog: { adapter: 'catalog-json', path: 'catalog.json' } };
    assert.throws(() => sourceHash(cfg, dir), /react-docgen adapter called with catalog\.adapter/);
    assert.throws(() => extractCatalog('acme', cfg, dir), /react-docgen adapter called with catalog\.adapter/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const docgenSkipReason = classicTsApiAvailable()
  ? false
  : "the installed 'typescript' package does not expose the classic Compiler API (see react-docgen.ts's module comment), install typescript@5 as a nested dependency of react-docgen-typescript to run this for real";

/**
 * A barrel that only uses ESM-style `.js` specifiers, the shape a real design system's
 * `tsc`-compiled barrel actually ships (import specifiers point at the emitted `.js` file,
 * not the `.ts` source):
 *   - index.ts re-exports everything from a nested barrel via `export * from './core/index.js'`.
 *   - core/index.ts is the target of that `export *`, declaring a plain component.
 *   - index.ts also names an export from a leaf module via `export { Thing } from './thing.js'`.
 * Before resolveRelativeModule stripped the JS extension, `export * from './core/index.js'`
 * failed to resolve at all and its exports were silently dropped from allExports.
 */
function writeEsmSpecifierFixture(dir: string): void {
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          jsx: 'react-jsx',
          strict: true,
          skipLibCheck: true,
          esModuleInterop: true,
        },
      },
      null,
      2
    )
  );

  mkdirSync(join(dir, 'src', 'core'), { recursive: true });

  writeFileSync(
    join(dir, 'src', 'core', 'index.ts'),
    [
      'export interface CoreProps {',
      '  label?: string;',
      '}',
      '',
      'export function Core(props: CoreProps) {',
      '  return null;',
      '}',
      '',
    ].join('\n')
  );

  writeFileSync(join(dir, 'src', 'thing.ts'), "export const Thing = 1;\n");

  writeFileSync(
    join(dir, 'src', 'index.ts'),
    ["export * from './core/index.js';", "export { Thing } from './thing.js';", ''].join('\n')
  );
}

test(
  'react-docgen: barrel resolves .js/.jsx/.mjs/.cjs specifiers to their .ts(x) source',
  { skip: docgenSkipReason },
  () => {
    const dir = makeTempDir();
    try {
      writeEsmSpecifierFixture(dir);
      const cfg: SystemConfig = { catalog: { adapter: 'react-docgen', src: 'src' } };
      const catalog = extractCatalog('acme', cfg, dir);

      // export * from './core/index.js' must resolve to core/index.ts and pick up Core.
      assert.ok(catalog.allExports.includes('Core'), 'Core should resolve through the .js export * specifier');
      // export { Thing } from './thing.js' names Thing directly.
      assert.ok(catalog.allExports.includes('Thing'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

/**
 * A component whose own props interface lives in a sibling file inside src (types.ts), and
 * whose inherited props come from a real node_modules package, run from a root that is NOT
 * under process.cwd(). This exercises splitOwnInherited's location-based own/inherited split
 * (resolveParentFileName, looksThirdParty, isInside) independent of where the test runner's
 * cwd happens to be.
 */
function writeOwnVsInheritedFixture(dir: string): void {
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'node',
          jsx: 'react-jsx',
          strict: true,
          skipLibCheck: true,
          esModuleInterop: true,
        },
      },
      null,
      2
    )
  );

  mkdirSync(join(dir, 'node_modules', 'fake-lib'), { recursive: true });
  writeFileSync(
    join(dir, 'node_modules', 'fake-lib', 'package.json'),
    JSON.stringify({ name: 'fake-lib', version: '1.0.0', types: 'index.d.ts', main: 'index.d.ts' }, null, 2)
  );
  writeFileSync(
    join(dir, 'node_modules', 'fake-lib', 'index.d.ts'),
    ['export interface LibProps {', '  libProp?: string;', '}', ''].join('\n')
  );

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'types.ts'),
    ["export interface ButtonProps {", "  variant?: 'a' | 'b';", '}', ''].join('\n')
  );
  writeFileSync(
    join(dir, 'src', 'Button.tsx'),
    [
      "import type { ButtonProps } from './types';",
      "import type { LibProps } from 'fake-lib';",
      '',
      'export interface FullButtonProps extends ButtonProps, LibProps {}',
      '',
      'export function Button(props: FullButtonProps) {',
      '  return null;',
      '}',
      '',
    ].join('\n')
  );
  writeFileSync(join(dir, 'src', 'index.ts'), "export { Button } from './Button';\n");
}

test(
  'react-docgen: own props from a sibling src file vs inherited props from node_modules, run outside cwd',
  { skip: docgenSkipReason },
  () => {
    const dir = makeTempDir();
    assert.ok(!dir.startsWith(process.cwd()), 'fixture must live outside process.cwd() to exercise the real code path');
    try {
      writeOwnVsInheritedFixture(dir);
      const cfg: SystemConfig = { catalog: { adapter: 'react-docgen', src: 'src' } };
      const catalog = extractCatalog('acme', cfg, dir);

      const button = catalog.components.flatMap((c) => c.exports).find((e) => e.displayName === 'Button');
      assert.ok(button);

      // variant is declared in the sibling src/types.ts file: own prop, with its type intact.
      const variant = button?.props.find((p) => p.name === 'variant');
      assert.ok(variant, 'variant should be an own prop even though declared in a sibling src file');
      assert.ok(variant?.type.includes('a') && variant?.type.includes('b'));

      // libProp comes from node_modules/fake-lib: inherited, not an own prop.
      assert.ok(!button?.props.some((p) => p.name === 'libProp'), 'libProp must not appear as an own prop');
      assert.ok(button?.inheritedProps?.includes('libProp'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

/**
 * A published-package shape: only `.d.ts` files under `dist/`, ESM-style `.js` barrel
 * specifiers, and a forwardRef component whose type is declared with the real React
 * generic (`React.ForwardRefExoticComponent<P & RefAttributes<E>>`). Nothing is actually
 * installed; a minimal ambient `node_modules/@types/react` gives just enough of a shape
 * (a call signature on ForwardRefExoticComponent) for react-docgen-typescript's own
 * name-based component detection to recognize it, see extractPropsFromTypeIfStatelessComponent
 * in node_modules/react-docgen-typescript/lib/parser.js. The barrel re-exports Widget by
 * name, so docgen documents it twice (once from its own file, once resolved through the
 * barrel's re-export): this exercises the bestByName dedupe picking the deeper, own-file doc.
 *
 * The widget module also exports a type alias (`WidgetTone`) and an interface
 * (`WidgetSummary`) alongside the component, the way a real `.d.ts` barrel export clause mixes
 * types and values (`export { Badge, BadgeAppearance, BadgeProps }`), plus a component-shaped
 * value export with no resolvable props (`LegacyWidget`, a bare `unknown`-typed const). This
 * exercises `typeOnlyExports` -- both type names must be recognised as types-only,
 * `WidgetSummary` in particular since it doesn't match the suffix heuristic in
 * src/data/undocumented.ts -- alongside a genuinely undocumented component that must still
 * surface as such from `undocumentedValueExports`.
 */
function writePublishedPackageFixture(dir: string): void {
  mkdirSync(join(dir, 'node_modules', '@types', 'react'), { recursive: true });
  writeFileSync(
    join(dir, 'node_modules', '@types', 'react', 'index.d.ts'),
    [
      "declare module 'react' {",
      '  export interface RefAttributes<T> {',
      '    ref?: unknown;',
      '  }',
      '  export interface ForwardRefExoticComponent<P> {',
      '    (props: P): unknown;',
      '  }',
      '}',
      '',
    ].join('\n')
  );

  mkdirSync(join(dir, 'dist', 'components', 'widget'), { recursive: true });
  mkdirSync(join(dir, 'dist', 'hooks'), { recursive: true });

  writeFileSync(
    join(dir, 'dist', 'index.d.ts'),
    [
      "export { Widget, WidgetProps, WidgetTone, WidgetSummary, LegacyWidget } from './components/widget/index.js';",
      "export { useThing } from './hooks/index.js';",
      '',
    ].join('\n')
  );

  writeFileSync(
    join(dir, 'dist', 'components', 'widget', 'index.d.ts'),
    [
      "import * as React from 'react';",
      '',
      'export interface WidgetProps {',
      "  tone?: 'calm' | 'loud';",
      '  label: string;',
      '}',
      '',
      'export declare const Widget: React.ForwardRefExoticComponent<WidgetProps & React.RefAttributes<HTMLDivElement>>;',
      '',
      "export type WidgetTone = 'calm' | 'loud';",
      '',
      'export interface WidgetSummary {',
      '  count: number;',
      '}',
      '',
      '// A real, published symbol with no resolvable props: react-docgen never documents it and',
      '// the props-type fallback has nothing to read (no LegacyWidgetProps, no call signature),',
      "// so it must still surface from undocumentedValueExports as a genuinely undocumented",
      '// component, unlike WidgetTone/WidgetSummary above.',
      'export declare const LegacyWidget: unknown;',
      '',
    ].join('\n')
  );

  writeFileSync(
    join(dir, 'dist', 'hooks', 'index.d.ts'),
    ['export declare function useThing(): number;', ''].join('\n')
  );
}

test(
  'react-docgen: a published-package dist/ shape, .d.ts barrel, forwardRef component documented once',
  { skip: docgenSkipReason },
  () => {
    const dir = makeTempDir();
    try {
      writePublishedPackageFixture(dir);
      const cfg: SystemConfig = { catalog: { adapter: 'react-docgen', src: 'dist', barrel: 'dist/index.d.ts' } };
      const catalog = extractCatalog('acme', cfg, dir);

      assert.ok(catalog.allExports.includes('Widget'));
      assert.ok(catalog.allExports.includes('WidgetProps'));
      assert.ok(catalog.allExports.includes('useThing'));

      const widgetDocs = catalog.components.flatMap((c) => c.exports).filter((e) => e.displayName === 'Widget');
      assert.equal(widgetDocs.length, 1, 'Widget must be documented once, not once per barrel re-export plus own file');

      const widget = widgetDocs[0];
      const tone = widget?.props.find((p) => p.name === 'tone');
      assert.ok(tone, 'Widget should document its tone prop');
      // docgen may quote the union members with single or double quotes.
      assert.match(tone!.type, /^["']calm["']\s*\|\s*["']loud["']$/);
      const label = widget?.props.find((p) => p.name === 'label');
      assert.ok(label, 'Widget should document its label prop');
      assert.equal(label?.required, true);

      const widgetComponent = catalog.components.find((c) => c.exports.some((e) => e.displayName === 'Widget'));
      assert.equal(widgetComponent?.dir, join('components', 'widget'));
      assert.notEqual(widgetComponent?.dir, '', "Widget's dir must be its own file's dir, not the barrel's");

      // WidgetTone (a type alias) and WidgetSummary (an interface) are both public, real
      // names -- legitimate to import as types -- but neither one is a component.
      assert.ok(catalog.allExports.includes('WidgetTone'));
      assert.ok(catalog.allExports.includes('WidgetSummary'));
      assert.ok(catalog.allExports.includes('LegacyWidget'));

      assert.ok(catalog.typeOnlyExports, 'typeOnlyExports should be resolvable for this fixture');
      assert.ok(catalog.typeOnlyExports?.includes('WidgetTone'));
      assert.ok(catalog.typeOnlyExports?.includes('WidgetSummary'));
      assert.ok(catalog.typeOnlyExports?.includes('WidgetProps'));
      assert.ok(!catalog.typeOnlyExports?.includes('Widget'));
      assert.ok(!catalog.typeOnlyExports?.includes('LegacyWidget'));
      assert.ok(!catalog.typeOnlyExports?.includes('useThing'));

      const undocumented = undocumentedValueExports(catalog);
      assert.ok(!undocumented.includes('WidgetTone'), 'a type alias must never read as an undocumented component');
      assert.ok(!undocumented.includes('WidgetSummary'), "an interface must never read as an undocumented component, even without a type-like suffix");
      assert.ok(undocumented.includes('LegacyWidget'), 'a real value export with no props must still surface as undocumented');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

/**
 * A published-package shape react-docgen-typescript's own component detection does not
 * recognise at all: a callable object (`declare const Stack: { (props): JSX.Element;
 * displayName: string }`) and a props type that is an intersection with a union (`type
 * CardProps = {...} & (ClickableProps | NonClickableProps)`). Both leave docgen with nothing
 * to document, which is exactly what the props-type fallback (see react-docgen.ts) exists
 * for: it reads `StackProps`/`CardProps` straight off the type checker instead.
 *   - dist/index.d.ts re-exports Stack, Card and useThing from their own files.
 *   - dist/components/stack/index.d.ts: StackProps extends ComponentPropsWithoutRef<'div'>
 *     (className/id land in inheritedProps) plus its own `direction`/`gap`.
 *   - dist/components/card/index.d.ts: CardProps is an intersection with a
 *     ClickableProps | NonClickableProps union, plus its own `heading`/`hasBadge`.
 *   - dist/hooks/index.d.ts: useThing, a plain function with no parameters, stays a `[]`
 *     symbol (there is no parameter type to read props off).
 * A minimal ambient node_modules/@types/react (plus a node_modules/react/package.json so the
 * bare `'react'` specifier resolves to it) provides just enough of React's own types.
 */
function writeCallableObjectFixture(dir: string): void {
  mkdirSync(join(dir, 'node_modules', 'react'), { recursive: true });
  writeFileSync(
    join(dir, 'node_modules', 'react', 'package.json'),
    JSON.stringify({ name: 'react', version: '18.0.0', main: 'index.js' }, null, 2)
  );

  mkdirSync(join(dir, 'node_modules', '@types', 'react'), { recursive: true });
  writeFileSync(
    join(dir, 'node_modules', '@types', 'react', 'index.d.ts'),
    [
      "declare module 'react' {",
      '  export type ReactNode = unknown;',
      '  export interface ComponentPropsWithoutRef<T> {',
      '    className?: string;',
      '    id?: string;',
      '  }',
      '  export type PropsWithChildren<P> = P & { children?: ReactNode };',
      '  export type Ref<T> = { current: T | null } | ((instance: T | null) => void) | null;',
      '}',
      'declare global {',
      '  namespace JSX {',
      '    interface Element {}',
      '  }',
      '}',
      '',
    ].join('\n')
  );

  mkdirSync(join(dir, 'dist', 'components', 'stack'), { recursive: true });
  mkdirSync(join(dir, 'dist', 'components', 'card'), { recursive: true });
  mkdirSync(join(dir, 'dist', 'hooks'), { recursive: true });

  writeFileSync(
    join(dir, 'dist', 'index.d.ts'),
    [
      "export { Stack } from './components/stack/index.js';",
      "export type { StackProps } from './components/stack/index.js';",
      "export { Card } from './components/card/index.js';",
      "export type { CardProps } from './components/card/index.js';",
      "export { useThing } from './hooks/index.js';",
      '',
    ].join('\n')
  );

  writeFileSync(
    join(dir, 'dist', 'components', 'stack', 'index.d.ts'),
    [
      "import type { ComponentPropsWithoutRef, PropsWithChildren, Ref } from 'react';",
      '',
      'export type StackProps = ComponentPropsWithoutRef<\'div\'> & {',
      '  /** Axis the children are laid out along. */',
      "  direction?: 'horizontal' | 'vertical';",
      '  /** Spacing between children, on the Tailwind gap scale. */',
      '  gap?: number;',
      '};',
      '',
      'declare const Stack: {',
      '  (props: PropsWithChildren<StackProps> & { ref?: Ref<HTMLDivElement> }): JSX.Element;',
      '  displayName: string;',
      '};',
      '',
      'export { Stack };',
      '',
    ].join('\n')
  );

  writeFileSync(
    join(dir, 'dist', 'components', 'card', 'index.d.ts'),
    [
      "import type { ReactNode } from 'react';",
      '',
      'interface ClickableProps {',
      '  onClick: () => void;',
      '}',
      '',
      'interface NonClickableProps {',
      '  onClick?: undefined;',
      '}',
      '',
      'export type CardProps = {',
      '  /** Heading content. */',
      '  heading?: ReactNode;',
      '  /**',
      '   * Shows a badge next to the heading.',
      '   * @default false',
      '   */',
      '  hasBadge?: boolean;',
      '} & (ClickableProps | NonClickableProps);',
      '',
      '/** A card surface. */',
      'declare const Card: {',
      '  (props: CardProps): JSX.Element;',
      '  displayName: string;',
      '};',
      '',
      'export { Card };',
      '',
    ].join('\n')
  );

  writeFileSync(
    join(dir, 'dist', 'hooks', 'index.d.ts'),
    ['export declare function useThing(): number;', ''].join('\n')
  );
}

test(
  'react-docgen: props-type fallback documents a callable-object component and an intersection-with-union props type',
  { skip: docgenSkipReason },
  () => {
    const dir = makeTempDir();
    try {
      writeCallableObjectFixture(dir);
      const cfg: SystemConfig = { catalog: { adapter: 'react-docgen', src: 'dist', barrel: 'dist/index.d.ts' } };
      const catalog = extractCatalog('acme', cfg, dir);

      assert.ok(catalog.allExports.includes('Stack'));
      assert.ok(catalog.allExports.includes('Card'));
      assert.ok(catalog.allExports.includes('useThing'));

      const stack = catalog.components.flatMap((c) => c.exports).find((e) => e.displayName === 'Stack');
      assert.ok(stack, 'Stack should be documented by the props-type fallback');
      assert.equal(stack?.docSource, 'props-type');

      const direction = stack?.props.find((p) => p.name === 'direction');
      assert.ok(direction, 'Stack should document its own direction prop');
      assert.match(direction!.type, /horizontal/);
      assert.match(direction!.type, /vertical/);
      assert.match(direction!.description ?? '', /axis/i);

      const gap = stack?.props.find((p) => p.name === 'gap');
      assert.ok(gap, 'Stack should document its own gap prop');
      assert.equal(gap?.type, 'number');
      assert.match(gap!.description ?? '', /spacing/i);

      assert.ok(!stack?.props.some((p) => p.name === 'className'), 'className must not be an own prop of Stack');
      assert.ok(stack?.inheritedProps?.includes('className'), 'className should be inherited');
      assert.ok(stack?.inheritedProps?.includes('id'), 'id should be inherited');

      assert.ok(catalog.allPropsByExport['Stack']?.includes('direction'));
      assert.ok(catalog.allPropsByExport['Stack']?.includes('className'));

      const card = catalog.components.flatMap((c) => c.exports).find((e) => e.displayName === 'Card');
      assert.ok(card, 'Card should be documented by the props-type fallback');
      assert.equal(card?.docSource, 'props-type');

      const heading = card?.props.find((p) => p.name === 'heading');
      assert.ok(heading, 'Card should document its own heading prop');

      const hasBadge = card?.props.find((p) => p.name === 'hasBadge');
      assert.ok(hasBadge, 'Card should document its own hasBadge prop');
      assert.equal(hasBadge?.defaultValue, 'false');

      // useThing has no parameter to read props off: it stays a confirmed, unverified symbol.
      assert.deepEqual(catalog.allPropsByExport['useThing'], []);
      assert.ok(!catalog.components.some((c) => c.exports.some((e) => e.displayName === 'useThing')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

test('react-docgen: barrel walk, docgen props, literal unions, deprecated, inherited props', { skip: docgenSkipReason }, () => {
  const dir = makeTempDir();
  try {
    writeFixture(dir);
    const cfg: SystemConfig = { catalog: { adapter: 'react-docgen', src: 'src' } };
    const catalog = extractCatalog('acme', cfg, dir);

    assert.equal(catalog.system, 'acme');
    assert.equal(catalog.source.adapter, 'react-docgen');
    assert.ok(catalog.source.srcHash);

    // The barrel's full public API: a component, a nested-barrel component, and a hook.
    assert.ok(catalog.allExports.includes('Button'));
    assert.ok(catalog.allExports.includes('Stack'));
    assert.ok(catalog.allExports.includes('useThing'));

    // useThing is a real symbol but not docgen-documentable: [] props, per allPropsByExport contract.
    assert.deepEqual(catalog.allPropsByExport['useThing'], []);

    const button = catalog.components.flatMap((c) => c.exports).find((e) => e.displayName === 'Button');
    assert.ok(button);
    const variant = button?.props.find((p) => p.name === 'variant');
    assert.ok(variant, 'Button should document its variant prop');
    assert.ok(variant?.type.includes('primary') && variant?.type.includes('secondary') && variant?.type.includes('ghost'));
    const disabled = button?.props.find((p) => p.name === 'disabled');
    assert.ok(disabled?.deprecated, 'disabled should carry a deprecated note');
    assert.match(disabled!.deprecated!, /isDisabled/);

    const stack = catalog.components.flatMap((c) => c.exports).find((e) => e.displayName === 'Stack');
    assert.ok(stack);
    assert.ok(stack?.props.some((p) => p.name === 'gap'));
    assert.ok(stack?.inheritedProps?.includes('className'));
    assert.ok(stack?.inheritedProps?.includes('id'));
    // className/id must not also show up as Stack's own, fully-typed props.
    assert.ok(!stack?.props.some((p) => p.name === 'className'));

    assert.ok(catalog.allPropsByExport['Stack']?.includes('gap'));
    assert.ok(catalog.allPropsByExport['Stack']?.includes('className'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SystemConfig } from '../types.ts';
import { extractCatalog as extractCatalogJson } from './catalog-json.ts';
import { extractCatalog as extractCatalogCem } from './custom-elements-manifest.ts';
import { extractTokens as extractTokensCssVars } from './css-vars-tokens.ts';
import { runExtract } from './index.ts';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ds-mcp-adapters-test-'));
}

// ---------------------------------------------------------------------------
// custom-elements-manifest
// ---------------------------------------------------------------------------

test('custom-elements-manifest: props from attributes + non-static/private members, kebab/camel index, deprecated', () => {
  const dir = makeTempDir();
  try {
    const manifest = {
      schemaVersion: '1.0.0',
      modules: [
        {
          path: 'src/widget.ts',
          declarations: [
            {
              kind: 'class',
              name: 'AcmeWidget',
              customElement: true,
              tagName: 'acme-widget',
              description: 'A widget.',
              deprecated: 'Use acme-gadget instead.',
              attributes: [
                {
                  name: 'aria-label',
                  type: { text: 'string' },
                  description: 'Accessible name.',
                },
                {
                  name: 'disabled',
                  type: { text: 'boolean' },
                  default: 'false',
                  deprecated: true,
                },
              ],
              members: [
                // Duplicate of the aria-label attribute (camelCase field name) -- must be skipped.
                { kind: 'field', name: 'ariaLabel', type: { text: 'string' } },
                // A genuinely new field.
                { kind: 'field', name: 'expanded', type: { text: 'boolean' }, default: 'false' },
                // Excluded: private.
                { kind: 'field', name: '_internal', privacy: 'private' },
                // Excluded: static.
                { kind: 'field', name: 'observedAttributes', static: true },
                // Excluded: not a field.
                { kind: 'method', name: 'focus' },
              ],
              events: [{ name: 'toggle', description: 'Fires on toggle.' }],
              slots: [{ name: '', description: 'Default slot.' }],
            },
          ],
          exports: [],
        },
      ],
    };
    const path = join(dir, 'custom-elements.json');
    writeFileSync(path, JSON.stringify(manifest));

    const cfg: SystemConfig = { catalog: { adapter: 'custom-elements-manifest', path: 'custom-elements.json' } };
    const catalog = extractCatalogCem('acme', cfg, dir);

    assert.equal(catalog.system, 'acme');
    assert.equal(catalog.source.adapter, 'custom-elements-manifest');
    assert.ok(catalog.source.srcHash);

    // Both the tag name and the class name are indexed.
    assert.ok(catalog.allExports.includes('acme-widget'));
    assert.ok(catalog.allExports.includes('AcmeWidget'));

    const widget = catalog.components[0]?.exports[0];
    assert.ok(widget);
    assert.equal(widget.displayName, 'acme-widget');
    assert.equal(widget.tagName, 'acme-widget');
    assert.deepEqual(widget.deprecated, { note: 'Use acme-gadget instead.' });

    const propNames = widget.props.map((p) => p.name).sort();
    // ariaLabel (member) is a duplicate of aria-label (attribute) and must not appear twice.
    assert.deepEqual(propNames, ['aria-label', 'disabled', 'expanded']);
    // Excluded members never show up.
    assert.ok(!propNames.includes('_internal'));
    assert.ok(!propNames.includes('observedAttributes'));
    assert.ok(!propNames.includes('focus'));

    const disabledProp = widget.props.find((p) => p.name === 'disabled');
    assert.equal(disabledProp?.deprecated, 'deprecated'); // boolean true -> a string

    assert.equal(widget.events?.[0]?.name, 'toggle');
    assert.equal(widget.slots?.[0]?.name, '');

    // Index carries kebab and camel spellings for every prop, under both the tag and class keys.
    const byTag = catalog.allPropsByExport['acme-widget'] ?? [];
    assert.ok(byTag.includes('aria-label'));
    assert.ok(byTag.includes('ariaLabel'));
    const byClass = catalog.allPropsByExport['AcmeWidget'] ?? [];
    assert.deepEqual(byTag, byClass);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('custom-elements-manifest: an element identified only by customElement:true (no tagName) still extracts', () => {
  const dir = makeTempDir();
  try {
    const manifest = {
      schemaVersion: '1.0.0',
      modules: [
        {
          path: 'src/odd.ts',
          declarations: [
            { kind: 'class', name: 'OddOne', customElement: true, attributes: [] },
            { kind: 'class', name: 'NotAnElement' }, // no customElement flag, no tagName: skipped
          ],
        },
      ],
    };
    const path = join(dir, 'custom-elements.json');
    writeFileSync(path, JSON.stringify(manifest));
    const cfg: SystemConfig = { catalog: { adapter: 'custom-elements-manifest', path: 'custom-elements.json' } };
    const catalog = extractCatalogCem('acme', cfg, dir);
    assert.deepEqual(catalog.allExports, ['OddOne']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// css-vars
// ---------------------------------------------------------------------------

test('css-vars: themes (data-theme + prefers-color-scheme), references, categories', () => {
  const dir = makeTempDir();
  try {
    const css = `
      /* comment with { braces } to make sure it is stripped before parsing */
      :root {
        --gray-900: #111318;
        --space-4: 16px;
        --radius-md: 8px;
        --duration-fast: 120ms;
        --color-text-default: var(--gray-900);
      }
      [data-theme="dark"] {
        --color-text-default: #eeeeee;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --color-text-default: #eeeeee;
        }
      }
      .unrelated-rule {
        margin: 0;
      }
    `;
    const path = join(dir, 'tokens.css');
    writeFileSync(path, css);

    const cfg: SystemConfig = {
      catalog: { adapter: 'catalog-json', path: 'catalog.json' },
      tokens: { adapter: 'css-vars', files: ['tokens.css'] },
    };
    const tokens = extractTokensCssVars('acme', cfg, dir);

    assert.equal(tokens.source.adapter, 'css-vars');
    assert.ok(tokens.source.hash);
    assert.deepEqual([...(tokens.themes ?? [])].sort(), ['dark', 'light']);

    const byName = Object.fromEntries(tokens.tokens.map((t) => [t.name, t]));

    assert.equal(byName['--gray-900']?.category, 'color');
    assert.equal(byName['--space-4']?.category, 'space');
    assert.equal(byName['--radius-md']?.category, 'radius');
    assert.equal(byName['--duration-fast']?.category, 'motion');

    const semantic = byName['--color-text-default'];
    assert.ok(semantic);
    assert.equal(semantic.value, 'var(--gray-900)'); // light (default theme) value
    assert.equal(semantic.valuesByTheme?.light, 'var(--gray-900)');
    assert.equal(semantic.valuesByTheme?.dark, '#eeeeee');
    assert.deepEqual(semantic.references, ['--gray-900']);
    assert.equal(semantic.category, 'color');

    // A rule with no recognized theme-bearing selector contributes no tokens.
    assert.ok(!('margin' in byName));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('css-vars: @layer and @theme wrapper blocks are unwrapped like a plain :root block', () => {
  const dir = makeTempDir();
  try {
    const css = `
      @layer base {
        :root {
          --space-1: 4px;
        }
      }
      @theme inline {
        --color-bg: var(--neutral-0);
        --radius-md: 8px;
      }
      :root {
        --neutral-0: #fff;
      }
      .dark {
        --neutral-0: #000;
      }
    `;
    writeFileSync(join(dir, 'tokens.css'), css);

    const cfg: SystemConfig = {
      catalog: { adapter: 'catalog-json', path: 'catalog.json' },
      tokens: { adapter: 'css-vars', files: ['tokens.css'] },
    };
    const tokens = extractTokensCssVars('acme', cfg, dir);

    const byName = Object.fromEntries(tokens.tokens.map((t) => [t.name, t]));

    // @layer base { :root { ... } } recurses like a plain :root block.
    assert.equal(byName['--space-1']?.category, 'space');

    // @theme inline { ... } is treated as a :root block: --color-bg is a default-theme token.
    const colorBg = byName['--color-bg'];
    assert.ok(colorBg);
    assert.equal(colorBg.category, 'color');
    assert.deepEqual(colorBg.references, ['--neutral-0']);

    assert.equal(byName['--radius-md']?.category, 'radius');

    const neutral0 = byName['--neutral-0'];
    assert.ok(neutral0);
    assert.equal(neutral0.valuesByTheme?.light, '#fff');
    assert.equal(neutral0.valuesByTheme?.dark, '#000');

    assert.deepEqual([...(tokens.themes ?? [])].sort(), ['dark', 'light']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('css-vars: .dark / .light classes are recognized theme selectors', () => {
  const dir = makeTempDir();
  try {
    const css = `
      :root { --accent: blue; }
      .dark { --accent: navy; }
    `;
    writeFileSync(join(dir, 'tokens.css'), css);
    const cfg: SystemConfig = {
      catalog: { adapter: 'catalog-json', path: 'catalog.json' },
      tokens: { adapter: 'css-vars', files: ['tokens.css'] },
    };
    const tokens = extractTokensCssVars('acme', cfg, dir);
    const accent = tokens.tokens.find((t) => t.name === '--accent');
    assert.equal(accent?.valuesByTheme?.light, 'blue');
    assert.equal(accent?.valuesByTheme?.dark, 'navy');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// catalog-json
// ---------------------------------------------------------------------------

test('catalog-json: accepts the minimal sibling shape and fills defaults', () => {
  const dir = makeTempDir();
  try {
    const minimal = {
      components: [
        {
          dir: 'src/Button',
          exports: [{ displayName: 'Button', props: [{ name: 'tone', type: 'string' }] }],
        },
      ],
      allExports: ['Button'],
      allPropsByExport: { Button: ['tone'] },
    };
    writeFileSync(join(dir, 'catalog.json'), JSON.stringify(minimal));

    const cfg: SystemConfig = { catalog: { adapter: 'catalog-json', path: 'catalog.json' } };
    const catalog = extractCatalogJson('acme', cfg, dir);

    assert.equal(catalog.system, 'acme');
    assert.equal(catalog.source.adapter, 'catalog-json');
    assert.ok(catalog.source.srcHash);
    assert.deepEqual(catalog.allExports, ['Button']);
    const button = catalog.components[0]?.exports[0];
    assert.equal(button?.description, ''); // defaulted
    assert.equal(button?.props[0]?.required, false); // defaulted
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('catalog-json: restamps system id, adapter and srcHash, keeps commit and the upstream hash', () => {
  const dir = makeTempDir();
  try {
    const full = {
      system: 'some-other-system',
      generatedAt: '2020-01-01T00:00:00.000Z',
      source: { root: '/elsewhere', commit: 'abc123', srcHash: 'preexisting-hash', adapter: 'react-docgen' },
      components: [],
      allExports: [],
      allPropsByExport: {},
    };
    writeFileSync(join(dir, 'catalog.json'), JSON.stringify(full));

    const cfg: SystemConfig = { catalog: { adapter: 'catalog-json', path: 'catalog.json' } };
    const catalog = extractCatalogJson('acme', cfg, dir);

    assert.equal(catalog.system, 'acme'); // restamped
    assert.equal(catalog.source.adapter, 'catalog-json'); // restamped
    assert.equal(catalog.source.commit, 'abc123'); // kept
    // srcHash must be the hash of the file this adapter read, or freshness can never match.
    assert.notEqual(catalog.source.srcHash, 'preexisting-hash');
    assert.match(catalog.source.srcHash ?? '', /^[0-9a-f]{64}$/);
    assert.equal(catalog.source.upstreamSrcHash, 'preexisting-hash'); // provenance only
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('css-vars: brace-less at-rules before a block do not leak into its header', () => {
  // A Tailwind 4 stylesheet starts with statements that end in a semicolon and may even
  // contain braces inside a quoted glob. If they were glued onto the next header, the
  // word "dark" in @custom-variant would label the base :root palette as the dark theme.
  const dir = mkdtempSync(join(tmpdir(), 'odsm-css-atrules-'));
  try {
    writeFileSync(
      join(dir, 't.css'),
      [
        "@import 'tailwindcss';",
        "@source '../../components/src/**/*.{js,jsx,ts,tsx}';",
        '@custom-variant dark (&:where(.dark, .dark *));',
        ':root,',
        ':host {',
        '  --color-blue-100: #f3f7fc;',
        '}',
        '.dark {',
        '  --bg: var(--color-blue-100);',
        '}',
        '@theme inline {',
        '  --color-blue-100: var(--color-blue-100);',
        '}',
        '',
      ].join('\n'),
    );
    const cfg = { catalog: { adapter: 'catalog-json', path: 'x' }, tokens: { adapter: 'css-vars', files: ['t.css'] } } as unknown as SystemConfig;
    const tokens = extractTokensCssVars('sys', cfg, dir);
    const blue = tokens.tokens.find((t) => t.name === '--color-blue-100');
    assert.ok(blue);
    assert.equal(blue.value, '#f3f7fc', 'the base palette value must win for the light theme');
    assert.equal(blue.valuesByTheme, undefined, 'a token declared only in :root has no per-theme split');
    assert.deepEqual(tokens.themes?.slice().sort(), ['dark', 'light']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runExtract writes no absolute paths into the committed data', () => {
  // Committed ground truth must be identical from clone to clone and must not leak a
  // username; source roots and file lists are stored relative to the config dir.
  const dir = mkdtempSync(join(tmpdir(), 'odsm-relpaths-'));
  try {
    writeFileSync(join(dir, 'tokens.css'), ':root { --a: #fff; --b: 4px; }\n');
    writeFileSync(
      join(dir, 'custom-elements.json'),
      JSON.stringify({ schemaVersion: '1.0.0', modules: [{ kind: 'javascript-module', path: 'x.ts', declarations: [{ kind: 'class', name: 'AcmeX', tagName: 'acme-x', customElement: true, attributes: [{ name: 'tone', type: { text: 'string' } }] }] }] }),
    );
    const cfg = {
      root: dir,
      componentModel: 'custom-elements',
      catalog: { adapter: 'custom-elements-manifest', path: 'custom-elements.json' },
      tokens: { adapter: 'css-vars', files: ['tokens.css'] },
    } as unknown as SystemConfig;
    const result = runExtract('sys', cfg, dir, { dataDir: join(dir, 'data') });
    const written = result.written.map((f) => readFileSync(f, 'utf8')).join('\n');
    assert.ok(!written.includes(dir), 'data files must not contain the absolute root');
    assert.equal(result.catalog.source.root, '.');
    assert.deepEqual(result.tokens?.source.files, ['tokens.css']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

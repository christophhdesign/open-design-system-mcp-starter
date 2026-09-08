import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SystemConfig } from '../types.ts';
import { extractTokens, sourceHash } from './dtcg-tokens.ts';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ds-mcp-dtcg-test-'));
}

test('dtcg: group-level $type inheritance, dimension/composite values, references, category mapping', () => {
  const dir = makeTempDir();
  try {
    const doc = {
      color: {
        $type: 'color',
        text: {
          muted: { $value: '#767676', $description: 'Secondary body text.' },
        },
        brand: {
          500: { $value: '#3355ff' },
        },
        link: {
          // Alias reference to another color token.
          $value: '{color.brand.500}',
        },
      },
      space: {
        $type: 'dimension',
        // Legacy 'value' key (no leading $), for pre-final-spec DTCG documents.
        sm: { value: { value: 4, unit: 'px' } },
        lg: { $value: { value: 16, unit: 'px' } },
      },
      radius: {
        $type: 'dimension',
        md: { $value: { value: 8, unit: 'px' } },
      },
      size: {
        $type: 'dimension',
        icon: { $value: { value: 24, unit: 'px' } },
      },
      shadow: {
        elevated: {
          $type: 'shadow',
          $value: { color: '{color.text.muted}', offsetX: '0px', offsetY: '4px', blur: '8px', spread: '0px' },
        },
      },
      opacity: {
        $type: 'number',
        disabled: { $value: 0.4 },
      },
      zIndex: {
        modal: { $type: 'number', $value: 1000 },
      },
      button: {
        primary: {
          $type: 'color',
          $value: '{color.brand.500}',
          $deprecated: 'Use button.accent instead.',
        },
      },
    };

    const path = join(dir, 'tokens.json');
    writeFileSync(path, JSON.stringify(doc));

    const cfg: SystemConfig = { catalog: { adapter: 'catalog-json', path: 'unused.json' }, tokens: { adapter: 'dtcg', files: ['tokens.json'] } };
    const tokens = extractTokens('acme', cfg, dir);

    assert.equal(tokens.system, 'acme');
    assert.equal(tokens.source.adapter, 'dtcg');
    assert.ok(tokens.source.hash);
    assert.equal(tokens.source.hash, sourceHash(cfg, dir));

    const byName = new Map(tokens.tokens.map((t) => [t.name, t]));

    // Group-level $type inheritance: color.text.muted has no own $type.
    const muted = byName.get('color.text.muted');
    assert.ok(muted);
    assert.equal(muted?.category, 'color');
    assert.equal(muted?.value, '#767676');
    assert.equal(muted?.cssVar, '--color-text-muted');
    assert.equal(muted?.description, 'Secondary body text.');

    // Alias reference is captured.
    const link = byName.get('color.link');
    assert.deepEqual(link?.references, ['color.brand.500']);
    assert.equal(link?.value, '{color.brand.500}');

    // Legacy 'value' key and $value key both work; dimension objects render as `${value}${unit}`.
    assert.equal(byName.get('space.sm')?.value, '4px');
    assert.equal(byName.get('space.sm')?.category, 'space');
    assert.equal(byName.get('space.lg')?.value, '16px');
    assert.equal(byName.get('space.lg')?.category, 'space');

    // Path-segment category refinement for dimension: radius vs size vs space.
    assert.equal(byName.get('radius.md')?.category, 'radius');
    assert.equal(byName.get('size.icon')?.category, 'size');

    // Composite (shadow) value: compact JSON, with its own nested reference captured.
    const shadow = byName.get('shadow.elevated');
    assert.equal(shadow?.category, 'shadow');
    assert.ok(shadow?.value?.startsWith('{'));
    assert.ok(shadow?.value?.includes('"offsetY":"4px"'));
    assert.deepEqual(shadow?.references, ['color.text.muted']);

    // number category refinement: opacity vs z-index, not a substring false-positive off 'size'.
    assert.equal(byName.get('opacity.disabled')?.category, 'opacity');
    assert.equal(byName.get('opacity.disabled')?.value, '0.4');
    assert.equal(byName.get('zIndex.modal')?.category, 'z-index');
    assert.notEqual(byName.get('size.icon')?.category, 'z-index');

    // $deprecated is folded into description since Token has no dedicated field.
    const primary = byName.get('button.primary');
    assert.ok(primary?.description?.includes('Deprecated: Use button.accent instead.'));

    assert.ok(tokens.cssVars.includes('--color-text-muted'));
    assert.equal(tokens.themes, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dtcg: multiple theme files merge into valuesByTheme, light (or first file) wins as value', () => {
  const dir = makeTempDir();
  try {
    const light = {
      color: {
        $type: 'color',
        surface: { $value: '#ffffff' },
        text: { $value: '#111111' },
      },
    };
    const dark = {
      color: {
        $type: 'color',
        surface: { $value: '#111111' },
        text: { $value: '#f5f5f5' },
      },
    };
    writeFileSync(join(dir, 'tokens.light.json'), JSON.stringify(light));
    writeFileSync(join(dir, 'tokens.dark.json'), JSON.stringify(dark));

    const cfg: SystemConfig = {
      catalog: { adapter: 'catalog-json', path: 'unused.json' },
      tokens: { adapter: 'dtcg', files: ['tokens.light.json', 'tokens.dark.json'] },
    };
    const tokens = extractTokens('acme', cfg, dir);

    assert.deepEqual(tokens.themes, ['dark', 'light']);

    const surface = tokens.tokens.find((t) => t.name === 'color.surface');
    assert.equal(surface?.value, '#ffffff'); // light wins
    assert.deepEqual(surface?.valuesByTheme, { light: '#ffffff', dark: '#111111' });

    const text = tokens.tokens.find((t) => t.name === 'color.text');
    assert.equal(text?.value, '#111111');
    assert.deepEqual(text?.valuesByTheme, { light: '#111111', dark: '#f5f5f5' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dtcg: throws a clear error for a non-dtcg tokens config', () => {
  const dir = makeTempDir();
  try {
    const cfg: SystemConfig = {
      catalog: { adapter: 'catalog-json', path: 'unused.json' },
      tokens: { adapter: 'css-vars', files: [] },
    };
    assert.throws(() => extractTokens('acme', cfg, dir), /dtcg adapter called with tokens\.adapter/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

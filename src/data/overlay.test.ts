import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CatalogOverlay, SystemCatalog, SystemConfig } from '../types.ts';
import { applyOverlay, loadOverlay, scaffoldOverlay, writeOverlayScaffold } from './overlay.ts';
import { undocumentedValueExports } from './undocumented.ts';
import { loadSystemData } from './load.ts';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ds-mcp-overlay-test-'));
}

/**
 * Button is a normally-documented export; IconFactory is a real symbol (present in allExports,
 * present with an empty allPropsByExport entry) the docgen adapter could not turn into a
 * CatalogExport -- the case the overlay exists for. IconFactoryProps is the same shape but
 * excluded by the type-like-suffix filter, so it must never show up as "undocumented".
 */
function baseCatalog(): SystemCatalog {
  return {
    system: 'acme',
    generatedAt: '2026-01-01T00:00:00.000Z',
    source: { root: '/virtual', adapter: 'catalog-json' },
    components: [
      {
        dir: 'src/Button',
        exports: [
          {
            displayName: 'Button',
            description: 'A button.',
            props: [
              { name: 'variant', type: 'string', required: false },
              { name: 'disabled', type: 'boolean', required: false },
            ],
            examples: [{ code: '<Button />' }],
          },
        ],
      },
    ],
    allExports: ['Button', 'IconFactory', 'IconFactoryProps'],
    allPropsByExport: { Button: ['variant', 'disabled'], IconFactory: [], IconFactoryProps: [] },
  };
}

// ---------------------------------------------------------------------------
// applyOverlay: merge precedence
// ---------------------------------------------------------------------------

test('applyOverlay: overlay prop wins by name, extracted prop not mentioned is kept', () => {
  const catalog = baseCatalog();
  const overlay: CatalogOverlay = {
    exports: [
      {
        displayName: 'Button',
        props: [
          { name: 'variant', type: '"primary" | "secondary"', required: false, description: 'overlay-authored' },
          { name: 'size', type: 'string', required: false },
        ],
      },
    ],
  };

  const { catalog: next, touched, unknown } = applyOverlay(catalog, overlay, { path: '/x/overlay.json', hash: 'h1' });

  assert.deepEqual(touched, ['Button']);
  assert.deepEqual(unknown, []);

  const button = next.components.flatMap((c) => c.exports).find((e) => e.displayName === 'Button')!;
  const byName = Object.fromEntries(button.props.map((p) => [p.name, p]));
  assert.equal(byName.variant?.type, '"primary" | "secondary"');
  assert.equal(byName.variant?.description, 'overlay-authored');
  assert.equal(byName.disabled?.type, 'boolean'); // kept from extraction, untouched
  assert.equal(byName.size?.type, 'string'); // appended
  assert.deepEqual(next.allPropsByExport.Button?.sort(), ['disabled', 'size', 'variant']);

  // The input catalog is never mutated.
  const originalButton = catalog.components[0]!.exports[0]!;
  assert.equal(originalButton.props.find((p) => p.name === 'variant')?.type, 'string');
});

test('applyOverlay: description overrides only when the overlay entry provides one', () => {
  const catalog = baseCatalog();
  const overlay: CatalogOverlay = { exports: [{ displayName: 'Button', props: [] }] };
  const { catalog: next } = applyOverlay(catalog, overlay, { path: '/x/overlay.json', hash: 'h1' });
  const button = next.components.flatMap((c) => c.exports).find((e) => e.displayName === 'Button')!;
  assert.equal(button.description, 'A button.'); // unchanged: overlay entry had no description
});

// ---------------------------------------------------------------------------
// applyOverlay: creating an export for an undocumented (but real) symbol
// ---------------------------------------------------------------------------

test('applyOverlay: an export with no CatalogExport is created under dir "overlay" and gets allPropsByExport', () => {
  const catalog = baseCatalog();
  const overlay: CatalogOverlay = {
    exports: [
      {
        displayName: 'IconFactory',
        description: 'Builds an icon component from a name.',
        props: [{ name: 'name', type: 'string', required: true }],
      },
    ],
  };

  const { catalog: next, touched } = applyOverlay(catalog, overlay, { path: '/x/overlay.json', hash: 'h1' });
  assert.deepEqual(touched, ['IconFactory']);

  const overlayGroup = next.components.find((c) => c.dir === 'overlay');
  assert.ok(overlayGroup);
  const icon = overlayGroup!.exports.find((e) => e.displayName === 'IconFactory');
  assert.ok(icon);
  assert.equal(icon!.description, 'Builds an icon component from a name.');
  assert.equal(icon!.docSource, 'overlay');
  assert.deepEqual(next.allPropsByExport.IconFactory, ['name']);

  // The un-overlaid symbol with the excluded suffix is left completely alone.
  assert.equal(next.components.some((c) => c.exports.some((e) => e.displayName === 'IconFactoryProps')), false);
});

// ---------------------------------------------------------------------------
// applyOverlay: custom-elements attribute spellings
// ---------------------------------------------------------------------------

test('applyOverlay: custom-elements systems get kebab and camel spellings in allPropsByExport', () => {
  const catalog = baseCatalog();
  const overlay: CatalogOverlay = {
    exports: [{ displayName: 'IconFactory', props: [{ name: 'iconName', type: 'string', required: false }] }],
  };
  const { catalog: next } = applyOverlay(catalog, overlay, { path: '/x/overlay.json', hash: 'h1', componentModel: 'custom-elements' });
  assert.deepEqual(next.allPropsByExport.IconFactory?.sort(), ['icon-name', 'iconName'].sort());
});

// ---------------------------------------------------------------------------
// applyOverlay: unknown names are reported, never invented
// ---------------------------------------------------------------------------

test('applyOverlay: a displayName not in allExports is reported unknown and not merged', () => {
  const catalog = baseCatalog();
  const overlay: CatalogOverlay = {
    exports: [{ displayName: 'Buttn', props: [{ name: 'variant', type: 'string', required: false }] }],
  };
  const { catalog: next, touched, unknown } = applyOverlay(catalog, overlay, { path: '/x/overlay.json', hash: 'h1' });
  assert.deepEqual(unknown, ['Buttn']);
  assert.deepEqual(touched, []);
  assert.equal(next.components.some((c) => c.exports.some((e) => e.displayName === 'Buttn')), false);
  assert.equal(next.source.overlay?.exports, 0);
});

// ---------------------------------------------------------------------------
// applyOverlay: examples/docs concatenation, deduplicated
// ---------------------------------------------------------------------------

test('applyOverlay: examples are concatenated and deduplicated by code', () => {
  const catalog = baseCatalog();
  const overlay: CatalogOverlay = {
    exports: [
      {
        displayName: 'Button',
        examples: [{ code: '<Button />' }, { code: '<Button size="lg" />', title: 'Large' }],
      },
    ],
  };
  const { catalog: next } = applyOverlay(catalog, overlay, { path: '/x/overlay.json', hash: 'h1' });
  const button = next.components.flatMap((c) => c.exports).find((e) => e.displayName === 'Button')!;
  assert.equal(button.examples?.length, 2); // the duplicate '<Button />' was not appended again
  assert.ok(button.examples?.some((e) => e.title === 'Large'));
});

test('applyOverlay: docs paths are concatenated and deduplicated', () => {
  const catalog = baseCatalog();
  catalog.components[0]!.exports[0]!.docs = ['docs/button.md'];
  const overlay: CatalogOverlay = {
    exports: [{ displayName: 'Button', docs: ['docs/button.md', 'docs/forms.md'] }],
  };
  const { catalog: next } = applyOverlay(catalog, overlay, { path: '/x/overlay.json', hash: 'h1' });
  const button = next.components.flatMap((c) => c.exports).find((e) => e.displayName === 'Button')!;
  assert.deepEqual(button.docs, ['docs/button.md', 'docs/forms.md']);
});

// ---------------------------------------------------------------------------
// scaffoldOverlay / undocumentedValueExports
// ---------------------------------------------------------------------------

test('undocumentedValueExports / scaffoldOverlay: lists exactly the undocumented, non-type-like names', () => {
  const catalog = baseCatalog();
  const names = undocumentedValueExports(catalog);
  assert.deepEqual(names, ['IconFactory']); // IconFactoryProps is excluded by the suffix filter

  const scaffold = scaffoldOverlay(catalog);
  assert.deepEqual(scaffold.exports.map((e) => e.displayName), ['IconFactory']);
  assert.equal(scaffold.exports[0]?.props?.length, 0);
  assert.match(scaffold.exports[0]?._note ?? '', /IconFactory/);
});

// ---------------------------------------------------------------------------
// writeOverlayScaffold: create, then append without clobbering an edit
// ---------------------------------------------------------------------------

test('writeOverlayScaffold: writes a fresh scaffold, then appends only new names without touching an edited entry', () => {
  const dir = makeTempDir();
  try {
    const catalog = baseCatalog();
    const first = writeOverlayScaffold(dir, catalog);
    assert.equal(first.written, true);
    assert.equal(first.entries, 1);
    assert.equal(first.path, join(dir, 'overlay.json'));

    // Simulate a team filling in the entry by hand.
    const onDisk = JSON.parse(readFileSync(first.path, 'utf8')) as CatalogOverlay;
    onDisk.exports[0]!.description = 'Builds an icon component from a name.';
    onDisk.exports[0]!.props = [{ name: 'name', type: 'string', required: true }];
    delete onDisk.exports[0]!._note;
    writeFileSync(first.path, JSON.stringify(onDisk, null, 2));

    // A newer extract adds another undocumented export.
    const catalog2: SystemCatalog = {
      ...catalog,
      allExports: [...catalog.allExports, 'WidgetFactory'],
      allPropsByExport: { ...catalog.allPropsByExport, WidgetFactory: [] },
    };

    const second = writeOverlayScaffold(dir, catalog2);
    assert.equal(second.written, true);
    assert.equal(second.entries, 1); // only WidgetFactory was added

    const merged = JSON.parse(readFileSync(first.path, 'utf8')) as CatalogOverlay;
    assert.equal(merged.exports.length, 2);
    const icon = merged.exports.find((e) => e.displayName === 'IconFactory')!;
    assert.equal(icon.description, 'Builds an icon component from a name.'); // survived
    assert.equal(icon._note, undefined);
    assert.ok(merged.exports.some((e) => e.displayName === 'WidgetFactory'));

    // A third call with nothing new to add is a no-op.
    const third = writeOverlayScaffold(dir, catalog2);
    assert.equal(third.written, false);
    assert.equal(third.entries, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeOverlayScaffold: force overwrites with a fresh scaffold', () => {
  const dir = makeTempDir();
  try {
    const catalog = baseCatalog();
    writeOverlayScaffold(dir, catalog);
    const result = writeOverlayScaffold(dir, catalog, { force: true });
    assert.equal(result.written, true);
    assert.equal(result.entries, 1);
    const onDisk = JSON.parse(readFileSync(result.path, 'utf8')) as CatalogOverlay;
    assert.ok(onDisk.exports[0]?._note); // the note is back: force replaced the hand-edited version
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// loadOverlay: shape validation
// ---------------------------------------------------------------------------

test('loadOverlay: undefined when the file does not exist', () => {
  assert.equal(loadOverlay('/nonexistent/overlay.json'), undefined);
});

test('loadOverlay: throws a clear error on invalid JSON and on a missing "exports" array', () => {
  const dir = makeTempDir();
  try {
    const badJson = join(dir, 'bad.json');
    writeFileSync(badJson, '{ not json');
    assert.throws(() => loadOverlay(badJson), /not valid JSON/);

    const noExports = join(dir, 'no-exports.json');
    writeFileSync(noExports, JSON.stringify({ foo: 'bar' }));
    assert.throws(() => loadOverlay(noExports), /"exports" array/);

    const badEntry = join(dir, 'bad-entry.json');
    writeFileSync(badEntry, JSON.stringify({ exports: [{ props: [] }] }));
    assert.throws(() => loadOverlay(badEntry), /displayName/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// load.ts integration: loadSystemData merges overlay.json when present
// ---------------------------------------------------------------------------

test('loadSystemData: merges data/<id>/overlay.json when present and stamps source.overlay', () => {
  const dir = makeTempDir();
  try {
    const dataDir = join(dir, 'data', 'acme');
    mkdirSync(dataDir, { recursive: true });

    const catalog = baseCatalog();
    writeFileSync(join(dataDir, 'catalog.json'), JSON.stringify(catalog));

    const overlay: CatalogOverlay = {
      exports: [{ displayName: 'IconFactory', description: 'Builds an icon.', props: [{ name: 'name', type: 'string', required: true }] }],
    };
    writeFileSync(join(dataDir, 'overlay.json'), JSON.stringify(overlay));

    const cfg: SystemConfig = { catalog: { adapter: 'catalog-json', path: 'catalog.json' }, dataDir: 'data/acme' };
    const data = loadSystemData('acme', cfg, dir);

    assert.equal(data.catalog.source.overlay?.exports, 1);
    assert.equal(data.catalog.source.overlay?.path, join(dataDir, 'overlay.json'));
    const icon = data.catalog.components.flatMap((c) => c.exports).find((e) => e.displayName === 'IconFactory');
    assert.equal(icon?.description, 'Builds an icon.');
    assert.deepEqual(data.catalog.allPropsByExport.IconFactory, ['name']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSystemData: no overlay.json leaves the catalog untouched', () => {
  const dir = makeTempDir();
  try {
    const dataDir = join(dir, 'data', 'acme');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'catalog.json'), JSON.stringify(baseCatalog()));

    const cfg: SystemConfig = { catalog: { adapter: 'catalog-json', path: 'catalog.json' }, dataDir: 'data/acme' };
    const data = loadSystemData('acme', cfg, dir);
    assert.equal(data.catalog.source.overlay, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

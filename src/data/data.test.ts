import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AliasMap, SystemCatalog, SystemConfig } from '../types.ts';
import { loadLexicon, loadTeamAliases, mergeAliases } from './aliases.ts';
import { buildRegistry, checkFreshness, loadSystemData } from './load.ts';
import type { LoadedConfig } from '../config.ts';
import { runExtract } from '../adapters/index.ts';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ds-mcp-data-test-'));
}

const MINIMAL_CATALOG: SystemCatalog = {
  system: 'placeholder',
  generatedAt: '2026-01-01T00:00:00.000Z',
  source: { root: '/virtual', adapter: 'catalog-json' },
  components: [{ dir: 'src/Button', exports: [{ displayName: 'Button', description: 'A button.', props: [] }] }],
  allExports: ['Button'],
  allPropsByExport: { Button: [] },
};

// ---------------------------------------------------------------------------
// aliases
// ---------------------------------------------------------------------------

test('loadLexicon reads the shipped convention-lexicon.json as an AliasMap', () => {
  const lexicon = loadLexicon();
  assert.ok(lexicon.components.length > 0);
  assert.ok(lexicon.props.length > 0);
  assert.ok(lexicon.components.every((e) => e.source === 'lexicon'));
  const card = lexicon.components.find((e) => e.alias === 'Card');
  assert.ok(card);
  assert.equal(typeof card?.occurrences, 'number');
});

test('loadTeamAliases defaults a missing "source" to team', () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'aliases.json');
    writeFileSync(path, JSON.stringify({ components: [{ alias: 'Card', target: 'Surface' }], props: [] }));
    const team = loadTeamAliases(path);
    assert.equal(team?.components[0]?.source, 'team');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadTeamAliases returns undefined when the file does not exist', () => {
  assert.equal(loadTeamAliases('/nonexistent/aliases.json'), undefined);
});

test('mergeAliases: team wins on the same alias, lexicon-only entries remain', () => {
  const lexicon: AliasMap = {
    components: [
      { alias: 'Card', concept: 'surface container', occurrences: 25, source: 'lexicon' },
      { alias: 'Typography', concept: 'text', occurrences: 29, source: 'lexicon' },
    ],
    props: [],
  };
  const team: AliasMap = {
    components: [{ alias: 'Card', target: 'Surface', note: 'team mapping', source: 'team' }],
    props: [],
  };
  const merged = mergeAliases(lexicon, team);
  assert.equal(merged.components.length, 2);
  const card = merged.components.find((e) => e.alias === 'Card');
  assert.equal(card?.source, 'team');
  assert.equal(card?.target, 'Surface');
  const typography = merged.components.find((e) => e.alias === 'Typography');
  assert.equal(typography?.source, 'lexicon');
});

test('mergeAliases: works with no team file', () => {
  const lexicon: AliasMap = { components: [{ alias: 'Card', source: 'lexicon' }], props: [] };
  const merged = mergeAliases(lexicon, undefined);
  assert.deepEqual(merged, lexicon);
});

// ---------------------------------------------------------------------------
// loadSystemData / registry
// ---------------------------------------------------------------------------

function writeCatalog(dataDir: string, catalog: SystemCatalog = MINIMAL_CATALOG): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'catalog.json'), JSON.stringify(catalog));
}

test('loadSystemData throws a clear error naming the extract command when catalog.json is missing', () => {
  const dir = makeTempDir();
  try {
    const cfg: SystemConfig = { catalog: { adapter: 'catalog-json', path: 'catalog.json' }, dataDir: 'data/acme' };
    assert.throws(() => loadSystemData('acme', cfg, dir), (err: Error) => {
      assert.match(err.message, /extract --system acme/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSystemData reads catalog + tokens + aliases (team over lexicon)', () => {
  const dir = makeTempDir();
  try {
    const dataDir = join(dir, 'data', 'acme');
    writeCatalog(dataDir);
    writeFileSync(
      join(dataDir, 'aliases.json'),
      JSON.stringify({ components: [{ alias: 'Card', target: 'Surface', source: 'team' }], props: [] })
    );
    const cfg: SystemConfig = { catalog: { adapter: 'catalog-json', path: 'catalog.json' }, dataDir: 'data/acme' };
    const data = loadSystemData('acme', cfg, dir);
    assert.equal(data.id, 'acme');
    assert.equal(data.catalog.allExports[0], 'Button');
    const card = data.aliases.components.find((e) => e.alias === 'Card');
    assert.equal(card?.source, 'team');
    assert.equal(card?.target, 'Surface');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function loadedConfigFor(dir: string, systems: Record<string, SystemConfig>): LoadedConfig {
  return { configPath: join(dir, 'ds.config.json'), configDir: dir, config: { systems } };
}

test('registry.get(): exact id, implicit single system, ambiguous and unknown throw', () => {
  const dir = makeTempDir();
  try {
    const cfgA: SystemConfig = { catalog: { adapter: 'catalog-json', path: 'catalog.json' }, dataDir: 'data/a' };
    const cfgB: SystemConfig = { catalog: { adapter: 'catalog-json', path: 'catalog.json' }, dataDir: 'data/b' };
    writeCatalog(join(dir, 'data', 'a'));
    writeCatalog(join(dir, 'data', 'b'));

    // Single system: get() with no id resolves it.
    const single = buildRegistry(loadedConfigFor(dir, { a: cfgA }));
    assert.equal(single.get().id, 'a');
    assert.equal(single.get('a').id, 'a');
    assert.throws(() => single.get('missing'), /Unknown system/);

    // Multiple systems: get() with no id is ambiguous.
    const multi = buildRegistry(loadedConfigFor(dir, { a: cfgA, b: cfgB }));
    assert.deepEqual(multi.ids().sort(), ['a', 'b']);
    assert.throws(() => multi.get(), /Multiple systems configured/);
    assert.equal(multi.get('b').id, 'b');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// freshness
// ---------------------------------------------------------------------------

test('checkFreshness: fresh right after extract, stale after the source changes', () => {
  const dir = makeTempDir();
  try {
    const root = join(dir, 'root');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'catalog.json'),
      JSON.stringify({
        components: [{ dir: 'src/Button', exports: [{ displayName: 'Button', description: '', props: [] }] }],
        allExports: ['Button'],
        allPropsByExport: { Button: [] },
      })
    );

    const cfg: SystemConfig = {
      root: 'root',
      catalog: { adapter: 'catalog-json', path: 'catalog.json' },
      dataDir: 'data/acme',
    };

    const loaded = loadedConfigFor(dir, { acme: cfg });
    runExtract('acme', cfg, dir);

    const freshData = loadSystemData('acme', cfg, dir);
    const freshReport = checkFreshness(freshData);
    assert.equal(freshReport.catalog, 'fresh');

    // Mutate the source after the extract: the stamped hash no longer matches.
    writeFileSync(
      join(root, 'catalog.json'),
      JSON.stringify({
        components: [{ dir: 'src/Button', exports: [{ displayName: 'Button', description: 'changed', props: [] }] }],
        allExports: ['Button'],
        allPropsByExport: { Button: [] },
      })
    );

    const staleData = loadSystemData('acme', cfg, dir);
    const staleReport = checkFreshness(staleData);
    assert.equal(staleReport.catalog, 'stale');
    assert.ok(staleReport.details.length > 0);
    void loaded;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkFreshness: unknown when no root is configured', () => {
  const dir = makeTempDir();
  try {
    const dataDir = join(dir, 'data', 'acme');
    writeCatalog(dataDir);
    const cfg: SystemConfig = { catalog: { adapter: 'catalog-json', path: 'catalog.json' }, dataDir: 'data/acme' };
    const data = loadSystemData('acme', cfg, dir);
    const report = checkFreshness(data);
    assert.equal(report.catalog, 'unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadDsConfig, resolveDataDir, resolveRoot } from './config.ts';

function makeTempDir(): string {
  // realpathSync: on macOS, tmpdir() is under /var, a symlink to /private/var. Resolve it so
  // path comparisons against process.cwd() (which returns the resolved path) line up.
  return realpathSync(mkdtempSync(join(tmpdir(), 'ds-mcp-config-test-')));
}

function writeConfig(dir: string, obj: unknown, filename = 'ds.config.json'): string {
  const path = join(dir, filename);
  writeFileSync(path, JSON.stringify(obj, null, 2));
  return path;
}

const VALID_SYSTEM = {
  name: 'Acme',
  root: 'examples/acme',
  catalog: { adapter: 'catalog-json', path: 'catalog.json' },
  tokens: { adapter: 'css-vars', files: ['tokens.css'] },
};

test('loadDsConfig parses a valid config and ignores $schema', () => {
  const dir = makeTempDir();
  try {
    const path = writeConfig(dir, {
      $schema: './schema/ds.config.schema.json',
      systems: { acme: VALID_SYSTEM },
    });
    const loaded = loadDsConfig(path);
    assert.equal(loaded.configPath, path);
    assert.equal(loaded.configDir, dir);
    assert.ok(!('$schema' in loaded.config));
    assert.deepEqual(Object.keys(loaded.config.systems), ['acme']);
    assert.equal(loaded.config.systems.acme?.catalog.adapter, 'catalog-json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDsConfig defaults to ./ds.config.json in cwd when no path is given', () => {
  const dir = makeTempDir();
  const cwd = process.cwd();
  try {
    writeConfig(dir, { systems: { acme: VALID_SYSTEM } });
    process.chdir(dir);
    const loaded = loadDsConfig();
    assert.equal(loaded.configPath, join(dir, 'ds.config.json'));
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDsConfig throws a clear error on missing file', () => {
  const dir = makeTempDir();
  try {
    assert.throws(() => loadDsConfig(join(dir, 'nope.json')), /Could not read config file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDsConfig throws a clear error on invalid JSON', () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'ds.config.json');
    writeFileSync(path, '{ not json');
    assert.throws(() => loadDsConfig(path), /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDsConfig throws a clear, actionable error on an invalid shape', () => {
  const dir = makeTempDir();
  try {
    const path = writeConfig(dir, { systems: { acme: { name: 'Acme' /* missing catalog */ } } });
    assert.throws(() => loadDsConfig(path), (err: Error) => {
      assert.match(err.message, /invalid/);
      assert.match(err.message, /catalog/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDsConfig rejects an unknown catalog adapter (discriminated union)', () => {
  const dir = makeTempDir();
  try {
    const path = writeConfig(dir, {
      systems: {
        acme: { catalog: { adapter: 'made-up-adapter', path: 'x.json' } },
      },
    });
    assert.throws(() => loadDsConfig(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDsConfig rejects a config with no systems', () => {
  const dir = makeTempDir();
  try {
    const path = writeConfig(dir, { systems: {} });
    assert.throws(() => loadDsConfig(path), /no systems/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRoot resolves a relative root against configDir', () => {
  const cfg = { catalog: { adapter: 'catalog-json' as const, path: 'catalog.json' }, root: 'examples/acme' };
  const root = resolveRoot(cfg, '/repo');
  assert.equal(root, join('/repo', 'examples/acme'));
});

test('resolveRoot returns undefined when neither root nor rootEnv is set', () => {
  const cfg = { catalog: { adapter: 'catalog-json' as const, path: 'catalog.json' } };
  assert.equal(resolveRoot(cfg, '/repo'), undefined);
});

test('resolveRoot: rootEnv wins over root when the env var is set', () => {
  const cfg = {
    catalog: { adapter: 'catalog-json' as const, path: 'catalog.json' },
    root: 'examples/acme',
    rootEnv: 'DS_MCP_TEST_ROOT',
  };
  const previous = process.env.DS_MCP_TEST_ROOT;
  process.env.DS_MCP_TEST_ROOT = '/somewhere/else';
  try {
    assert.equal(resolveRoot(cfg, '/repo'), '/somewhere/else');
  } finally {
    if (previous === undefined) delete process.env.DS_MCP_TEST_ROOT;
    else process.env.DS_MCP_TEST_ROOT = previous;
  }
});

test('resolveRoot: rootEnv is ignored when unset, falls back to root', () => {
  const cfg = {
    catalog: { adapter: 'catalog-json' as const, path: 'catalog.json' },
    root: 'examples/acme',
    rootEnv: 'DS_MCP_TEST_ROOT_UNSET',
  };
  delete process.env.DS_MCP_TEST_ROOT_UNSET;
  assert.equal(resolveRoot(cfg, '/repo'), join('/repo', 'examples/acme'));
});

test('resolveDataDir defaults to data/<id> under configDir', () => {
  const cfg = { catalog: { adapter: 'catalog-json' as const, path: 'catalog.json' } };
  assert.equal(resolveDataDir('acme', cfg, '/repo'), join('/repo', 'data', 'acme'));
});

test('resolveDataDir resolves a custom dataDir against configDir', () => {
  const cfg = { catalog: { adapter: 'catalog-json' as const, path: 'catalog.json' }, dataDir: 'custom/data' };
  assert.equal(resolveDataDir('acme', cfg, '/repo'), join('/repo', 'custom/data'));
});

// Offline tests for the init wizard: detection against two synthetic checkouts (a web-component
// repo and a React monorepo), and runInit's non-interactive and interactive paths. Everything
// lives under a temp dir; nothing here names a real design system.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadDsConfig } from '../config.ts';
import { detectPackage, detectSystem } from './detect.ts';
import { runInit } from './wizard.ts';

function makeTempDir(prefix: string): string {
  // realpathSync: on macOS tmpdir() is under /var, a symlink to /private/var; resolve it so
  // path comparisons (relative/inside-configDir checks) line up.
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function write(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function cssWithCustomProps(names: string[]): string {
  const decls = names.map((n) => `  ${n}: 4px;`).join('\n');
  return `:root {\n${decls}\n}\n`;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A web-component checkout: a manifest plus a compiled token sheet, no React source. */
function buildWebComponentRepo(): string {
  const root = makeTempDir('ds-mcp-init-cem-');
  write(
    root,
    'custom-elements.json',
    JSON.stringify({
      schemaVersion: '1.0.0',
      modules: [
        {
          kind: 'javascript-module',
          path: 'src/acme-button.js',
          declarations: [{ kind: 'class', name: 'AcmeButton', tagName: 'acme-button', customElement: true }],
        },
      ],
    })
  );
  write(
    root,
    'tokens.css',
    cssWithCustomProps([
      '--acme-color-gray-900',
      '--acme-color-gray-0',
      '--acme-color-brand-600',
      '--acme-space-1',
      '--acme-space-2',
      '--acme-radius-sm',
    ])
  );
  write(root, 'docs/button.md', '# Button\n\nUsage notes.\n');
  return root;
}

/** A React monorepo: packages/ui declares a react peerDep, has a barrel and several .tsx files. */
function buildReactMonorepo(): string {
  const root = makeTempDir('ds-mcp-init-react-');
  write(
    root,
    'packages/ui/package.json',
    JSON.stringify({ name: '@acme/react', version: '1.0.0', peerDependencies: { react: '^18.0.0' } })
  );
  write(root, 'packages/ui/src/index.ts', "export * from './Button.tsx';\nexport * from './Card.tsx';\n");
  write(root, 'packages/ui/src/Button.tsx', 'export function Button() { return null; }\n');
  write(root, 'packages/ui/src/Card.tsx', 'export function Card() { return null; }\n');
  write(root, 'packages/ui/src/Badge.tsx', 'export function Badge() { return null; }\n');
  write(
    root,
    'tokens.json',
    JSON.stringify({
      color: { brand: { $value: '#2563eb', $type: 'color' } },
      space: { sm: { $value: '4px', $type: 'dimension' } },
    })
  );
  return root;
}

/**
 * An app folder with a design system package (and its foundations package) installed under
 * node_modules -- the "consumed from npm" shape package mode detects from, not a checkout.
 */
function buildInstalledApp(): string {
  const root = makeTempDir('ds-mcp-init-pkg-');
  write(
    root,
    'node_modules/@acme/ui/package.json',
    JSON.stringify({
      name: '@acme/ui',
      version: '3.1.0',
      types: './dist/index.d.ts',
      peerDependencies: { '@acme/foundations': '*', react: '^18.0.0' },
    })
  );
  write(root, 'node_modules/@acme/ui/dist/index.d.ts', "export declare function Button(): null;\n");
  write(root, 'node_modules/@acme/ui/README.md', '# @acme/ui\n\nComponent library.\n');
  write(
    root,
    'node_modules/@acme/foundations/package.json',
    JSON.stringify({ name: '@acme/foundations', version: '1.0.0', main: './src/index.css' })
  );
  write(
    root,
    'node_modules/@acme/foundations/src/index.css',
    cssWithCustomProps([
      '--acme-color-brand-600',
      '--acme-color-gray-900',
      '--acme-color-gray-0',
      '--acme-space-1',
      '--acme-space-2',
      '--acme-radius-sm',
    ])
  );
  write(root, 'node_modules/@acme/foundations/README.md', '# @acme/foundations\n\nDesign tokens.\n');
  write(root, 'node_modules/@types/react/package.json', JSON.stringify({ name: '@types/react', version: '18.0.0' }));
  return root;
}

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// detectSystem
// ---------------------------------------------------------------------------

test('detectSystem finds a custom-elements manifest and a css token sheet in a web-component repo', () => {
  const root = buildWebComponentRepo();
  try {
    const detection = detectSystem(root);
    assert.deepEqual(detection.manifests, ['custom-elements.json']);
    assert.equal(detection.componentModel, 'custom-elements');
    assert.equal(detection.reactSrc.length, 0, 'no package.json declares react, so no react source is a candidate');
    assert.equal(detection.cssTokenFiles.length, 1);
    assert.equal(detection.cssTokenFiles[0]?.path, 'tokens.css');
    assert.ok(detection.cssTokenFiles[0]!.count >= 5);
    assert.deepEqual(detection.docsGlobs, ['docs/**/*.md']);
  } finally {
    cleanup(root);
  }
});

test('detectSystem finds a react source dir with a barrel and a dtcg token file in a React monorepo', () => {
  const root = buildReactMonorepo();
  try {
    const detection = detectSystem(root);
    assert.equal(detection.componentModel, 'react');
    assert.equal(detection.manifests.length, 0);
    assert.equal(detection.reactSrc[0]?.dir, 'packages/ui/src');
    assert.equal(detection.reactSrc[0]?.tsxCount, 3);
    assert.deepEqual(detection.barrels, ['packages/ui/src/index.ts']);
    assert.deepEqual(detection.dtcgFiles, ['tokens.json']);
    assert.equal(detection.packageName, '@acme/react');
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// runInit: non-interactive
// ---------------------------------------------------------------------------

test('runInit (non-interactive) writes a config that loadDsConfig accepts', async () => {
  const root = buildWebComponentRepo();
  const configDir = makeTempDir('ds-mcp-init-config-');
  const configPath = join(configDir, 'ds.config.json');
  try {
    const result = await runInit({ configPath, answers: { systemId: 'acme', root } });

    assert.equal(result.systemId, 'acme');
    assert.equal(result.configPath, configPath);
    const sys = result.config.systems.acme;
    assert.ok(sys);
    assert.equal(sys?.catalog.adapter, 'custom-elements-manifest');
    assert.equal(sys?.componentModel, 'custom-elements');
    assert.equal(sys?.rootEnv, 'ACME_DIR');

    // loadDsConfig must accept the file as written, not just the in-memory result.
    const reloaded = loadDsConfig(configPath);
    assert.deepEqual(reloaded.config.systems.acme, sys);
  } finally {
    cleanup(root, configDir);
  }
});

test('runInit (non-interactive) merges into an existing config, keeping other systems and $schema', async () => {
  const root = buildWebComponentRepo();
  const configDir = makeTempDir('ds-mcp-init-merge-');
  const configPath = join(configDir, 'ds.config.json');
  const existing = {
    $schema: './schema/ds.config.schema.json',
    systems: {
      other: { catalog: { adapter: 'catalog-json', path: 'catalog.json' } },
    },
  };
  writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');

  try {
    const result = await runInit({ configPath, answers: { systemId: 'acme', root } });

    assert.deepEqual(Object.keys(result.config.systems).sort(), ['acme', 'other']);
    assert.deepEqual(result.config.systems.other, existing.systems.other);

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as { $schema?: string };
    assert.equal(onDisk.$schema, existing.$schema);
  } finally {
    cleanup(root, configDir);
  }
});

test('runInit (non-interactive) throws a clear error when no catalog adapter can be detected or supplied', async () => {
  const root = makeTempDir('ds-mcp-init-empty-');
  const configDir = makeTempDir('ds-mcp-init-empty-config-');
  const configPath = join(configDir, 'ds.config.json');
  try {
    await assert.rejects(
      () => runInit({ configPath, answers: { systemId: 'acme', root } }),
      /Could not detect a catalog adapter/
    );
  } finally {
    cleanup(root, configDir);
  }
});

// ---------------------------------------------------------------------------
// runInit: interactive
// ---------------------------------------------------------------------------

test('runInit (interactive) with an ask that echoes defaults matches the non-interactive result', async () => {
  const root = buildReactMonorepo();
  const configDirA = makeTempDir('ds-mcp-init-noninteractive-');
  const configDirB = makeTempDir('ds-mcp-init-interactive-');
  const configPathA = join(configDirA, 'ds.config.json');
  const configPathB = join(configDirB, 'ds.config.json');

  try {
    const nonInteractive = await runInit({ configPath: configPathA, answers: { systemId: 'acme', root } });

    const echoAsk = async (_question: string, defaultValue: string) => defaultValue;
    const interactive = await runInit({
      configPath: configPathB,
      answers: { systemId: 'acme', root },
      ask: echoAsk,
    });

    // Both configs point at the same root, so compare everything except the root string, which
    // is stored relative to each config's own (different) directory.
    const { root: rootA, ...restA } = nonInteractive.config.systems.acme!;
    const { root: rootB, ...restB } = interactive.config.systems.acme!;
    assert.deepEqual(restA, restB);
    assert.equal(rootA, root, 'non-interactive root is outside configDirA, so stored absolute');
    assert.equal(rootB, root, 'interactive root is outside configDirB, so stored absolute');
  } finally {
    cleanup(root, configDirA, configDirB);
  }
});

// ---------------------------------------------------------------------------
// detectPackage (package mode)
// ---------------------------------------------------------------------------

test('detectPackage reads the barrel, css, readmes, react types and peer foundations from an installed package', () => {
  const root = buildInstalledApp();
  try {
    const detection = detectPackage(root, '@acme/ui');
    assert.equal(detection.pkg, '@acme/ui');
    assert.equal(detection.pkgDir, 'node_modules/@acme/ui');
    assert.equal(detection.version, '3.1.0');
    assert.equal(detection.barrel, 'node_modules/@acme/ui/dist/index.d.ts');
    assert.equal(detection.src, 'node_modules/@acme/ui/dist');
    assert.deepEqual(detection.readmes, ['node_modules/@acme/ui/README.md']);
    assert.equal(detection.hasReactTypes, true);
    assert.equal(detection.peerFoundations, '@acme/foundations', 'inferred from peerDependencies, not given explicitly');
    // No foundations package name was passed, so only @acme/ui's own css is considered (none here).
    assert.deepEqual(detection.cssFiles, []);
  } finally {
    cleanup(root);
  }
});

test('detectPackage folds in the foundations package css and readme when given', () => {
  const root = buildInstalledApp();
  try {
    const detection = detectPackage(root, '@acme/ui', '@acme/foundations');
    assert.equal(detection.peerFoundations, undefined, 'foundations was given explicitly, so it is not (re)detected');
    assert.deepEqual(detection.cssFiles, ['node_modules/@acme/foundations/src/index.css']);
    assert.deepEqual(
      detection.readmes.sort(),
      ['node_modules/@acme/foundations/README.md', 'node_modules/@acme/ui/README.md'].sort()
    );
  } finally {
    cleanup(root);
  }
});

test('detectPackage throws a clear error when the package is not installed', () => {
  const root = makeTempDir('ds-mcp-init-pkg-missing-');
  try {
    assert.throws(() => detectPackage(root, '@acme/ui'), /@acme\/ui is not installed.*npm install @acme\/ui/s);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// runInit: package mode
// ---------------------------------------------------------------------------

test('runInit (non-interactive, package mode) writes a config that loadDsConfig accepts', async () => {
  const root = buildInstalledApp();
  const configDir = makeTempDir('ds-mcp-init-pkg-config-');
  const configPath = join(configDir, 'ds.config.json');
  try {
    const result = await runInit({ configPath, answers: { systemId: 'acme', package: '@acme/ui', root } });

    const sys = result.config.systems.acme;
    assert.ok(sys);
    assert.equal(sys?.root, '.', 'package mode always stores root as "."');
    assert.equal(sys?.componentModel, 'react');
    assert.equal(sys?.componentsPkg, '@acme/ui');
    assert.equal(sys?.foundationsPkg, '@acme/foundations', 'detected via the peerDependency');
    assert.deepEqual(sys?.catalog, {
      adapter: 'react-docgen',
      src: 'node_modules/@acme/ui/dist',
      barrel: 'node_modules/@acme/ui/dist/index.d.ts',
    });
    assert.deepEqual(sys?.tokens, { adapter: 'css-vars', files: ['node_modules/@acme/foundations/src/index.css'] });
    assert.deepEqual(
      sys?.docs?.include.slice().sort(),
      ['node_modules/@acme/foundations/README.md', 'node_modules/@acme/ui/README.md'].sort()
    );

    const reloaded = loadDsConfig(configPath);
    assert.deepEqual(reloaded.config.systems.acme, sys);
  } finally {
    cleanup(root, configDir);
  }
});

test('runInit (non-interactive, package mode) is triggered by systemId + package, without a root', async () => {
  const root = buildInstalledApp();
  const configDir = makeTempDir('ds-mcp-init-pkg-noroot-');
  const configPath = join(configDir, 'ds.config.json');
  const cwd = process.cwd();
  try {
    process.chdir(root);
    const result = await runInit({ configPath, answers: { systemId: 'acme', package: '@acme/ui' } });
    assert.equal(result.config.systems.acme?.root, '.');
    assert.equal(result.config.systems.acme?.componentsPkg, '@acme/ui');
  } finally {
    process.chdir(cwd);
    cleanup(root, configDir);
  }
});

test('runInit (interactive, package mode) with an ask that echoes defaults matches the non-interactive result', async () => {
  const root = buildInstalledApp();
  const configDirA = makeTempDir('ds-mcp-init-pkg-noninteractive-');
  const configDirB = makeTempDir('ds-mcp-init-pkg-interactive-');
  const configPathA = join(configDirA, 'ds.config.json');
  const configPathB = join(configDirB, 'ds.config.json');

  try {
    const nonInteractive = await runInit({ configPath: configPathA, answers: { systemId: 'acme', package: '@acme/ui', root } });

    const echoAsk = async (_question: string, defaultValue: string) => defaultValue;
    const interactive = await runInit({
      configPath: configPathB,
      answers: { systemId: 'acme', package: '@acme/ui', root },
      ask: echoAsk,
    });

    assert.deepEqual(interactive.config.systems.acme, nonInteractive.config.systems.acme);
  } finally {
    cleanup(root, configDirA, configDirB);
  }
});

test('runInit (package mode) logs the @types/react hint when it is missing', async () => {
  const root = buildInstalledApp();
  rmSync(join(root, 'node_modules/@types/react'), { recursive: true, force: true });
  const configDir = makeTempDir('ds-mcp-init-pkg-notypes-');
  const configPath = join(configDir, 'ds.config.json');
  const lines: string[] = [];
  try {
    await runInit({ configPath, answers: { systemId: 'acme', package: '@acme/ui', root }, log: (line) => lines.push(line) });
    assert.ok(
      lines.some((l) => l.includes('npm install -D @types/react @types/react-dom')),
      `expected a @types/react hint, got: ${lines.join('\n')}`
    );
  } finally {
    cleanup(root, configDir);
  }
});

test('runInit (package mode) throws the clear detectPackage error when the package is not installed', async () => {
  const root = makeTempDir('ds-mcp-init-pkg-missing-config-');
  const configDir = makeTempDir('ds-mcp-init-pkg-missing-configdir-');
  const configPath = join(configDir, 'ds.config.json');
  try {
    await assert.rejects(
      () => runInit({ configPath, answers: { systemId: 'acme', package: '@acme/ui', root } }),
      /@acme\/ui is not installed/
    );
  } finally {
    cleanup(root, configDir);
  }
});

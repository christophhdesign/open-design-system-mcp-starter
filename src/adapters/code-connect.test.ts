import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';

import type { AliasMap, SystemCatalog, SystemConfig } from '../types.ts';
import { collectCodeConnectFiles, enrichFromCodeConnect, parseCodeConnectFile } from './code-connect.ts';
import { runExtract } from './index.ts';
import { loadCodeConnectAliases, mergeAliases } from '../data/aliases.ts';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ds-mcp-code-connect-test-'));
}

function writeFile(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

// Fictional "acme" components only. Mirrors the general shape of a Figma Code Connect file
// without reproducing any real design system's content: an identifier component arg
// (AcmeButton) with boolean/string/enum/children props and an example, a second identifier
// component arg (AcmeGhost) with no example (dashed node-id encoding), and a string-literal
// component arg (AcmeMystery) for a component this repo never exports.
const FIXTURE = `
import React from 'react';
import figma from '@figma/code-connect';
import { AcmeButton } from './acme-button';
import { AcmeGhost } from './acme-ghost';

figma.connect(
  AcmeButton,
  'https://www.figma.com/design/ABCDEF/Acme-Kit?node-id=101%3A202',
  {
    props: {
      disabled: figma.boolean('Disabled'),
      label: figma.string('Label'),
      variant: figma.enum('Variant', {
        Primary: 'accent',
        neutral: 'neutral',
      }),
      content: figma.children('Content'),
    },
    example: (props) => (
      <AcmeButton disabled={props.disabled} variant={props.variant}>
        {props.label}
      </AcmeButton>
    ),
  },
);

figma.connect(AcmeGhost, 'https://www.figma.com/design/ABCDEF/Acme-Kit?node-id=303-404', {
  props: {
    active: figma.boolean('Active'),
  },
});

figma.connect('AcmeMystery', 'https://www.figma.com/design/ABCDEF/Acme-Kit?node-id=505-606', {
  props: {},
});
`;

function makeCatalog(): SystemCatalog {
  return {
    system: 'acme',
    generatedAt: '2026-01-01T00:00:00.000Z',
    source: { root: '/virtual/acme' },
    components: [
      { dir: 'src/button', exports: [{ displayName: 'AcmeButton', description: 'A button.', props: [] }] },
    ],
    allExports: ['AcmeButton', 'AcmeGhost'],
    allPropsByExport: { AcmeButton: [], AcmeGhost: [] },
  };
}

// ---------------------------------------------------------------------------
// parseCodeConnectFile
// ---------------------------------------------------------------------------

test('parseCodeConnectFile: reads component, nodeId, url, props and example for an identifier arg', () => {
  const mappings = parseCodeConnectFile('acme.figma.tsx', FIXTURE);
  assert.equal(mappings.length, 3);

  const button = mappings.find((m) => m.component === 'AcmeButton');
  assert.ok(button);
  assert.equal(button!.nodeId, '101:202');
  assert.equal(button!.url, 'https://www.figma.com/design/ABCDEF/Acme-Kit?node-id=101%3A202');
  assert.equal(button!.source, 'acme.figma.tsx');
  assert.equal(button!.props.length, 4);

  const disabled = button!.props.find((p) => p.prop === 'disabled');
  assert.deepEqual(disabled, { figma: 'Disabled', kind: 'boolean', prop: 'disabled', values: undefined });

  const label = button!.props.find((p) => p.prop === 'label');
  assert.deepEqual(label, { figma: 'Label', kind: 'string', prop: 'label', values: undefined });

  const variant = button!.props.find((p) => p.prop === 'variant');
  assert.equal(variant?.kind, 'enum');
  assert.equal(variant?.figma, 'Variant');
  assert.deepEqual(variant?.values, { Primary: 'accent', neutral: 'neutral' });

  const content = button!.props.find((p) => p.prop === 'content');
  assert.equal(content?.kind, 'children');
  assert.equal(content?.figma, 'Content');

  assert.ok(button!.example);
  assert.ok(button!.example!.includes('disabled={disabled}'));
  assert.ok(button!.example!.includes('variant={variant}'));
  assert.ok(button!.example!.includes('{label}'));
  assert.ok(!button!.example!.includes('props.'));
});

test('parseCodeConnectFile: normalizes both %3A and dashed node-id separators, handles a string component arg', () => {
  const mappings = parseCodeConnectFile('acme.figma.tsx', FIXTURE);

  const ghost = mappings.find((m) => m.component === 'AcmeGhost');
  assert.ok(ghost);
  assert.equal(ghost!.nodeId, '303:404');
  assert.equal(ghost!.example, undefined);

  const mystery = mappings.find((m) => m.component === 'AcmeMystery');
  assert.ok(mystery);
  assert.equal(mystery!.nodeId, '505:606');
  assert.equal(mystery!.props.length, 0);
});

test('parseCodeConnectFile: an unrecognized figma.<kind> method name becomes "other", never throws', () => {
  const text = `
    import figma from '@figma/code-connect';
    figma.connect(Weird, 'https://www.figma.com/design/X/Y?node-id=1-2', {
      props: { odd: figma.somethingUnknown('Odd') },
    });
  `;
  const mappings = parseCodeConnectFile('weird.figma.tsx', text);
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0]!.props[0]!.kind, 'other');
});

test('parseCodeConnectFile: malformed source never throws, just yields fewer or no mappings', () => {
  assert.doesNotThrow(() => parseCodeConnectFile('broken.figma.tsx', 'this is not { valid at all figma.connect('));
  assert.doesNotThrow(() => parseCodeConnectFile('empty.figma.tsx', ''));
});

// ---------------------------------------------------------------------------
// enrichFromCodeConnect
// ---------------------------------------------------------------------------

test('enrichFromCodeConnect: sets figma on the matching export, appends the example, reports unmatched', () => {
  const catalog = makeCatalog();
  const mappings = parseCodeConnectFile('acme.figma.tsx', FIXTURE);
  const result = enrichFromCodeConnect(catalog, mappings, { files: 1, hash: 'deadbeef' });

  assert.deepEqual([...result.mapped].sort(), ['AcmeButton', 'AcmeGhost']);
  assert.deepEqual(result.unmatched, ['AcmeMystery']);

  const exports = result.catalog.components.flatMap((c) => c.exports);
  const button = exports.find((e) => e.displayName === 'AcmeButton');
  assert.ok(button);
  assert.deepEqual(button!.figma, {
    nodeId: '101:202',
    url: 'https://www.figma.com/design/ABCDEF/Acme-Kit?node-id=101%3A202',
    source: 'acme.figma.tsx',
  });
  assert.equal(button!.examples?.length, 1);
  assert.equal(button!.examples![0]!.title, 'Code Connect example');
  assert.equal(button!.examples![0]!.language, 'tsx');

  // AcmeGhost is in allExports but docgen produced no CatalogExport for it: a stub is created.
  const ghost = exports.find((e) => e.displayName === 'AcmeGhost');
  assert.ok(ghost);
  assert.equal(ghost!.docSource, 'code-connect');
  assert.deepEqual(ghost!.props, []);
  assert.equal(ghost!.figma?.nodeId, '303:404');

  assert.deepEqual(result.catalog.source.codeConnect, { files: 1, mapped: 2, hash: 'deadbeef' });

  // The input catalog is never mutated.
  assert.equal(catalog.components.length, 1);
  assert.equal(catalog.components[0]!.exports[0]!.figma, undefined);
});

test('enrichFromCodeConnect: an alias is produced only for enum values that actually differ', () => {
  const catalog = makeCatalog();
  const mappings = parseCodeConnectFile('acme.figma.tsx', FIXTURE);
  const result = enrichFromCodeConnect(catalog, mappings, { files: 1, hash: 'deadbeef' });

  assert.equal(result.aliases.length, 1);
  assert.equal(result.aliases[0]!.alias, 'Primary');
  assert.equal(result.aliases[0]!.target, 'accent');
  assert.equal(result.aliases[0]!.concept, 'AcmeButton.variant');
  assert.equal(result.aliases[0]!.source, 'code-connect');
  // 'Secondary' maps to the identical code value 'secondary' in the fixture, so it must not
  // produce an alias.
  assert.ok(!result.aliases.some((a) => a.alias === 'Secondary'));
});

test('enrichFromCodeConnect: re-running with the same mapping does not duplicate the example', () => {
  const catalog = makeCatalog();
  const mappings = parseCodeConnectFile('acme.figma.tsx', FIXTURE);
  const first = enrichFromCodeConnect(catalog, mappings, { files: 1, hash: 'a' });
  const second = enrichFromCodeConnect(first.catalog, mappings, { files: 1, hash: 'b' });

  const button = second.catalog.components.flatMap((c) => c.exports).find((e) => e.displayName === 'AcmeButton');
  assert.equal(button!.examples?.length, 1);
});

// ---------------------------------------------------------------------------
// collectCodeConnectFiles
// ---------------------------------------------------------------------------

test('collectCodeConnectFiles: matches the default *.figma.tsx/*.figma.ts globs, skips node_modules and dot-dirs', () => {
  const dir = makeTempDir();
  try {
    writeFile(dir, 'src/button/acme-button.figma.tsx', '// a');
    writeFile(dir, 'src/alert/acme-alert.figma.ts', '// b');
    writeFile(dir, 'src/button/acme-button.tsx', '// not a code connect file');
    writeFile(dir, 'node_modules/some-pkg/whatever.figma.tsx', '// must be skipped');
    writeFile(dir, '.hidden/skip.figma.tsx', '// must be skipped');

    const files = collectCodeConnectFiles(dir, undefined);
    const rels = files.map((f) => relative(dir, f).split(sep).join('/')).sort();
    assert.deepEqual(rels, ['src/alert/acme-alert.figma.ts', 'src/button/acme-button.figma.tsx']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectCodeConnectFiles: an explicit include list is honored instead of the default', () => {
  const dir = makeTempDir();
  try {
    writeFile(dir, 'a.figma.tsx', '// a');
    writeFile(dir, 'nested/b.figma.tsx', '// b');

    const files = collectCodeConnectFiles(dir, ['a.figma.tsx']);
    const rels = files.map((f) => relative(dir, f).split(sep).join('/'));
    assert.deepEqual(rels, ['a.figma.tsx']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// mergeAliases: three-layer precedence (team > code-connect > lexicon)
// ---------------------------------------------------------------------------

test('mergeAliases: team overrides code-connect overrides lexicon on the same alias key', () => {
  const lexicon: AliasMap = {
    components: [{ alias: 'Card', concept: 'surface container', source: 'lexicon', occurrences: 5 }],
    props: [],
  };
  const codeConnect: AliasMap = {
    components: [{ alias: 'Card', target: 'AcmeCard', concept: 'surface container', source: 'code-connect', note: 'Figma property value' }],
    props: [],
  };
  const team: AliasMap = {
    components: [{ alias: 'Card', target: 'AcmeSurface', source: 'team' }],
    props: [],
  };

  const lexiconOnly = mergeAliases(lexicon);
  assert.equal(lexiconOnly.components[0]!.source, 'lexicon');

  const codeConnectWins = mergeAliases(lexicon, undefined, codeConnect);
  assert.equal(codeConnectWins.components[0]!.target, 'AcmeCard');
  assert.equal(codeConnectWins.components[0]!.source, 'code-connect');

  const teamWinsOverBoth = mergeAliases(lexicon, team, codeConnect);
  assert.equal(teamWinsOverBoth.components[0]!.target, 'AcmeSurface');
  assert.equal(teamWinsOverBoth.components[0]!.source, 'team');

  // A code-connect-only alias (no lexicon entry for it at all) still surfaces.
  const extraCodeConnect: AliasMap = {
    components: [{ alias: 'Toast', target: 'AcmeToast', source: 'code-connect', note: 'Figma property value' }],
    props: [],
  };
  const withExtra = mergeAliases(lexicon, undefined, extraCodeConnect);
  assert.ok(withExtra.components.some((e) => e.alias === 'Toast' && e.source === 'code-connect'));
});

test('loadCodeConnectAliases: reads aliases.code-connect.json, undefined when missing', () => {
  const dir = makeTempDir();
  try {
    assert.equal(loadCodeConnectAliases(dir), undefined);

    const aliasMap: AliasMap = {
      components: [],
      props: [{ alias: 'Primary', target: 'accent', concept: 'AcmeButton.variant', note: 'Figma property value', source: 'code-connect' }],
    };
    writeFileSync(join(dir, 'aliases.code-connect.json'), JSON.stringify(aliasMap), 'utf8');

    const loaded = loadCodeConnectAliases(dir);
    assert.ok(loaded);
    assert.equal(loaded!.props.length, 1);
    assert.equal(loaded!.props[0]!.alias, 'Primary');
    assert.equal(loaded!.props[0]!.target, 'accent');
    assert.equal(loaded!.props[0]!.source, 'code-connect');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runExtract: end-to-end through the adapter dispatcher
// ---------------------------------------------------------------------------

test('runExtract: enriches the catalog from a *.figma.tsx file and writes aliases.code-connect.json', () => {
  const dir = makeTempDir();
  try {
    const root = join(dir, 'root');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'catalog.json'),
      JSON.stringify({
        components: [{ dir: 'src/button', exports: [{ displayName: 'AcmeButton', description: '', props: [] }] }],
        allExports: ['AcmeButton'],
        allPropsByExport: { AcmeButton: [] },
      })
    );
    writeFile(root, 'src/button/acme-button.figma.tsx', FIXTURE);

    const cfg: SystemConfig = {
      root: 'root',
      catalog: { adapter: 'catalog-json', path: 'catalog.json' },
      dataDir: 'data/acme',
      codeConnect: { include: ['**/*.figma.tsx'] },
    };

    const result = runExtract('acme', cfg, dir);

    assert.ok(result.codeConnect);
    assert.equal(result.codeConnect!.files, 1);
    assert.equal(result.codeConnect!.mapped, 1);
    assert.deepEqual([...result.codeConnect!.unmatched].sort(), ['AcmeGhost', 'AcmeMystery']);

    const button = result.catalog.components.flatMap((c) => c.exports).find((e) => e.displayName === 'AcmeButton');
    assert.equal(button?.figma?.nodeId, '101:202');
    assert.ok(result.catalog.source.codeConnect);
    assert.equal(result.catalog.source.codeConnect!.mapped, 1);

    const aliasPath = join(dir, 'data/acme/aliases.code-connect.json');
    assert.ok(existsSync(aliasPath));
    assert.ok(result.written.includes(aliasPath));
    const aliasJson = JSON.parse(readFileSync(aliasPath, 'utf8')) as AliasMap;
    assert.deepEqual(aliasJson.components, []);
    assert.ok(aliasJson.props.some((e) => e.alias === 'Primary' && e.target === 'accent'));

    const catalogPath = join(dir, 'data/acme/catalog.json');
    const writtenCatalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as SystemCatalog;
    const writtenButton = writtenCatalog.components.flatMap((c) => c.exports).find((e) => e.displayName === 'AcmeButton');
    assert.equal(writtenButton?.figma?.nodeId, '101:202');
    assert.equal(writtenButton?.examples?.length, 1);
    assert.equal(writtenButton?.examples?.[0]?.title, 'Code Connect example');

    // A second run over unchanged source is idempotent: writeStamped keeps the first
    // generatedAt because nothing but it differs.
    const second = runExtract('acme', cfg, dir);
    const secondCatalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as SystemCatalog;
    assert.equal(secondCatalog.generatedAt, writtenCatalog.generatedAt);
    assert.equal(second.codeConnect!.mapped, 1);
    assert.ok(existsSync(aliasPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

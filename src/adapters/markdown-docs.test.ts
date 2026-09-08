import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { SystemCatalog, SystemConfig } from '../types.ts';
import { buildDocsIndex, docsSourceHash } from './markdown-docs.ts';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ds-mcp-markdown-docs-test-'));
}

function writeFile(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function makeCatalog(): SystemCatalog {
  const button = {
    displayName: 'acme-button',
    description: 'A clickable control.',
    props: [],
  };
  const surface = {
    displayName: 'acme-surface',
    description: 'A container.',
    props: [],
  };
  return {
    system: 'acme',
    generatedAt: '2026-08-25T00:00:00.000Z',
    source: { root: '/virtual/acme' },
    components: [
      { dir: 'src/components/button', exports: [button as SystemCatalog['components'][number]['exports'][number]] },
      { dir: 'src/components/surface', exports: [surface as SystemCatalog['components'][number]['exports'][number]] },
    ],
    allExports: ['acme-button', 'acme-surface'],
    allPropsByExport: { 'acme-button': [], 'acme-surface': [] },
  };
}

// ---------------------------------------------------------------------------
// glob matching
// ---------------------------------------------------------------------------

test('buildDocsIndex: matches nested files via **, respects exclude, skips node_modules and dot-dirs', () => {
  const root = makeTempDir();
  try {
    writeFile(root, 'docs/button.md', '# Button\n\nA control.\n');
    writeFile(root, 'docs/nested/deep/notes.md', '# Notes\n\nDeep notes.\n');
    writeFile(root, 'docs/draft.md', '# Draft\n\nSkip me.\n');
    writeFile(root, 'node_modules/pkg/readme.md', '# Should not appear\n');
    writeFile(root, '.git/COMMIT_EDITMSG', '# Should not appear\n');
    writeFile(root, 'README.md', '# Root readme\n\nNot included by this pattern.\n');

    const cfg: SystemConfig = { catalog: { adapter: 'catalog-json', path: 'catalog.json' }, docs: { include: ['docs/**/*.md'], exclude: ['docs/draft.md'] } };
    const index = buildDocsIndex('acme', cfg, root, makeCatalog());

    const paths = new Set(index.chunks.map((c) => c.path));
    assert.ok(paths.has('docs/button.md'));
    assert.ok(paths.has('docs/nested/deep/notes.md'));
    assert.ok(!paths.has('docs/draft.md'));
    assert.ok(![...paths].some((p) => p.includes('node_modules')));
    assert.ok(![...paths].some((p) => p.includes('.git')));
    assert.ok(!paths.has('README.md'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildDocsIndex: {a,b} brace alternation matches either branch', () => {
  const root = makeTempDir();
  try {
    writeFile(root, 'docs/button.md', '# Button\n\nBody.\n');
    writeFile(root, 'guides/setup.md', '# Setup\n\nBody.\n');
    writeFile(root, 'other/ignored.md', '# Ignored\n\nBody.\n');

    const cfg: SystemConfig = { catalog: { adapter: 'catalog-json', path: 'catalog.json' }, docs: { include: ['{docs,guides}/*.md'] } };
    const index = buildDocsIndex('acme', cfg, root, makeCatalog());

    const paths = new Set(index.chunks.map((c) => c.path));
    assert.ok(paths.has('docs/button.md'));
    assert.ok(paths.has('guides/setup.md'));
    assert.ok(!paths.has('other/ignored.md'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// heading chunking + trail
// ---------------------------------------------------------------------------

test('buildDocsIndex: chunks by heading, builds a nested trail, and keeps preamble as its own chunk', () => {
  const root = makeTempDir();
  try {
    writeFile(
      root,
      'docs/button.md',
      [
        'Some preamble text before any heading.',
        '',
        '# Button',
        '',
        'Top-level intro.',
        '',
        '## Accessibility',
        '',
        'Icon-only acme-button needs an accessible name.',
        '',
        '### Notes',
        '',
        'Fine print.',
        '',
        '## Sizes',
        '',
        'sm, md, lg.',
        '',
      ].join('\n'),
    );

    const cfg: SystemConfig = { catalog: { adapter: 'catalog-json', path: 'catalog.json' }, docs: { include: ['docs/*.md'] } };
    const index = buildDocsIndex('acme', cfg, root, makeCatalog());

    // Preamble chunk uses the file's first h1 as its heading/title.
    const preamble = index.chunks.find((c) => c.text.startsWith('Some preamble'));
    assert.ok(preamble);
    assert.equal(preamble!.heading, 'Button');
    assert.deepEqual(preamble!.trail, ['Button']);

    const h1 = index.chunks.find((c) => c.heading === 'Button' && c.text.startsWith('Top-level'));
    assert.ok(h1);
    assert.deepEqual(h1!.trail, ['Button']);

    const a11y = index.chunks.find((c) => c.heading === 'Accessibility');
    assert.ok(a11y);
    assert.deepEqual(a11y!.trail, ['Button', 'Accessibility']);

    const notes = index.chunks.find((c) => c.heading === 'Notes');
    assert.ok(notes);
    assert.deepEqual(notes!.trail, ['Button', 'Accessibility', 'Notes']);

    // Sibling h2 pops the h3 off the stack.
    const sizes = index.chunks.find((c) => c.heading === 'Sizes');
    assert.ok(sizes);
    assert.deepEqual(sizes!.trail, ['Button', 'Sizes']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildDocsIndex: keeps code fences intact and trims section text to 1200 chars', () => {
  const root = makeTempDir();
  try {
    const longLine = 'x'.repeat(2000);
    writeFile(
      root,
      'docs/button.md',
      ['# Button', '', '## Usage', '', '```html', '<acme-button># not a heading</acme-button>', '```', '', longLine, ''].join('\n'),
    );

    const cfg: SystemConfig = { catalog: { adapter: 'catalog-json', path: 'catalog.json' }, docs: { include: ['docs/*.md'] } };
    const index = buildDocsIndex('acme', cfg, root, makeCatalog());

    const usage = index.chunks.find((c) => c.heading === 'Usage');
    assert.ok(usage);
    assert.ok(usage!.text.includes('```html'));
    assert.ok(usage!.text.includes('```'));
    assert.ok(usage!.text.length <= 1200);

    // Only one 'Button' h1 chunk (no false heading found inside the fence).
    const buttonChunks = index.chunks.filter((c) => c.heading === 'Button');
    assert.equal(buttonChunks.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// mentions
// ---------------------------------------------------------------------------

test('buildDocsIndex: mentions catch catalog export names as whole words, including backticked, deduplicated', () => {
  const root = makeTempDir();
  try {
    writeFile(
      root,
      'docs/button.md',
      [
        '# acme-button',
        '',
        '## Accessibility',
        '',
        'Use `acme-button` inside `acme-surface`. acme-button needs a label. acme-buttons (plural) should not count.',
        '',
      ].join('\n'),
    );

    const cfg: SystemConfig = { catalog: { adapter: 'catalog-json', path: 'catalog.json' }, docs: { include: ['docs/*.md'] } };
    const index = buildDocsIndex('acme', cfg, root, makeCatalog());

    const a11y = index.chunks.find((c) => c.heading === 'Accessibility');
    assert.ok(a11y);
    // Deduplicated: acme-button appears three times as a whole word but is listed once.
    assert.deepEqual(a11y!.mentions.filter((m) => m === 'acme-button').length, 1);
    assert.ok(a11y!.mentions.includes('acme-surface'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// docsSourceHash
// ---------------------------------------------------------------------------

test('docsSourceHash: stable for identical content, changes when a matched file changes, order-independent', () => {
  const rootA = makeTempDir();
  const rootB = makeTempDir();
  try {
    writeFile(rootA, 'docs/a.md', '# A\n\nOne.\n');
    writeFile(rootA, 'docs/b.md', '# B\n\nTwo.\n');
    writeFile(rootB, 'docs/b.md', '# B\n\nTwo.\n');
    writeFile(rootB, 'docs/a.md', '# A\n\nOne.\n');

    const cfg: SystemConfig = { catalog: { adapter: 'catalog-json', path: 'catalog.json' }, docs: { include: ['docs/*.md'] } };
    const hashA = docsSourceHash(cfg, rootA);
    const hashB = docsSourceHash(cfg, rootB);
    assert.equal(hashA, hashB);

    writeFile(rootA, 'docs/a.md', '# A\n\nOne changed.\n');
    const hashAChanged = docsSourceHash(cfg, rootA);
    assert.notEqual(hashA, hashAChanged);
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test('docsSourceHash: unaffected by an excluded file changing', () => {
  const root = makeTempDir();
  try {
    writeFile(root, 'docs/a.md', '# A\n\nOne.\n');
    writeFile(root, 'docs/draft.md', '# Draft\n\nWork in progress.\n');

    const cfg: SystemConfig = { catalog: { adapter: 'catalog-json', path: 'catalog.json' }, docs: { include: ['docs/*.md'], exclude: ['docs/draft.md'] } };
    const before = docsSourceHash(cfg, root);

    writeFile(root, 'docs/draft.md', '# Draft\n\nChanged.\n');
    const after = docsSourceHash(cfg, root);
    assert.equal(before, after);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

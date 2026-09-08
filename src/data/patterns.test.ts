import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { PatternParseContext } from './load.ts';
import { loadSystemData, parsePatternFile } from './load.ts';
import type { SystemCatalog, SystemConfig } from '../types.ts';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ds-mcp-patterns-test-'));
}

const REACT_CTX: PatternParseContext = {
  componentModel: 'react',
  exportNames: ['TextInput', 'Stack', 'Button'],
  tagNames: [],
};

const CE_CTX: PatternParseContext = {
  componentModel: 'custom-elements',
  exportNames: ['acme-text-input', 'acme-stack', 'acme-button'],
  tagNames: ['acme-text-input', 'acme-stack', 'acme-button'],
};

// ---------------------------------------------------------------------------
// parsePatternFile: front matter
// ---------------------------------------------------------------------------

test('parsePatternFile: front matter title/description/tags/language win over body fallbacks', () => {
  const text = `---
title: Labeled field
description: A field with a label and an error.
tags: form, validation
language: tsx
---

# Some other H1

Some other paragraph that should be ignored because front matter set the description.

\`\`\`tsx
<TextInput required />
\`\`\`
`;
  const pattern = parsePatternFile('labeled-field', text, REACT_CTX);
  assert.equal(pattern.id, 'labeled-field');
  assert.equal(pattern.title, 'Labeled field');
  assert.equal(pattern.description, 'A field with a label and an error.');
  assert.deepEqual(pattern.tags, ['form', 'validation']);
  assert.equal(pattern.language, 'tsx');
  assert.equal(pattern.code, '<TextInput required />');
  assert.deepEqual(pattern.components, ['TextInput']);
});

test('parsePatternFile: tags as a bracketed list', () => {
  const text = `---
title: X
tags: [form, validation, error]
---

Body.

\`\`\`tsx
<Button />
\`\`\`
`;
  const pattern = parsePatternFile('x', text, REACT_CTX);
  assert.deepEqual(pattern.tags, ['form', 'validation', 'error']);
});

// ---------------------------------------------------------------------------
// parsePatternFile: fallbacks with no front matter
// ---------------------------------------------------------------------------

test('parsePatternFile: no front matter falls back to first H1, first paragraph, first fence', () => {
  const text = `# Confirm actions

A primary and secondary action side by side.

Some more prose that is not part of the first paragraph anymore.

\`\`\`tsx
<Stack direction="row">
  <Button>Confirm</Button>
  <Button>Cancel</Button>
</Stack>
\`\`\`
`;
  const pattern = parsePatternFile('confirm-actions', text, REACT_CTX);
  assert.equal(pattern.title, 'Confirm actions');
  assert.equal(pattern.description, 'A primary and secondary action side by side.');
  assert.equal(pattern.language, 'tsx');
  assert.match(pattern.code, /<Stack direction="row">/);
  assert.deepEqual(pattern.components.sort(), ['Button', 'Stack']);
});

test('parsePatternFile: id is the fallback title when there is no front matter and no H1', () => {
  const text = 'Just a paragraph, no heading.\n\n```tsx\n<Button />\n```\n';
  const pattern = parsePatternFile('no-heading', text, REACT_CTX);
  assert.equal(pattern.title, 'no-heading');
  assert.equal(pattern.description, 'Just a paragraph, no heading.');
});

test('parsePatternFile: default language is tsx for react and html for custom-elements when unset', () => {
  const text = '# Title\n\nDescription.\n\n```\n<Button />\n```\n';
  const reactPattern = parsePatternFile('x', text, REACT_CTX);
  assert.equal(reactPattern.language, 'tsx');

  const ceText = '# Title\n\nDescription.\n\n```\n<acme-button></acme-button>\n```\n';
  const cePattern = parsePatternFile('x', ceText, CE_CTX);
  assert.equal(cePattern.language, 'html');
});

test('parsePatternFile: no fenced code block leaves code empty and components empty', () => {
  const text = '# Title\n\nJust prose, no code.\n';
  const pattern = parsePatternFile('x', text, REACT_CTX);
  assert.equal(pattern.code, '');
  assert.deepEqual(pattern.components, []);
});

// ---------------------------------------------------------------------------
// parsePatternFile: component detection for both models
// ---------------------------------------------------------------------------

test('parsePatternFile: detects react components as JSX tags, ignoring ones not used', () => {
  const text = '```tsx\n<Stack><Button>Go</Button></Stack>\n```\n';
  const pattern = parsePatternFile('x', text, REACT_CTX);
  assert.deepEqual(pattern.components.sort(), ['Button', 'Stack']);
});

test('parsePatternFile: detects custom-elements as dashed tags, open or close', () => {
  const text = '```html\n<acme-stack>\n  <acme-button variant="primary">Go</acme-button>\n</acme-stack>\n```\n';
  const pattern = parsePatternFile('x', text, CE_CTX);
  assert.deepEqual(pattern.components.sort(), ['acme-button', 'acme-stack']);
});

test('parsePatternFile: does not false-positive on a component name that is a prefix of another tag', () => {
  const ctx: PatternParseContext = { componentModel: 'custom-elements', exportNames: ['acme-button'], tagNames: ['acme-button'] };
  const text = '```html\n<acme-button-group></acme-button-group>\n```\n';
  const pattern = parsePatternFile('x', text, ctx);
  assert.deepEqual(pattern.components, []);
});

// ---------------------------------------------------------------------------
// loadSystemData: picks up patterns from <dataDir>/patterns
// ---------------------------------------------------------------------------

const MINIMAL_CATALOG: SystemCatalog = {
  system: 'acme',
  generatedAt: '2026-01-01T00:00:00.000Z',
  source: { root: '/virtual', adapter: 'catalog-json' },
  components: [{ dir: 'src/Button', exports: [{ displayName: 'Button', description: 'A button.', props: [] }] }],
  allExports: ['Button'],
  allPropsByExport: { Button: [] },
};

test('loadSystemData: patterns is undefined when the patterns directory does not exist', () => {
  const dir = makeTempDir();
  try {
    const dataDir = join(dir, 'data', 'acme');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'catalog.json'), JSON.stringify(MINIMAL_CATALOG));
    const cfg: SystemConfig = { catalog: { adapter: 'catalog-json', path: 'catalog.json' }, dataDir: 'data/acme' };
    const data = loadSystemData('acme', cfg, dir);
    assert.equal(data.patterns, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSystemData: reads every *.md file under <dataDir>/patterns, sorted by filename', () => {
  const dir = makeTempDir();
  try {
    const dataDir = join(dir, 'data', 'acme');
    const patternsDir = join(dataDir, 'patterns');
    mkdirSync(patternsDir, { recursive: true });
    writeFileSync(join(dataDir, 'catalog.json'), JSON.stringify(MINIMAL_CATALOG));
    writeFileSync(
      join(patternsDir, 'labeled-field.md'),
      '---\ntitle: Labeled field\ntags: form\n---\n\n```tsx\n<Button>Go</Button>\n```\n'
    );
    writeFileSync(join(patternsDir, 'notes.txt'), 'not a pattern file, should be ignored');

    const cfg: SystemConfig = { catalog: { adapter: 'catalog-json', path: 'catalog.json' }, dataDir: 'data/acme' };
    const data = loadSystemData('acme', cfg, dir);
    assert.ok(data.patterns);
    assert.equal(data.patterns?.length, 1);
    assert.equal(data.patterns?.[0]?.id, 'labeled-field');
    assert.equal(data.patterns?.[0]?.title, 'Labeled field');
    assert.deepEqual(data.patterns?.[0]?.components, ['Button']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSystemData: an empty patterns directory yields an empty array, not undefined', () => {
  const dir = makeTempDir();
  try {
    const dataDir = join(dir, 'data', 'acme');
    mkdirSync(join(dataDir, 'patterns'), { recursive: true });
    writeFileSync(join(dataDir, 'catalog.json'), JSON.stringify(MINIMAL_CATALOG));
    const cfg: SystemConfig = { catalog: { adapter: 'catalog-json', path: 'catalog.json' }, dataDir: 'data/acme' };
    const data = loadSystemData('acme', cfg, dir);
    assert.deepEqual(data.patterns, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

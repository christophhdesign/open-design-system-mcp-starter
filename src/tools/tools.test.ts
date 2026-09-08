import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { makeRegistry, makeSystemData } from '../test-helpers.ts';
import { DEFAULT_TEXT_BUDGET } from './index.ts';
import { run as runCheckUsage } from './check-usage.ts';
import { run as runFindToken } from './find-token.ts';
import { run as runGetComponent } from './get-component.ts';
import { run as runGetGuidance } from './get-guidance.ts';
import { run as runGetMigration } from './get-migration.ts';
import { run as runGetPattern } from './get-pattern.ts';
import { run as runListTokens } from './list-tokens.ts';
import { run as runResolveComponent } from './resolve-component.ts';
import { run as runSearchComponents } from './search-components.ts';

test('search_components: text stays within budget and structured shape is typed', () => {
  const registry = makeRegistry(makeSystemData());
  const result = runSearchComponents(registry, { query: 'Card' });
  assert.ok(result.text.length <= DEFAULT_TEXT_BUDGET);
  assert.equal(result.structured.system, 'acme');
  assert.ok(Array.isArray(result.structured.hits));
  assert.ok(!result.isError);
});

test('search_components: unknown system is an error naming known systems', () => {
  const registry = makeRegistry(makeSystemData());
  const result = runSearchComponents(registry, { system: 'nope', query: 'Card' });
  assert.equal(result.isError, true);
  assert.match(result.text, /acme/);
});

test('get_component: react usage line', () => {
  const registry = makeRegistry(makeSystemData());
  const result = runGetComponent(registry, { name: 'Button' });
  assert.ok(!result.isError);
  assert.ok('component' in result.structured);
  if ('component' in result.structured) {
    assert.match(result.structured.component.usage, /^import \{ Button \} from '@acme\/react'$/);
  }
});

test('get_component: custom-elements usage line', () => {
  const registry = makeRegistry(makeSystemData({ model: 'custom-elements' }));
  const result = runGetComponent(registry, { name: 'acme-button' });
  assert.ok(!result.isError);
  if ('component' in result.structured) {
    assert.match(result.structured.component.usage, /^<acme-button>\.\.\.<\/acme-button>/);
  }
});

test('get_component: brief detail is shorter than full', () => {
  const registry = makeRegistry(makeSystemData());
  const brief = runGetComponent(registry, { name: 'Surface', detail: 'brief' });
  const full = runGetComponent(registry, { name: 'Surface', detail: 'full' });
  assert.ok(brief.text.length <= full.text.length);
});

test('get_component: unknown component is an error with nearest names, never fabricated', () => {
  const registry = makeRegistry(makeSystemData());
  const result = runGetComponent(registry, { name: 'Card' });
  assert.equal(result.isError, true);
  assert.ok('nearest' in result.structured);
  if ('nearest' in result.structured) {
    for (const hit of result.structured.nearest) {
      assert.ok(registry.get('acme').catalog.allExports.includes(hit.name));
    }
  }
});

test('get_component: unknown system is an error', () => {
  const registry = makeRegistry(makeSystemData());
  const result = runGetComponent(registry, { system: 'nope', name: 'Button' });
  assert.equal(result.isError, true);
});

test('resolve_component: exact, alias and missing are not tool errors (missing is a legitimate answer)', () => {
  const registry = makeRegistry(makeSystemData());
  const exact = runResolveComponent(registry, { name: 'Button' });
  assert.ok(!exact.isError);
  assert.equal(exact.structured.status, 'exact');

  const alias = runResolveComponent(registry, { name: 'Card' });
  assert.ok(!alias.isError);
  assert.equal(alias.structured.status, 'alias');

  const missing = runResolveComponent(registry, { name: 'Zzz' });
  assert.ok(!missing.isError);
  assert.equal(missing.structured.status, 'missing');
});

test('resolve_component: unknown system is a tool error', () => {
  const registry = makeRegistry(makeSystemData());
  const result = runResolveComponent(registry, { system: 'nope', name: 'Button' });
  assert.equal(result.isError, true);
});

test('find_token: structured hits and write field', () => {
  const registry = makeRegistry(makeSystemData());
  const result = runFindToken(registry, { query: '8px', category: 'space' });
  assert.ok(!result.isError);
  assert.ok(result.structured.hits.length > 0);
  assert.equal(result.structured.hits[0]!.write, 'var(--acme-space-2)');
});

test('find_token: unknown system is an error', () => {
  const registry = makeRegistry(makeSystemData());
  const result = runFindToken(registry, { system: 'nope', query: '8px' });
  assert.equal(result.isError, true);
});

test('get_guidance: topic matching a heading returns the relevant chunk', () => {
  const registry = makeRegistry(makeSystemData());
  const result = runGetGuidance(registry, { topic: 'accessibility' });
  assert.ok(!result.isError);
  assert.ok(result.structured.chunks.length > 0);
  assert.match(result.text, /Accessibility/);
});

test('get_guidance: component filter narrows to chunks mentioning it', () => {
  const registry = makeRegistry(makeSystemData());
  const result = runGetGuidance(registry, { topic: 'use', component: 'Surface' });
  assert.ok(!result.isError);
  for (const chunk of result.structured.chunks) {
    assert.ok(chunk.mentions.includes('Surface'));
  }
});

test('get_guidance: no docs index returns a note, not an error', () => {
  const registry = makeRegistry(makeSystemData({ docs: undefined }));
  const result = runGetGuidance(registry, { topic: 'anything' });
  assert.ok(!result.isError);
  assert.equal(result.structured.chunks.length, 0);
  assert.match(result.text, /No docs are indexed/);
  assert.match(result.text, /"include"/);
});

test('get_guidance: unknown system is an error', () => {
  const registry = makeRegistry(makeSystemData());
  const result = runGetGuidance(registry, { system: 'nope', topic: 'accessibility' });
  assert.equal(result.isError, true);
});

test('list_tokens: category filter and table text', () => {
  const registry = makeRegistry(makeSystemData());
  const result = runListTokens(registry, { category: 'color' });
  assert.ok(!result.isError);
  assert.equal(result.structured.count, result.structured.tokens.length);
  assert.ok(result.structured.tokens.every((t) => t.category === 'color'));
  assert.match(result.text, /\| token \| write \| value \| themes \|/);
});

test('list_tokens: query filters by name segment', () => {
  const registry = makeRegistry(makeSystemData());
  const result = runListTokens(registry, { query: 'muted' });
  assert.ok(!result.isError);
  assert.ok(result.structured.tokens.length > 0);
  assert.ok(result.structured.tokens.every((t) => t.name.includes('muted')));
});

test('list_tokens: unknown system is an error', () => {
  const registry = makeRegistry(makeSystemData());
  const result = runListTokens(registry, { system: 'nope' });
  assert.equal(result.isError, true);
});

test('tool run() resolves the sole configured system when none is passed', () => {
  const registry = makeRegistry(makeSystemData({ id: 'only-one' }));
  const result = runSearchComponents(registry, { query: 'Button' });
  assert.equal(result.structured.system, 'only-one');
});

test('check_usage: summary line reports counts and used components', () => {
  const registry = makeRegistry(makeSystemData());
  const result = runCheckUsage(registry, { code: "import { Button } from '@acme/react';\nconst X = () => <Button kind=\"brand\">Save</Button>;" });
  assert.ok(!result.isError);
  assert.match(result.text, /^\d+ errors?, \d+ warnings?\. Components used: Button\./);
  assert.match(result.text, /- \[warning\] line 2: Invented prop 'kind' on Button \(fix: use 'tone' instead\)/);
  assert.ok(result.text.length <= DEFAULT_TEXT_BUDGET);
});

test('check_usage: no components used renders a bold pointer to search_components', () => {
  const registry = makeRegistry(makeSystemData());
  const result = runCheckUsage(registry, { code: '<div className="foo">Hi</div>' });
  assert.ok(!result.isError);
  assert.ok('usedComponents' in result.structured);
  if ('usedComponents' in result.structured) {
    assert.equal(result.structured.usedComponents.length, 0);
  }
  assert.match(result.text, /\*\*No design-system components were used in this snippet\.\*\*/);
  assert.match(result.text, /search_components/);
});

test('check_usage: unknown system is an error', () => {
  const registry = makeRegistry(makeSystemData());
  const result = runCheckUsage(registry, { system: 'nope', code: '<div/>' });
  assert.equal(result.isError, true);
});

// ---------------------------------------------------------------------------
// get_pattern
// ---------------------------------------------------------------------------

test('get_pattern: a matching query returns a hit with title, code fence and uses line', () => {
  const registry = makeRegistry(makeSystemData());
  const result = runGetPattern(registry, { query: 'labeled field with error' });
  assert.ok(!result.isError);
  assert.ok(result.structured.hits.length > 0);
  assert.match(result.text, /### /);
  assert.match(result.text, /```/);
  assert.match(result.text, /uses:/);
});

test('get_pattern: no patterns authored yet is a plain note, not an error, naming the patterns directory and format', () => {
  const registry = makeRegistry(makeSystemData({ patterns: undefined }));
  const result = runGetPattern(registry, { query: 'anything' });
  assert.ok(!result.isError);
  assert.deepEqual(result.structured.hits, []);
  assert.match(result.text, /No patterns are authored yet/);
  assert.match(result.text, /data\/acme\/patterns\//);
  assert.match(result.text, /search_components/);
});

test('get_pattern: patterns exist but nothing matches the query is a plain note, not an error', () => {
  const registry = makeRegistry(makeSystemData());
  const result = runGetPattern(registry, { query: 'xyzzy quux nonsense' });
  assert.ok(!result.isError);
  assert.deepEqual(result.structured.hits, []);
  assert.match(result.text, /No patterns in/);
});

test('get_pattern: unknown system is an error', () => {
  const registry = makeRegistry(makeSystemData());
  const result = runGetPattern(registry, { system: 'nope', query: 'labeled field' });
  assert.equal(result.isError, true);
});

// ---------------------------------------------------------------------------
// get_migration
// ---------------------------------------------------------------------------

test('get_migration: prop-level deprecation from the catalog', () => {
  const registry = makeRegistry(makeSystemData());
  const result = runGetMigration(registry, { name: 'Badge.color' });
  assert.ok(!result.isError);
  assert.ok(result.structured.deprecated);
  assert.match(result.structured.deprecated?.note ?? '', /tone/);
  assert.match(result.text, /deprecated/);
});

test('get_migration: CHANGELOG mentions from a temp root, with heading and line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-mcp-migration-test-'));
  try {
    writeFileSync(
      join(dir, 'CHANGELOG.md'),
      [
        '# Changelog',
        '',
        '## 2.0.0',
        '',
        "- Button's `iconOnly` prop replaces the old icon-only pattern.",
        '',
        '## 1.0.0',
        '',
        '- Initial release.',
        '',
      ].join('\n')
    );
    mkdirSync(join(dir, 'codemods'), { recursive: true });
    writeFileSync(join(dir, 'codemods', 'button-icon-only.js'), '// codemod stub');

    const registry = makeRegistry(makeSystemData({ root: dir }));
    const result = runGetMigration(registry, { name: 'Button' });
    assert.ok(!result.isError);
    assert.ok(result.structured.changelog.length > 0);
    const mention = result.structured.changelog.find((m) => m.text.includes('iconOnly'));
    assert.ok(mention);
    assert.equal(mention?.heading, '2.0.0');
    assert.equal(typeof mention?.line, 'number');
    assert.ok(result.structured.codemods.some((c) => c.includes('button-icon-only.js')));
    assert.match(result.text, /iconOnly/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('get_migration: nothing deprecated and nothing mentioned is said plainly, not an error', () => {
  const registry = makeRegistry(makeSystemData());
  const result = runGetMigration(registry, { name: 'Stack' });
  assert.ok(!result.isError);
  assert.equal(result.structured.deprecated, null);
  assert.deepEqual(result.structured.changelog, []);
  assert.deepEqual(result.structured.codemods, []);
  assert.match(result.text, /Nothing found/);
});

test('get_migration: unknown system is an error', () => {
  const registry = makeRegistry(makeSystemData());
  const result = runGetMigration(registry, { system: 'nope', name: 'Button' });
  assert.equal(result.isError, true);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeSystemData } from '../test-helpers.ts';
import { listTokens, searchDocs } from './index.ts';

// ---------------------------------------------------------------------------
// searchDocs
// ---------------------------------------------------------------------------

test('searchDocs: returns [] when the system has no docs index', () => {
  const data = makeSystemData({ docs: undefined });
  const hits = searchDocs(data, 'accessibility');
  assert.deepEqual(hits, []);
});

test('searchDocs: heading word match ranks a chunk whose heading contains the query word', () => {
  const data = makeSystemData();
  const hits = searchDocs(data, 'accessibility');
  assert.ok(hits.length > 0);
  assert.equal(hits[0]!.heading, 'Accessibility');
  assert.ok(hits[0]!.matchedOn.includes('heading'));
});

test('searchDocs: component filter scores chunks that mention it higher, even off-topic query words', () => {
  const data = makeSystemData();
  const hits = searchDocs(data, 'anything unrelated words here', { component: 'Surface' });
  assert.ok(hits.length > 0);
  const top = hits[0]!;
  assert.ok(top.mentions.includes('Surface'));
  assert.ok(top.matchedOn.some((m) => m.startsWith('component:')));
});

test('searchDocs: trail word match scores a chunk whose ancestry (not heading) contains the word', () => {
  const data = makeSystemData();
  // "Button" is in the trail (['Button', 'Accessibility']) of the accessibility chunk but not
  // its own heading text.
  const hits = searchDocs(data, 'button');
  assert.ok(hits.length > 0);
  const heading = hits.find((h) => h.heading === 'Accessibility');
  assert.ok(heading);
  assert.ok(heading!.matchedOn.includes('trail'));
});

test('searchDocs: body word overlap matches on text content alone', () => {
  const data = makeSystemData();
  const hits = searchDocs(data, 'aria-label');
  assert.ok(hits.length > 0);
  assert.ok(hits.some((h) => h.matchedOn.includes('body')));
});

test('searchDocs: default limit is 5, and a limit option is respected', () => {
  const data = makeSystemData();
  const hits = searchDocs(data, 'a', { limit: 1 });
  assert.ok(hits.length <= 1);
});

// ---------------------------------------------------------------------------
// listTokens
// ---------------------------------------------------------------------------

test('listTokens: returns [] when the system has no tokens', () => {
  const data = makeSystemData({ tokens: undefined });
  assert.deepEqual(listTokens(data), []);
});

test('listTokens: category filter restricts to that category', () => {
  const data = makeSystemData();
  const hits = listTokens(data, { category: 'space' });
  assert.ok(hits.length > 0);
  assert.ok(hits.every((t) => t.category === 'space'));
});

test('listTokens: query filters by name segment and description word', () => {
  const data = makeSystemData();
  const byName = listTokens(data, { query: 'muted' });
  assert.ok(byName.length > 0);
  assert.ok(byName.every((t) => t.name.includes('muted')));

  const byDescription = listTokens(data, { query: 'secondary' });
  assert.ok(byDescription.some((t) => t.name === 'color.text.muted'));
});

test('listTokens: sorted by name with numeric-aware ordering (space-2 before space-10)', () => {
  const data = makeSystemData({
    tokens: {
      system: 'acme',
      generatedAt: '2026-08-25T00:00:00.000Z',
      source: { root: '/virtual/acme', files: ['tokens.css'], adapter: 'css-vars' },
      tokens: [
        { name: 'space-10', cssVar: '--acme-space-10', value: '40px', category: 'space' },
        { name: 'space-2', cssVar: '--acme-space-2', value: '8px', category: 'space' },
        { name: 'space-1', cssVar: '--acme-space-1', value: '4px', category: 'space' },
      ],
      cssVars: ['--acme-space-10', '--acme-space-2', '--acme-space-1'],
    },
  });
  const hits = listTokens(data, { category: 'space' });
  assert.deepEqual(hits.map((t) => t.name), ['space-1', 'space-2', 'space-10']);
});

test('listTokens: default limit is 40, and a limit option is respected', () => {
  const data = makeSystemData({
    tokens: {
      system: 'acme',
      generatedAt: '2026-08-25T00:00:00.000Z',
      source: { root: '/virtual/acme', files: ['tokens.css'], adapter: 'css-vars' },
      tokens: Array.from({ length: 50 }, (_, i) => ({
        name: `space-${i}`,
        cssVar: `--acme-space-${i}`,
        value: `${i}px`,
        category: 'space' as const,
      })),
      cssVars: [],
    },
  });
  assert.equal(listTokens(data).length, 40);
  assert.equal(listTokens(data, { limit: 5 }).length, 5);
});

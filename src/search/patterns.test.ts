import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeSystemData } from '../test-helpers.ts';
import type { Pattern } from '../types.ts';
import { searchPatterns } from './index.ts';

function makePatterns(): Pattern[] {
  return [
    {
      id: 'labeled-field',
      title: 'Labeled field with error',
      description: 'A text input with a label and an inline validation error.',
      code: '<TextInput required />',
      language: 'tsx',
      components: ['TextInput'],
      tags: ['form', 'validation'],
    },
    {
      id: 'confirm-actions',
      title: 'Confirm dialog actions',
      description: 'A primary and secondary action laid out side by side.',
      code: '<Stack direction="row"><Button>Confirm</Button><Button>Cancel</Button></Stack>',
      language: 'tsx',
      components: ['Stack', 'Button'],
      tags: ['dialog', 'actions'],
    },
    {
      id: 'empty-state',
      title: 'Empty state placeholder',
      description: 'A centered message shown when a list has nothing to display yet.',
      code: '<Surface><Stack align="center">Nothing here yet.</Stack></Surface>',
      language: 'tsx',
      components: ['Surface', 'Stack'],
      tags: ['empty', 'placeholder'],
    },
  ];
}

test('searchPatterns: returns [] when the system has no patterns', () => {
  const data = makeSystemData({ patterns: undefined });
  const hits = searchPatterns(data, 'labeled field');
  assert.deepEqual(hits, []);
});

test('searchPatterns: returns [] for an empty patterns array', () => {
  const data = makeSystemData({ patterns: [] });
  const hits = searchPatterns(data, 'labeled field');
  assert.deepEqual(hits, []);
});

test('searchPatterns: title word match ranks a pattern whose title contains the query words highest', () => {
  const data = makeSystemData({ patterns: makePatterns() });
  const hits = searchPatterns(data, 'labeled field with error');
  assert.ok(hits.length > 0);
  assert.equal(hits[0]!.id, 'labeled-field');
  assert.ok(hits[0]!.matchedOn.includes('title'));
});

test('searchPatterns: tag match finds a pattern whose title does not mention the query word', () => {
  const data = makeSystemData({ patterns: makePatterns() });
  const hits = searchPatterns(data, 'validation');
  assert.ok(hits.some((h) => h.id === 'labeled-field'));
  const hit = hits.find((h) => h.id === 'labeled-field')!;
  assert.ok(hit.matchedOn.some((m) => m.startsWith('tag:')));
});

test('searchPatterns: component name match finds a pattern by a component it uses', () => {
  const data = makeSystemData({ patterns: makePatterns() });
  const hits = searchPatterns(data, 'button');
  assert.ok(hits.some((h) => h.id === 'confirm-actions'));
  const hit = hits.find((h) => h.id === 'confirm-actions')!;
  assert.ok(hit.matchedOn.some((m) => m.startsWith('component:')));
});

test('searchPatterns: description overlap matches on body text alone', () => {
  const data = makeSystemData({ patterns: makePatterns() });
  const hits = searchPatterns(data, 'centered message nothing to display');
  assert.ok(hits.some((h) => h.id === 'empty-state'));
});

test('searchPatterns: unrelated query matches nothing', () => {
  const data = makeSystemData({ patterns: makePatterns() });
  const hits = searchPatterns(data, 'xyzzy quux');
  assert.deepEqual(hits, []);
});

test('searchPatterns: default limit is 5, and a limit option is respected', () => {
  const many: Pattern[] = Array.from({ length: 8 }, (_, i) => ({
    id: `pattern-${i}`,
    title: 'Confirm dialog actions',
    description: 'A primary and secondary action.',
    code: '<Stack />',
    language: 'tsx',
    components: [],
    tags: [],
  }));
  const data = makeSystemData({ patterns: many });
  assert.equal(searchPatterns(data, 'confirm dialog actions').length, 5);
  assert.equal(searchPatterns(data, 'confirm dialog actions', { limit: 2 }).length, 2);
});

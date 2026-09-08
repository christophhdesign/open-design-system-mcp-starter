import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeSystemData } from '../test-helpers.ts';
import { findTokens, getComponentDetail, resolveComponent, searchComponents } from './index.ts';

test('resolveComponent: exact match (react)', () => {
  const data = makeSystemData();
  const result = resolveComponent(data, 'Button');
  assert.equal(result.status, 'exact');
  if (result.status === 'exact') {
    assert.equal(result.component.name, 'Button');
    assert.match(result.component.usage, /import \{ Button \} from '@acme\/react'/);
  }
});

test('resolveComponent: exact match, custom-elements usage line', () => {
  const data = makeSystemData({ model: 'custom-elements' });
  const result = resolveComponent(data, 'acme-button');
  assert.equal(result.status, 'exact');
  if (result.status === 'exact') {
    assert.match(result.component.usage, /<acme-button>\.\.\.<\/acme-button>/);
    assert.match(result.component.usage, /registered by importing '@acme\/elements' once/);
  }
});

test('resolveComponent: case-insensitive match notes the real spelling', () => {
  const data = makeSystemData();
  const result = resolveComponent(data, 'button');
  assert.equal(result.status, 'exact');
  if (result.status === 'exact') {
    assert.match(result.component.description, /matched case-insensitively/);
    assert.match(result.component.description, /"Button"/);
  }
});

test('resolveComponent: team alias resolves to the real target', () => {
  const data = makeSystemData();
  const result = resolveComponent(data, 'Card');
  assert.equal(result.status, 'alias');
  if (result.status === 'alias') {
    assert.equal(result.alias, 'Card');
    assert.equal(result.target.name, 'Surface');
    assert.equal(result.concept, 'surface container');
    assert.match(result.note ?? '', /Surface/);
  }
});

test('resolveComponent: missing name returns nearest candidates and a message', () => {
  const data = makeSystemData({ model: 'custom-elements' });
  const result = resolveComponent(data, 'Typography');
  assert.equal(result.status, 'missing');
  if (result.status === 'missing') {
    assert.equal(result.query, 'Typography');
    assert.ok(result.nearest.length > 0);
    assert.match(result.message, /not a component in/);
    assert.match(result.message, /Nearest:/);
    // 'Typography' is a lexicon-only alias (no team target) -> concept surfaces.
    assert.equal(result.concept, 'text display');
  }
});

test('resolveComponent: fully unknown name is missing with no fabricated entry', () => {
  const data = makeSystemData();
  const result = resolveComponent(data, 'ZzzNotReal');
  assert.equal(result.status, 'missing');
  if (result.status === 'missing') {
    for (const hit of result.nearest) {
      assert.ok(data.catalog.allExports.includes(hit.name));
    }
  }
});

test('searchComponents: concept search maps a lexicon alias to a description match', () => {
  const data = makeSystemData();
  const hits = searchComponents(data, 'Card');
  // Team alias "Card" -> Surface should be the top hit via alias:Card.
  assert.ok(hits.length > 0);
  assert.equal(hits[0]!.name, 'Surface');
  assert.ok(hits[0]!.matchedOn.some((m) => m === 'alias:Card'));
});

test('searchComponents: prop-name match finds the owning component', () => {
  const data = makeSystemData();
  const hits = searchComponents(data, 'gap');
  const stackHit = hits.find((h) => h.name === 'Stack');
  assert.ok(stackHit);
  assert.ok(stackHit!.matchedOn.includes('prop:gap'));
});

test('searchComponents: description word overlap and docs mentions', () => {
  const data = makeSystemData();
  const hits = searchComponents(data, 'accessible name icon');
  const buttonHit = hits.find((h) => h.name === 'Button');
  assert.ok(buttonHit);
  assert.ok(buttonHit!.matchedOn.includes('docs') || buttonHit!.matchedOn.includes('description'));
});

test('searchComponents: respects limit', () => {
  const data = makeSystemData();
  const hits = searchComponents(data, 'a e o', { limit: 2 });
  assert.ok(hits.length <= 2);
});

test('getComponentDetail: full shape for an existing component', () => {
  const data = makeSystemData();
  const detail = getComponentDetail(data, 'TextInput');
  assert.ok(detail);
  assert.equal(detail!.a11y?.accessibleName, 'required');
  assert.deepEqual(
    detail!.props.map((p) => p.name),
    ['value', 'placeholder', 'disabled', 'required'],
  );
  assert.deepEqual(detail!.examples, []);
});

test('getComponentDetail: commonMistakes surfaces team prop aliases with lexicon evidence', () => {
  const data = makeSystemData();
  const detail = getComponentDetail(data, 'Button');
  assert.ok(detail);
  const mistake = detail!.commonMistakes?.find((m) => m.wrote === 'kind');
  assert.ok(mistake);
  assert.equal(mistake!.use, 'tone');
  assert.match(mistake!.note ?? '', /invented 12x/);
});

test('getComponentDetail: commonMistakes for Stack maps spacing -> gap', () => {
  const data = makeSystemData();
  const detail = getComponentDetail(data, 'Stack');
  assert.ok(detail);
  const mistake = detail!.commonMistakes?.find((m) => m.wrote === 'spacing');
  assert.ok(mistake);
  assert.equal(mistake!.use, 'gap');
});

test('getComponentDetail: never invents a mistake without a team target', () => {
  const data = makeSystemData();
  const detail = getComponentDetail(data, 'Badge');
  // 'variant' is lexicon-only (no team target anywhere) -> must not appear.
  assert.ok(!detail!.commonMistakes?.some((m) => m.wrote === 'variant'));
});

test('getComponentDetail: unknown component returns undefined', () => {
  const data = makeSystemData();
  assert.equal(getComponentDetail(data, 'NopeNotHere'), undefined);
});

test('findTokens: color distance ranks the nearest color token first', () => {
  const data = makeSystemData();
  const hits = findTokens(data, '#5b6b7a');
  assert.ok(hits.length > 0);
  assert.equal(hits[0]!.token.name, 'color.text.muted');
  assert.match(hits[0]!.matchedOn[0]!, /^color-distance:/);
  assert.equal(hits[0]!.write, 'var(--acme-color-text-muted)');
});

test('findTokens: color distance resolves var() reference chains', () => {
  const data = makeSystemData();
  // color.text.default's default value is var(--acme-color-gray-900) which is #111318 exactly.
  const hits = findTokens(data, '#111318');
  assert.ok(hits.length > 0);
  const top = hits[0]!;
  assert.match(top.matchedOn[0]!, /^color-distance:0$/);
});

test('findTokens: bare number and px length match the space scale', () => {
  const data = makeSystemData();
  const hits = findTokens(data, '8px', { category: 'space' });
  assert.ok(hits.length > 0);
  assert.equal(hits[0]!.token.name, 'space.2');
  assert.equal(hits[0]!.matchedOn[0], 'value');
});

test('findTokens: rem length converts to px for matching', () => {
  const data = makeSystemData();
  const hits = findTokens(data, '1rem', { category: 'space' });
  assert.equal(hits[0]!.token.name, 'space.4');
});

test('findTokens: word match over name segments, description and category', () => {
  const data = makeSystemData();
  const hits = findTokens(data, 'muted');
  assert.ok(hits.some((h) => h.token.name === 'color.text.muted'));
  const hit = hits.find((h) => h.token.name === 'color.text.muted')!;
  assert.ok(hit.matchedOn.some((m) => m === 'name:muted'));
});

test('findTokens: category word matches tokens in that category', () => {
  const data = makeSystemData();
  const hits = findTokens(data, 'radius');
  assert.ok(hits.length > 0);
  assert.ok(hits.every((h) => h.token.category === 'radius'));
});

test('findTokens: unknown system without tokens returns empty', () => {
  const data = makeSystemData({ tokens: undefined });
  assert.deepEqual(findTokens(data, '#000000'), []);
});

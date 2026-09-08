import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from './server.ts';
import { makeRegistry, makeSystemData } from './test-helpers.ts';

function textOf(block: unknown): string {
  const text = (block as { text?: unknown } | undefined)?.text;
  assert.equal(typeof text, 'string');
  return text as string;
}

async function connected() {
  const registry = makeRegistry(makeSystemData({ model: 'custom-elements' }));
  const server = createServer(registry);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server, registry };
}

test('listTools returns exactly the nine tools', async () => {
  const { client } = await connected();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'check_usage',
    'find_token',
    'get_component',
    'get_guidance',
    'get_migration',
    'get_pattern',
    'list_tokens',
    'resolve_component',
    'search_components',
  ]);
});

test('callTool: search_components end to end', async () => {
  const { client } = await connected();
  const result = await client.callTool({ name: 'search_components', arguments: { query: 'Card' } });
  assert.ok(!result.isError);
  assert.ok(Array.isArray((result.structuredContent as { hits?: unknown[] })?.hits));
  const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text;
  assert.ok(typeof text === 'string' && text.length > 0);
});

test('callTool: get_component end to end (custom-elements usage)', async () => {
  const { client } = await connected();
  const result = await client.callTool({ name: 'get_component', arguments: { name: 'acme-button' } });
  assert.ok(!result.isError);
  const structured = result.structuredContent as { component?: { usage?: string } };
  assert.match(structured.component?.usage ?? '', /^<acme-button>/);
});

test('callTool: resolve_component end to end (alias)', async () => {
  const { client } = await connected();
  const result = await client.callTool({ name: 'resolve_component', arguments: { name: 'Card' } });
  assert.ok(!result.isError);
  const structured = result.structuredContent as { status?: string; target?: { name?: string } };
  assert.equal(structured.status, 'alias');
  assert.equal(structured.target?.name, 'acme-surface');
});

test('callTool: find_token end to end', async () => {
  const { client } = await connected();
  const result = await client.callTool({ name: 'find_token', arguments: { query: '#111318' } });
  assert.ok(!result.isError);
  const structured = result.structuredContent as { hits?: Array<{ write: string }> };
  assert.ok((structured.hits?.length ?? 0) > 0);
});

test('callTool: get_guidance end to end', async () => {
  const { client } = await connected();
  const result = await client.callTool({ name: 'get_guidance', arguments: { topic: 'accessible name' } });
  assert.ok(!result.isError);
  const structured = result.structuredContent as { chunks?: Array<{ heading?: string }> };
  assert.ok((structured.chunks?.length ?? 0) > 0);
});

test('callTool: list_tokens end to end', async () => {
  const { client } = await connected();
  const result = await client.callTool({ name: 'list_tokens', arguments: { category: 'space' } });
  assert.ok(!result.isError);
  const structured = result.structuredContent as { count?: number; tokens?: Array<{ category?: string }> };
  assert.ok((structured.count ?? 0) > 0);
  assert.ok((structured.tokens ?? []).every((t) => t.category === 'space'));
});

test('callTool: get_pattern end to end', async () => {
  const { client } = await connected();
  const result = await client.callTool({ name: 'get_pattern', arguments: { query: 'labeled field with error' } });
  assert.ok(!result.isError);
  const structured = result.structuredContent as { hits?: Array<{ title?: string }> };
  assert.ok((structured.hits?.length ?? 0) > 0);
});

test('callTool: get_migration end to end (prop-level deprecation)', async () => {
  const { client } = await connected();
  const result = await client.callTool({ name: 'get_migration', arguments: { name: 'acme-badge.color' } });
  assert.ok(!result.isError);
  const structured = result.structuredContent as { deprecated?: { note?: string } | null };
  assert.match(structured.deprecated?.note ?? '', /tone/);
});

test('callTool: check_usage end to end (unknown component)', async () => {
  const { client } = await connected();
  const result = await client.callTool({ name: 'check_usage', arguments: { code: '<acme-modal>Hi</acme-modal>', language: 'html' } });
  assert.ok(!result.isError);
  const structured = result.structuredContent as { findings?: Array<{ kind?: string }> };
  assert.ok((structured.findings ?? []).some((f) => f.kind === 'unknown-component'));
});

test('readResource: catalog, one component, and llms.txt', async () => {
  const { client } = await connected();

  const catalog = await client.readResource({ uri: 'ds://acme/catalog' });
  const catalogJson = JSON.parse(textOf(catalog.contents[0])) as Array<{ name: string }>;
  assert.ok(catalogJson.some((c) => c.name === 'acme-button'));

  const component = await client.readResource({ uri: 'ds://acme/components/acme-button' });
  const componentJson = JSON.parse(textOf(component.contents[0])) as { name: string; props: unknown[] };
  assert.equal(componentJson.name, 'acme-button');
  assert.ok(Array.isArray(componentJson.props));

  const llms = await client.readResource({ uri: 'ds://acme/llms.txt' });
  assert.equal(llms.contents[0]!.mimeType, 'text/plain');
  assert.match(textOf(llms.contents[0]), /acme-button/);
});

test('getPrompt: build-ui', async () => {
  const { client } = await connected();
  const result = await client.getPrompt({ name: 'build-ui', arguments: { task: 'Add a save button to the settings page.' } });
  assert.ok(result.messages.length > 0);
  const text = textOf(result.messages[0]!.content);
  assert.match(text, /search_components/);
  assert.match(text, /resolve_component/);
  assert.match(text, /get_component/);
  assert.match(text, /find_token/);
});

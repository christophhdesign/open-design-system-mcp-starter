// Shared helpers for the tool layer, plus the single registration entry
// point the server calls.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { SystemData, SystemRegistry } from '../types.ts';

import { register as registerCheckUsage } from './check-usage.ts';
import { register as registerFindToken } from './find-token.ts';
import { register as registerGetComponent } from './get-component.ts';
import { register as registerGetGuidance } from './get-guidance.ts';
import { register as registerGetMigration } from './get-migration.ts';
import { register as registerGetPattern } from './get-pattern.ts';
import { register as registerListTokens } from './list-tokens.ts';
import { register as registerResolveComponent } from './resolve-component.ts';
import { register as registerSearchComponents } from './search-components.ts';

/** Default character budget for a tool's text content. */
export const DEFAULT_TEXT_BUDGET = 4000;

/** Trims markdown to a character budget, closing cleanly instead of mid-word. */
export function truncate(text: string, budget = DEFAULT_TEXT_BUDGET): string {
  if (text.length <= budget) return text;
  const marker = '\n\n... (truncated)';
  const cut = Math.max(0, budget - marker.length);
  return `${text.slice(0, cut)}${marker}`;
}

/**
 * Resolves a system from the registry, or returns a helpful error instead of
 * throwing. `registry.get` is documented to throw a clear message (naming the
 * configured systems) when the id is unknown or ambiguous; we just capture it.
 */
export function resolveSystem(registry: SystemRegistry, id: string | undefined): { data: SystemData } | { error: string } {
  try {
    return { data: registry.get(id) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Registers every tool on the server. */
export function registerAllTools(server: McpServer, registry: SystemRegistry): void {
  registerSearchComponents(server, registry);
  registerGetComponent(server, registry);
  registerResolveComponent(server, registry);
  registerFindToken(server, registry);
  registerGetGuidance(server, registry);
  registerListTokens(server, registry);
  registerGetPattern(server, registry);
  registerGetMigration(server, registry);
  registerCheckUsage(server, registry);
}

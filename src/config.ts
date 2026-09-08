// Load and validate ds.config.json, and resolve the paths a system's config points at.
//
// This is the only place config shape is validated. Everything downstream (adapters, data
// loading, tools) trusts a DsConfig / SystemConfig it received from here.

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { DsConfig, SystemConfig, SystemId } from './types.ts';

export interface LoadedConfig {
  configPath: string;
  configDir: string;
  config: DsConfig;
}

// ---------------------------------------------------------------------------
// zod schema (validation only; src/types.ts stays the canonical shape)
// ---------------------------------------------------------------------------

const catalogSourceSchema = z.discriminatedUnion('adapter', [
  z.object({ adapter: z.literal('catalog-json'), path: z.string() }),
  z.object({ adapter: z.literal('custom-elements-manifest'), path: z.string() }),
  z.object({ adapter: z.literal('react-docgen'), src: z.string(), barrel: z.string().optional() }),
]);

const tokensSourceSchema = z.discriminatedUnion('adapter', [
  z.object({ adapter: z.literal('css-vars'), files: z.array(z.string()) }),
  z.object({ adapter: z.literal('dtcg'), files: z.array(z.string()) }),
]);

const systemConfigSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  root: z.string().optional(),
  rootEnv: z.string().optional(),
  dataDir: z.string().optional(),
  componentModel: z.enum(['react', 'custom-elements']).optional(),
  componentsPkg: z.string().optional(),
  foundationsPkg: z.string().optional(),
  catalog: catalogSourceSchema,
  tokens: tokensSourceSchema.optional(),
  docs: z
    .object({
      include: z.array(z.string()),
      exclude: z.array(z.string()).optional(),
    })
    .optional(),
  codeConnect: z.object({ include: z.array(z.string()).min(1), root: z.string().optional() }).optional(),
  aliases: z.string().optional(),
});

// `$schema` (and any other unrecognized top-level key) is stripped silently: z.object()
// drops unknown keys by default unless made strict.
const dsConfigSchema = z.object({
  systems: z.record(z.string(), systemConfigSchema),
});

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : '(root)';
      return `  - ${path}: ${issue.message}`;
    })
    .join('\n');
}

/**
 * Loads and validates ds.config.json (or the file at `configPath`). Throws with a clear,
 * actionable message on missing file, invalid JSON, or a shape that fails validation.
 */
export function loadDsConfig(configPath?: string): LoadedConfig {
  const resolvedPath = configPath
    ? resolve(process.cwd(), configPath)
    : resolve(process.cwd(), 'ds.config.json');

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, 'utf8');
  } catch (err) {
    throw new Error(
      `Could not read config file at ${resolvedPath}: ${(err as Error).message}\n` +
        `Pass --config <path> or create a ds.config.json at the repo root.`
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Config file ${resolvedPath} is not valid JSON: ${(err as Error).message}`);
  }

  const result = dsConfigSchema.safeParse(json);
  if (!result.success) {
    throw new Error(`Config file ${resolvedPath} is invalid:\n${formatZodError(result.error)}`);
  }

  const config = result.data as DsConfig;
  const ids = Object.keys(config.systems);
  if (ids.length === 0) {
    throw new Error(
      `Config file ${resolvedPath} declares no systems. Add at least one entry under "systems".`
    );
  }

  return { configPath: resolvedPath, configDir: dirname(resolvedPath), config };
}

/**
 * Resolves the checkout root for a system. `rootEnv` wins when the named env var is set
 * (non-empty); otherwise `root`, resolved against `configDir` when relative. Returns undefined
 * when neither is configured or resolvable.
 */
export function resolveRoot(cfg: SystemConfig, configDir: string): string | undefined {
  if (cfg.rootEnv) {
    const envValue = process.env[cfg.rootEnv];
    if (envValue) {
      return isAbsolute(envValue) ? envValue : resolve(configDir, envValue);
    }
  }
  if (!cfg.root) return undefined;
  return isAbsolute(cfg.root) ? cfg.root : resolve(configDir, cfg.root);
}

/**
 * Resolves the absolute data directory for a system: `cfg.dataDir` (relative to configDir) when
 * set, else `<configDir>/data/<id>`.
 */
export function resolveDataDir(id: SystemId, cfg: SystemConfig, configDir: string): string {
  const rel = cfg.dataDir ?? `data/${id}`;
  return isAbsolute(rel) ? rel : resolve(configDir, rel);
}

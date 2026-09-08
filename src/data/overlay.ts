// data/<id>/overlay.json: hand-written facts merged over the extracted catalog at load time, for
// exports the adapter could not document (factory-built or polymorphic components) or to add
// examples and guidance the source has no place to author. An overlay can only enrich a symbol
// that already exists in the catalog (allExports) -- it never invents one, so a typo in the
// overlay reports `unknown` instead of silently creating a fake export.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CatalogExport, CatalogOverlay, CatalogProp, SystemCatalog } from '../types.ts';
import { undocumentedValueExports } from './undocumented.ts';

type OverlayExportFields = Omit<CatalogOverlay['exports'][number], 'displayName' | '_note'>;

// ---------------------------------------------------------------------------
// Loading + validation
// ---------------------------------------------------------------------------

/**
 * Reads and validates `path` as a CatalogOverlay. Returns undefined when the file does not
 * exist. Throws a clear error when it exists but is not valid JSON or does not have the
 * overlay shape (an `exports` array of objects each carrying a string `displayName`).
 */
export function loadOverlay(path: string): CatalogOverlay | undefined {
  if (!existsSync(path)) return undefined;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Could not read overlay at ${path}: ${(err as Error).message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Overlay at ${path} is not valid JSON: ${(err as Error).message}`);
  }

  assertOverlayShape(json, path);
  return json;
}

function assertOverlayShape(value: unknown, path: string): asserts value is CatalogOverlay {
  if (!value || typeof value !== 'object') {
    throw new Error(`Overlay at ${path} is not a JSON object.`);
  }
  const exportsList = (value as Record<string, unknown>).exports;
  if (!Array.isArray(exportsList)) {
    throw new Error(`Overlay at ${path} is missing an "exports" array.`);
  }
  exportsList.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object' || typeof (entry as Record<string, unknown>).displayName !== 'string') {
      throw new Error(`Overlay at ${path}: exports[${i}] is missing a string "displayName".`);
    }
  });
}

// ---------------------------------------------------------------------------
// Applying: merge over an already-loaded catalog
// ---------------------------------------------------------------------------

export interface ApplyOverlayOptions {
  /** Overlay file path, stamped into catalog.source.overlay. */
  path: string;
  /** Hash of the overlay file's contents, stamped into catalog.source.overlay. */
  hash: string;
  /** custom-elements systems also get kebab/camel attribute spellings in allPropsByExport. */
  componentModel?: 'react' | 'custom-elements';
}

export interface ApplyOverlayResult {
  /** A new catalog object; the input catalog is never mutated. */
  catalog: SystemCatalog;
  /** displayNames the overlay successfully merged into. */
  touched: string[];
  /** displayNames the overlay named that are not in allExports (typos, or a name that was never real). */
  unknown: string[];
}

/** Merges `overlay` over `catalog`, per-export, and stamps `catalog.source.overlay`. */
export function applyOverlay(catalog: SystemCatalog, overlay: CatalogOverlay, opts: ApplyOverlayOptions): ApplyOverlayResult {
  const touched: string[] = [];
  const unknown: string[] = [];
  const allExportsSet = new Set(catalog.allExports);

  // Clone components/exports/props so nothing in the input catalog is mutated.
  const components = catalog.components.map((c) => ({
    dir: c.dir,
    exports: c.exports.map((e) => ({ ...e, props: e.props.map((p) => ({ ...p })) })),
  }));

  for (const entry of overlay.exports) {
    const { displayName, _note: _ignoredNote, ...fields } = entry;

    if (!allExportsSet.has(displayName)) {
      unknown.push(displayName);
      continue;
    }

    let target = findExport(components, displayName);
    if (!target) {
      target = {
        displayName,
        description: typeof fields.description === 'string' ? fields.description : '',
        props: [],
        // Nothing here came from docgen: the export is real (allExports confirms it) but the
        // whole CatalogExport was authored by the overlay, not extracted.
        docSource: 'overlay',
      };
      let overlayGroup = components.find((c) => c.dir === 'overlay');
      if (!overlayGroup) {
        overlayGroup = { dir: 'overlay', exports: [] };
        components.push(overlayGroup);
      }
      overlayGroup.exports.push(target);
    }

    mergeExportFields(target, fields);
    touched.push(displayName);
  }

  const allPropsByExport: Record<string, string[]> = { ...catalog.allPropsByExport };
  for (const name of touched) {
    const merged = findExport(components, name);
    if (!merged) continue;
    const names = [...merged.props.map((p) => p.name), ...(merged.inheritedProps ?? [])];
    allPropsByExport[name] = opts.componentModel === 'custom-elements' ? expandPropSpellings(names) : names;
  }

  const nextCatalog: SystemCatalog = {
    ...catalog,
    components,
    allPropsByExport,
    source: {
      ...catalog.source,
      overlay: { path: opts.path, hash: opts.hash, exports: touched.length },
    },
  };

  return { catalog: nextCatalog, touched, unknown };
}

function findExport(components: Array<{ dir: string; exports: CatalogExport[] }>, displayName: string): CatalogExport | undefined {
  for (const c of components) {
    const found = c.exports.find((e) => e.displayName === displayName);
    if (found) return found;
  }
  return undefined;
}

/** Merges one overlay entry's fields into `target` in place. Overlay wins on every field it sets. */
function mergeExportFields(target: CatalogExport, fields: OverlayExportFields): void {
  if (fields.description !== undefined) target.description = fields.description;
  if (fields.tagName !== undefined) target.tagName = fields.tagName;
  if (fields.inheritedProps !== undefined) target.inheritedProps = fields.inheritedProps;
  if (fields.events !== undefined) target.events = fields.events;
  if (fields.slots !== undefined) target.slots = fields.slots;
  if (fields.a11y !== undefined) target.a11y = fields.a11y;
  if (fields.guidance !== undefined) target.guidance = fields.guidance;
  if (fields.deprecated !== undefined) target.deprecated = fields.deprecated;
  if (fields.figma !== undefined) target.figma = fields.figma;

  if (fields.props) {
    const byName = new Map<string, CatalogProp>(target.props.map((p) => [p.name, p]));
    for (const p of fields.props) byName.set(p.name, p);
    target.props = Array.from(byName.values());
    // The props table now includes overlay-authored entries, whatever it was documented from before.
    target.docSource = 'overlay';
  }

  if (fields.examples) {
    const existing = target.examples ?? [];
    const seen = new Set(existing.map((e) => e.code));
    const merged = existing.slice();
    for (const ex of fields.examples) {
      if (seen.has(ex.code)) continue;
      seen.add(ex.code);
      merged.push(ex);
    }
    target.examples = merged;
  }

  if (fields.docs) {
    const existing = target.docs ?? [];
    const seen = new Set(existing);
    const merged = existing.slice();
    for (const d of fields.docs) {
      if (seen.has(d)) continue;
      seen.add(d);
      merged.push(d);
    }
    target.docs = merged;
  }
}

// ---------------------------------------------------------------------------
// Attribute spellings (mirrors src/adapters/custom-elements-manifest.ts)
// ---------------------------------------------------------------------------

function kebabToCamel(name: string): string {
  return name.replace(/-([a-z0-9])/gi, (_, c: string) => c.toUpperCase());
}

function camelToKebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function expandPropSpellings(names: string[]): string[] {
  const set = new Set<string>();
  for (const name of names) {
    set.add(name);
    set.add(kebabToCamel(name));
    set.add(camelToKebab(name));
  }
  return Array.from(set).sort();
}

// ---------------------------------------------------------------------------
// Scaffolding: a starting overlay.json for a team to fill in
// ---------------------------------------------------------------------------

/** One empty overlay entry per undocumented export, each with a `_note` telling a human what to do. */
export function scaffoldOverlay(catalog: SystemCatalog): CatalogOverlay {
  const names = undocumentedValueExports(catalog);
  return {
    exports: names.map((name) => ({
      displayName: name,
      props: [],
      description: '',
      _note: `Read the declaration file for ${name} and fill props (name, type, required, defaultValue, description). Delete this note when done.`,
    })),
  };
}

/**
 * Writes `<dataDir>/overlay.json` from `scaffoldOverlay(catalog)`. When the file already exists
 * and `force` is not set, existing entries are left untouched (a team's edits survive) and only
 * names not already present are appended; `entries` reports how many were added.
 */
export function writeOverlayScaffold(dataDir: string, catalog: SystemCatalog, opts?: { force?: boolean }): { path: string; written: boolean; entries: number } {
  const path = join(dataDir, 'overlay.json');
  const scaffold = scaffoldOverlay(catalog);

  if (existsSync(path) && !opts?.force) {
    const existing = loadOverlay(path);
    const existingNames = new Set((existing?.exports ?? []).map((e) => e.displayName));
    const toAdd = scaffold.exports.filter((e) => !existingNames.has(e.displayName));
    if (toAdd.length === 0) {
      return { path, written: false, entries: 0 };
    }
    const merged: CatalogOverlay = { exports: [...(existing?.exports ?? []), ...toAdd] };
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    return { path, written: true, entries: toAdd.length };
  }

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(scaffold, null, 2)}\n`, 'utf8');
  return { path, written: true, entries: scaffold.exports.length };
}

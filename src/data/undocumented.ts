// Real catalog exports the extraction adapter could not document: a PascalCase symbol that
// resolved to an empty allPropsByExport entry and has no CatalogExport of its own (a
// factory-built or polymorphic component the docgen adapter's per-file walk never turns into a
// documented component). Shared by the overlay scaffolder (src/data/overlay.ts) and the
// generated do/don't line in src/generate/shared.ts -- one filter, two callers.

import type { SystemCatalog } from '../types.ts';

const TYPE_LIKE_SUFFIX = /Props$|Variant$|Size$|State$|Status$|Appearance$|Padding$|Position$|Type$|Name$|Platform$/;

/**
 * Names in `catalog.allExports` that are real (confirmed) symbols but carry no documented props:
 * PascalCase, an empty `allPropsByExport` entry, and no matching `CatalogExport` anywhere in
 * `catalog.components`. Excludes names that read as a type/variant/prop-bag rather than a
 * component (the `TYPE_LIKE_SUFFIX` list), since those are almost never meant to be used as JSX.
 */
export function undocumentedValueExports(catalog: SystemCatalog): string[] {
  const documented = catalog.components.flatMap((c) => c.exports);
  const knowsTypeOnly = catalog.typeOnlyExports !== undefined;
  const typeOnly = new Set(catalog.typeOnlyExports ?? []);
  return catalog.allExports.filter((name) => {
    const props = catalog.allPropsByExport[name];
    return (
      props !== undefined &&
      props.length === 0 &&
      !documented.some((e) => e.displayName === name) &&
      /^[A-Z][A-Za-z0-9]*$/.test(name) &&
      !typeOnly.has(name) &&
      // The adapter told us exactly which names are types (react-docgen, via the type
      // checker): trust that over the heuristic, which can misfire on a real component
      // whose name happens to end in e.g. "Status". Catalogs without that information
      // (another adapter, or an overlay-only catalog) fall back to the suffix guess.
      (knowsTypeOnly || !TYPE_LIKE_SUFFIX.test(name))
    );
  });
}

# open-design-system-mcp-starter: agent instructions

You are working on the starter itself, not on a design system that adopts it.
open-design-system-mcp-starter is a system-agnostic template for a design system MCP server: a
team clones it, points it at their catalog, tokens and docs, and coding agents get a grounded API
to ask instead of a memory to guess from. It is its own repo with its own release cadence and no
code dependency on any other project.

README.md is the adopter-facing reference and CHANGELOG.md tracks what shipped. This file is conventions and
context, not a substitute for it.

## What exists

- `src/types.ts`: every shared contract (treat as the seam between adapters and the server).
  Includes `SystemConfig.codeConnect` (`{ include, root? }`), `CatalogExport.figma` and
  `CatalogExport.docSource` (`'docgen' | 'props-type' | 'overlay' | 'code-connect'`),
  `SystemCatalog.source.overlay` / `source.codeConnect`, `CatalogOverlay`, and `AliasEntry.source`
  of `'lexicon' | 'team' | 'code-connect'`.
- `src/config.ts`: loads `ds.config.json`, resolves roots and data dirs (including `rootEnv`
  overrides).
- `src/data/load.ts`: validates, stamps and loads catalog/tokens/docs per system, plus
  `patterns/*.md` (`loadPatterns` / `parsePatternFile`): optional front matter (`title`,
  `description`, `tags`, `language`) between `---` lines, falling back to the first H1, first
  paragraph and first fenced code block; which catalog exports a pattern uses is detected from
  JSX/dashed tags found in its code, not authored by hand. `data.patterns` is `undefined` when a
  system has no `patterns/` directory, `[]` when the directory exists but is empty.
  `loadSystemData` also applies `data/<id>/overlay.json` (via `applyOverlay`) over the freshly read
  catalog before anything downstream sees it. `checkFreshness` reports four dimensions (catalog,
  tokens, docs, `codeConnect`) as stale/fresh/none/unknown; `overlayReport` (used by `doctor`) is
  the touched/unknown summary.
- `src/data/overlay.ts`: `loadOverlay`/`applyOverlay` merge `data/<id>/overlay.json` over an
  already-extracted catalog, per export, by `displayName`; a name not in `allExports` is refused
  into an `unknown` list rather than invented as a new export. `props` merges by prop name (overlay
  wins on collision, other extracted props survive); every other field is a plain overwrite when
  set. Also `scaffoldOverlay`/`writeOverlayScaffold`, which back the `overlay-scaffold` CLI command:
  one empty entry with a `_note` per name `undocumentedValueExports` reports, appending only new
  names on a re-run unless `--force`.
- `src/data/undocumented.ts`: `undocumentedValueExports`, the one shared filter (PascalCase,
  empty `allPropsByExport` entry, no `CatalogExport`, not a `...Props`/`...Variant`/etc.-suffixed
  type name) used by both `overlay-scaffold` and `doctor`'s "N exports have no props table" note.
- `src/data/aliases.ts`: merges the ecosystem lexicon (`src/data/convention-lexicon.json`), an
  optional `data/<id>/aliases.code-connect.json` (written by `runExtract` from Figma enum maps),
  and a team's `data/<id>/aliases.json`, in that precedence: team wins over code-connect wins over
  the lexicon on the same alias.
- `src/adapters/`: the only place format knowledge lives.
  - `catalog-json.ts`, `custom-elements-manifest.ts`, `css-vars-tokens.ts`.
  - `react-docgen.ts`: the public API is whatever the barrel exports (named re-exports,
    `export *` followed recursively through nested barrels up to 6 hops, local `export
    const/function/class`), independent of what `react-docgen-typescript` can document. A barrel
    written against compiled output (`export * from './core/index.js'`) resolves: `.js`/`.jsx`/
    `.mjs`/`.cjs` specifiers are matched back to their `.ts`/`.tsx` source before being read.
    Props come from `react-docgen-typescript`; a prop declared outside the system's own source
    (DOM attrs, a third-party base component) is recorded by name only, under `inheritedProps`. A
    tsconfig compiler option this project's pinned TypeScript doesn't recognize is warned about
    and skipped rather than a hard failure. A system consumed from npm has no `.tsx` source, only
    `.d.ts` files, so the barrel resolution falls back to `index.d.ts` and the file walk reads
    `.d.ts` alongside `.tsx`; when a barrel re-exports components (always true for a published
    package's `dist/index.d.ts`), the component's own declaration file wins over the barrel's
    re-export (deepest file path, then more props, decides which doc survives). Props-type
    fallback: for every barrel export docgen still left with zero props (a callable object shape,
    a props type that is an intersection with a union -- both outside `react-docgen-typescript`'s
    name/shape detection), `applyPropsTypeFallback` builds one `ts.Program` over the declaring
    files and resolves `<Name>Props`/`<Name>BaseProps`, or failing that the first parameter type of
    the export's call signature, through the checker directly. Stamps `docSource: 'props-type'`; a
    resolved prop declared outside the system's own source is still recorded name-only under
    `inheritedProps`, exactly like docgen. Never throws: a `ts.createProgram` failure or one
    export's resolution failing just leaves it exactly as docgen left it. `extract` prints
    `[extract] props-type fallback documented N of M undocumented exports`.
  - `code-connect.ts`: parses `figma.connect(Component, url, { props, example })` calls out of
    `*.figma.tsx`/`*.figma.ts` files (a team-hand-written file, never generated here, so a call or a
    whole file that doesn't match the expected shape is skipped, never aborts the run).
    `enrichFromCodeConnect` merges the parsed mappings over the catalog by component name (matched
    against `allExports`, unmatched names reported, never invented): sets `figma: { nodeId, url,
    source }` on the matching export (creating a bare `code-connect`-dir stub when docgen produced
    none, mirroring the overlay's stub creation), appends a "Code Connect example" built from the
    `example` callback's JSX with `props.<name>` rewritten to `{<name>}`, and derives
    `AliasEntry`s (`source: 'code-connect'`) from `figma.enum('<FigmaValue>', { code: 'value' })`
    maps whose Figma-side and code-side values differ. Also `collectCodeConnectFiles` /
    `codeConnectSourceHash` (mirrors `markdown-docs.ts`'s glob walker and literal-path exception),
    wired into `runExtract` (`src/adapters/index.ts`): the enriched catalog is what gets written,
    and `data/<id>/aliases.code-connect.json` is (re)written or deleted based on whether any
    aliases were derived this run.
  - `dtcg-tokens.ts`: DTCG JSON with group-inherited `$type`, `{a.b.c}` reference capture, and
    per-file theme detection (light/dark/high-contrast) by basename when multiple files are given.
  - `markdown-docs.ts`: `docs.include`/`docs.exclude` globs chunked by heading into
    `docs-index.json` (1200-char chunks, each recording which catalog exports it mentions). The
    glob walker skips `node_modules` and dot-directories; an `include` entry with no glob
    characters is read as a literal path instead, bypassing that skip, so a README shipped inside
    an installed package is still reachable.
  - `css-vars-tokens.ts`: the brace-aware CSS walker also handles Tailwind 4's `@theme { ... }`
    block (treated as default-theme `:root` declarations) and `@layer x { ... }` (unwrapped and
    recursed into). A brace-less at-rule immediately before a block (`@import "./x.css";`,
    `@custom-variant dark (...);`) is stripped from that block's header instead of being read as
    part of the next selector, which would otherwise mislabel the block's theme.
- `src/search/index.ts`: scoring across exact name, alias, prop, description and docs matches,
  plus `searchPatterns` for `get_pattern`.
- `src/check/analyze.ts`: `checkUsage`, the static usage checker behind `check_usage`. Parses
  TSX with the TypeScript compiler API (same `^5` pin as `react-docgen.ts`) or a small regex tag
  scanner for HTML, both filling one shared element/attribute model so every check (unknown
  component, invented prop, raw color/length, missing accessible name, disallowed import,
  deprecated API) runs once, independent of source language.
- `src/tools/`: one file per tool, a pure function over loaded data plus a thin MCP wrapper. Nine
  tools: `search_components`, `get_component`, `resolve_component`, `find_token`, `get_guidance`
  (docs search by topic/component, with a plain note when no docs are indexed), `list_tokens`
  (browse by category or word, as opposed to `find_token`'s single-value lookup), `check_usage`
  (wraps `checkUsage`), `get_pattern` (wraps `searchPatterns`, with a plain note when a system has
  no patterns yet), and `get_migration` (a component's or `Component.prop`'s catalog `deprecated`
  field, then `CHANGELOG*.md` mentions at the system root, then a `codemods`/`scripts/codemods`
  directory listing).
- `src/resources.ts`, `src/prompts.ts`: the `ds://<system>/...` resources and the `build-ui`
  prompt.
- `src/server.ts`: `createServer()`, which registers tools, resources and prompts; the stdio entry
  point.
- `src/generate/`: writes the agent-facing surface for one already-loaded system into an adopting
  team's repo. `index.ts` is the orchestrator (`runGenerate`, dispatching on `GenerateTarget`);
  `shared.ts` holds everything every generator reuses and nothing else does -- the fixed 8-step
  routine text tied to exact tool names, the consumption-line sentence, derived team-alias rows and
  do/don't lines pulled from the real catalog (never a placeholder), and the two file-write idioms:
  `writeMarkedFile` (replace only the text between `<!-- ds-mcp:begin <id> -->` /
  `<!-- ds-mcp:end <id> -->`, used by `agents-md.ts` for AGENTS.md/CLAUDE.md and `editor-rules.ts`
  for copilot-instructions.md) and `writeGenerated` (a fully-generated file, skipped when one
  already sits at that path unless it carries the embedded `GENERATED_SIGNATURE` or `--force` is
  passed, used by `llms-txt.ts`, `skill.ts`, `editor-rules.ts`'s `.mdc`, and `well-known.ts`).
- `src/cli.ts`: commands `init`, `serve`, `extract`, `doctor`, `generate`, `overlay-scaffold`.
  `init` (`src/init/wizard.ts` + `src/init/detect.ts`) scans a checkout, detects a
  catalog/tokens/docs shape, and writes a system entry to `ds.config.json`; interactive by default,
  non-interactive with `--id` and `--root`, or `--id` and `--package <npm name> [--foundations
  <npm name>]` for a system that is only ever installed (`detectPackage` reads
  `node_modules/<package>/package.json` instead of scanning a checkout; `root` is stored as `"."`).
  `serve` takes `--http [--port] [--host] [--path]` to start `src/http.ts`'s streamable-HTTP
  transport instead of stdio; `overlay-scaffold --system <id> [--force]` wraps
  `writeOverlayScaffold`. `generate <agents-md|llms-txt|skill|editor-rules|well-known|all>
  --system <id> --target <dir> [--force] [--server-url <url>]` resolves a system from the registry
  and calls `runGenerate`; the USAGE string in `src/cli.ts` is authoritative for every command and
  flag.
- `src/http.ts`: the streamable-HTTP transport, a plain `node:http` server (no framework,
  deliberately no CORS -- it serves agent clients, not browsers). Sessions are stateful: an
  `initialize` POST with no `mcp-session-id` header spins up a fresh `McpServer` + transport pair
  keyed by the transport's generated session id; later POST/GET/DELETE requests for that session
  route to the same transport via that header. Bearer auth (`DS_MCP_TOKEN`, constant-time compare
  via `timingSafeEqual`) gates every request when the token is set; unset, the endpoint is open,
  same as stdio, and a warning logs at startup when bound to a non-loopback host with no token.
  `GET /healthz` (unauthenticated) reports each system's id, name, export/token counts and
  catalog/tokens/docs freshness, plus live session count. `cli.ts serve` wires `--http` to
  `startHttp`.
- Freshness (`checkFreshness` in `src/data/load.ts`, surfaced by `doctor` and `serve --strict`)
  covers four artifacts: catalog, tokens, docs and `codeConnect`, each getting its own
  stale/fresh/none/unknown report; `currentSourceHashes` (`src/adapters/index.ts`) recomputes the
  Code Connect hash the same way `runExtract` does, without re-parsing the mapping files' meaning.
- `.claude/skills/ds-mcp-setup/`: the shipped onboarding skill. Walks a setup session through
  `init`, `extract`, `doctor`, a server smoke test, `generate all`, registering the server with a
  client, and authoring `aliases.json` from a first real agent session's mistakes -- each step
  names a concrete check, not "looks fine." `generate skill` (above) writes two more skills,
  generated per system rather than shipped: `use-<id>` and `review-<id>`.

## Conventions

- **Never fabricate.** A lookup miss returns `missing` plus nearest candidates and why, never a
  guessed entry.
- **Small payloads by default.** Every tool has a character budget and a `detail` level. Log the
  size of every response so cost stays measurable.
- **Stamped, and refused when stale.** Every artifact (catalog, tokens, docs, and Code Connect
  mappings when configured) carries its source hash. `doctor` compares each against its source;
  `serve` warns (or refuses with `--strict`) when any of them is older than the source.
- **Agnostic or it is a bug.** Component, package, kit and provider names come from config. If a
  real component, package or system name ends up in `src/`, that is a bug: fix it, do not ship
  it. Vocabulary defaults come from the lexicon data file, extended only with mined evidence; team
  aliases live in the team file.
- **Pure core, thin wrapper.** Every tool is a plain function over loaded data, tested directly;
  the MCP registration around it is a few lines. This is what keeps the server portable to a
  second transport or protocol later.
- **Offline tests.** node:test via tsx, the SDK's in-memory transport, synthetic catalogs in temp
  dirs. No network, no model calls.
- **ESM TypeScript, strict, explicit `.ts` import extensions, no build step.** Plain `fetch` if
  anything ever needs the network. No new runtime dependencies without a strong reason.
- **Docs style:** sentence-case headings, straight quotes, no em dashes.

## Verification loop

Run after any change:

```bash
node_modules/.bin/tsc --noEmit -p tsconfig.json
node_modules/.bin/tsx --test 'src/**/*.test.ts'
npx tsx src/cli.ts extract && npx tsx src/cli.ts doctor
npx tsx src/cli.ts generate all --system acme-elements --target .out/gen-check
npx tsx src/cli.ts serve --http --port 3399 &
curl -s http://127.0.0.1:3399/healthz; kill %1
```

## Decisions not to relitigate

- **Template repo with an `init` wizard, not a scaffolding CLI.** Lowest friction for adopters, no
  publish pipeline. Upstream improvements arrive as a documented merge from the template.
- **Standalone, no code dependency on other projects.** Contracts are a superset of the
  benchmark's so its files load, but nothing is imported from it. Anything shared later is a
  conscious extraction, not a dependency now.
- **The lexicon ships as an alias seed.** Version-stamped, never hand-edited, extended only with
  mined evidence. Teams map aliases to their names in a separate team file the server merges over
  it.
- **Nothing authored is required to get a working server.** Catalog, tokens and deprecations
  extract mechanically. Patterns and guidance are optional directories with a schema and examples;
  the setup skill offers to draft them.
- **One system per kit, stdio first, HTTP for the shared instance.** Multi-kit systems declare one
  system per kit. Local stdio is the default transport; `serve --http` adds streamable HTTP as an
  alternative for a team-shared instance, not a replacement.
- **No Figma lookup tool: Figma's MCP owns node-to-code, we own catalog and validation.** "Which
  code component is this Figma node, with today's live property values" is exactly what Figma's
  own MCP server already answers from an open file. Adding a `get_figma_mapping` tool here would
  duplicate that with a staler, file-based answer. The Code Connect adapter instead reads the same
  mapping files Figma's Code Connect already uses and feeds their node links, examples and
  prop-value aliases into this server's own catalog and alias data, so the nine existing tools get
  richer answers instead of a tenth tool appearing.
- **The overlay never invents: unknown names are rejected.** `applyOverlay` only enriches a
  `displayName` already present in the catalog's `allExports`; anything else is collected into
  `unknown` and surfaced by `doctor` as a failing check, never silently created as a new export.
  This is the same non-negotiable the lexicon and Code Connect aliases already follow (an alias
  with no `target` is a hint, never a fabricated resolution) applied to catalog data.
- **`typescript` stays pinned to `^5`.** TypeScript 7 (the native/preview rewrite) ships no
  classic Compiler API, `ts.createSourceFile`, `ts.SyntaxKind`, and the rest that
  `react-docgen-typescript` and this repo's own barrel parser (`src/adapters/react-docgen.ts`)
  both need are simply absent from its default export. Upgrading the top-level `typescript`
  package breaks the `react-docgen` adapter outright; if TypeScript 7 is ever needed elsewhere,
  give `react-docgen-typescript` its own nested `typescript@5` dependency instead of bumping this
  repo's.
- **Generated files carry a signature; never overwrite a team's hand-written file without
  `--force`.** Every fully-generated file (`llms.txt`, `llms-full.txt`, `SKILL.md`, `<id>.mdc`,
  `servers.json`) embeds `GENERATED_SIGNATURE` (`src/generate/shared.ts`). A re-run of `generate`
  only overwrites a path that doesn't exist yet, already carries that signature, or when `--force`
  is passed; anything else already sitting at that path is left alone and reported as `skipped`.
  AGENTS.md, CLAUDE.md and copilot-instructions.md use the complementary begin/end-marker rule
  instead, since those files are expected to carry hand-written text alongside the generated
  section.

## Map

```
ds.config.json             the systems registry (ships with one example system)
package.json               private, ESM, scripts: serve | extract | doctor | typecheck | test
tsconfig.json               strict, nodenext, noEmit; run via tsx, no build step
schema/                     JSON schemas: ds.config, catalog, tokens, aliases
examples/acme-elements/     tiny example system: custom-elements.json, tokens.css, docs/*.md
data/<system>/              committed ground truth per system (generated by extract)
  catalog.json  tokens.json  docs-index.json  aliases.json
  overlay.json                 hand-written facts merged over the catalog at load time
  aliases.code-connect.json    generated by extract from Figma enum maps, not hand-maintained
  patterns/*.md               optional authored recipes (front matter + body fallbacks)
src/
  types.ts                  every shared contract
  config.ts                 load ds.config.json, resolve roots and data dirs
  cli.ts                    init | serve | extract | doctor | generate | overlay-scaffold
  server.ts                 createServer(): registers tools, resources, prompts; stdio entry
  http.ts                   streamable-HTTP transport: sessions, bearer auth, GET /healthz
  init/                     the `init` wizard
    detect.ts                 scans a checkout: manifests, react src + barrel, css/dtcg token
                               files, docs globs, package name, component model; detectPackage
                               reads an installed package's own node_modules/<pkg> instead
    wizard.ts                 interactive or non-interactive answers -> ds.config.json entry;
                               package mode when `answers.package` is set
  data/                     load + validate + freshness; lexicon, alias merge, patterns parsing
    convention-lexicon.json    empirical alias seed (do not hand-edit)
    overlay.ts                 applyOverlay, scaffoldOverlay, writeOverlayScaffold
    undocumented.ts            undocumentedValueExports: shared by overlay.ts and doctor
  adapters/                 the only place format knowledge lives
    catalog-json.ts  custom-elements-manifest.ts  react-docgen.ts
    css-vars-tokens.ts  dtcg-tokens.ts  markdown-docs.ts  code-connect.ts
  search/                   scoring: exact, alias, prop, description, docs; searchPatterns
  check/
    analyze.ts                checkUsage: the static analyzer behind check_usage
  tools/                    one file per tool, pure functions + a thin MCP wrapper
    search-components.ts  get-component.ts  resolve-component.ts  find-token.ts
    get-guidance.ts  list-tokens.ts  check-usage.ts  get-pattern.ts  get-migration.ts
  resources.ts  prompts.ts
  generate/                 writes the agent-facing surface into an adopting team's repo
    index.ts                  runGenerate: dispatches on GenerateTarget
    shared.ts                  routine text, consumption line, derived aliases/do-dont,
                               marker-section and generated-file write helpers
    agents-md.ts  llms-txt.ts  skill.ts  editor-rules.ts  well-known.ts
  **/*.test.ts              node:test, in-memory MCP transport, synthetic data in temp dirs
.claude/skills/
  ds-mcp-setup/             shipped: drives onboarding a new system
docs/
  bench-pairing.md          the later note: how this pairs with a benchmark
```

For the adopter-facing reference, read README.md. CHANGELOG.md tracks what shipped.

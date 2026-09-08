# open-design-system-mcp-starter

<p align="center">
  <img src="docs/cursor.jpg" width="100%" alt="Glowing cursor on a dark grainy background">
</p>

A system-agnostic MCP server template for a design system. Point it at your own catalog, tokens
and docs, and coding agents get a real API to ask instead of a memory to guess from: what
components exist, what props they take, which token to write, whether a name they are about to
use is actually real. A lookup miss never returns a fabricated answer; it returns "not in this
system, nearest is X, because Y".

## Quick start

1. Clone the repo.
2. Install dependencies:

   ```bash
   npm install
   ```

3. The repo ships a fictional example system, `acme-elements`, under `examples/acme-elements`, so
   the server runs immediately with no configuration:

   ```bash
   npm run serve
   ```

4. Try it. Register the example server in Claude Code:

   ```bash
   claude mcp add acme-elements -- npx tsx /absolute/path/to/src/cli.ts serve
   ```

   Then ask the agent "does this system have a Card component?" and expect a correction pointing
   at the nearest real element instead of an agent that invents one.

5. Point it at your own system next. When it is a checkout, run `init --id <id> --root <path>`;
   when it is only ever installed via npm, run `init --id <id> --package <npm name>` instead (see
   "Point it at your system" and "Systems consumed from npm" below).

## Point it at your system

The recommended way to add a system is the `init` wizard. It scans a checkout, detects a catalog
adapter, a tokens adapter and doc globs, and writes (or merges into) `ds.config.json` for you:

```bash
npx tsx src/cli.ts init
```

Answer its prompts, or skip them entirely with `--id` and `--root`:

```bash
npx tsx src/cli.ts init --id acme-elements --root ../acme-elements
```

Both forms accept `--config <path>` to target a config file other than `./ds.config.json`. When
only one of `--id` / `--root` is given, `init` still asks interactively, using the one you passed
as that prompt's default.

When your system is only ever `npm install`ed, never checked out, use package mode instead of
`--root`: `init --id <id> --package <npm name> [--foundations <npm name>]` reads the installed
package's own `node_modules/<npm name>` (barrel, compiled CSS, README) instead of scanning a
source tree. See "Systems consumed from npm" below for the full walkthrough and what it detects.

To edit the config by hand instead, or to see every field `init` can set, the file that ships in
the repo looks like this:

```json
{
  "$schema": "./schema/ds.config.schema.json",
  "systems": {
    "acme-elements": {
      "name": "Acme Elements (example)",
      "description": "Placeholder system shipped with the starter so the server runs out of the box. Replace with your own.",
      "root": "examples/acme-elements",
      "componentModel": "custom-elements",
      "componentsPkg": "@acme/elements",
      "catalog": { "adapter": "custom-elements-manifest", "path": "custom-elements.json" },
      "tokens": { "adapter": "css-vars", "files": ["tokens.css"] },
      "docs": { "include": ["docs/**/*.md"] }
    }
  }
}
```

Every field of a system entry, from `SystemConfig` in `src/types.ts`:

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | No | Human name shown to agents, e.g. "Acme Elements". Defaults to the id. |
| `description` | No | Short description shown alongside the name. |
| `root` | No | Checkout root the adapters read from. Relative paths resolve against the config file's directory. |
| `rootEnv` | No | Env var that overrides `root` (a CI checkout, a teammate's local path). |
| `dataDir` | No | Where generated ground truth lives. Default: `data/<id>`. Committed on purpose. |
| `componentModel` | No | `"react"` (default): components are imported by name. `"custom-elements"`: registered once, written as dashed tags. |
| `componentsPkg` | No | The specifier consumers import (react) or register (custom-elements), e.g. `"@acme/react"`. |
| `foundationsPkg` | No | Tokens/foundations package, if separate from `componentsPkg`. |
| `catalog` | Yes | Where the catalog comes from. See the adapters table below. |
| `tokens` | No | Where tokens come from. See the adapters table below. |
| `docs` | No | `{ include: string[], exclude?: string[] }`, globs relative to `root`. |
| `aliases` | No | Team-maintained alias file, relative to the config dir. Default: `<dataDir>/aliases.json` if present. |
| `codeConnect` | No | `{ include: string[], root?: string }`, Figma Code Connect files to enrich the catalog from. Globs relative to `root`, or to `codeConnect.root` for a mapping file checkout other than the system's own. See "Figma Code Connect" below. |

Once the config points at your system, run:

```bash
npx tsx src/cli.ts extract --system <id>
npx tsx src/cli.ts doctor
npx tsx src/cli.ts serve
```

`extract` reads your source through the configured adapters and writes the ground-truth files
into the system's data dir (`data/<id>/catalog.json`, `tokens.json`, `docs-index.json`, plus
`aliases.json` when you maintain one). That data dir is **committed on purpose**: it is the
server's ground truth, and a diff to it should be reviewed like a diff to code, not treated as
build output. Pass `--out <dir>` to `extract` to write into a different directory instead, for a
dry run or a CI check.

Every command accepts `--config <path>` (default `./ds.config.json`); `extract` and `doctor`
accept `--system <id>` to limit the run to one system.

Each extracted file is stamped with a hash of the source it came from. `doctor` compares that
stamp against the current source and reports whether the catalog, tokens, docs and (when
`codeConnect` is configured) the Code Connect mappings are each fresh. `serve` runs the same check
on startup: it warns when any of them is older than the source, and refuses to start with
`--strict` until you re-run `extract`.

## Adapters

Adapters are the only place format knowledge lives. Everything downstream (search, tools,
resources) reads the same `SystemCatalog` / `SystemTokens` shape regardless of which adapter
produced it.

| Adapter | Kind | Input |
| --- | --- | --- |
| `catalog-json` | catalog | An already-built catalog matching the `SystemCatalog` shape (path relative to `root`). |
| `custom-elements-manifest` | catalog | A `custom-elements.json` (Custom Elements Manifest, schema 1.x or 2.x). |
| `react-docgen` | catalog | A source tree (`src`) and an optional barrel file (`barrel`). |
| `css-vars` | tokens | CSS files declaring custom properties, e.g. a compiled `tokens.css` (`files`, relative to `root`). |
| `dtcg` | tokens | Design Tokens Community Group (DTCG) JSON files (`files`, relative to `root`). |

### react-docgen

```json
{ "adapter": "react-docgen", "src": "<dir relative to root>", "barrel": "<optional, relative to root>" }
```

The public API is whatever the barrel exports, not whatever docgen manages to document: named
re-exports (`export { A, B as C } from './x'`, including `export { default as X }`), `export *
from './x'` followed recursively through nested barrels up to 6 hops, and local `export
const/function/class`. A barrel written against the compiled output (`export * from
'./core/index.js'`) resolves fine: `.js`/`.jsx`/`.mjs`/`.cjs` specifiers are matched back to their
`.ts`/`.tsx` source before being read. `barrel` defaults to `<src>/index.ts` or `index.tsx`, or
`index.d.ts` when neither exists, since a published package installed into `node_modules` ships
only declaration files.

Props come from `react-docgen-typescript`, run once over every `.tsx` file under `src`, plus every
`.d.ts` file so a published package's own declaration files are documented too. Literal union
types are expanded into their member values rather than left as an alias name. A prop declared
outside the system's own source, such as an inherited DOM attribute or a spread from a
third-party base component, is recorded by name only, under `inheritedProps`, not given a full
entry. A tsconfig compiler option this project's pinned TypeScript does not recognize (written for
a newer TypeScript than the adapter runs on) is warned about and skipped rather than treated as a
hard failure. When a barrel re-exports components (always true for a published package's
`dist/index.d.ts`), the same component would otherwise be documented twice, once from its own
file and once from the barrel; the adapter keeps one entry per name, and the component's own file
wins over the barrel's re-export.

**Props-type fallback.** `react-docgen-typescript`'s component detection is name- and shape-based,
so it misses some perfectly ordinary components: a callable object
(`declare const Stack: { (props): JSX.Element }`), or a props type that is an intersection with a
union. For every barrel export docgen left with no props at all, the adapter reads the export's
own `<Name>Props` (or `<Name>BaseProps`) type straight off a TypeScript checker built over the
exports' declaring files, or, when there is no such type, the first parameter type of the export's
call signature. An export documented this way carries `docSource: 'props-type'` instead of the
default (docgen). A prop resolved this way whose declaration lives outside the system's own source
is still recorded by name only, under `inheritedProps`, exactly like a docgen-documented export -
an inherited DOM prop is name-only either way. `extract` prints a one-line summary of how many
exports this closed the gap for, e.g.
`[extract] props-type fallback documented 12 of 34 undocumented exports`. What is left after that
line is what "Known limits" below, and the catalog overlay, are for.

### css-vars

```json
{ "adapter": "css-vars", "files": ["<file relative to root>", "..."] }
```

Parses `--name: value;` custom-property declarations out of plain CSS. `:root`/`html`/`body`
selectors are the default ("light") theme; `[data-theme="x"]`, `.x-theme` and `.dark`/`.light`
classes, and `@media (prefers-color-scheme: dark)` are recognized as other themes. Tailwind 4
`@theme` blocks are read as default-theme declarations, and `@layer` wrappers (`@layer utilities {
:root { ... } }`) are unwrapped and their contents processed normally. A brace-less at-rule ahead
of a block, such as `@import "./x.css";` or Tailwind's `@custom-variant dark (...);`, is ignored
rather than folded into the next selector's header (which would otherwise mislabel that block's
theme).

### dtcg

```json
{ "adapter": "dtcg", "files": ["tokens.json"] }
```

Parses Design Tokens Community Group JSON: `$type` is inherited from the nearest ancestor group
when a token doesn't declare its own, `{value}` references are captured, and when multiple files
are given each is matched to a theme (light/dark, or high-contrast) by its basename.

### markdown-docs

`docs.include` (and optional `docs.exclude`) globs, relative to `root`, are chunked by heading
into `data/<id>/docs-index.json`: one chunk per heading section, truncated to 1200 characters,
each recording which catalog exports it mentions. This index is what `get_guidance` searches, and
it is checked for freshness the same way the catalog and tokens are.

A glob walk skips `node_modules` and dot-directories, so it never reaches a README shipped inside
an installed package. An entry in `docs.include` with no glob characters (`*`, `?`, `{`, `[`) is
taken as a literal path instead and read directly, bypassing that skip -- this is how a system
consumed from npm points at a package's own `README.md` under `node_modules`.

## Known limits

Neither docgen nor the props-type fallback above can document every component: some polymorphic
or factory-built component (one assembled at runtime rather than declared as a plain function, for
example) resolves to no props type and no callable signature the checker can read. Such a
component still appears in `allExports` and still resolves through `resolve_component` as a real,
existing symbol; it just has no props table. `overlay-scaffold` lists exactly which exports are
still in this state and gives a team a starting point to fill them in by hand; see "Catalog
overlay" below.

## Catalog overlay

`data/<id>/overlay.json` holds hand-written facts merged over the extracted catalog at load time:
for exports neither docgen nor the props-type fallback could document, or simply to add an
example, a11y note, deprecation, or Figma link the source has no place to author. An overlay entry
can only enrich a symbol that already exists in the catalog's `allExports` -- it never invents one,
so a typo reports as `unknown` instead of silently creating a fake export.

```json
{
  "exports": [
    {
      "displayName": "AcmeStack",
      "description": "Vertical layout primitive with a configurable gap.",
      "props": [{ "name": "gap", "type": "string", "required": false, "defaultValue": "\"md\"" }],
      "examples": [{ "title": "Basic stack", "code": "<AcmeStack gap=\"lg\">...</AcmeStack>", "language": "tsx" }],
      "a11y": { "accessibleName": "none" },
      "guidance": { "do": ["Use for vertical rhythm between blocks."], "dont": ["Don't use for inline layout."] },
      "deprecated": { "since": "2.0", "replacement": "AcmeStackV2" },
      "figma": { "nodeId": "1:23", "url": "https://figma.com/file/...?node-id=1-23" }
    }
  ]
}
```

Every field is optional except `displayName`. Precedence: an overlay `props` entry is merged into
the extracted props list by name -- an overlay prop with the same name replaces the extracted one,
any other extracted prop is kept, and a name the extractor never found is added. Every other field
(`description`, `a11y`, `guidance`, `deprecated`, `figma`, `tagName`, `inheritedProps`, `events`,
`slots`) is a plain overwrite when the overlay sets it; `examples` and `docs` are appended to,
de-duplicated by content. Setting `props` also stamps `docSource: 'overlay'` on that export, same
as when the overlay creates a whole new entry for a name docgen never produced one for.

`unknown` names -- a `displayName` the overlay lists that is not in `allExports` -- are never
invented into existence. They are reported by `doctor` (`overlay: N exports enriched, unknown
names: ...`, marked a failing check) so a typo or a renamed component gets caught instead of
silently doing nothing.

The scaffold workflow:

```bash
npx tsx src/cli.ts overlay-scaffold --system acme-elements
```

writes `data/<id>/overlay.json` with one empty entry per undocumented export (the same set
"Known limits" describes), each carrying a `_note` telling a human what to do: read the
declaration file, fill in `props` (name, type, required, defaultValue, description), then delete
the note. Re-running without `--force` only appends entries for names not already listed, so a
team's edits to existing entries are never touched; `--force` rewrites the file from the current
undocumented set.

## Systems consumed from npm

No checkout is required. When your design system is only ever installed, not cloned, run the
`init` wizard's package mode first:

```bash
npx tsx src/cli.ts init --id acme-elements --package @acme/elements
```

pointed at the app folder that has `@acme/elements` installed (default: the current directory).
It reads `node_modules/@acme/elements/package.json` for the `.d.ts` barrel (`types`, `typings`, or
`exports['.'].types`), finds compiled CSS from `main`/`style`/`exports` or by walking the package
for a token-shaped stylesheet, picks up the package's own `README.md`, and writes the
`react-docgen` + `css-vars` config below for you. Pass `--foundations @acme/foundations` when
tokens ship from a separate package the components package does not declare as a peer dependency
(when it does, the wizard finds it on its own). If `@types/react` is not installed in the app, the
wizard prints a reminder: `react-docgen-typescript` needs it to resolve the package's declaration
files.

Point the config at the app that has the packages installed instead of at the package's own repo,
by hand, when the wizard's detection does not fit your package's layout, or to hand-tune what it
wrote:

```json
{
  "systems": {
    "acme-elements": {
      "root": "../my-app",
      "componentsPkg": "@acme/elements",
      "catalog": { "adapter": "react-docgen", "src": "node_modules/@acme/elements/dist", "barrel": "node_modules/@acme/elements/dist/index.d.ts" },
      "tokens": { "adapter": "css-vars", "files": ["node_modules/@acme/foundations/dist/tokens.css"] },
      "docs": { "include": ["node_modules/@acme/elements/README.md"] }
    }
  }
}
```

- `root` is the app folder that has the packages installed (its `node_modules`), not the design
  system's own checkout.
- `catalog.src` and `catalog.barrel` point into `node_modules/<componentsPkg>/dist` and its
  `dist/index.d.ts`; the `react-docgen` adapter falls back to `index.d.ts` for the barrel and
  reads `.d.ts` files alongside `.tsx` ones for exactly this case (see react-docgen above).
- `tokens.files` points at the foundations package's compiled CSS, e.g.
  `node_modules/<foundationsPkg>/dist/tokens.css`, when tokens ship from a separate package than
  the components.
- `docs.include` needs a literal file path, not a glob, to reach a README inside `node_modules`:
  globs skip `node_modules` by design, but a literal path is read directly regardless (see
  markdown-docs above).
- Install `@types/react` in the app so the components' declaration files resolve; without it,
  `react-docgen-typescript` cannot type-check the `.d.ts` files and documents nothing.
- When the package's barrel re-exports its components, as `dist/index.d.ts` normally does, the
  component's own declaration file wins over the barrel's re-export for the recorded props.

## Aliases

Agents write the vocabulary they already know, not necessarily your system's vocabulary. Aliases
are merged at load time from three layers, later layers winning on the same alias: team, then
Code Connect, then the ecosystem lexicon.

- **Ecosystem lexicon** (`src/data/convention-lexicon.json`): names AI models tend to invent when
  a design system does not have them, mined from 898 graded agent generations across two
  production design systems. Never hand-edited; extended only with new mined evidence.
- **Code Connect aliases** (`data/<id>/aliases.code-connect.json`): written by `extract` when
  `codeConnect` is configured, from Figma enum property maps whose value differs from the code
  value (e.g. Figma's "Primary" versus the code's `variant="primary"`). See "Figma Code Connect"
  below. Not hand-maintained; regenerated on every `extract`.
- **Team file** (`data/<id>/aliases.json`): your own mapping from an alias to your system's real
  name. This is the file you maintain, and it wins over both of the above.

An alias without a team target still helps: the server can say "there is no Card here, the
nearest concept is Surface" even before your team has mapped anything. A team entry that names a
target turns that into a direct resolution.

Example `data/acme-elements/aliases.json`:

```json
{
  "components": [
    {
      "alias": "Card",
      "concept": "surface-card",
      "target": "acme-surface",
      "source": "team"
    }
  ],
  "props": [
    {
      "alias": "spacing",
      "concept": "stack-gap",
      "target": "gap",
      "source": "team"
    }
  ]
}
```

## Figma Code Connect

When your team already maintains [Figma Code Connect](https://www.figma.com/code-connect-docs/)
files (`figma.connect(Component, url, { props, example })` calls, usually in `*.figma.tsx`),
point `codeConnect` at them and `extract` folds the mapping into the catalog and aliases:

```json
{
  "systems": {
    "acme-elements": {
      "root": "../acme-elements",
      "catalog": { "adapter": "react-docgen", "src": "src" },
      "codeConnect": { "include": ["**/*.figma.tsx"] }
    }
  }
}
```

`include` (default `**/*.figma.tsx`, `**/*.figma.ts`) is a glob list, or a literal path,
relative to `root`; set `codeConnect.root` instead when the mapping files live in a different
checkout than the system itself (a separate storybook repo, say).

For every `figma.connect(...)` call that names a real catalog export, `extract` adds:

- **A Figma node link** -- `figma: { nodeId, url, source }` -- on the matching export, resolved from
  the connect call's URL. When docgen produced no `CatalogExport` for that name at all, a bare
  stub is created so the link still surfaces, the same way the catalog overlay does for an
  undocumented export.
- **A Code Connect example** -- the connect call's `example` callback, with its JSX pulled out and
  `props.<name>` occurrences rewritten to `{<name>}` placeholders -- appended to the export's
  `examples`.
- **Component-value aliases** -- for every `props: { x: figma.enum('<FigmaValue>', { a: 'valueA' })
  }` map where a Figma-side value differs from the code-side value it maps to, an alias entry
  (`source: 'code-connect'`) is written to `data/<id>/aliases.code-connect.json`. See "Aliases"
  above for how this merges: team beats Code Connect beats the lexicon on the same alias.

`doctor` reports Code Connect coverage when it is configured: `code connect: N of M documented
exports mapped (F files)`. Mappings are stamped and checked for freshness exactly like catalog,
tokens and docs: a hash over the sorted list of matched files (paths and contents) is compared on
every `doctor` and `serve` run, and `serve --strict` refuses to start when it is stale.

**This does not replace Figma's own MCP server.** Figma's MCP answers "what component is this
node, with its current, live property values" straight from an open Figma file. This adapter
answers a different question, offline: it reads the mapping files your team already wrote and
maintains, and uses them to enrich this server's own catalog and alias data -- node links, a
worked example, and vocabulary aliases -- without ever opening a Figma session itself.

## Patterns

Nothing here is required to run the server, but a component-by-component API is not always
enough: an agent asking "how do I compose a labeled field with an error" needs a recipe, not a
props table. Patterns fill that gap, and `get_pattern` serves them.

Add markdown files to `data/<id>/patterns/*.md`. Each file is one pattern, with optional YAML-ish
front matter between `---` lines:

~~~markdown
---
title: Labeled field with error
description: A single-line text field with its own label, ready to show a validation error.
tags: form, validation, error
language: html
---

# Labeled field with error

... prose ...

```html
<acme-text-field label="Email" invalid error-text="Enter a valid email address."></acme-text-field>
```
~~~

Front matter wins when present; anything missing falls back to the body: the first `# ` heading
becomes the title, the first paragraph becomes the description, and the first fenced code block
becomes the code (its info string is the language, defaulting to `tsx` for a `react` system or
`html` for `custom-elements` when neither front matter nor the fence say). Which catalog
components a pattern uses is detected automatically from tags in the code, not authored by hand.

`get_pattern` searches these by plain-language query (`"confirm dialog"`, `"empty state"`) and
returns the matched pattern's full prose and code. A system with no `patterns/` directory yet
gets a plain note back instead of an error, pointing at `search_components` in the meantime.

The example system ships three: `confirm-actions.md`, `labeled-field.md` and `status-notice.md`
under `data/acme-elements/patterns/`.

## Migration lookups

`get_migration` answers "is this deprecated, and what do I do instead" for a component or a
specific prop (`Button` or `Button.type`), from three sources, in order:

1. **The catalog's own `deprecated` field** on the export or the prop, extracted mechanically by
   the catalog adapters -- this is the authoritative answer when present.
2. **`CHANGELOG*.md` at the system's root** (`CHANGELOG.md` preferred over any other
   `CHANGELOG.*`): lines that word-match the component or prop name, with the nearest preceding
   `##`/`###` heading (usually the version) attached.
3. **A `codemods/` or `scripts/codemods/` directory at the root**: file names that mention the
   component are listed as available codemods; when a codemods directory exists but nothing
   matches, that is reported too, so an agent doesn't assume none exists.

## Tools

Every tool returns a short text summary for the model plus a `structuredContent` object matching
a type in `src/types.ts`. Nine tools ship:

| Tool | Question it answers |
| --- | --- |
| `search_components` | "What do I use for a dismissible notice?" |
| `get_component` | "What are Button's real props and values?" |
| `resolve_component` | "Does TextField exist here?" |
| `find_token` | "Which token is `#1a1a1a`, or 'muted text on a card'?" |
| `list_tokens` | Lists tokens, filtered by category (color, space, size, typography, radius, shadow, motion, border, opacity, z-index) or a word; for browsing what's available rather than guessing a name. |
| `get_guidance` | Gets written guidance from the system's own docs for a component or a question (e.g. "when not to use a modal", "how do I migrate off the deprecated variant prop"); returns the most relevant doc sections, ranked, or a plain note when no docs are indexed for the system. |
| `check_usage` | Checks a JSX/TSX or HTML snippet against the design system before it's committed: unknown components, invented props, raw colors and lengths, missing accessible names, disallowed imports, deprecated API. Meant to be called on every file a build task writes. |
| `get_pattern` | "How does this system compose a labeled field with an error?" Gets a complete, correct recipe composed from real components for a common UI need, in preference to composing from scratch. |
| `get_migration` | "Button's `type` prop is deprecated, what now?" Deprecation and migration info for a component or `Component.prop`: the catalog's own `deprecated` field, matching CHANGELOG entries, and any codemod that can automate the change. |

No `get_figma_mapping` tool is planned: "which code component is this Figma node" is exactly what
Figma's own MCP server already answers, with live property values from an open file. This starter's
job is the catalog and validation side, which is why the Code Connect adapter feeds node links and
aliases into the tools above instead of adding a tenth tool that would duplicate Figma's own.

### Resources and prompts

Resources serve clients that attach context up front; tools serve agents mid-task. Both read the
same data:

- `ds://<system>/catalog`
- `ds://<system>/tokens`
- `ds://<system>/components/<name>`
- `ds://<system>/llms.txt`

The `build-ui` prompt starts a UI task with the system's conventions and the tool routine already
loaded, so an agent reaches for the right tool before it writes anything.

## Registering the server

All registrations run the same command, with an absolute path to this repo's `src/cli.ts` and
config:

```bash
npx tsx <abs>/src/cli.ts serve --config <abs>/ds.config.json
```

This is the stdio transport: one process per client, spawned by the client itself. For a team
that wants one server everyone points at instead, see "Shared HTTP instance" below.

The repository ships a project-scoped `.mcp.json` that runs `npx tsx src/cli.ts serve` with a
relative path, so opening a clone in Claude Code registers the example system with no setup. Edit
the server name once you point the config at your own system, or delete the file if you register
the server globally instead.

### Claude Code

```bash
claude mcp add acme-elements -- npx tsx <abs>/src/cli.ts serve --config <abs>/ds.config.json
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "acme-elements": {
      "command": "npx",
      "args": ["tsx", "<abs>/src/cli.ts", "serve", "--config", "<abs>/ds.config.json"]
    }
  }
}
```

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "acme-elements": {
      "command": "npx",
      "args": ["tsx", "<abs>/src/cli.ts", "serve", "--config", "<abs>/ds.config.json"]
    }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.acme-elements]
command = "npx"
args = ["tsx", "<abs>/src/cli.ts", "serve", "--config", "<abs>/ds.config.json"]
```

## Shared HTTP instance

For a team, run one server everyone points at instead of every client spawning its own stdio
process: `serve --http` starts the same server over streamable HTTP.

```bash
npx tsx <abs>/src/cli.ts serve --config <abs>/ds.config.json --http --port 3333 --host 127.0.0.1 --path /mcp
```

- `--port` defaults to 3333, `--path` to `/mcp`.
- `--host` defaults to `127.0.0.1` (loopback only). Set it to `0.0.0.0` to expose the server
  beyond localhost, and set `DS_MCP_TOKEN` in the environment whenever you do -- the server prints
  a startup warning if it is bound to a non-loopback host with no token configured.
- `DS_MCP_TOKEN`, when set, is required as a bearer token on every request to `--path`
  (`Authorization: Bearer <token>`); with no token set, the endpoint is unauthenticated, same as
  the stdio transport.
- `GET /healthz` (no auth) returns each configured system's id, name, export and token counts, and
  catalog/tokens/docs freshness, plus the number of live sessions and the session limits -- point a
  load balancer's health check or a quick "is this instance current" glance at it.
- Sessions expire: a client that stops talking without a `DELETE` is evicted after 30 minutes idle
  (`DS_MCP_SESSION_TTL_MS`), and at most 200 sessions are held at once (`DS_MCP_MAX_SESSIONS`);
  when the cap is reached the least recently seen session is evicted first. Both are logged.
- Security: the token check is constant-time, but there is no rate limiting and no TLS. Put a
  reverse proxy with TLS in front of an exposed instance, keep `--host 127.0.0.1` for a single
  machine, and treat the catalog as what it is: a description of your public component API, not a
  secret.

Registering a shared instance in Claude Code is a URL, not a spawned command (fictional host and
id, use your own):

```bash
claude mcp add --transport http acme-elements http://ds-mcp.internal:3333/mcp
```

`generate well-known --server-url <url>` advertises the same URL alongside the stdio start command
in the generated `.well-known/mcp/servers.json`, so a client that reads that file can reach either
transport:

```bash
npx tsx src/cli.ts generate well-known --system acme-elements --target . --server-url http://ds-mcp.internal:3333/mcp
```

## Generating the agent surface

`extract` produces the ground truth the server reads. `generate` writes the *agent-facing*
surface derived from that data into an adopting team's own repo (their design system repo, or an
app that consumes it) -- so an agent that hasn't attached this MCP server yet, or a plain-text
client that can't call tools, still gets a grounded starting point.

```bash
npx tsx src/cli.ts generate <agents-md|llms-txt|skill|editor-rules|well-known|all> --system <id> --target <dir> [--force] [--server-url <url>]
```

`--target` is the repo to write into, defaulting to the current directory. `--system` picks the
system when more than one is configured. `--server-url` only matters for `well-known`: it
advertises a hosted streamable-http endpoint (a "Shared HTTP instance", see above) alongside the
stdio command; omit it when the only registration you support is stdio.

### Generated surface

| Target | Writes | Rule when the path already exists |
| --- | --- | --- |
| `agents-md` | A section in `AGENTS.md` (created if missing); the same section in `CLAUDE.md`, only when that file already exists. | Fenced marker: only the marked section is replaced. |
| `llms-txt` | `llms.txt` (a short index) and `llms-full.txt` (the full per-component and per-token reference). | Fully generated: skipped unless `--force`. |
| `skill` | `.claude/skills/use-<id>/SKILL.md` and `.claude/skills/review-<id>/SKILL.md`. | Fully generated: skipped unless `--force`. |
| `editor-rules` | `.cursor/rules/<id>.mdc`; a section in `.github/copilot-instructions.md`. | `.mdc` fully generated (skipped unless `--force`); `copilot-instructions.md` uses the fenced marker. |
| `well-known` | `.well-known/mcp/servers.json`, advertising the stdio start command (and a streamable-http `url` when `--server-url` is given). | Fully generated: skipped unless `--force`. |
| `all` | Every target above. | As above, per file. |

Every generated section carries the same content: the system's name and consumption rule (import
by name, or register-once-then-tag), the MCP server start command, the fixed 8-step tool routine
(`search_components` -> `resolve_component` -> `get_component` -> `find_token` -> `check_usage`
-> `get_pattern` -> `get_guidance` -> `get_migration`), the never-invent rule, any team aliases
that resolve to a real target, and a few do/don't lines derived from the live catalog (a
deprecated component or prop, a component whose accessible name is required, always calling
`find_token` before a raw value) -- never a generic placeholder.

Two write rules, so `generate` is always safe to re-run as the catalog changes:

- **Begin/end markers.** `AGENTS.md`, `CLAUDE.md` and `copilot-instructions.md` mix hand-written
  and generated text. A re-run replaces only the text between
  `<!-- ds-mcp:begin <id> -->` and `<!-- ds-mcp:end <id> -->` for that system id; everything else
  in the file, including the team's own prose above and below, is untouched. `AGENTS.md` and
  `copilot-instructions.md` are created if missing; `CLAUDE.md` is only ever updated, never
  created, since not every team has one.
- **Skip unless `--force`.** The fully-generated files (`llms.txt`, `llms-full.txt`, both
  `SKILL.md` files, `<id>.mdc`, `servers.json`) carry an embedded signature marking them as
  written by this tool. A file already at that path is left alone -- and reported as `skipped` --
  unless it carries that signature (a previous run of this tool) or `--force` is passed, so a
  team's own hand-written file at the same path is never silently clobbered.

`generate llms-txt` (and `all`) always reports the size of both files, e.g.
`llms.txt 1.4 KB, llms-full.txt 12.7 KB`, so the context cost of attaching them is visible before
anyone does.

## Skills

The repo ships one skill for onboarding the starter itself: `.claude/skills/ds-mcp-setup/`. It
walks a setup session through adding a system (`init`), extracting, running `doctor`,
smoke-testing the server, generating the agent surface (`generate all`), registering the server
with a client, and authoring `aliases.json` from what an agent got wrong on its first real
session -- each step names a concrete check rather than "looks fine."

`generate skill` writes two more, generated per system rather than shipped: `use-<id>` (the build
routine with concrete tool calls, this system's own aliases and do/don'ts) and `review-<id>` (how
to review a diff against the system -- run `check_usage` per changed file, treat an
unknown-component or invented-prop finding as blocking, and name the deprecated replacement
instead of letting it pass silently). See "Generating the agent surface" above for where these
land and when a re-run touches them.

## Multi-kit systems

A design system with more than one consumable kit, for example a React kit and a web-component
kit, declares one system per kit in `ds.config.json` rather than one system covering both. Every
tool takes an optional `system` argument: omit it when only one system is configured, pass it to
disambiguate when several are.

## Development

```bash
npm run check        # typecheck + the offline test suite
npx tsx src/cli.ts extract && npx tsx src/cli.ts doctor   # the shipped example must stay idempotent and green
```

Node 22 or newer (`.nvmrc` pins 22). The GitHub Actions workflow in `.github/workflows/ci.yml`
runs the same checks plus a `git diff --exit-code -- data` guard, so a change that alters the
committed example data without meaning to fails CI. See CONTRIBUTING.md before opening a pull
request.

Conventions: ESM TypeScript, strict, explicit `.ts` import extensions, no build step. Tests are
offline (node:test via tsx, the MCP SDK's in-memory transport, synthetic data in temp dirs) and
never call a live model or network endpoint. Nothing under `src/` names a real design system,
package or component; every name resolves from `ds.config.json`.

`typescript` is pinned to `^5` on purpose: TypeScript 7, the native rewrite, ships no classic
Compiler API, so neither `react-docgen-typescript` nor this repo's own barrel parser can load
under it. Keep `typescript@^5` as the installed package, or if you need TypeScript 7 elsewhere in
your workflow, install `typescript@5` as a nested dependency of `react-docgen-typescript` instead
of upgrading the top-level package.

## Later

Pairing with a benchmark. The catalog and token contracts here are a superset of what
open-design-system-bench extracts, so its output loads through the `catalog-json` adapter with no
conversion. The starter does not depend on this; see `docs/bench-pairing.md` for the full note.

---
name: ds-mcp-setup
description: Use when onboarding a design system into this MCP starter: detect its shape, write ds.config.json, extract, verify with doctor, smoke-test the server, generate the agent surface, and register the server in Claude Code, Cursor or Codex.
---

# Onboarding a design system

Work through these steps in order. Each names a concrete check -- do not skip one because the
previous step "looked fine."

## 1. Add the system

Interactive: `npx tsx src/cli.ts init`. Non-interactive, when the id and checkout path are
already known: `npx tsx src/cli.ts init --id <id> --root <path>`.

This detects a catalog adapter (`custom-elements-manifest`, `react-docgen`, or `catalog-json`
when the team already builds one), a tokens adapter (`css-vars` or `dtcg`), and doc globs,
then writes or merges an entry into `ds.config.json`. Open the file after and sanity-check
`root`, `componentModel` and `componentsPkg` -- `init` guesses these; it does not always get
them right.

## 2. Extract

`npx tsx src/cli.ts extract --system <id>`

Check: the printed line names a plausible export, symbol, token and doc-chunk count. Zero
exports usually means the wrong `src` or `barrel`; zero tokens usually means the wrong `files`
glob. `data/<id>/catalog.json`, `tokens.json` and `docs-index.json` are committed -- review
that diff like a diff to code, not build output.

## 3. Doctor

`npx tsx src/cli.ts doctor --system <id>`

Check: every line reads `ok`. A `FAIL` on the root means the path in `ds.config.json` is
wrong or `rootEnv` is not set here. A `FAIL` on freshness means extract needs a re-run.

## 4. Smoke-test the server

Either start it (`npx tsx src/cli.ts serve --config ds.config.json`) and drive it with a real
client, or write a one-off script that builds `createServer()` (`src/server.ts`) against the
SDK's in-memory transport and calls tools directly -- faster to iterate on.

Check: `search_components` on a real name returns it at the top; a guessed name not in the
system returns `missing` with a `nearest` list, never a fabricated `exact` match. An `exact`
match on a name known not to exist is a bug in extraction, not something to route around.

## 5. Generate the agent surface

`npx tsx src/cli.ts generate all --system <id> --target <their repo>`

Writes the AGENTS.md section, `llms.txt`/`llms-full.txt`, the `use-<id>` and `review-<id>`
skills, editor rules, and `.well-known/mcp/servers.json` into the target repo -- the system's
own repo, or an app that consumes it, wherever the team's agents work. Re-running after a data
change updates these in place: hand-written text around the fenced markers in AGENTS.md and
copilot-instructions.md is untouched, and a hand-authored llms.txt or SKILL.md at the same
path is left alone unless `--force` is passed.

## 6. Register the server

Always with an absolute path, or registration breaks once the client's working directory
differs from this repo.

Claude Code: `claude mcp add <id> -- npx tsx <abs>/src/cli.ts serve --config
<abs>/ds.config.json`, or the same command/args in `.mcp.json`'s `mcpServers`. Cursor's
`.cursor/mcp.json` takes the same shape. Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.<id>]
command = "npx"
args = ["tsx", "<abs>/src/cli.ts", "serve", "--config", "<abs>/ds.config.json"]
```

## Authoring aliases.json

After the first real agent session, look at what it got wrong before the server corrected it:
names guessed, props invented. Add those as team entries to `data/<id>/aliases.json` (shape in
`schema/aliases.schema.json`): `alias`, the system's real `target`, a short `note`. This is
how the lexicon's generic guesses (`Card`, `spacing`, ...) become this system's exact fixes.

## Patterns and guidance

Optional: `data/<id>/patterns/*.md` for authored recipes, matched against the schema and
examples already in the repo. Nothing here is required -- catalog, tokens and deprecations
extract mechanically with zero authoring. Offer to draft a first pattern from an existing
story or doc page for the team to edit, rather than write one from scratch.

## Never invent

Every step above keeps one rule true end to end: an agent working against this system should
never have to guess a name, a prop, or a raw value. If a check here fails, fix the data or
config before moving on -- do not patch around it in generated text.

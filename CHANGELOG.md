# Changelog

All notable changes to this template are listed here. The format follows Keep a Changelog; the
project has not been tagged yet.

## Unreleased

### Added

- Nine MCP tools over a committed data layer: search_components, resolve_component, get_component,
  find_token, list_tokens, get_guidance, get_pattern, get_migration, check_usage.
- Resources (`ds://<system>/catalog`, `tokens`, `components/<name>`, `llms.txt`) and the `build-ui`
  prompt.
- Adapters: react-docgen (source trees and published packages, with a props-type fallback),
  custom-elements-manifest, catalog-json, css-vars (Tailwind 4 aware), dtcg, markdown-docs, and a
  Figma Code Connect enricher.
- Hand-written catalog overlay with a scaffold command.
- Three-layer aliases: ecosystem lexicon, Code Connect enum maps, team file.
- `init` wizard for checkouts and for npm packages.
- `generate` for the agent-facing surface: AGENTS.md section, llms.txt, skills, editor rules,
  `.well-known/mcp`.
- Stdio and streamable HTTP transports, health endpoint, bearer token, idle session expiry and a
  session cap (`DS_MCP_SESSION_TTL_MS`, `DS_MCP_MAX_SESSIONS`).
- Type-only exports are recorded so they never appear as undocumented components.
- Freshness checks for catalog, tokens, docs and Code Connect; idempotent extract.

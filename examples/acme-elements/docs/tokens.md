# Tokens

Acme Elements ships two layers of design tokens as CSS custom properties in `tokens.css`.

## Base layer

Raw values: the gray and brand color scale, a 4px space scale, radii, font sizes and
durations. Base tokens are named by scale position (`--acme-gray-900`, `--acme-space-4`), not
by where they are used. Do not reference base tokens directly from component code or app code;
they exist so the semantic layer has something to point at.

## Semantic layer

Named by intent: `--acme-color-text-default`, `--acme-color-surface-sunken`,
`--acme-color-accent-emphasis`. Semantic tokens reference base tokens with `var()`. This is
the layer to use everywhere: it is what changes between light and dark, so hardcoding a base
color or a raw hex value breaks theming.

## Theming

The semantic layer has a light value (the default, declared on `:root`) and a dark override,
applied two ways: an explicit `[data-theme="dark"]` attribute on any ancestor, or
`prefers-color-scheme: dark` when no explicit theme is set. Set `data-theme="light"` to opt an
element back out of the system preference.

## Common mistake

Writing `color: #18222c` instead of `color: var(--acme-color-text-default)` reads correctly in
light mode and silently breaks in dark mode. If you catch yourself typing a hex value in
component styles, there is almost always a semantic token for it.

# Getting started with Acme Elements

Acme Elements is a small set of web components. Register the package once, then use the
elements as plain HTML tags anywhere in your markup.

## Install

```html
<script type="module" src="https://example.invalid/@acme/elements/register.js"></script>
```

## Use a component

```html
<acme-surface tone="brand">
  <acme-stack gap="md">
    <acme-alert state="success">Saved.</acme-alert>
    <acme-button variant="primary">Continue</acme-button>
  </acme-stack>
</acme-surface>
```

## Naming

Every element tag starts with `acme-`. The class behind each element (for example
`AcmeButton`) is exported for TypeScript users who want typed refs, but you never need to
import it just to render the tag.

## Theming

Components read color from CSS custom properties, not hardcoded values. Load `tokens.css`
once; switch themes by setting `data-theme="dark"` on `<html>` or any ancestor, or by leaving
it unset to follow `prefers-color-scheme`.

# Changelog

## 2.0.0

- **Breaking:** `acme-button`'s `type` attribute is deprecated. Use `variant` instead; it
  carries the same `primary` / `secondary` axis plus a new `ghost` value.
- Added `loading` to `acme-button`, showing a spinner in place of the label while an action is
  in flight.

## 1.4.0

- Added `acme-alert`, with a `dismiss` event for dismissible notices.
- `acme-text-field` now supports `invalid` and `error-text` for inline validation.

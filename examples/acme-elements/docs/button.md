# Button

`acme-button` is a clickable control that triggers an action. Use it for the primary and
secondary actions on a page or inside a dialog.

## Variants

`variant` is the emphasis axis: `primary` for the one action you want the reader to take,
`secondary` for an alternative action, `ghost` for a low-emphasis action next to other
controls.

## Sizes

`size` is `sm`, `md`, or `lg`. Match the size to the density of the surrounding UI; do not mix
sizes in the same row of actions.

## States

`disabled` removes the control from the tab order and dims it. `loading` keeps the control
focusable but replaces the label with a spinner and ignores clicks; use it while an action is
in flight.

## Accessibility

When `acme-button` wraps only an icon (no visible text), it needs an accessible name from the
consumer: set `aria-label` on the element. A button with visible text needs nothing extra; the
text content is its accessible name.

## Migration

The `type` attribute is deprecated. It used to carry the same `primary` / `secondary` axis
that `variant` now carries. Replace `type="primary"` with `variant="primary"`, and
`type="secondary"` with `variant="secondary"`.

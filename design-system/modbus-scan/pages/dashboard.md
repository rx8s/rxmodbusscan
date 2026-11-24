# Dashboard overrides

This page is an operator tool, not a marketing landing page. Apply the Master palette and tokens with restrained translucency. Keep data tables and form surfaces opaque enough for sustained reading; reserve blur for decorative header depth only.

- Thai text uses the operating system's Thai-capable sans font. Use Fira Code only for Latin protocol labels and numeric data, falling back to the system mono font. Do not fetch fonts at runtime; localhost use should work offline.
- Desktop body text is at least 14px; mobile body and editable input text are 16px. Compact metadata can be 12–13px when contrast remains sufficient.
- Interactive controls are at least 44px high on touch layouts. Give every focusable control a visible 3px focus ring.
- Keep the connection and scan controls in the sidebar on desktop. On narrow screens stack controls above results and keep the page itself within the viewport; wide data tables may scroll inside a labelled container.
- Values and connection state must include text, not color alone. Errors stay visible near the affected form section and preserve entered values.
- Use one green primary action per context. Destructive/stop actions are red. Use a consistent 2px SVG stroke for functional icons and accessible names for icon-only buttons.
- Respect reduced motion; keep hover and state transitions short and avoid movement that shifts layout.

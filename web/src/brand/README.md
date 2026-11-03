# Default theme

Vendored from the [AIsa](https://aisa.one) design system: `aisa-tokens.css` (colour, type and spacing tokens),
the self-hosted fonts, `aisa-charts.{js,css}` (the compact chart library the home page and data boards use),
`aisa-report.{js,css}` (the report series: counted marks and motion in reading order, used by the same modules) and
`aisa-ui.css` with `motif/` (the component styles, all prefixed `aisa-`, used by pages such as the data source detail page).
The `--aisa-*` names are the theme's token names; a company recolours the hub with `HUB_ACCENT`
and swaps the logo with `HUB_BRAND_DIR` (see `.env.example`) rather than editing these files.

Fonts are under the SIL Open Font License 1.1, see `LICENSE-*.txt` in this folder.

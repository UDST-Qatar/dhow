# Sustainable Dhows Retrofitting in Qatar

Showcase site for the **MoECC-UDST-5** progress report (January 2026) — UDST's project on retrofitting traditional Qatari Dhow vessels with electric propulsion.

A long-form, editorial single-page site with a built-in live-telemetry dashboard pulling from the onshore charging station's published Google Sheet.

## Stack

- **Astro 6** + **Tailwind v4** — content-first, ships ~0 KB JS by default
- **TypeScript (strict)** — types live in `src/lib/`
- No client-side framework runtime; the live-data dashboard is a vanilla TS island

## What's on the page

| Section | What it shows |
|---|---|
| Hero | Bilingual masthead (EN + AR), 1:5 prototype longitudinal cutout, key project stats |
| Background | Reference vessel facts (Al Arour), 4-phase status timeline |
| Prototype | Stability simulations, rudder + servo, structural & PV frames |
| Onboard electrical | Electric box, BMS, V1/V2 data-logger PCBs |
| Charging station | System architecture, layers, JSON-over-serial protocol |
| **Live data** | Tabbed dashboard pulling the published sheet — Inverter and AC unit panels |
| VR training | Sim screenshots + user-testing improvements |
| Safety framework | 4-domain grid mapped to IEC / ISO / IMO / NFPA standards |
| eDhow Competition | Components grid + 3-phase format + Apr 1 2026 callout |
| Team | Investigators + students & research engineers |
| Footer | UDST-blue masthead, project leadership, recipient, report metadata |

## Live telemetry

The "Live data" section reads two tabs of a published Google Sheet over the gviz CSV endpoint:

| Tab | Columns |
|---|---|
| `inverter1` | Battery V/%, PV1 power, load, AC voltages, heatsink temps, inverter bus, lifetime kWh |
| `ac_unit1` | Internal cabin temp, cool setpoint |

How it stays fast and resilient:

1. **Build-time snapshot** — both sheets are fetched in `LiveData.astro`'s frontmatter and the parsed samples are baked into the HTML as a JSON island. First paint shows real numbers without a network round trip.
2. **localStorage cache** with a 5-minute TTL (per source, separate keys).
3. **SWR pattern at runtime** — cached data renders immediately, then a background fetch revalidates and updates the dashboard without flashing.
4. **Re-fetch triggers** — every 5 min via `setInterval`, plus on tab visibility change.

Charts are vanilla SVG (no chart library) — see `src/lib/chart.ts`. Bucket-averaged downsampling keeps render cost flat regardless of range.

### Pointing it at a different sheet

Set `PUBLIC_SHEET_ID` in `.env`:

```bash
cp .env.example .env
# edit PUBLIC_SHEET_ID=<your-spreadsheet-id>
```

The component derives both tab URLs from the ID:

```
https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:csv&sheet=inverter1
https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:csv&sheet=ac_unit1
```

The sheet must be published (File → Share → "Anyone with the link"). Tab names must match `inverter1` / `ac_unit1` — or rename in `src/components/LiveData.astro`.

## Project structure

```
src/
├── assets/
│   ├── brand/           # UDST logos (full + monogram)
│   └── report/          # 28 figures from the docx, renamed
├── components/
│   ├── BaseLayout       # html shell, fonts, lightbox mount
│   ├── Header           # scroll-aware sticky topbar
│   ├── Hero             # bilingual masthead + prototype cutout
│   ├── Section          # standard section wrapper (eyebrow / title / lede / slot)
│   ├── SectionDivider   # symmetric rule between sections
│   ├── Figure           # image + caption, opens in lightbox on click
│   ├── Lightbox         # fullscreen gallery (←/→/Esc/swipe)
│   ├── ChartFrame       # titled card hosting one chart instance
│   ├── LiveData         # tabbed dashboard (Inverter / AC unit)
│   ├── CodeSnippet      # editorial code block (used for JSON protocol)
│   ├── PhaseTimeline    # 4-phase status row
│   ├── Stat             # number + label
│   └── Footer           # UDST-blue masthead, leadership, metadata
├── lib/
│   ├── sheet.ts         # CSV parse, fetch + SWR cache, downsample, derived stats
│   └── chart.ts         # SVG line-chart class with crosshair + tooltip
├── layouts/
│   └── BaseLayout.astro
├── pages/
│   └── index.astro
└── styles/
    └── global.css       # tailwind v4 + UDST design tokens
```

## Lightbox / image gallery

Every `<Figure>` on the page is a lightbox trigger. The `Lightbox` component (mounted once in `BaseLayout`) collects all `[data-lb]` elements at click time, treats them as one ordered gallery, and supports:

- `←` / `→` arrows or buttons to step through
- `Esc` or backdrop click to close
- Swipe gestures on mobile
- Neighbour preloading after each navigation

A pre-generated 1800 px WebP variant (via `getImage()` at build time) is passed to the lightbox so zoomed views are sharp without runtime work.

## Branding

- **Primary**: UDST blue `#0055B8`
- **Deep**: `#003E87` (used in the footer + scrolled-state hovers)
- **Tints**: `#EAF1FA` (surfaces), `#F5F8FC` (washes)
- **Ink**: `#1D1E1C` (logo near-black)

The brand colour is used as a **background** more than a text accent — footer block, code-snippet header strip, "Save the date" callout, the highlighted Battery card on the live dashboard. Editorial neutrals (off-white paper, paper-soft surface) carry the body content.

Charts use a cool palette only: UDST blue · forest green · slate · deep violet — no warm colours.

## Commands

```sh
npm install      # install deps
npm run dev      # dev server (default :4321 — Astro picks the next free port)
npm run build    # static build → ./dist/
npm run preview  # preview the production build locally
```

## Deploying

Static output — `npm run build` produces `./dist/` ready for any static host (Cloudflare Pages, Vercel, Netlify, GitHub Pages).

Two things happen at build time and need network access for the freshest output:

1. The two Google Sheet tabs are fetched and baked into the HTML.
2. `getImage()` generates the lightbox variants for each figure.

If the build runs offline the snapshot is empty — the runtime SWR fetch picks it up the first time the page loads.

## Status

| | |
|---|---|
| Report | MOECC-UDST-5 · Version A — Progress · 26 Jan 2026 |
| Phase | 3 / 4 — prototype development & validation (ongoing) |
| Paper | Accepted at OMAE 2026, Tokyo (safety framework) |
| Competition | UDST Skills Day · 1 April 2026 |

## License

Internal UDST research project. All report content, figures, and brand assets © UDST / MoECC.

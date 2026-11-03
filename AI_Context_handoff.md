# AI Context Handoff — Empyre Pulse

> Audience: an autonomous coding agent that will maintain and extend this repo.
> This document is the single source of truth for how the project is built and
> why. Read it fully before editing. It is written to be acted on, not skimmed.

---

## 0. TL;DR operating rules (do not violate without reason)

1. **The app code lives on branch `cursor/airbnb-earnings-heatmap-6a03`.** The
   `main` branch currently holds only a seed commit. Do not assume `main` has
   the app. Confirm with `git branch --show-current` and `git ls-files`.
2. **Dev server runs on port `44317`.** Never 3000. Scripts hardcode it.
   For remote/preview access bind the host: `npx next dev -H 0.0.0.0 -p 44317`.
3. **`maplibre-gl` is pinned to v5 (`^5.24.0`). Do NOT upgrade to v6+.** v6 drops
   the default export and its vector-tile web worker dies silently → black map.
   Always import named: `import { Map as MapLibreMap, NavigationControl, GeolocateControl } from "maplibre-gl"`.
4. **This is Next.js 16 (Turbopack), not the Next you were trained on.** APIs and
   conventions differ. When unsure, read `node_modules/next/dist/docs/`. The
   `AGENTS.md` agent-rules block is auto-written by `next dev`; commit it with
   your changes rather than fighting it.
5. **No secrets, no `.env`, no database server.** The Airbnb endpoint is
   unauthenticated (public key only); the basemap is CARTO's free style. If you
   think you need a key, you are doing it wrong. Collected gross estimates are
   the one exception to the old "no database" rule: they accumulate in a local
   SQLite file via Node's built-in `node:sqlite` (see §13). Still no accounts,
   no hosted database, no API keys. Node 22+ is required for that driver.
6. **Verify before claiming done:** `npm run typecheck` and `npm run lint` must
   both pass clean. For behavior, hit the API directly with `curl` (see §9).
7. **Gross revenue only.** Every number this app shows is gross booking revenue.
   Never silently relabel it as profit/net.

---

## 1. What this project is

Empyre Pulse is a short-term-rental **earnings heatmap**. The user picks a place
or pans a map; the app sweeps a grid of coordinates across the visible area and
asks Airbnb's own host-landing-page endpoint "how much could you earn here?" once
per grid cell, painting the answers as a heatmap that streams in progressively.

A second mode cross-checks against **Inside Airbnb** (public-domain per-listing
scrapes of 123 markets), reconstructing revenue with a published occupancy model
and ranking neighbourhoods.

Product identity: name **Empyre Pulse**, brand purple `#702B9B`
(`oklch(0.444 0.176 309.1)`). Logos in `public/empyre-pulse-logo.png` (full
wordmark) and `public/empyre-emblem.png` (emblem only, used at small sizes).
App icons: `src/app/icon.png`, `src/app/apple-icon.png`.

GitHub: `https://github.com/amirsaade/empyre-pulse` (public; read-only to the
public, pushes restricted to the owner). License: MIT.

---

## 2. Tech stack (exact, as pinned in package.json)

| Area | Choice | Version | Notes |
| --- | --- | --- | --- |
| Framework | Next.js | `16.3.4` | App Router, Turbopack, React Server + Client Components |
| Language | TypeScript | `^5` | `strict`; path alias `@/*` → `src/*` |
| React | react / react-dom | `19.2.8` | |
| Styling | Tailwind CSS | `^4` | via `@tailwindcss/postcss`; tokens in `globals.css` |
| UI primitives | shadcn/ui + radix-ui | `shadcn ^4.21`, `radix-ui ^1.6.7` | components in `src/components/ui/` |
| Map | maplibre-gl | `^5.24.0` | **PINNED. Do not bump to v6.** |
| Data viz | deck.gl (+ aggregation, layers, mapbox, react) | `^9.4.0` | overlaid on MapLibre via `MapboxOverlay` |
| Icons | lucide-react | `^1.43.0` | |
| Command menu | cmdk | `^1.1.1` | market picker |
| Tooling | eslint `^9` (`eslint-config-next`), tsx `^4.23` | | `tsx` runs the `.mts` snapshot script |

There is **no Jest/Vitest**. `npm run verify:collector` runs Node's built-in
test runner through `tsx` for the collector's throttle, stop, and resume rules.
Everything else is typecheck + lint + manual/`curl`. Do not assume `npm test`.

---

## 3. Repository map (every file that matters)

```
AI_Context_handoff.md         This file.
AGENTS.md                     Auto-managed Next.js agent-rules block. Leave it.
CLAUDE.md                     Just "@AGENTS.md".
README.md                     Human-facing project doc. Keep in sync on big changes.
LICENSE                       MIT.
components.json               shadcn config (style, aliases).
next.config.ts                allowedDevOrigins (see §7.2). Add config here.
eslint.config.mjs             ESLint flat config (next core-web-vitals + TS).
postcss.config.mjs            Tailwind v4 postcss plugin.
tsconfig.json                 strict TS, @/* alias.
package.json                  Scripts + pinned deps.

data/snapshots/*.json         Pre-baked Inside Airbnb markets (offline fallback):
                              austin-texas, new-york-city-new-york,
                              paris-ile-de-france, san-francisco-california.

public/empyre-pulse-logo.png  Full logo (wordmark). Used in README + large UI.
public/empyre-emblem.png      Emblem crop. Used at <=32px (header, mobile).
public/*.svg                  Default Next placeholders (unused, harmless).

scripts/build-catalog.mjs     Regenerates src/data/markets.json by scraping the
                              Inside Airbnb "Get the Data" index. `npm run build:catalog`.
scripts/build-world-grid.mjs  Regenerates the land mask, population grid, and
                              Inside Airbnb reservation anchors. `npm run build:grid`.
scripts/snapshot.mts          Bakes a market CSV into data/snapshots/<slug>.json.
                              `npm run snapshot -- <slug> [...]`. ESM (.mts) for
                              top-level await; run via tsx.
scripts/collect.mts           Background world collector. `npm run collect`. (§13)

data/grid/land-mask-1deg.bin  1° land bitset (Natural Earth 110m). Oceans are off.
data/grid/population-1deg.json  Max GeoNames population per land cell.
data/grid/market-anchors.json Reservation circles for the 123 Inside Airbnb markets.
data/collected/estimates.sqlite  The gross-estimate store. WAL/SHM are gitignored.

src/app/layout.tsx            Root layout. Dark mode (<html class="dark">), metadata,
                              fonts. Title "Empyre Pulse — ...".
src/app/page.tsx              Server component: loads MARKETS, renders <Dashboard>.
src/app/globals.css           Tailwind v4 + design tokens (oklch). Brand purple is
                              --primary / --ring / --sidebar-primary.
src/app/icon.png              Favicon (emblem). src/app/apple-icon.png likewise.

src/app/api/scan/route.ts         POST. Streams the live grid scan as NDJSON. (§4)
                                  Successful cells are also upserted into the store.
src/app/api/collected/route.ts    GET. World-tab payload for one currency + room type.
src/app/api/place/route.ts        GET ?q=&currency=. Resolves place → bounds+headline.
src/app/api/markets/route.ts      GET. Lists all Inside Airbnb markets.
src/app/api/markets/[slug]/route.ts GET. Loads one market dataset (cache/net/snapshot).

src/lib/airbnb-estimate.ts    Client for Airbnb GetHostEstimateData. THE core integration. (§5)
src/lib/estimate-record.ts    Types for a stored gross estimate. Safe to import from client components.
src/lib/estimate-store.ts     SQLite store. Server and collector only — imports `node:sqlite`.
src/lib/collect-policy.ts     Pure delay / backoff / stop / resume decisions. No I/O.
src/lib/collector.ts          One collector run. One Airbnb request in flight.
src/lib/world-grid.ts         1° cell ids, land mask, population order, reservation test.
src/lib/aggregate-market.ts   Inside Airbnb listings → median gross monthly per world cell.
src/lib/scan.ts               Grid math over a bounding box; types for scan stream.
src/lib/inside-airbnb.ts      MARKETS registry, CSV→MarketDataset, caching, fallback.
src/lib/revenue.ts            "San Francisco Model" occupancy/revenue + median/percentile.
src/lib/market-stats.ts       Filter + model + neighbourhood rollups → MarketSummary.
src/lib/csv.ts                Minimal RFC-4180 CSV parser.
src/lib/types.ts              Market, MarketDataset (columnar), ModelParams, Filters.
src/lib/color.ts              Magma ramp, normalize, percentile colorDomain.
src/lib/format.ts             Intl money/count/percent/date formatters (cached).
src/lib/utils.ts              cn() classname helper (shadcn).

src/hooks/use-area-scan.ts    Client hook: drives /api/scan NDJSON, rAF-batches cells.

src/components/dashboard.tsx        TOP-LEVEL client orchestrator. Map + panels + deck layers.
src/components/map-canvas.tsx       MapLibre + deck.gl MapboxOverlay wrapper.
src/components/live-scan-panel.tsx  "Airbnb live" tab UI (search, filters, scan, results).
src/components/city-data-panel.tsx  "City data" tab UI (market picker, model sliders, ranks).
src/components/world-panel.tsx     "World" tab UI. Reads /api/collected. Gross, one currency.
src/components/legend.tsx           Color legend.
src/components/methodology-dialog.tsx  Explains data sources/method.
src/components/stat-tile.tsx        Single stat display.
src/components/ui/*                 shadcn primitives. Prefer these over hand-rolling.

src/data/markets.json         123-market catalog (generated by build-catalog).
```

---

## 4. Live scan data flow (the primary feature)

End to end, "Airbnb live" tab:

1. **Search** (`dashboard.tsx` → `handleSearch`): `GET /api/place?q=<name>&currency=<cur>`.
   `place/route.ts` calls `fetchEstimateWithRetry` with `ENTIRE_HOME, bedrooms:2`,
   reads Airbnb's `suggestedMapBounds` (padded via `padBounds`) or falls back to a
   box around the mean comparable. Returns `{ name, description, bounds, headline }`.
   Dashboard flies the map to `bounds` (`focus` prop → `map.fitBounds`).
2. **Scan** (`handleScan`): takes the *current map bounds* (`mapHandle.getBounds()`),
   calls `useAreaScan.start({ bounds, resolution, roomTypeCategory, bedrooms, currency })`.
3. **Hook** (`use-area-scan.ts`): `POST /api/scan` with that body; reads the
   response as an **NDJSON stream**; parses line-by-line; **batches cells into
   `requestAnimationFrame` flushes** so 400 cells don't thrash React/the map.
4. **Server** (`scan/route.ts`): validates input (`bounds` valid; `roomTypeCategory`
   in `ENTIRE_HOME|PRIVATE_ROOM`; `0<=bedrooms<=8`). Builds grid via `buildGrid`
   (clamped `resolution` 4..20, hard cap `MAX_CELLS = 400`). Runs `CONCURRENCY = 8`
   workers, each calling `fetchEstimateWithRetry` per cell. Emits events:
   - `{type:"meta", total, rows, cols, cellHeight, cellWidth, currency}` first
   - `{type:"cell", cell:{index,latitude,longitude,monthly,nightly,nights}, comparables:[...]}`
   - `{type:"empty", index}` — valid "no supply here"
   - `{type:"error", index, message}`
   - `{type:"done", filled, empty, failed, elapsedMs}` last
   A successful cell is also written to the SQLite store (`persistScanEstimate`)
   with source `GetHostEstimateData`. That write is best-effort and does not
   change `MAX_CELLS` (400) or `CONCURRENCY` (8). Empty scan cells are not stored;
   the collector stores its own empties so it does not retry them.
   Response headers: `content-type: application/x-ndjson`, `cache-control: no-store`,
   `x-accel-buffering: no`. `maxDuration = 300`, `dynamic = "force-dynamic"`.
5. **Render** (`dashboard.tsx` `layers` memo): a deck.gl `PolygonLayer<ScanCell>`
   colored by `magma(normalize(monthly, low..high))` where `[low,high]` is the 5–95
   percentile domain (`colorDomain`). `extruded` toggles 3D columns
   (`getElevation = normalize(...) * 900`) and tilts the map (`pitched` → pitch 50).
   Optional `ScatterplotLayer` of comparables when `showComparables`.

**To add a scan parameter** (e.g. bathrooms): thread it through `ScanConfig`
(`live-scan-panel.tsx`) → `ScanRequest`/`ScanOptions` (`scan.ts`,
`use-area-scan.ts`) → validate in `scan/route.ts` → add to the `EstimateQuery`
and `buildUrl` variables in `airbnb-estimate.ts`.

---

## 5. Airbnb GetHostEstimateData integration (critical, fragile)

File: `src/lib/airbnb-estimate.ts`. This is an **undocumented, unauthenticated**
internal Airbnb GraphQL persisted query — the same one their host landing page
uses. It can change without notice; everything degrades to a `null` cell rather
than throwing, so one bad point never fails a whole scan.

- Endpoint: `https://www.airbnb.com/api/v3/GetHostEstimateData/<HASH>`
- `AIRBNB_API_KEY = "d306zoyjsyarp7ifhu67rjxn52tv0t20"` (public web key; sent as
  header `X-Airbnb-API-Key`).
- `HOST_ESTIMATE_HASH = "a929d4d832695d0dc9344afb283387ecc8140f6e58b5a1949051898afe6e1167"`
  (used both in the URL path and `extensions.persistedQuery.sha256Hash`).
- Query vars: `durationGranularity:["MONTHLY"]`, `source:"HOST_LANDING_PAGE"`,
  `location.searchQuery` (**a place name OR a raw `"lat,lng"` string** — this is
  what enables arbitrary grid sampling), `roomTypeCategory`, `bedroom`,
  `fetchDebugInfo:false`. Query string also sets `locale=en`, `currency`.
- `ROOM_TYPE_CATEGORIES = ["ENTIRE_HOME","PRIVATE_ROOM"]`.
- Response → `Estimate`: `monthly`, `nightly`, `nights`, `currency`, `description`,
  `locationName`, `comparables[]` (id, lat/lng, nightly, title, rating, reviews,
  superhost, url), `bounds` (from `suggestedMapBounds`).
- `parseAmount` handles both `"€1,234"` (en) and `"1.234,56"` (eu) display strings.
- `fetchEstimateWithRetry(query, attempts=3, signal)` — exponential backoff
  (400·2^n ms); a `null` result is NOT retried (it's a valid empty area).
- `coordQuery(lat,lng)` → `"48.3064,18.0863"` (4 dp).

**If scans suddenly return all-empty or error:** Airbnb likely rotated the
persisted-query hash or key. Re-capture both from a logged-out
`airbnb.com/host/homes` session (DevTools → the `GetHostEstimateData` request)
and update the two constants. This is the single most likely breakage.

---

## 6. Inside Airbnb / City data flow (secondary feature)

- `src/data/markets.json` (123 markets) is the registry, generated by
  `scripts/build-catalog.mjs` scraping `insideairbnb.com/get-the-data/`. Each
  `Market` has `slug, city, region, country, scrapedAt, currency, summaryUrl,
  neighbourhoodsUrl`. Currency is derived from the URL country segment (Inside
  Airbnb never states it). Inside Airbnb re-scrapes ~quarterly, which **changes
  download URLs** — re-run `npm run build:catalog` when loads start 404ing.
- `GET /api/markets/[slug]` → `loadDataset` resolves in order:
  memory cache → disk cache (`.cache/markets/<slug>-<scrapedAt>.json`, gitignored)
  → network (`summaryUrl` CSV, parsed by `buildDataset`) → **committed snapshot**
  (`data/snapshots/<slug>.json`). Source is reported in `x-data-source` header.
- `buildDataset` (`inside-airbnb.ts`) parses the summary CSV into a **columnar**
  `MarketDataset` (see §8) — ~3× smaller than array-of-objects and map-ready.
  Listings with no price/coords are dropped (`skipped`).
- `summarizeMarket` (`market-stats.ts`) applies `MarketFilters`, runs the revenue
  model per listing, and rolls up by neighbourhood (medians, min 3 listings per
  neighbourhood to count). Returns `MarketSummary` consumed by the HeatmapLayer +
  HexagonLayer in `dashboard.tsx`.
- Revenue model (`revenue.ts`, the "San Francisco Model"):
  `bookings = reviewsLtm / reviewRate`;
  `nightsPerBooking = clamp(max(minNights, averageStay), ..30)`;
  `nights = min(bookings * nightsPerBooking, 365 * maxOccupancy)`;
  `revenue = nights * price`. `ModelParams` defaults:
  `reviewRate 0.5, averageStay 3, maxOccupancy 0.7` — all exposed as UI sliders.

**To add a pre-baked market:** `npm run snapshot -- <slug>` (writes
`data/snapshots/<slug>.json`), then commit the JSON.

---

## 7. Conventions, gotchas, and hard-won fixes

### 7.1 Rendering / map

- deck.gl overlay is **non-interleaved** (`new MapboxOverlay({ interleaved: false })`).
  Interleaving (to slot layers under labels) crashes this MapLibre version. Cells
  are drawn semi-transparent instead to keep labels legible. Do not flip this.
- Basemap is CARTO's **vector** dark style
  (`https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json`). Their
  raster tiles now stamp "API KEY REQUIRED". Keep vector.
- `MapCanvas` creates the map exactly once; `onBoundsChange`/`onReady` are kept in
  refs and synced in an effect so the init effect has `[]` deps. Follow that
  pattern — do not add changing deps to the map-init effect.

### 7.2 Next.js 16 dev

- `next.config.ts` sets `allowedDevOrigins` (127.0.0.1, localhost, 0.0.0.0, and
  `*.cursor.sh|cursor.com|ngrok-free.app|trycloudflare.com`). Without it, Next 16
  returns 403 for `/_next/*` dev assets to "cross-origin" hosts, hydration fails,
  and the page renders as dead HTML (no map, no interactivity). Add new preview
  hosts here if previews break.

### 7.3 ESLint rules that WILL bite you (all previously hit)

- `react-hooks/set-state-in-effect`: don't `setState` directly in an effect body.
  Market loading was refactored into a `useCallback` (`selectMarket`) for this.
- `react-hooks/refs`: don't read/write a ref during render; sync in an effect.
- `react-hooks/exhaustive-deps`: keep dep arrays honest; import concrete types
  instead of `typeof someState` to avoid phantom deps.
- deck.gl composite-layer `onHover` must **return `false`** (not `undefined`) to
  satisfy the handler signature while meaning "not handled" (see HexagonLayer).

### 7.4 Data / modeling

- `MarketDataset` is **columnar**: every array is length `count`, index `i` is one
  listing across all arrays. `roomType[i]` indexes `ROOM_TYPES`; `neighbourhood[i]`
  indexes `dataset.neighbourhoods`. Preserve this shape — the map reads it directly.
- Use **medians, not means**, for any market/neighbourhood rollup; luxury outliers
  wreck means.
- Color domains use **5–95th percentile** (`colorDomain`) so one outlier cell
  doesn't wash the map to a single color.

### 7.5 Scripts / modules

- `scripts/snapshot.mts` is `.mts` on purpose (ESM top-level await, `@/` alias) and
  is run with `tsx`. Don't rename to `.ts`/`.mjs` or it breaks.
- `scripts/build-catalog.mjs` throws if it parses `<50` markets — a guard against
  the Inside Airbnb page layout changing silently.

---

## 8. Core types (src/lib/types.ts + scan.ts + airbnb-estimate.ts)

- `Market`: `{ slug, city, region|null, country, scrapedAt(ISO), currency(ISO4217), summaryUrl, neighbourhoodsUrl }`
- `MarketDataset` (columnar): `{ market, count, skipped, center{lat,lng}, neighbourhoods[], lat[], lng[], price[], minNights[], reviewsLtm[], reviewsTotal[], availability[], roomType[](idx), neighbourhood[](idx), hostListings[] }`
- `ModelParams`: `{ reviewRate, averageStay, maxOccupancy }`; `DEFAULT_MODEL = {0.5, 3, 0.7}`
- `ROOM_TYPES = ["Entire home/apt","Private room","Shared room","Hotel room"]`
- `ScanRequest`: `{ bounds{north,south,east,west}, resolution, roomTypeCategory, bedrooms, currency }`
- `ScanCell`: `{ index, latitude, longitude, monthly, nightly, nights }`
- `ScanEvent`: union of `meta | cell | empty | error | done` (see §4)
- `MAX_CELLS = 400`, `RESOLUTION_OPTIONS = [6,8,10,12,16]`
- `Estimate` / `Comparable`: see §5.

---

## 9. How to run and verify (do this every change)

```bash
# from repo root, on branch cursor/airbnb-earnings-heatmap-6a03
npm install
npm run dev            # http://localhost:44317  (use -H 0.0.0.0 for remote preview)

npm run typecheck      # tsc --noEmit — MUST be clean
npm run lint           # eslint — MUST be clean
npm run build          # production build sanity check for bigger changes
```

Verify the live scan without a browser (fast, deterministic):

```bash
# resolve a place to bounds
curl -s "http://127.0.0.1:44317/api/place?q=Bratislava&currency=EUR"

# run a scan (NDJSON stream) against those bounds
curl -s -X POST http://127.0.0.1:44317/api/scan \
  -H 'content-type: application/json' \
  -d '{"bounds":{"north":48.216,"south":48.107,"east":17.176,"west":17.084},
       "resolution":8,"roomTypeCategory":"ENTIRE_HOME","bedrooms":2,"currency":"EUR"}'
```

Expect a leading `meta` line, many `cell`/`empty` lines, then `done`. If every
line is `empty`/`error`, suspect the Airbnb hash/key (§5). For UI/visual changes,
drive a real browser (the human previews on port 44317; a `computerUse` agent can
operate the desktop Chrome).

Other scripts: `npm run build:catalog` (refresh `src/data/markets.json`),
`npm run snapshot -- <slug>` (bake an offline market),
`npm run collect` (resume the world collector, §13),
`npm run verify:collector` (throttle / stop / grid-resume checks, no Airbnb traffic).

---

## 10. Git workflow

- Branch naming in this project uses the `cursor/<desc>-6a03` convention; the
  live app branch is `cursor/airbnb-earnings-heatmap-6a03`.
- Commit per logical change with a clear message; stage only related files
  (don't sweep in `.cache/`, `node_modules/`, scratch files).
- `.gitignore` already excludes `.cache/`, `node_modules/`, `.next/`.
- Binary assets (the logo PNGs) must go through a real `git push` — API/file
  tools that take string content will corrupt them.
- Do not force-push shared branches or amend published history unless explicitly
  asked.

---

## 11. Non-goals / constraints (don't "helpfully" add these)

- No auth, no hosted database, no server-side user accounts. The store in §13
  is a local SQLite file, not a database server. Do not add a second store.
- No paid/keyed map provider; no second component library beyond shadcn/radix.
- Don't present estimates as net profit; don't remove the gross-revenue caveats
  in `methodology-dialog.tsx` / README. Do not FX-convert the world view.
- Don't widen Airbnb scan concurrency or the 400-cell cap — it's deliberately
  polite to an undocumented endpoint. The collector is a separate, stricter path.
- Don't lower the collector's 5 second delay floor, overlap its requests, or
  let it continue after a 429 or 403 without `--acknowledge-stop`.
- Don't upgrade `maplibre-gl` past v5 or re-enable interleaved deck rendering
  without proving the map still draws.
- Don't change `CELL_DEGREES` (1) once the store has rows. Cell ids would orphan.

---

## 12. When something breaks — quick triage

| Symptom | Most likely cause | Where to look |
| --- | --- | --- |
| `ERR_CONNECTION_REFUSED` on 44317 | dev server not running / fresh VM on empty `main` | checkout app branch, `npm install`, `npm run dev` |
| Black map, page looks static | hydration blocked (dev origin) or maplibre v6 | `next.config.ts` allowedDevOrigins; confirm maplibre v5 |
| All scan cells empty/errored | Airbnb rotated hash/key | `src/lib/airbnb-estimate.ts` constants (§5) |
| City market 404/502 on load | Inside Airbnb re-scraped (URL changed) | `npm run build:catalog`; snapshot fallback covers 4 cities |
| Lint fails on hooks | setState-in-effect / ref-in-render / deps | §7.3 |
| deck layer type error on hover | composite `onHover` must return `false` | §7.3 |
| `tsx`/snapshot script fails | wrong extension or not via tsx | keep `.mts`, run `npm run snapshot` |
| `collect` exits 2 immediately | previous run stopped on 429, 403, or an error spike | read the detail in the store; resume with `--acknowledge-stop` |

---

## 13. Collected estimates, the World tab, and the collector

Later requirements superseded the "no database" line **for this store only**.
Results have to accumulate across runs, including when nobody is searching.

### Why SQLite

A JSON file would be rewritten on every cell and is awkward to query for
"is this cell fresh?". SQLite is one file, no server, no credentials, and Node
22 already ships `node:sqlite`, so there is no native addon. The file is
`data/collected/estimates.sqlite` and is committed so a fresh checkout has the
seeded markets. `*.sqlite-wal` and `*.sqlite-shm` are gitignored. The collector
checkpoints on exit.

Each row stores: cell id, center coordinates, cell size in degrees, gross
`monthly` / `nightly` / `nights`, currency, room type, bedrooms, source
(`inside-airbnb` or `GetHostEstimateData`), `fetched_at`, and status
(`estimate` or `empty`). Inside Airbnb has no bedroom column, so those rows
use bedrooms `-1`. There is no FX conversion.

### World tab

`GET /api/collected?currency=&roomType=` returns gross cells for one currency
and one room type. The map uses the existing non-interleaved `MapboxOverlay`
and a `PolygonLayer` coloured with `colorDomain` at the 5th–95th percentile
(`magma`). When both sources share a cell id, the Inside Airbnb figure is the
one drawn. `minZoom` on the map is 1 so the world fits.

### Collector (`npm run collect`)

Independent of user searches. One run:

1. Ingests any stale local snapshots, then at most `--markets` (default 1)
   network markets. Listings are aggregated with the San Francisco Model
   (`DEFAULT_MODEL`) to a median gross month (`annual / 12`). Three failed
   downloads and that market is marked `skipped` so it stops blocking the walk.
2. Walks land cells from `data/grid/`, highest population first. Oceans are
   not in the list. A cell inside the reservation circle of a market that is
   not ingested yet is deferred, not requested. A fresh Inside Airbnb row
   covers the cell even when its currency differs from the Airbnb query.
3. Calls `fetchEstimate` (not `fetchEstimateWithRetry` — that helper's short
   backoff is only for interactive scans). Exactly one call is in flight.

Politeness, enforced in `collect-policy.ts` and covered by
`npm run verify:collector` (no network):

| Rule | Default |
| --- | --- |
| Gap between requests | `--delay-ms` minimum **5000**, plus `--jitter-ms` 2500 random extra |
| Requests per run | `--budget` 24, hard maximum 120 |
| Error backoff | one gap, then double, then double again |
| Hard stop | HTTP 429, HTTP 403, or `--spike` 3 consecutive errors |
| Resume after a hard stop | refuses until `--acknowledge-stop` |
| Freshness | `--fresh-days` 30, including stored empties |
| Airbnb query | `ENTIRE_HOME`, 2 bedrooms, `USD` unless flagged |

Progress (cursor, deferred indexes, stop reason) lives in the same SQLite file.
`--dry-run` prints the next Airbnb cells and writes nothing.

The grid is 1°. Changing it changes every cell id. Reservation radii in
`market-anchors.json` are approximate (120km for a city, larger for regions
such as New Zealand); ingested listing cells are the real coverage.

Do not point a long unattended loop at Airbnb. A budget run is the unit of work.

---

_Keep this file current. If you change the scan protocol, the Airbnb integration,
the dataset shape, the port, the maplibre/deck setup, or the collector's rate
limits, update the relevant section in the same commit._

# AI Context Handoff — Empyre Pulse

> Audience: an autonomous coding agent that will maintain and extend this repo.
> This document is the single source of truth for how the project is built and
> why. Read it fully before editing. It is written to be acted on, not skimmed.

---

## 0. TL;DR operating rules (do not violate without reason)

1. **The app lives on `main`.** `dev` is a long-lived branch created from
   `main` and is never deleted. Code changes go to `dev` via pull requests and
   need Amir's yes before they merge into `main`. Collected data files under
   `data/collected/` may be committed directly to both `dev` and `main`. Do not
   delete or force-push either branch. Confirm with `git branch --show-current`
   and `git ls-files`.
2. **Dev server runs on port `44317`.** Never 3000. Scripts hardcode it.
   For remote/preview access bind the host: `npx next dev -H 0.0.0.0 -p 44317`.
3. **`maplibre-gl` is pinned to v5 (`^5.24.0`). Do NOT upgrade to v6+.** v6 drops
   the default export and its vector-tile web worker dies silently → black map.
   Always import named: `import { Map as MapLibreMap, NavigationControl, GeolocateControl } from "maplibre-gl"`.
4. **This is Next.js 16 (Turbopack), not the Next you were trained on.** APIs and
   conventions differ. When unsure, read `node_modules/next/dist/docs/`. The
   `AGENTS.md` agent-rules block is auto-written by `next dev`; commit it with
   your changes rather than fighting it.
5. **No secrets and no `.env`.** The Airbnb endpoint is unauthenticated
   (public key only); the basemap is CARTO's free style. If you think you need a
   key, you are doing it wrong. Collected estimate data is persisted as JSON
   files in `data/collected/` (§6a). That supersedes the old "no database"
   non-goal for collected data only. There is still no database server and no
   user account state.
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

There is **no test framework** installed. Verification is typecheck + lint +
manual/`curl` API checks. Do not assume `npm test` exists.

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
data/collected/cells/*.json   One gross estimate per cell and query. Empty until
                              a collector writes. See §6a.
data/collected/cursor.json    Grid resumption cursor. JSON `null` when idle.
data/collected/runs.jsonl     Append-only collector run log (one JSON object
                              per line). Empty until the first run.
src/data/europe-land.json     Bundled Natural Earth 1:110m Europe land mask.
src/data/europe-market-cities.json  City points used to walk populated cells first.

public/empyre-pulse-logo.png  Full logo (wordmark). Used in README + large UI.
public/empyre-emblem.png      Emblem crop. Used at <=32px (header, mobile).
public/*.svg                  Default Next placeholders (unused, harmless).

scripts/build-catalog.mjs     Regenerates src/data/markets.json by scraping the
                              Inside Airbnb "Get the Data" index. `npm run build:catalog`.
scripts/snapshot.mts          Bakes a market CSV into data/snapshots/<slug>.json.
                              `npm run snapshot -- <slug> [...]`. ESM (.mts) for
                              top-level await; run via tsx.

src/app/layout.tsx            Root layout. Dark mode (<html class="dark">), metadata,
                              fonts. Title "Empyre Pulse — ...".
src/app/page.tsx              Server component: loads MARKETS, renders <Dashboard>.
src/app/globals.css           Tailwind v4 + design tokens (oklch). Brand purple is
                              --primary / --ring / --sidebar-primary.
src/app/icon.png              Favicon (emblem). src/app/apple-icon.png likewise.

src/app/api/scan/route.ts         POST. Streams the live grid scan as NDJSON. (§4)
src/app/api/store/route.ts        GET. Read-only cells, cursor, and run-log summary.
src/app/api/place/route.ts        GET ?q=&currency=. Resolves place → bounds+headline.
src/app/api/markets/route.ts      GET. Lists all Inside Airbnb markets.
src/app/api/markets/[slug]/route.ts GET. Loads one market dataset (cache/net/snapshot).

src/lib/airbnb-estimate.ts    Client for Airbnb GetHostEstimateData. THE core integration. (§5)
src/lib/store.ts              Collected cells, freshness, cursor, run log. (§6a)
src/lib/europe-grid.ts        0.5° European land grid. Oceans omitted. (§6b)
src/lib/inside-airbnb-grid.ts Local Inside Airbnb gross figures for grid cells.
src/lib/collector.ts          Throttled collector. One Airbnb request at a time.
scripts/collect.mts           `npm run collect`.
scripts/check-collector.mts   Throttle, stop, and resume checks. No Airbnb calls.
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

## 6a. Collected estimate store

Persisted gross estimates accumulate across collector runs (§6b). The live
scan (`POST /api/scan`) does not write this store. `src/lib/store.ts` is the
API the collector uses. The store module itself never calls Airbnb.

**Why JSON files, not SQLite.** The rows have to be committed from a collector
and reviewed in git. SQLite is a binary: diffs are opaque and two branches
cannot merge it. Pretty-printed JSON is text. One file per cell and query means
an upsert rewrites only that record, so a commit shows the cells that run
wrote and two collectors of different cells do not conflict. The run log is
JSONL so each run is one appended line and history is not rewritten. No native
module and no database server.

```
data/collected/cells/<slug>__<source>__<room>__<bedrooms>__<currency>__<hash>.json
data/collected/cursor.json     null, or one GridCursor
data/collected/runs.jsonl      append-only RunLogEntry lines
```

The committed tree ships the directory, `cursor.json` = `null`, and an empty
`runs.jsonl`. No fixture cells.

**Cell record** (`StoredEstimate`), all of these, gross figures only:

- `cellId` — stable id chosen by the collector (not the in-memory scan index)
- `latitude`, `longitude`
- `monthly`, `nightly`, `nights` — gross booking revenue, never net/profit
- `currency` — ISO 4217, stored uppercase
- `roomTypeCategory` — `ENTIRE_HOME | PRIVATE_ROOM | SHARED_ROOM | HOTEL_ROOM`
- `bedrooms` — integer 0..20
- `source` — `airbnb-host-estimate` or `inside-airbnb`
- `fetchedAt` — ISO-8601

Map Inside Airbnb room labels before writing: `Entire home/apt` →
`ENTIRE_HOME`, `Private room` → `PRIVATE_ROOM`, `Shared room` → `SHARED_ROOM`,
`Hotel room` → `HOTEL_ROOM`.

**Dedupe / upsert.** `upsertEstimate` replaces the record whose key is
`cellId + source + roomTypeCategory + bedrooms + currency`. `readEstimate` /
`readEstimates` read them back. Invalid files throw `StoreError`.

**Freshness.** `lookupFreshness(key, { maxAgeMs, now })` returns
`{ record, fetchedAt, ageMs, fresh }`. Missing records are not fresh. Default
`maxAgeMs` is 30 days (`DEFAULT_FRESHNESS_MS`). A `fetchedAt` in the future is
not fresh. A collector uses `fresh === true` to skip a cell.

**Cursor.** One active sweep in `cursor.json`. `writeCursor({ sweepId,
nextIndex, lastCellId, total, roomTypeCategory, bedrooms, currency, source,
stopReason })` sets `updatedAt`. `stopReason` is null while a run is in
progress. `readCursor()` returns the cursor or `null`. `clearCursor()` writes
`null`. `nextIndex === total` means the grid was finished; `nextIndex` cannot
exceed `total`. The cursor `source` for the Europe sweep is
`airbnb-host-estimate` (the remote query). Inside Airbnb cells are still stored
under their own source.

**Run log.** `appendRun` adds one line and does not rewrite older lines.
`readRuns` returns them oldest first. Each entry:

- `date` — ISO-8601
- `cellsCollected` — total stored this run
- `cellsBySource` — `{ "airbnb-host-estimate", "inside-airbnb" }`, sums to `cellsCollected`
- `errors[]` — `{ status, message, count }`. Put HTTP 429 and 403 in `status`
  (`null` when the failure had no status). `count` is how many times it happened.
- `stopped` — true when the sweep did not finish
- `stopReason` — `budget`, `complete`, `http-429`, `http-403`,
  `error-spike-consecutive`, or `error-spike-rate`
- `prsOpened` — pull request URLs (or other ids) opened for that run's data

`summarizeRuns` rolls that up to run count, cells collected, cells by source,
last run time, last stop reason, stopped runs, error counts by status, and the
PR list.

**Read API.** `GET /api/store` (nodejs, `force-dynamic`, `cache-control:
no-store`) returns `{ cells, cellCount, cursor, runLog }` where `runLog` is the
summary. It does not write. Verify with:

```bash
curl -s http://127.0.0.1:44317/api/store
```

An empty store is `{ "cells": [], "cellCount": 0, "cursor": null, "runLog": { ... zeros ... } }`.

---

## 6b. European collector

`npm run collect` (`scripts/collect.mts` → `runCollector` in `src/lib/collector.ts`)
fills the store. It does not change the interactive scan, which stays at 8
concurrent requests and a 400-cell cap.

**Grid.** 0.5° cells from 34°N–72°N and 25°W–40°E. A cell is kept when its
center or a point 0.2° from the center is inside the bundled land mask
(`src/data/europe-land.json`, Natural Earth 1:110m public-domain countries,
plus boxes for microstates and islands the 110m coastline drops). That is
**4248 land cells** out of 9675 candidates. Oceans are not visited. Order:

1. Cells with at least 3 local Inside Airbnb listings of the requested room type.
2. Other cells inside that dataset's bounding box (covered, nothing to store, no Airbnb call).
3. Land within 80 km of a European market city (`src/data/europe-market-cities.json`, the European rows of `src/data/markets.json`).
4. Remaining land, west to east is not the sort; distance to the nearest market city is.

The sweep id is `europe-v1-0.5-<room>-<bedrooms>-<currency>-<snapshot stamp>`.
A matching cursor with `nextIndex < total` resumes there, including after
`http-429` / `http-403` (the blocked cell is retried). A finished sweep starts
again at 0 and skips fresh cells.

**Inside Airbnb first.** For a European market whose currency matches the run,
load `data/snapshots/<slug>.json` if present, otherwise
`.cache/markets/<slug>-<scrapedAt>.json`. Do not download. Derive with
`estimateNightsBooked` / the default San Francisco model. Store
`source: "inside-airbnb"`. `monthly` and `nights` are the annual gross divided
by 12; `nightly` is the median listed price. All three are gross. Summary CSVs
have no bedroom column, so the sample is the room type only and the record is
tagged with the configured bedroom count (default 2). Paris is the European
snapshot shipped today, and it covers two cells (`49.0,2.0` and `49.0,2.5`).

**Airbnb for the rest.** `fetchEstimate` in `src/lib/airbnb-estimate.ts`, never
`fetchEstimateWithRetry` (that helper retries 429 quickly and is for the
interactive scan only).

- Exactly one request in flight.
- Wait `max(5000, delayMs + random * jitterMs)` before every attempt, including the first. Defaults: delay 25s, jitter 5s.
- `--budget` default 45. Integers only. Above 60 throws. Every attempt, including a retry, consumes one.
- Transient statuses 408, 425, 500, 502, 503, 504 and network errors back off to `gap * 2^(retry+1)`, up to 2 retries.
- HTTP 429 or 403: stop immediately, leave `nextIndex` on that cell, `stopReason` `http-429` or `http-403`.
- After a non-fatal cell failure, move past that cell. Stop when 3 consecutive Airbnb cells fail (`error-spike-consecutive`) or, once 5 cells have finished, when failures / finished > 0.2 (`error-spike-rate`). The 5-cell floor is what keeps a single error from always tripping the 20% rule.
- Skip a cell whose record for the source about to be written is fresh. Default 30 days (`--fresh-days`).
- Defaults: `ENTIRE_HOME`, 2 bedrooms, `EUR`. Airbnb accepts only `ENTIRE_HOME` and `PRIVATE_ROOM`.

An empty Airbnb body (no supply) is not an error and is not stored. The cursor
moves on.

**Check without Airbnb.** `npm run check:collector` mocks fetch and sleep. It
must stay green. Do not point it at the real store; it uses a temp directory.

```bash
npm run collect -- --budget 3
```

That is the smoke shape: at most 3 Airbnb attempts, full default spacing.
Code changes after the collector landed go to `dev` via pull requests. Collected
files under `data/collected/` may still be committed directly to `dev` and `main`.

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
- Collected store (`src/lib/store.ts`, §6a): `StoredEstimate`, `EstimateKey`,
  `GridCursor`, `RunLogEntry`, `RunError`, `RunLogSummary`, `Freshness`.
  Sources: `airbnb-host-estimate | inside-airbnb`. Dedupe is cell id plus
  source, room type, bedrooms, and currency.

---

## 9. How to run and verify (do this every change)

```bash
# from repo root. The app is on main; code changes land on dev via PR (§10).
npm install
npm run dev            # http://localhost:44317  (use -H 0.0.0.0 for remote preview)

npm run typecheck      # next typegen && tsc --noEmit — MUST be clean
npm run lint           # eslint — MUST be clean
npm run build          # production build sanity check for bigger changes
npm run check:collector # throttle, stop, and resume. Does not call Airbnb.
```

`LayoutProps` (and `PageProps` / `RouteContext`) are globals Next writes during
`next dev`, `next build`, or `next typegen`. A fresh checkout has no `.next`,
so `tsc` alone fails on `src/app/layout.tsx`. The typecheck script runs
`next typegen` first. Do not commit `.next/` or `next-env.d.ts` (both gitignored).

Read the collected store without calling Airbnb:

```bash
curl -s http://127.0.0.1:44317/api/store
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
`npm run snapshot -- <slug>` (bake an offline market).

---

## 10. Git workflow

- The app lives on `main`. `dev` is a long-lived branch created from `main`.
  Never delete `dev` or `main`.
- Code changes go to `dev` through pull requests. Merging `dev` (or any code
  change) into `main` needs Amir's explicit yes.
- Collected data files under `data/collected/` may be committed directly to
  `dev` and directly to `main`. That is the exception to the PR rule, and it
  applies only to those data files.
- Do not force-push `main` or `dev`. Fast-forward `dev` to `main` only when
  `dev` has no commits of its own.
- Commit per logical change with a clear message; stage only related files
  (don't sweep in `.cache/`, `node_modules/`, scratch files).
- `.gitignore` already excludes `.cache/`, `node_modules/`, `.next/`, and
  `next-env.d.ts`. Do commit `data/collected/` (cells, `cursor.json`,
  `runs.jsonl`).
- Binary assets (the logo PNGs) must go through a real `git push` — API/file
  tools that take string content will corrupt them.
- Do not amend published history unless explicitly asked.

---

## 11. Non-goals / constraints (don't "helpfully" add these)

- No auth and no server-side user state. Collected estimates are the one
  persisted dataset, stored as committed JSON (§6a), not a database server.
  Do not add a database server, an ORM, or user accounts.
- No paid/keyed map provider; no second component library beyond shadcn/radix.
- Don't present estimates as net profit; don't remove the gross-revenue caveats
  in `methodology-dialog.tsx` / README.
- Don't widen Airbnb scan concurrency or the 400-cell cap — it's deliberately
  polite to an undocumented endpoint. Don't run the collector with more than
  one Airbnb request in flight, and don't raise its budget above 60.
- Don't upgrade `maplibre-gl` past v5 or re-enable interleaved deck rendering
  without proving the map still draws.

---

## 12. When something breaks — quick triage

| Symptom | Most likely cause | Where to look |
| --- | --- | --- |
| `ERR_CONNECTION_REFUSED` on 44317 | dev server not running | `npm install`, `npm run dev` on `main` (port 44317) |
| `TS2304 Cannot find name 'LayoutProps'` | `tsc` ran before Next generated route types | `npm run typecheck` (`next typegen` first). Do not hand-write the global |
| Black map, page looks static | hydration blocked (dev origin) or maplibre v6 | `next.config.ts` allowedDevOrigins; confirm maplibre v5 |
| All scan cells empty/errored | Airbnb rotated hash/key | `src/lib/airbnb-estimate.ts` constants (§5) |
| City market 404/502 on load | Inside Airbnb re-scraped (URL changed) | `npm run build:catalog`; snapshot fallback covers 4 cities |
| Lint fails on hooks | setState-in-effect / ref-in-render / deps | §7.3 |
| deck layer type error on hover | composite `onHover` must return `false` | §7.3 |
| `tsx`/snapshot script fails | wrong extension or not via tsx | keep `.mts`, run `npm run snapshot` |

---

_Keep this file current. If you change the scan protocol, the Airbnb integration,
the dataset shape, the port, or the maplibre/deck setup, update the relevant
section in the same commit._

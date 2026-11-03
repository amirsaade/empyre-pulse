<img src="public/empyre-pulse-logo.png" alt="Empyre" width="96" />

# Empyre Pulse

Map what Airbnb hosts actually earn.

Pick an area and Empyre Pulse sweeps a grid of coordinates across it, asking Airbnb
the same question its own host landing page asks - *how much could you earn
here?* - once per cell. The result is an earnings heatmap built from Airbnb's own
figures rather than a statistical reconstruction, painted progressively as the
answers stream back.

A second layer cross-checks that against [Inside Airbnb](https://insideairbnb.com),
whose public-domain scrapes cover every individual listing in 123 markets.

## Why this exists

Airbnb publishes no earnings API. The commercial products that answer this
question - AirDNA, Mashvisor - are closed and paid. The open alternatives are
one-off Kaggle notebooks rather than something you can point at your own market
and use.

Empyre Pulse is that missing tool, and it is MIT licensed.

## The two data sources

### Airbnb host estimate - live, official, coarse

Airbnb's host landing page calls a GraphQL operation named
`GetHostEstimateData`. It is undocumented but unauthenticated: the only
credential is the public web API key that ships in Airbnb's own front-end
bundle. Critically, its location argument accepts a raw `lat,lng` string, so it
can be sampled anywhere rather than only at named places.

Each cell returns Airbnb's own answer - average monthly earnings, the nightly
rate behind it, and nights booked per month - plus around 20 nearby comparable
listings with coordinates and prices.

Because it is an internal endpoint it may change without notice. Scans are
capped at 400 cells and run 8 requests at a time.

### Inside Airbnb - public domain, complete, modelled

[Inside Airbnb](https://insideairbnb.com/get-the-data/) publishes CC0 scrapes of
every listing in 123 markets. That per-listing coverage is what makes the
neighbourhood ranking possible, but Airbnb does not publish bookings, so revenue
is reconstructed with the San Francisco Model that Inside Airbnb itself
publishes:

```
bookings      = reviews in last 12 months / review rate
nights booked = min(bookings × typical stay, 365 × occupancy ceiling)
revenue       = nights booked × nightly price
```

All three assumptions are sliders in the UI, so you can see how sensitive the
answer is to them.

## Reading the numbers honestly

- Both figures are **gross booking revenue**. They exclude cleaning costs,
  Airbnb's host fee, furnishing, management, taxes and mortgage.
- A scrape is a single snapshot, so seasonal pricing is baked in rather than
  averaged out.
- Short-term rental rules vary by street, not just by city. A bright cell does
  not mean letting is permitted there.

## Running it

```bash
npm install
npm run dev
```

Then open <http://localhost:44317>. No API keys and no `.env`. The Airbnb
endpoint needs only its public key and the basemap is CARTO's free dark style.
Collected estimates are JSON files in this repo, not a database server.

Four markets ship pre-baked in `data/snapshots/` so the Inside Airbnb tab works
offline; the other 119 download on first use and cache to `.cache/`.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server on port 44317 |
| `npm run build` | Production build |
| `npm run typecheck` | `next typegen && tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run build:catalog` | Refresh `src/data/markets.json` from Inside Airbnb |
| `npm run snapshot -- <slug>` | Pre-bake a market for offline use |

Inside Airbnb re-scrapes each city roughly quarterly, which changes the download
URLs. Re-run `npm run build:catalog` to pick up new scrapes.

## Collected estimates

A future collector can keep every gross figure it has already fetched. The live
scan does not write this store yet, and nothing here calls Airbnb.

The store is JSON committed in the repo, rather than SQLite. A SQLite file is a
binary blob: a collector cannot review it, and two runs cannot merge it. Text
JSON diffs line by line and needs no native module. Each cell is its own file,
so a commit contains only the records written in that run. The run log is
append-only JSON Lines, one run per line.

```
data/collected/cells/<cell>__<source>__<room>__<bedrooms>__<currency>__<hash>.json
data/collected/cursor.json     grid resumption cursor, or null when idle
data/collected/runs.jsonl      append-only run log
```

`src/lib/store.ts` is the typed API:

- `readEstimates` / `readEstimate` read stored cells.
- `upsertEstimate` inserts or replaces one cell. The dedupe key is `cellId` plus
  `source`, `roomTypeCategory`, `bedrooms`, and `currency` (stored uppercase).
- `lookupFreshness` reports whether that key is already stored and still inside
  the freshness window (default 30 days), so a collector can skip it.
- `readCursor` / `writeCursor` / `clearCursor` persist the active grid sweep
  (`sweepId`, next index, last cell id, total, and the query).
- `appendRun` / `readRuns` / `summarizeRuns` append and read the run log.

Each cell record holds `cellId`, `latitude`, `longitude`, gross `monthly`,
gross `nightly`, gross `nights`, `currency`, `roomTypeCategory`, `bedrooms`,
`source` (`airbnb-host-estimate` or `inside-airbnb`), and `fetchedAt`.
`monthly`, `nightly`, and `nights` are gross booking revenue, never profit.
Room categories are `ENTIRE_HOME`, `PRIVATE_ROOM`, `SHARED_ROOM`, and
`HOTEL_ROOM`. Map Inside Airbnb's labels onto those before writing
(`Entire home/apt` → `ENTIRE_HOME`, and the same way for private, shared, and
hotel rooms).

A run-log line holds `date`, `cellsCollected`, `errors` (`status`, `message`,
`count` — record HTTP 429 and 403 in `status`), `stopped` (the run halted
before the sweep finished), and `prsOpened`.

`GET /api/store` returns the cells, the cursor, and a short summary of the run
log. It is read-only. The committed store starts empty.

Collected files under `data/collected/` may be committed directly on `dev` and
on `main`. Other code changes do not: see below.

## Branching

The app lives on `main`. `dev` is a long-lived branch created from `main`. It
is never deleted.

- Code changes go to `dev` through pull requests, and need Amir's yes before
  they merge into `main`.
- Collected data files may be committed directly to `dev` and to `main`.
- Do not delete or force-push either branch.

## How it fits together

```
src/lib/airbnb-estimate.ts   Client for Airbnb's GetHostEstimateData
src/lib/scan.ts              Grid construction over a bounding box
src/lib/store.ts             Collected cells, cursor, and run log
src/lib/inside-airbnb.ts     CSV download, parse and cache
src/lib/revenue.ts           The San Francisco occupancy model
src/lib/market-stats.ts      Filtering and neighbourhood rollups
src/app/api/scan             Streams grid results as NDJSON
src/app/api/store            Reads collected cells and the run-log summary
src/app/api/place            Resolves a place name to a scan area
src/app/api/markets/[slug]   Serves a parsed Inside Airbnb market
src/components/dashboard.tsx Map, layers and panel state
```

Next.js, TypeScript, Tailwind, shadcn/ui, MapLibre GL and deck.gl.

## Licence

MIT - see [LICENSE](./LICENSE).

Inside Airbnb data is CC0. Airbnb data retrieved through `GetHostEstimateData`
belongs to Airbnb; this project queries a public endpoint the same way their own
website does, but you are responsible for your own use of it.

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
Gross estimates accumulate in a local SQLite file, `data/collected/estimates.sqlite`
(Node 22's built-in `node:sqlite` — there is no database server). The World tab
draws that file.

Four markets ship pre-baked in `data/snapshots/` so the Inside Airbnb tab works
offline; the other 119 download on first use and cache to `.cache/`.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server on port 44317 |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run build:catalog` | Refresh `src/data/markets.json` from Inside Airbnb |
| `npm run snapshot -- <slug>` | Pre-bake a market for offline use |
| `npm run collect` | Resume the background world collector (see below) |
| `npm run collect -- --dry-run` | Print the next Airbnb cells without requesting them |
| `npm run verify:collector` | Check throttle, stop, and grid-resume behaviour |

## Background collector

`npm run collect` is independent of anyone using the map. Each run does two
things, then exits:

1. Folds Inside Airbnb markets into the store. The four committed snapshots are
   read from disk. After that it downloads at most one further market
   (`--markets`, default 1). Listings become a median **gross** monthly figure
   on the 1° cell they fall in.
2. Walks a 1° grid of land cells, populated places first, oceans omitted. A cell
   Inside Airbnb already covers is not requested. Anything else is one call to
   `GetHostEstimateData`.

Airbnb traffic from this command is deliberately boring:

- One request in flight. No concurrency.
- At least 5 seconds between requests, plus up to 2.5 seconds of random jitter
  (`--delay-ms` cannot be set lower than 5000; `--jitter-ms` defaults to 2500).
- A budget of 24 requests per run (`--budget`, maximum 120).
- Exponential backoff after an error. The first failure waits one gap, the next
  waits double, and so on.
- The process stops on HTTP 429, HTTP 403, or 3 consecutive errors
  (`--spike`). Progress records why. The next run refuses to continue until
  you pass `--acknowledge-stop`.
- A cell that is already stored and younger than 30 days (`--fresh-days`) is
  not fetched again. An empty answer is stored too, so a dead coordinate is
  not retried all week.

```bash
npm run collect -- --dry-run
npm run collect -- --budget 24 --fresh-days 30
npm run collect -- --acknowledge-stop
```

The walk resumes from the cursor in the SQLite file. Live scans keep their own
cap (400 cells, 8 at a time) and also append into the same file. Figures stay
in the currency they were collected in; the World tab never mixes currencies
on one colour scale.

Node 22 or newer is required for the built-in SQLite driver.

Inside Airbnb re-scrapes each city roughly quarterly, which changes the download
URLs. Re-run `npm run build:catalog` to pick up new scrapes.

## How it fits together

```
src/lib/airbnb-estimate.ts   Client for Airbnb's GetHostEstimateData
src/lib/scan.ts              Grid construction over a bounding box
src/lib/inside-airbnb.ts     CSV download, parse and cache
src/lib/revenue.ts           The San Francisco occupancy model
src/lib/market-stats.ts      Filtering and neighbourhood rollups
src/lib/estimate-store.ts    Local SQLite store of gross estimates
src/lib/collector.ts         Resumable world-grid collector
src/lib/collect-policy.ts    Delay, backoff, and stop rules
src/app/api/scan             Streams grid results as NDJSON
src/app/api/place            Resolves a place name to a scan area
src/app/api/markets/[slug]   Serves a parsed Inside Airbnb market
src/app/api/collected        Serves the store for the World tab
src/components/dashboard.tsx Map, layers and panel state
```

Next.js, TypeScript, Tailwind, shadcn/ui, MapLibre GL and deck.gl.

## Licence

MIT - see [LICENSE](./LICENSE).

Inside Airbnb data is CC0. Airbnb data retrieved through `GetHostEstimateData`
belongs to Airbnb; this project queries a public endpoint the same way their own
website does, but you are responsible for your own use of it.

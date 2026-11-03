// Background world collector. One GetHostEstimateData request at a time.
//
//   npm run collect
//   npm run collect -- --dry-run
//   npm run collect -- --budget 24 --delay-ms 5000 --jitter-ms 2500 --fresh-days 30
//   npm run collect -- --acknowledge-stop
//
// The delay cannot be set below 5000ms. A 429, a 403, or three consecutive
// errors stop the process; the next run refuses to start until --acknowledge-stop.

import { ROOM_TYPE_CATEGORIES, type RoomTypeCategory } from "@/lib/airbnb-estimate";
import { runCollector } from "@/lib/collector";
import { isHardStop } from "@/lib/collect-policy";

const argv = process.argv.slice(2);

function has(flag: string): boolean {
  return argv.includes(flag);
}

function value(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const next = argv[index + 1];
  if (!next || next.startsWith("--")) return undefined;
  return next;
}

function integer(flag: string, fallback: number): number {
  const raw = value(flag);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${flag} must be an integer`);
  }
  return parsed;
}

if (has("--help")) {
  console.log(`Usage: npm run collect -- [options]

Walks a 1° world grid of land cells, populated places first. Cells inside an
Inside Airbnb market are filled from that public data. GetHostEstimateData is
called only for the rest, with:

  - one request in flight
  - at least 5000ms between requests, plus random jitter
  - a per-run budget (default 24)
  - exponential backoff on errors
  - a full stop on HTTP 429, HTTP 403, or 3 consecutive errors

Options:
  --budget <n>         Airbnb requests this run (0..120, default 24)
  --delay-ms <n>       Base gap between requests (minimum 5000, default 5000)
  --jitter-ms <n>      Extra random wait added to the base gap (default 2500)
  --fresh-days <n>     Do not refetch a stored cell younger than this (default 30)
  --markets <n>        Inside Airbnb markets to download this run (default 1)
  --room <type>        ENTIRE_HOME or PRIVATE_ROOM (default ENTIRE_HOME)
  --bedrooms <n>       0..8 (default 2). Inside Airbnb rows are not split by bedroom.
  --currency <code>    Currency sent to Airbnb (default USD). No FX conversion.
  --spike <n>          Consecutive errors that abort the run (default 3)
  --acknowledge-stop   Required after a 429, 403, or error spike before continuing
  --dry-run            Print the Airbnb cells that would be requested. Sends nothing.
`);
  process.exit(0);
}

const room = (value("--room") ?? "ENTIRE_HOME") as RoomTypeCategory;
if (!ROOM_TYPE_CATEGORIES.includes(room)) {
  console.error("--room must be ENTIRE_HOME or PRIVATE_ROOM");
  process.exit(1);
}

const summary = await runCollector({
  budget: integer("--budget", 24),
  delayMs: integer("--delay-ms", 5_000),
  jitterMs: integer("--jitter-ms", 2_500),
  freshDays: integer("--fresh-days", 30),
  marketsPerRun: integer("--markets", 1),
  roomType: room,
  bedrooms: integer("--bedrooms", 2),
  currency: value("--currency") ?? "USD",
  spikeThreshold: integer("--spike", 3),
  acknowledgeStop: has("--acknowledge-stop"),
  dryRun: has("--dry-run"),
});

if (summary.refused || isHardStop(summary.stop)) {
  process.exitCode = 2;
}

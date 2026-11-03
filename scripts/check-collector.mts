/**
 * Checks throttle, stop, and resume without calling Airbnb.
 *   npm run check:collector
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Estimate } from "@/lib/airbnb-estimate";
import {
  MAX_BUDGET,
  MIN_REQUEST_GAP_MS,
  STOP_REASONS,
  assertBudget,
  backoffMs,
  requestGapMs,
  runCollector,
  spikeReason,
  type FetchOutcome,
} from "@/lib/collector";
import { buildLandGrid, formatCellId, snapToGrid, type EuropeCell } from "@/lib/europe-grid";
import { buildOrderedGrid } from "@/lib/inside-airbnb-grid";
import { readCursor, readRuns, resetCollectedRoot, setCollectedRoot, upsertEstimate } from "@/lib/store";

let failed = 0;

function check(condition: boolean, message: string): void {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${message}`);
    return;
  }
  console.log(`ok ${message}`);
}

function cell(cellId: string): EuropeCell {
  const [lat, lng] = cellId.split(",").map(Number);
  return {
    cellId,
    latitude: lat,
    longitude: lng,
    priority: 3,
    listingCount: 0,
    cityDistanceKm: 400,
  };
}

function estimate(monthly = 1200): Estimate {
  return {
    monthly,
    nightly: 80,
    nights: 15,
    currency: "EUR",
    description: null,
    locationName: null,
    comparables: [],
    bounds: null,
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "empyre-collect-"));
}

check(requestGapMs(0, 0, () => 0) === MIN_REQUEST_GAP_MS, "gap never drops under 5s");
check(requestGapMs(25_000, 5_000, () => 0) === 25_000, "default base delay is 25s");
check(requestGapMs(25_000, 5_000, () => 1) === 30_000, "jitter adds up to 5s");
check(backoffMs(25_000, 0, () => 0, 0) === 50_000, "first retry backs off to 50s");
check(backoffMs(25_000, 0, () => 0, 1) === 100_000, "second retry backs off to 100s");
let budgetThrew = false;
try {
  assertBudget(61);
} catch {
  budgetThrew = true;
}
check(budgetThrew, "budget above 60 is rejected");
check(assertBudget(MAX_BUDGET) === 60, "budget of 60 is allowed");
check(spikeReason(3, 3, 3) === STOP_REASONS.consecutive, "3 consecutive errors stop the run");
check(spikeReason(1, 1, 4) === null, "error rate waits for 5 finished cells");
check(spikeReason(1, 2, 5) === STOP_REASONS.rate, "more than 20% errors stop the run");

const land = buildLandGrid();
const parisId = formatCellId(snapToGrid(48.86), snapToGrid(2.35));
check(land.cells.length > 1000, `European land cells are ${land.cells.length}`);
check(land.candidates > land.cells.length, `oceans skipped ${land.candidates - land.cells.length}`);
check(land.cells.some((entry) => entry.cellId === parisId), `Paris cell ${parisId} is on land`);
check(
  !land.cells.some((entry) => entry.cellId === "48.0,-20.0"),
  "mid-Atlantic cell is not in the grid",
);

const ordered = buildOrderedGrid(land.cells, "EUR", "ENTIRE_HOME");
const firstRemote = ordered.cells.findIndex((entry) => entry.priority >= 2);
const insideCount = ordered.cells.filter((entry) => entry.priority === 0).length;
check(insideCount > 0, `local Inside Airbnb cells: ${insideCount}`);
check(firstRemote > 0 && ordered.cells[0].priority === 0, "Inside Airbnb cells come first");
console.log(
  `grid land ${land.cells.length} candidates ${land.candidates} inside-airbnb ${insideCount} covered-empty ${ordered.coverage.coveredEmpty.size} populated ${ordered.cells.filter((entry) => entry.priority <= 2).length}`,
);

type Harness = {
  sleeps: number[];
  calls: string[];
  maxInFlight: number;
};

async function harness(
  dir: string,
  outcomes: FetchOutcome[] | ((query: string) => FetchOutcome),
  options: Parameters<typeof runCollector>[0] = {},
): Promise<{ result: Awaited<ReturnType<typeof runCollector>>; harness: Harness }> {
  setCollectedRoot(dir);
  const state: Harness = { sleeps: [], calls: [], maxInFlight: 0 };
  let inFlight = 0;
  let cursor = 0;
  const result = await runCollector({
    budget: 3,
    delayMs: 25_000,
    jitterMs: 0,
    random: () => 0,
    now: () => new Date("2026-11-03T12:00:00.000Z"),
    cells: [cell("48.5,2.0"), cell("48.5,2.5"), cell("49.0,2.0"), cell("49.0,2.5"), cell("49.5,2.0")],
    sleep: async (ms) => {
      state.sleeps.push(ms);
    },
    fetchCell: async (query) => {
      inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, inFlight);
      state.calls.push(query.searchQuery);
      const outcome =
        typeof outcomes === "function" ? outcomes(query.searchQuery) : outcomes[cursor++] ?? outcomes.at(-1)!;
      inFlight -= 1;
      return outcome;
    },
    ...options,
  });
  return { result, harness: state };
}

{
  const dir = tempDir();
  const { result, harness: state } = await harness(dir, [
    { kind: "estimate", estimate: estimate(1100) },
    { kind: "estimate", estimate: estimate(1300) },
    { kind: "estimate", estimate: estimate(900) },
  ], { budget: 2 });
  check(state.maxInFlight === 1, "only one Airbnb request is in flight");
  check(state.calls.length === 2, "budget 2 makes two requests");
  check(state.sleeps.length === 2 && state.sleeps.every((ms) => ms >= MIN_REQUEST_GAP_MS), "each request waits at least 5s");
  check(state.sleeps[0] === 25_000 && state.sleeps[1] === 25_000, "default spacing is 25s when jitter is 0");
  check(result.stopReason === STOP_REASONS.budget && result.stopped, "budget ends the run");
  check(result.cellsBySource["airbnb-host-estimate"] === 2, "two Airbnb cells stored");
  check(readCursor()?.nextIndex === 2, "cursor resumes after the stored cells");
}

{
  const dir = tempDir();
  const { result, harness: state } = await harness(
    dir,
    [{ kind: "estimate", estimate: estimate() }],
    { budget: 1, delayMs: 0, jitterMs: 0 },
  );
  check(state.sleeps[0] === MIN_REQUEST_GAP_MS, "a configured delay under 5s is raised to 5s");
  check(result.airbnbAttempts === 1, "floor check still performs the request");
}

for (const status of [429, 403] as const) {
  const dir = tempDir();
  const { result, harness: state } = await harness(dir, [{ kind: "http", status }], { budget: 5 });
  check(state.calls.length === 1, `HTTP ${status} does not send another request`);
  check(result.stopped && result.stopReason === (status === 429 ? STOP_REASONS.http429 : STOP_REASONS.http403), `HTTP ${status} stops the run`);
  check(readCursor()?.nextIndex === 0, `HTTP ${status} leaves the cursor on the same cell`);
  check(result.errors.some((error) => error.status === status), `HTTP ${status} is in the run log errors`);
  check(readRuns().length === 1 && readRuns()[0].stopped, `HTTP ${status} run log says the run stopped`);
}

{
  const dir = tempDir();
  const { result, harness: state } = await harness(
    dir,
    [{ kind: "error", message: "network error" }],
    { budget: 10, maxTransientRetries: 0 },
  );
  check(state.calls.length === 3, "three consecutive errors are attempted");
  check(result.stopReason === STOP_REASONS.consecutive, "three consecutive errors stop the run");
  check(readCursor()?.nextIndex === 3, "a failed cell does not block the next run");
}

{
  const dir = tempDir();
  const queue: FetchOutcome[] = [
    { kind: "error", message: "network error" },
    { kind: "estimate", estimate: estimate() },
    { kind: "error", message: "network error" },
    { kind: "estimate", estimate: estimate() },
    { kind: "error", message: "network error" },
  ];
  const { result } = await harness(dir, queue, {
    budget: 10,
    maxTransientRetries: 0,
    cells: [
      cell("48.5,2.0"),
      cell("48.5,2.5"),
      cell("49.0,2.0"),
      cell("49.0,2.5"),
      cell("49.5,2.0"),
      cell("49.5,2.5"),
    ],
  });
  check(result.stopReason === STOP_REASONS.rate, `error rate above 20% stops the run (${result.stopReason})`);
  check(result.airbnbAttempts === 5, "rate stop happens on the fifth finished cell");
}

{
  const dir = tempDir();
  const queue: FetchOutcome[] = [
    { kind: "error", message: "network error" },
    { kind: "estimate", estimate: estimate(1500) },
  ];
  const { result, harness: state } = await harness(dir, queue, { budget: 2, maxTransientRetries: 2 });
  check(result.airbnbAttempts === 2, "a retry counts against the budget");
  check(state.sleeps[1] === 50_000, "the retry uses exponential backoff");
  check(result.cellsBySource["airbnb-host-estimate"] === 1, "the retried cell is stored once");
  check(state.calls.length === 2, "the budget is spent before the next cell");
}

{
  const dir = tempDir();
  const first = await harness(dir, [{ kind: "estimate", estimate: estimate(1000) }], { budget: 1 });
  const second = await harness(dir, [{ kind: "estimate", estimate: estimate(1100) }], { budget: 1 });
  check(first.harness.calls.length === 1 && second.harness.calls.length === 1, "resume fetches only the next cell");
  check(second.harness.calls[0] !== first.harness.calls[0], "resume does not repeat the stored cell");
  check(readCursor()?.nextIndex === 2, "cursor advances across runs");
}

{
  const dir = tempDir();
  setCollectedRoot(dir);
  upsertEstimate({
    cellId: "48.5,2.0",
    latitude: 48.5,
    longitude: 2,
    monthly: 900,
    nightly: 70,
    nights: 12,
    currency: "EUR",
    roomTypeCategory: "ENTIRE_HOME",
    bedrooms: 2,
    source: "airbnb-host-estimate",
    fetchedAt: "2026-11-03T00:00:00.000Z",
  });
  const { result, harness: state } = await harness(
    dir,
    [{ kind: "estimate", estimate: estimate() }],
    { budget: 1, freshMs: 30 * 24 * 60 * 60 * 1000 },
  );
  check(state.calls.length === 1 && !state.calls[0].startsWith("48.5000,2.0000"), "a fresh cell is not fetched");
  check(result.cellsBySource["airbnb-host-estimate"] === 1, "the next stale cell is stored");
}

{
  const dir = tempDir();
  const coverage = {
    derivable: new Map([
      ["48.5,2.0", { monthly: 2100, nightly: 140, nights: 15, samples: 12 }],
    ]),
    coveredEmpty: new Set<string>(),
    stamp: "injected",
  };
  const { result, harness: state } = await harness(
    dir,
    [{ kind: "estimate", estimate: estimate() }],
    { budget: 1, coverage },
  );
  check(state.calls.length === 1 && state.calls[0] !== "48.5000,2.0000", "Inside Airbnb cells do not call Airbnb");
  check(result.cellsBySource["inside-airbnb"] === 1, "the covered cell is stored as inside-airbnb");
  check(result.cellsBySource["airbnb-host-estimate"] === 1, "the next cell still uses the Airbnb budget");
}

resetCollectedRoot();
const runsBytes = fs.statSync(path.join(process.cwd(), "data", "collected", "runs.jsonl")).size;
const cursorText = fs.readFileSync(path.join(process.cwd(), "data", "collected", "cursor.json"), "utf8");
const cellFiles = fs.readdirSync(path.join(process.cwd(), "data", "collected", "cells")).filter((name) => name.endsWith(".json"));
check(runsBytes === 0 && cursorText === "null\n" && cellFiles.length === 0, "the check script does not write the repo store");

if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("collector checks passed");

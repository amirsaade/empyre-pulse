/**
 * Checks throttle, stop, and resume without calling Airbnb.
 *   npm run check:collector
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Estimate } from "@/lib/airbnb-estimate";
import {
  DAILY_REQUEST_CAP,
  DEFAULT_BUDGET,
  MAX_BUDGET,
  MIN_REQUEST_GAP_MS,
  STOP_REASONS,
  assertBudget,
  backoffMs,
  parisCalendarDay,
  requestGapMs,
  runCollector,
  spikeReason,
  type FetchOutcome,
} from "@/lib/collector";
import { buildLandGrid, formatCellId, snapToGrid, type EuropeCell } from "@/lib/europe-grid";
import { buildOrderedGrid } from "@/lib/inside-airbnb-grid";
import {
  appendRun,
  emptyCellsBySource,
  readCursor,
  readRuns,
  resetCollectedRoot,
  setCollectedRoot,
  upsertEstimate,
} from "@/lib/store";

function storeFingerprint(): string {
  const root = path.join(process.cwd(), "data", "collected");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(root);
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(root, file));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex");
}

const storeBefore = storeFingerprint();
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
  assertBudget(MAX_BUDGET + 1);
} catch {
  budgetThrew = true;
}
check(budgetThrew, "budget above 200 is rejected");
check(assertBudget(MAX_BUDGET) === 200, "budget of 200 is allowed");
check(DEFAULT_BUDGET === 150, "default per-run budget is 150");
check(DAILY_REQUEST_CAP === 200, "Paris-day cap is 200");
check(parisCalendarDay(new Date("2026-11-03T12:00:00.000Z")) === "2026-11-03", "noon UTC is 3 Nov in Paris");
check(parisCalendarDay(new Date("2026-11-03T23:30:00.000Z")) === "2026-11-04", "23:30 UTC is already 4 Nov in Paris");
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

function manyCells(count: number): EuropeCell[] {
  return Array.from({ length: count }, (_, index) => {
    const latitude = (30 + (index % 40) * 0.5).toFixed(1);
    const longitude = (Math.floor(index / 40) - 2).toFixed(1);
    return cell(`${latitude},${longitude}`);
  });
}

function seedAttempts(dir: string, date: string, airbnbAttempts: number): void {
  setCollectedRoot(dir);
  appendRun({
    date,
    cellsCollected: 0,
    cellsBySource: emptyCellsBySource(),
    airbnbAttempts,
    errors: [],
    stopped: true,
    stopReason: "budget",
    prsOpened: [],
  });
}

{
  const dir = tempDir();
  setCollectedRoot(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "runs.jsonl"),
    `${JSON.stringify({
      date: "2026-11-03T14:40:14.422Z",
      cellsCollected: 3,
      cellsBySource: { "airbnb-host-estimate": 3, "inside-airbnb": 0 },
      errors: [{ status: 500, message: "HTTP 500", count: 2 }],
      stopped: true,
      stopReason: "budget",
      prsOpened: [],
    })}\n`,
  );
  check(readRuns()[0]?.airbnbAttempts === 5, "older run logs count stored Airbnb cells plus errors");
}

{
  const dir = tempDir();
  seedAttempts(dir, "2026-11-03T12:00:00.000Z", DAILY_REQUEST_CAP);
  const { result, harness: state } = await harness(dir, [{ kind: "estimate", estimate: estimate() }], {
    budget: 10,
    now: () => new Date("2026-11-03T18:00:00.000Z"),
  });
  check(state.calls.length === 0, "a full Paris day sends no further Airbnb requests");
  check(result.stopReason === STOP_REASONS.dailyCap, "the daily cap stops the run");
  check(result.airbnbAttempts === 0, "the blocked run records zero attempts");
}

{
  const dir = tempDir();
  seedAttempts(dir, "2026-11-03T08:00:00.000Z", 150);
  const { result, harness: state } = await harness(
    dir,
    [{ kind: "estimate", estimate: estimate() }],
    {
      budget: 100,
      now: () => new Date("2026-11-03T18:00:00.000Z"),
      cells: manyCells(80),
    },
  );
  check(state.calls.length === 50, "a later run only uses what the Paris day has left");
  check(result.stopReason === STOP_REASONS.dailyCap && result.stopped, "hitting the remainder stops as daily-cap");
  check(readRuns().reduce((sum, run) => sum + run.airbnbAttempts, 0) === 200, "the two runs together stay at 200");
}

{
  const dir = tempDir();
  seedAttempts(dir, "2026-11-03T23:30:00.000Z", DAILY_REQUEST_CAP);
  const { result, harness: state } = await harness(dir, [{ kind: "estimate", estimate: estimate() }], {
    budget: 2,
    now: () => new Date("2026-11-03T15:00:00.000Z"),
  });
  check(state.calls.length === 2 && result.stopReason === STOP_REASONS.budget, "the next Paris day does not consume today's cap");
}

{
  const dir = tempDir();
  seedAttempts(dir, "2026-11-03T22:30:00.000Z", DAILY_REQUEST_CAP);
  const { harness: state, result } = await harness(dir, [{ kind: "estimate", estimate: estimate() }], {
    budget: 1,
    now: () => new Date("2026-11-03T20:00:00.000Z"),
  });
  check(state.calls.length === 0 && result.stopReason === STOP_REASONS.dailyCap, "22:30 UTC still counts as the same Paris day");
}

{
  const dir = tempDir();
  seedAttempts(dir, "2026-11-03T12:00:00.000Z", DAILY_REQUEST_CAP);
  const coverage = {
    derivable: new Map([["48.5,2.0", { monthly: 2100, nightly: 140, nights: 15, samples: 12 }]]),
    coveredEmpty: new Set<string>(),
    stamp: "injected",
  };
  const { result, harness: state } = await harness(dir, [{ kind: "estimate", estimate: estimate() }], {
    budget: 5,
    now: () => new Date("2026-11-03T16:00:00.000Z"),
    coverage,
  });
  check(state.calls.length === 0, "a full day still does not call Airbnb");
  check(result.cellsBySource["inside-airbnb"] === 1, "Inside Airbnb cells are still stored when the day is full");
  check(result.stopReason === STOP_REASONS.dailyCap, "the run stops when the next cell would call Airbnb");
}

resetCollectedRoot();
check(storeFingerprint() === storeBefore, "the check script does not write the repo store");

if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("collector checks passed");

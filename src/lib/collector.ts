/**
 * Walks the European land grid and stores gross estimates.
 *
 * Inside Airbnb snapshots fill a cell when they already cover it. Every other
 * cell uses Airbnb GetHostEstimateData, one request at a time, with a gap that
 * never drops under 5 seconds. A 429 or 403 stops the run immediately.
 */

import {
  AirbnbHttpError,
  coordQuery,
  fetchEstimate,
  type Estimate,
  type EstimateQuery,
} from "./airbnb-estimate";
import { buildLandGrid, GRID_STEP, type EuropeCell } from "./europe-grid";
import {
  buildOrderedGrid,
  localDecision,
  type DerivedGross,
  type LocalCoverage,
} from "./inside-airbnb-grid";
import {
  appendRun,
  DEFAULT_FRESHNESS_MS,
  emptyCellsBySource,
  lookupFreshness,
  readCursor,
  upsertEstimate,
  writeCursor,
  type CellsBySource,
  type EstimateSource,
  type RunError,
  type StoredRoomTypeCategory,
} from "./store";

export const MIN_REQUEST_GAP_MS = 5_000;
export const DEFAULT_DELAY_MS = 25_000;
export const DEFAULT_JITTER_MS = 5_000;
export const DEFAULT_BUDGET = 45;
export const MAX_BUDGET = 60;
export const MAX_CONSECUTIVE_ERRORS = 3;
export const MAX_ERROR_RATE = 0.2;
export const ERROR_RATE_MIN_CELLS = 5;
export const DEFAULT_TRANSIENT_RETRIES = 2;

export const STOP_REASONS = {
  budget: "budget",
  complete: "complete",
  http429: "http-429",
  http403: "http-403",
  consecutive: "error-spike-consecutive",
  rate: "error-spike-rate",
} as const;

export type StopReason = (typeof STOP_REASONS)[keyof typeof STOP_REASONS];

const TRANSIENT_STATUS = new Set([408, 425, 500, 502, 503, 504]);

export type FetchOutcome =
  | { kind: "estimate"; estimate: Estimate | null }
  | { kind: "http"; status: number }
  | { kind: "error"; message: string };

export type AirbnbAttemptLog = {
  cellId: string;
  latitude: number;
  longitude: number;
  status: number | null;
  stored: boolean;
  empty: boolean;
  waitedMs: number;
};

export type CollectorResult = {
  totalLandCells: number;
  candidateCells: number;
  oceanCellsSkipped: number;
  insideAirbnbCells: number;
  populatedCells: number;
  startedAtIndex: number;
  nextIndex: number;
  airbnbAttempts: number;
  attempts: AirbnbAttemptLog[];
  cellsBySource: CellsBySource;
  stopped: boolean;
  stopReason: StopReason;
  errors: RunError[];
};

export type CollectorOptions = {
  budget?: number;
  delayMs?: number;
  jitterMs?: number;
  freshMs?: number;
  roomTypeCategory?: StoredRoomTypeCategory;
  bedrooms?: number;
  currency?: string;
  maxTransientRetries?: number;
  /** Injected by the check script. The CLI uses the real European grid. */
  cells?: EuropeCell[];
  candidateCells?: number;
  coverage?: LocalCoverage;
  fetchCell?: (query: EstimateQuery) => Promise<FetchOutcome>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  random?: () => number;
  log?: (message: string) => void;
};

export function assertBudget(budget: number): number {
  if (!Number.isInteger(budget) || budget < 1 || budget > MAX_BUDGET) {
    throw new Error(`budget must be an integer from 1 to ${MAX_BUDGET}`);
  }
  return budget;
}

/** Gap before an Airbnb request. Jitter is added to the base delay, then floored at 5s. */
export function requestGapMs(delayMs: number, jitterMs: number, random: () => number): number {
  const roll = Math.min(1, Math.max(0, random()));
  const jitter = Math.max(0, jitterMs) * roll;
  return Math.max(MIN_REQUEST_GAP_MS, delayMs + jitter);
}

/** Exponential backoff for a transient retry. `retryIndex` 0 is the first retry. */
export function backoffMs(
  delayMs: number,
  jitterMs: number,
  random: () => number,
  retryIndex: number,
): number {
  const gap = requestGapMs(delayMs, jitterMs, random);
  return Math.max(MIN_REQUEST_GAP_MS, gap * 2 ** (retryIndex + 1));
}

export function spikeReason(
  consecutive: number,
  failures: number,
  finished: number,
): StopReason | null {
  if (consecutive >= MAX_CONSECUTIVE_ERRORS) return STOP_REASONS.consecutive;
  if (finished >= ERROR_RATE_MIN_CELLS && failures / finished > MAX_ERROR_RATE) {
    return STOP_REASONS.rate;
  }
  return null;
}

export function isTransient(outcome: FetchOutcome): boolean {
  if (outcome.kind === "http") return TRANSIENT_STATUS.has(outcome.status);
  if (outcome.kind === "error") {
    const message = outcome.message.toLowerCase();
    return (
      message.includes("network") ||
      message.includes("fetch") ||
      message.includes("timeout") ||
      message.includes("aborted")
    );
  }
  return false;
}

export async function runCollector(options: CollectorOptions = {}): Promise<CollectorResult> {
  const budget = assertBudget(options.budget ?? DEFAULT_BUDGET);
  const delayMs = assertNonNegative(options.delayMs ?? DEFAULT_DELAY_MS, "delayMs");
  const jitterMs = assertNonNegative(options.jitterMs ?? DEFAULT_JITTER_MS, "jitterMs");
  const freshMs = assertNonNegative(options.freshMs ?? DEFAULT_FRESHNESS_MS, "freshMs");
  const roomTypeCategory = options.roomTypeCategory ?? "ENTIRE_HOME";
  const bedrooms = options.bedrooms ?? 2;
  const currency = (options.currency ?? "EUR").toUpperCase();
  const maxTransientRetries = options.maxTransientRetries ?? DEFAULT_TRANSIENT_RETRIES;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const fetchCell = options.fetchCell ?? defaultFetchCell;
  const log = options.log ?? (() => {});

  if (roomTypeCategory !== "ENTIRE_HOME" && roomTypeCategory !== "PRIVATE_ROOM") {
    throw new Error("roomTypeCategory must be ENTIRE_HOME or PRIVATE_ROOM");
  }
  if (!Number.isInteger(bedrooms) || bedrooms < 0 || bedrooms > 20) {
    throw new Error("bedrooms must be an integer from 0 to 20");
  }
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("currency must be a 3-letter ISO code");

  const grid = options.cells
    ? {
        cells: options.cells,
        candidates: options.candidateCells ?? options.cells.length,
        coverage: options.coverage ?? {
          derivable: new Map<string, DerivedGross>(),
          coveredEmpty: new Set<string>(),
          stamp: "injected",
        },
      }
    : prepareEurope(currency, roomTypeCategory);

  const cells = grid.cells;
  const sweepId = sweepIdFor(roomTypeCategory, bedrooms, currency, grid.coverage.stamp);
  const cursor = readCursor();
  const resume =
    cursor !== null &&
    cursor.sweepId === sweepId &&
    cursor.roomTypeCategory === roomTypeCategory &&
    cursor.bedrooms === bedrooms &&
    cursor.currency === currency &&
    cursor.nextIndex < cells.length &&
    cursor.stopReason !== STOP_REASONS.complete;

  let index = resume ? cursor.nextIndex : 0;
  const startedAtIndex = index;
  let lastCellId = cursor?.lastCellId ?? null;
  let attempts = 0;
  let consecutive = 0;
  let failures = 0;
  let finished = 0;
  const cellsBySource = emptyCellsBySource();
  const errors = new Map<string, RunError>();
  const attemptLog: AirbnbAttemptLog[] = [];
  let stopReason: StopReason = STOP_REASONS.complete;

  const persist = (reason: string | null) => {
    writeCursor({
      sweepId,
      nextIndex: index,
      lastCellId,
      total: cells.length,
      roomTypeCategory,
      bedrooms,
      currency,
      source: "airbnb-host-estimate",
      stopReason: reason,
    });
  };

  persist(null);
  log(
    `European land cells: ${cells.length} (oceans skipped: ${grid.candidates - cells.length} of ${grid.candidates}). Resuming at ${index}.`,
  );

  const finish = (reason: StopReason): CollectorResult => {
    const gridFinished = index >= cells.length;
    const resolved = gridFinished ? STOP_REASONS.complete : reason;
    const stopped = resolved !== STOP_REASONS.complete;
    persist(resolved);
    appendRun({
      date: now().toISOString(),
      cellsCollected: cellsBySource["airbnb-host-estimate"] + cellsBySource["inside-airbnb"],
      cellsBySource,
      errors: [...errors.values()],
      stopped,
      stopReason: resolved,
      prsOpened: [],
    });
    return {
      totalLandCells: cells.length,
      candidateCells: grid.candidates,
      oceanCellsSkipped: grid.candidates - cells.length,
      insideAirbnbCells: cells.filter((cell) => cell.priority === 0 || cell.priority === 1).length,
      populatedCells: cells.filter((cell) => cell.priority <= 2).length,
      startedAtIndex,
      nextIndex: index,
      airbnbAttempts: attempts,
      attempts: attemptLog,
      cellsBySource,
      stopped,
      stopReason: resolved,
      errors: [...errors.values()],
    };
  };

  while (index < cells.length) {
    const cell = cells[index];
    const decision = localDecision(cell, grid.coverage);
    const source: EstimateSource = decision.kind === "derive" ? "inside-airbnb" : "airbnb-host-estimate";

    if (decision.kind !== "covered-empty") {
      const fresh = lookupFreshness(
        {
          cellId: cell.cellId,
          roomTypeCategory,
          bedrooms,
          currency,
          source,
        },
        { maxAgeMs: freshMs, now: now() },
      );
      if (fresh.fresh) {
        index += 1;
        persist(null);
        continue;
      }
    }

    if (decision.kind === "derive") {
      storeCell(cell, decision.gross, "inside-airbnb", roomTypeCategory, bedrooms, currency, now());
      cellsBySource["inside-airbnb"] += 1;
      lastCellId = cell.cellId;
      index += 1;
      persist(null);
      continue;
    }

    if (decision.kind === "covered-empty") {
      lastCellId = cell.cellId;
      index += 1;
      persist(null);
      continue;
    }

    const outcome = await fetchWithinBudget({
      cell,
      budget,
      attempts,
      delayMs,
      jitterMs,
      random,
      sleep,
      fetchCell,
      maxTransientRetries,
      roomTypeCategory,
      bedrooms,
      currency,
      onAttempt(entry) {
        attempts += 1;
        attemptLog.push(entry);
      },
    });

    if (outcome.kind === "budget") {
      stopReason = STOP_REASONS.budget;
      break;
    }

    if (outcome.kind === "fatal") {
      noteError(errors, outcome.status, `HTTP ${outcome.status}`);
      stopReason = outcome.status === 429 ? STOP_REASONS.http429 : STOP_REASONS.http403;
      break;
    }

    if (outcome.kind === "failed") {
      noteError(errors, outcome.status, outcome.message);
      consecutive += 1;
      failures += 1;
      finished += 1;
      const spiked = spikeReason(consecutive, failures, finished);
      index += 1;
      lastCellId = cell.cellId;
      persist(null);
      if (spiked) {
        stopReason = spiked;
        break;
      }
      if (attempts >= budget) {
        stopReason = STOP_REASONS.budget;
        break;
      }
      continue;
    }

    if (outcome.kind === "stored") {
      storeCell(
        cell,
        {
          monthly: outcome.estimate.monthly,
          nightly: outcome.estimate.nightly,
          nights: outcome.estimate.nights,
        },
        "airbnb-host-estimate",
        roomTypeCategory,
        bedrooms,
        currency,
        now(),
      );
      cellsBySource["airbnb-host-estimate"] += 1;
    }

    consecutive = 0;
    finished += 1;
    lastCellId = cell.cellId;
    index += 1;
    persist(null);
    if (attempts >= budget) {
      stopReason = STOP_REASONS.budget;
      break;
    }
  }

  return finish(stopReason);
}

type BudgetFetch =
  | { kind: "stored"; estimate: Estimate }
  | { kind: "empty" }
  | { kind: "failed"; status: number | null; message: string }
  | { kind: "fatal"; status: 429 | 403 }
  | { kind: "budget" };

async function fetchWithinBudget(input: {
  cell: EuropeCell;
  budget: number;
  attempts: number;
  delayMs: number;
  jitterMs: number;
  random: () => number;
  sleep: (ms: number) => Promise<void>;
  fetchCell: (query: EstimateQuery) => Promise<FetchOutcome>;
  maxTransientRetries: number;
  roomTypeCategory: "ENTIRE_HOME" | "PRIVATE_ROOM";
  bedrooms: number;
  currency: string;
  onAttempt: (entry: AirbnbAttemptLog) => void;
}): Promise<BudgetFetch> {
  let attempts = input.attempts;
  let retryIndex = 0;

  while (true) {
    if (attempts >= input.budget) return { kind: "budget" };
    const waitedMs =
      retryIndex === 0
        ? requestGapMs(input.delayMs, input.jitterMs, input.random)
        : backoffMs(input.delayMs, input.jitterMs, input.random, retryIndex - 1);
    await input.sleep(waitedMs);
    attempts += 1;

    const query: EstimateQuery = {
      searchQuery: coordQuery(input.cell.latitude, input.cell.longitude),
      roomTypeCategory: input.roomTypeCategory,
      bedrooms: input.bedrooms,
      currency: input.currency,
    };
    const outcome = await input.fetchCell(query);
    const status = outcome.kind === "http" ? outcome.status : outcome.kind === "estimate" ? 200 : null;
    const stored = outcome.kind === "estimate" && outcome.estimate !== null;
    input.onAttempt({
      cellId: input.cell.cellId,
      latitude: input.cell.latitude,
      longitude: input.cell.longitude,
      status,
      stored,
      empty: outcome.kind === "estimate" && outcome.estimate === null,
      waitedMs,
    });

    if (outcome.kind === "http" && (outcome.status === 429 || outcome.status === 403)) {
      return { kind: "fatal", status: outcome.status };
    }
    if (outcome.kind === "estimate") {
      return outcome.estimate ? { kind: "stored", estimate: outcome.estimate } : { kind: "empty" };
    }

    const message = outcome.kind === "http" ? `HTTP ${outcome.status}` : outcome.message;
    const statusOrNull = outcome.kind === "http" ? outcome.status : null;
    if (isTransient(outcome) && retryIndex < input.maxTransientRetries && attempts < input.budget) {
      retryIndex += 1;
      continue;
    }
    return { kind: "failed", status: statusOrNull, message };
  }
}

function storeCell(
  cell: EuropeCell,
  gross: { monthly: number; nightly: number; nights: number },
  source: EstimateSource,
  roomTypeCategory: StoredRoomTypeCategory,
  bedrooms: number,
  currency: string,
  fetchedAt: Date,
): void {
  upsertEstimate({
    cellId: cell.cellId,
    latitude: cell.latitude,
    longitude: cell.longitude,
    monthly: gross.monthly,
    nightly: gross.nightly,
    nights: gross.nights,
    currency,
    roomTypeCategory,
    bedrooms,
    source,
    fetchedAt: fetchedAt.toISOString(),
  });
}

function noteError(errors: Map<string, RunError>, status: number | null, message: string): void {
  const key = `${status ?? "none"}|${message}`;
  const existing = errors.get(key);
  if (existing) existing.count += 1;
  else errors.set(key, { status, message, count: 1 });
}

function prepareEurope(currency: string, roomTypeCategory: StoredRoomTypeCategory): {
  cells: EuropeCell[];
  candidates: number;
  coverage: LocalCoverage;
} {
  const land = buildLandGrid();
  const ordered = buildOrderedGrid(land.cells, currency, roomTypeCategory);
  return { cells: ordered.cells, candidates: land.candidates, coverage: ordered.coverage };
}

function sweepIdFor(
  roomTypeCategory: StoredRoomTypeCategory,
  bedrooms: number,
  currency: string,
  stamp: string,
): string {
  const id = `europe-v1-${GRID_STEP}-${roomTypeCategory}-${bedrooms}-${currency}-${stamp}`;
  return id.length <= 180 ? id : `${id.slice(0, 140)}-${stamp.length}`;
}

function assertNonNegative(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function defaultFetchCell(query: EstimateQuery): Promise<FetchOutcome> {
  try {
    const estimate = await fetchEstimate(query);
    return { kind: "estimate", estimate };
  } catch (error) {
    if (error instanceof AirbnbHttpError) return { kind: "http", status: error.status };
    const message = error instanceof Error ? error.message : "network error";
    return { kind: "error", message: message.slice(0, 180) };
  }
}

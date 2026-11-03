/**
 * Politeness rules for the background collector. Pure: no timers, no sockets.
 * The collector (and its tests) make every stop/resume decision through here
 * so a run cannot "just this once" overlap requests or ignore a 429.
 */

/** Floor for the gap between Airbnb requests. Not configurable below this. */
export const MIN_DELAY_MS = 5_000;
export const DEFAULT_DELAY_MS = 5_000;
/** Added on top of the base delay, uniformly at random. 0 is allowed. */
export const DEFAULT_JITTER_MS = 2_500;
/** A few dozen GetHostEstimateData calls, then the process exits. */
export const DEFAULT_BUDGET = 24;
/** Raise this in code if a longer polite run is really intended. */
export const MAX_BUDGET = 120;
export const DEFAULT_FRESH_DAYS = 30;
export const DEFAULT_SPIKE = 3;
export const DEFAULT_MARKETS_PER_RUN = 1;
export const MARKET_FAILURE_LIMIT = 3;

export const HARD_STOPS = ["http_429", "http_403", "error_spike"] as const;
export type HardStop = (typeof HARD_STOPS)[number];

export type StopReason = HardStop | "budget" | "complete" | "awaiting-markets";

export function isHardStop(reason: string | null | undefined): reason is HardStop {
  return reason === "http_429" || reason === "http_403" || reason === "error_spike";
}

export function assertPoliteDelay(delayMs: number): number {
  if (!Number.isFinite(delayMs) || delayMs < MIN_DELAY_MS) {
    throw new Error(
      `Base delay must be at least ${MIN_DELAY_MS}ms so the collector cannot outrun a polite crawl`,
    );
  }
  return delayMs;
}

export function assertBudget(budget: number): number {
  if (!Number.isInteger(budget) || budget < 0 || budget > MAX_BUDGET) {
    throw new Error(`Budget must be an integer from 0 to ${MAX_BUDGET}`);
  }
  return budget;
}

function unitRandom(random: number): number {
  if (!Number.isFinite(random)) return 0;
  return Math.min(1, Math.max(0, random));
}

/** Gap before the next request: base delay, plus up to `jitterMs` extra. */
export function spacingMs(baseDelayMs: number, jitterMs: number, random: number): number {
  const extra = Math.max(0, jitterMs) * unitRandom(random);
  return Math.round(baseDelayMs + extra);
}

/**
 * Wait after a failed request and before another is attempted.
 * The first consecutive error waits one spacing; each further error doubles it.
 */
export function errorGapMs(
  baseDelayMs: number,
  jitterMs: number,
  consecutiveErrors: number,
  random: number,
): number {
  const factor = 2 ** Math.max(0, consecutiveErrors - 1);
  return spacingMs(baseDelayMs, jitterMs, random) * factor;
}

export function httpStopReason(status: number | null | undefined): "http_429" | "http_403" | null {
  if (status === 429) return "http_429";
  if (status === 403) return "http_403";
  return null;
}

export function isFresh(fetchedAtIso: string, nowMs: number, freshMs: number): boolean {
  const then = Date.parse(fetchedAtIso);
  if (!Number.isFinite(then)) return false;
  return nowMs - then >= 0 && nowMs - then <= freshMs;
}

export type CellAction = "fetch" | "skip-fresh" | "defer-reserved";

/** Fresh cells are never re-fetched. Reserved cells wait for Inside Airbnb. */
export function cellAction(input: { fresh: boolean; reserved: boolean }): CellAction {
  if (input.fresh) return "skip-fresh";
  if (input.reserved) return "defer-reserved";
  return "fetch";
}

export type VisitKind =
  | "skip-fresh"
  | "defer-reserved"
  | "stored"
  | "empty"
  | "error"
  | "http_429"
  | "http_403";

export type WalkState = {
  cursor: number;
  length: number;
  budget: number;
  used: number;
  consecutiveErrors: number;
  spikeThreshold: number;
  /** Cell indexes to retry after Inside Airbnb ingest, or after a soft error. */
  deferred: number[];
  stop: StopReason | null;
  stopDetail: string | null;
};

export function initialWalk(input: {
  length: number;
  budget: number;
  cursor: number;
  deferred: number[];
  spikeThreshold: number;
}): WalkState {
  return {
    cursor: input.cursor,
    length: input.length,
    budget: input.budget,
    used: 0,
    consecutiveErrors: 0,
    spikeThreshold: input.spikeThreshold,
    deferred: [...input.deferred],
    stop: null,
    stopDetail: null,
  };
}

function without(indexes: number[], index: number): number[] {
  return indexes.filter((item) => item !== index);
}

function withIndex(indexes: number[], index: number): number[] {
  return indexes.includes(index) ? indexes : [...indexes, index];
}

/** Put `index` at the front so the next run retries it before anything else. */
function deferFirst(indexes: number[], index: number): number[] {
  return [index, ...indexes.filter((item) => item !== index)];
}

/**
 * Fold one cell visit into the resume cursor.
 * Hard stops (429, 403, error spike) freeze the run and queue that cell first.
 * A soft error queues the cell for a later run and moves on, after backoff.
 */
export function reduceVisit(
  state: WalkState,
  index: number,
  kind: VisitKind,
  fromDeferred: boolean,
): WalkState {
  if (state.stop) return state;

  if (kind === "skip-fresh") {
    return {
      ...state,
      cursor: fromDeferred ? state.cursor : index + 1,
      deferred: without(state.deferred, index),
    };
  }

  if (kind === "defer-reserved") {
    return {
      ...state,
      cursor: fromDeferred ? state.cursor : index + 1,
      deferred: withIndex(state.deferred, index),
    };
  }

  const used = state.used + 1;
  const budgetStop = used >= state.budget;

  if (kind === "stored" || kind === "empty") {
    return {
      ...state,
      used,
      consecutiveErrors: 0,
      cursor: fromDeferred ? state.cursor : index + 1,
      deferred: without(state.deferred, index),
      stop: budgetStop ? "budget" : null,
      stopDetail: budgetStop ? `Request budget of ${state.budget} reached` : null,
    };
  }

  const consecutiveErrors = state.consecutiveErrors + 1;
  const hard = kind === "http_429" || kind === "http_403";
  const spiked = !hard && consecutiveErrors >= state.spikeThreshold;

  if (hard || spiked) {
    const reason: HardStop = hard ? kind : "error_spike";
    const stopDetail = hard
      ? `Airbnb responded ${kind === "http_429" ? 429 : 403}. Run stopped so this does not look like abuse.`
      : `${consecutiveErrors} consecutive Airbnb errors (threshold ${state.spikeThreshold}). Run stopped.`;
    return {
      ...state,
      used,
      consecutiveErrors,
      cursor: fromDeferred ? state.cursor : index + 1,
      deferred: deferFirst(state.deferred, index),
      stop: reason,
      stopDetail,
    };
  }

  return {
    ...state,
    used,
    consecutiveErrors,
    cursor: fromDeferred ? state.cursor : index + 1,
    deferred: withIndex(state.deferred, index),
    stop: budgetStop ? "budget" : null,
    stopDetail: budgetStop ? `Request budget of ${state.budget} reached` : null,
  };
}

export function finishWalk(state: WalkState): WalkState {
  if (state.stop) return state;
  if (state.cursor >= state.length && state.deferred.length === 0) {
    return {
      ...state,
      stop: "complete",
      stopDetail: "World grid walk finished for this query",
    };
  }
  if (state.cursor >= state.length && state.deferred.length > 0) {
    return {
      ...state,
      stop: "awaiting-markets",
      stopDetail: `${state.deferred.length} cells sit inside Inside Airbnb markets that are not ingested yet`,
    };
  }
  return state;
}

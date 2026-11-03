import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { aggregateMarketCells } from "./aggregate-market";
import {
  airbnbStatus,
  coordQuery,
  fetchEstimate,
  type Estimate,
  type EstimateQuery,
  type RoomTypeCategory,
} from "./airbnb-estimate";
import {
  DEFAULT_BUDGET,
  DEFAULT_DELAY_MS,
  DEFAULT_FRESH_DAYS,
  DEFAULT_JITTER_MS,
  DEFAULT_MARKETS_PER_RUN,
  DEFAULT_SPIKE,
  MARKET_FAILURE_LIMIT,
  assertBudget,
  assertPoliteDelay,
  cellAction,
  errorGapMs,
  finishWalk,
  httpStopReason,
  initialWalk,
  isFresh,
  isHardStop,
  reduceVisit,
  spacingMs,
  type StopReason,
} from "./collect-policy";
import { EstimateStore, defaultStorePath, queryKey } from "./estimate-store";
import { MARKETS, loadDataset } from "./inside-airbnb";
import { DEFAULT_MODEL, type Market, type MarketDataset } from "./types";
import {
  CELL_DEGREES,
  loadWorldGrid,
  reservedBy,
  type MarketAnchor,
  type WorldCell,
} from "./world-grid";

export type CollectSummary = {
  refused: boolean;
  dryRun: boolean;
  stop: StopReason | "refused" | null;
  stopDetail: string | null;
  airbnbRequests: number;
  cursor: number;
  gridLength: number;
  deferred: number;
  marketsIngested: string[];
  planned: { cellId: string; latitude: number; longitude: number }[];
};

export type CollectOptions = {
  budget?: number;
  delayMs?: number;
  jitterMs?: number;
  freshDays?: number;
  marketsPerRun?: number;
  roomType?: RoomTypeCategory;
  bedrooms?: number;
  currency?: string;
  spikeThreshold?: number;
  acknowledgeStop?: boolean;
  dryRun?: boolean;
  storePath?: string;
  /** Test seam. Production calls GetHostEstimateData. */
  fetchImpl?: (query: EstimateQuery) => Promise<Estimate | null>;
  sleepImpl?: (ms: number) => Promise<void>;
  randomImpl?: () => number;
  now?: () => number;
  log?: (message: string) => void;
  cells?: WorldCell[];
  anchors?: MarketAnchor[];
  markets?: Market[];
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function snapshotPath(slug: string): string {
  return path.join(process.cwd(), "data", "snapshots", `${slug}.json`);
}

/**
 * One polite pass over the world grid.
 *
 * Inside Airbnb markets are ingested first (local snapshots, then at most
 * `marketsPerRun` downloads). GetHostEstimateData is used only for cells that
 * public data does not already cover, and only one request is in flight.
 */
export async function runCollector(options: CollectOptions = {}): Promise<CollectSummary> {
  const delayMs = assertPoliteDelay(options.delayMs ?? DEFAULT_DELAY_MS);
  const budget = assertBudget(options.budget ?? DEFAULT_BUDGET);
  const jitterMs = Math.max(0, options.jitterMs ?? DEFAULT_JITTER_MS);
  const freshMs = Math.max(1, options.freshDays ?? DEFAULT_FRESH_DAYS) * 24 * 60 * 60 * 1000;
  const marketsPerRun = options.marketsPerRun ?? DEFAULT_MARKETS_PER_RUN;
  const roomType = options.roomType ?? "ENTIRE_HOME";
  const bedrooms = options.bedrooms ?? 2;
  const currency = (options.currency ?? "USD").toUpperCase();
  const spikeThreshold = options.spikeThreshold ?? DEFAULT_SPIKE;
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.log(message));
  const random = options.randomImpl ?? Math.random;
  const pause = options.sleepImpl ?? sleep;
  const fetchImpl = options.fetchImpl ?? fetchEstimate;
  const markets = options.markets ?? MARKETS;

  if (!Number.isInteger(bedrooms) || bedrooms < 0 || bedrooms > 8) {
    throw new Error("Bedrooms must be an integer from 0 to 8");
  }
  if (!Number.isInteger(marketsPerRun) || marketsPerRun < 0) {
    throw new Error("marketsPerRun must be a non-negative integer");
  }
  if (!Number.isInteger(spikeThreshold) || spikeThreshold < 1) {
    throw new Error("spikeThreshold must be an integer of at least 1");
  }

  const grid =
    options.cells !== undefined
      ? { cells: options.cells, anchors: options.anchors ?? [] }
      : loadWorldGrid();

  const key = queryKey(roomType, bedrooms, currency);
  const store = new EstimateStore(options.storePath ?? defaultStorePath());

  let inFlight = 0;
  const fetchOne = async (query: EstimateQuery) => {
    if (inFlight !== 0) {
      throw new Error("Collector invariant broken: more than one Airbnb request in flight");
    }
    inFlight += 1;
    try {
      return await fetchImpl(query);
    } finally {
      inFlight -= 1;
    }
  };

  try {
    const previous = store.getProgress(key);
    if (previous && previous.cellDegrees !== CELL_DEGREES) {
      throw new Error(
        `This store was collected at ${previous.cellDegrees}° cells. Refusing to mix in a ${CELL_DEGREES}° grid.`,
      );
    }

    if (previous && isHardStop(previous.lastStopReason) && !options.acknowledgeStop) {
      log(
        `collect  refused  last run stopped (${previous.lastStopReason}). Re-run with --acknowledge-stop after you have read why: ${previous.lastStopDetail ?? ""}`,
      );
      return {
        refused: true,
        dryRun,
        stop: "refused",
        stopDetail: previous.lastStopDetail,
        airbnbRequests: 0,
        cursor: previous.gridCursor,
        gridLength: previous.gridLength,
        deferred: previous.deferredIndexes.length,
        marketsIngested: [],
        planned: [],
      };
    }

    const marketsIngested: string[] = [];
    if (!dryRun) {
      marketsIngested.push(
        ...(await ingestDueMarkets({
          store,
          markets,
          marketsPerRun,
          freshMs,
          now,
          log,
        })),
      );
    }

    const pending = pendingAnchors(store, markets, grid.anchors, now(), freshMs);
    const freshCell = (cell: WorldCell) =>
      cellIsFresh(store, cell, roomType, bedrooms, currency, now(), freshMs);
    const reservedCell = (cell: WorldCell) => reservedBy(cell, pending) !== null;

    if (dryRun) {
      const planned = planRequests({
        cells: grid.cells,
        cursor: previous?.gridCursor ?? 0,
        deferred: previous?.deferredIndexes ?? [],
        budget,
        freshCell,
        reservedCell,
      });
      for (const cell of planned) {
        log(`collect  dry-run  ${cell.latitude.toFixed(1)},${cell.longitude.toFixed(1)}  ${cell.id}`);
      }
      log(`collect  dry-run  ${planned.length} Airbnb request(s) would be made. Nothing was sent or saved.`);
      return {
        refused: false,
        dryRun: true,
        stop: planned.length >= budget && budget > 0 ? "budget" : null,
        stopDetail: "Dry run. No requests were sent and progress was not saved.",
        airbnbRequests: 0,
        cursor: previous?.gridCursor ?? 0,
        gridLength: grid.cells.length,
        deferred: previous?.deferredIndexes.length ?? 0,
        marketsIngested,
        planned: planned.map((cell) => ({
          cellId: cell.id,
          latitude: cell.latitude,
          longitude: cell.longitude,
        })),
      };
    }

    let state = initialWalk({
      length: grid.cells.length,
      budget,
      cursor: previous?.gridCursor ?? 0,
      deferred: previous?.deferredIndexes ?? [],
      spikeThreshold,
    });

    if (budget > 0) {
      let launched = 0;
      let nextGap = spacingMs(delayMs, jitterMs, random());

      const consider = async (index: number, fromDeferred: boolean) => {
        if (state.stop) return;
        const cell = grid.cells[index];
        if (!cell) return;
        const action = cellAction({
          fresh: freshCell(cell),
          reserved: reservedCell(cell),
        });

        if (action !== "fetch") {
          state = reduceVisit(state, index, action, fromDeferred);
          return;
        }

        if (state.used >= state.budget) {
          state = {
            ...state,
            stop: "budget",
            stopDetail: `Request budget of ${state.budget} reached`,
            deferred:
              fromDeferred && !state.deferred.includes(index)
                ? [...state.deferred, index]
                : state.deferred,
          };
          return;
        }

        if (launched > 0) await pause(nextGap);

        launched += 1;
        log(
          `collect  airbnb ${launched}/${budget}  ${cell.latitude.toFixed(2)},${cell.longitude.toFixed(2)}  ${roomType} ${bedrooms}br ${currency}`,
        );

        try {
          const estimate = await fetchOne({
            searchQuery: coordQuery(cell.latitude, cell.longitude),
            roomTypeCategory: roomType,
            bedrooms,
            currency,
          });
          store.upsert({
            cellId: cell.id,
            latitude: cell.latitude,
            longitude: cell.longitude,
            cellHeight: CELL_DEGREES,
            cellWidth: CELL_DEGREES,
            monthly: estimate?.monthly ?? null,
            nightly: estimate?.nightly ?? null,
            nights: estimate?.nights ?? null,
            currency,
            roomType,
            bedrooms,
            source: "GetHostEstimateData",
            fetchedAt: new Date(now()).toISOString(),
            status: estimate ? "estimate" : "empty",
            sampleSize: estimate ? estimate.comparables.length : 0,
            marketSlug: null,
          });
          state = reduceVisit(state, index, estimate ? "stored" : "empty", fromDeferred);
          const gross = estimate ? `${estimate.monthly} ${estimate.currency}/mo gross` : "no supply";
          log(`collect  stored  ${cell.id}  ${gross}`);
          nextGap = spacingMs(delayMs, jitterMs, random());
        } catch (error) {
          const status = airbnbStatus(error);
          const hard = httpStopReason(status);
          const message = error instanceof Error ? error.message : "Request failed";
          log(`collect  error  ${cell.id}  ${message}`);
          state = reduceVisit(state, index, hard ?? "error", fromDeferred);
          if (!state.stop) {
            nextGap = errorGapMs(delayMs, jitterMs, state.consecutiveErrors, random());
          }
        }
      };

      const deferredQueue = [...state.deferred];
      for (const index of deferredQueue) {
        await consider(index, true);
        if (state.stop) break;
      }

      while (!state.stop && state.cursor < grid.cells.length) {
        const index = state.cursor;
        await consider(index, false);
        if (!state.stop && state.cursor === index) {
          throw new Error(`Collector did not advance past cell index ${index}`);
        }
      }
    } else {
      state = {
        ...state,
        stop: "budget",
        stopDetail:
          "Budget is 0. Inside Airbnb markets were ingested; no Airbnb requests were made.",
      };
    }

    state = finishWalk(state);
    const updatedAt = new Date(now()).toISOString();
    store.saveRun(
      {
        queryKey: key,
        gridCursor: state.cursor,
        gridLength: grid.cells.length,
        cellDegrees: CELL_DEGREES,
        lastRunAt: updatedAt,
        lastStopReason: state.stop,
        lastStopDetail: state.stopDetail,
        lastAirbnbRequests: state.used,
        totalAirbnbRequests: (previous?.totalAirbnbRequests ?? 0) + state.used,
        updatedAt,
      },
      state.deferred,
    );

    log(
      `collect  done  stop=${state.stop ?? "none"}  airbnb=${state.used}  cursor=${state.cursor}/${grid.cells.length}  deferred=${state.deferred.length}`,
    );
    if (state.stopDetail) log(`collect  ${state.stopDetail}`);

    return {
      refused: false,
      dryRun: false,
      stop: state.stop,
      stopDetail: state.stopDetail,
      airbnbRequests: state.used,
      cursor: state.cursor,
      gridLength: grid.cells.length,
      deferred: state.deferred.length,
      marketsIngested,
      planned: [],
    };
  } finally {
    store.close();
  }
}

function cellIsFresh(
  store: EstimateStore,
  cell: WorldCell,
  roomType: RoomTypeCategory,
  bedrooms: number,
  currency: string,
  nowMs: number,
  freshMs: number,
): boolean {
  const airbnbAt = store.airbnbFetchedAt(cell.id, roomType, bedrooms, currency);
  if (airbnbAt && isFresh(airbnbAt, nowMs, freshMs)) return true;
  const insideAt = store.insideFetchedAt(cell.id, roomType);
  return Boolean(insideAt && isFresh(insideAt, nowMs, freshMs));
}

function pendingAnchors(
  store: EstimateStore,
  markets: readonly Market[],
  anchors: readonly MarketAnchor[],
  nowMs: number,
  freshMs: number,
): MarketAnchor[] {
  const pending = new Set<string>();
  for (const market of markets) {
    const row = store.getMarket(market.slug);
    if (!row || row.status === "failed") {
      pending.add(market.slug);
      continue;
    }
    if (row.status === "skipped") continue;
    if (!isFresh(row.fetchedAt, nowMs, freshMs)) pending.add(market.slug);
  }
  return anchors.filter((anchor) => pending.has(anchor.slug));
}

async function ingestDueMarkets(input: {
  store: EstimateStore;
  markets: readonly Market[];
  marketsPerRun: number;
  freshMs: number;
  now: () => number;
  log: (message: string) => void;
}): Promise<string[]> {
  const due = input.markets.filter((market) => {
    const row = input.store.getMarket(market.slug);
    if (!row || row.status === "failed") return true;
    if (row.status === "skipped") return false;
    return !isFresh(row.fetchedAt, input.now(), input.freshMs);
  });

  const snapshots: Market[] = [];
  const remote: Market[] = [];
  for (const market of due) {
    if (existsSync(snapshotPath(market.slug))) snapshots.push(market);
    else remote.push(market);
  }

  const ingested: string[] = [];
  for (const market of snapshots) {
    if (await ingestMarket(input, market, "snapshot")) ingested.push(market.slug);
  }
  for (const market of remote.slice(0, input.marketsPerRun)) {
    if (await ingestMarket(input, market, "network")) ingested.push(market.slug);
  }
  return ingested;
}

async function ingestMarket(
  input: { store: EstimateStore; now: () => number; log: (message: string) => void },
  market: Market,
  origin: "snapshot" | "network",
): Promise<boolean> {
  try {
    const dataset = await readMarket(market, origin);
    const fetchedAt = new Date(input.now()).toISOString();
    const rows = aggregateMarketCells(dataset, DEFAULT_MODEL, fetchedAt);
    input.store.replaceMarket(market.slug, rows);
    input.store.recordMarket({
      slug: market.slug,
      fetchedAt,
      cellsWritten: rows.length,
      origin,
      failures: 0,
      status: "ok",
    });
    input.log(`collect  inside-airbnb  ${market.city}  ${rows.length} gross cells (${origin})`);
    return true;
  } catch (error) {
    const failures = input.store.recordMarketFailure(market.slug, MARKET_FAILURE_LIMIT);
    const message = error instanceof Error ? error.message : "failed";
    input.log(`collect  inside-airbnb  ${market.slug}  failed (${failures}): ${message}`);
    return false;
  }
}

async function readMarket(market: Market, origin: "snapshot" | "network"): Promise<MarketDataset> {
  if (origin === "snapshot") {
    const text = await readFile(snapshotPath(market.slug), "utf8");
    return JSON.parse(text) as MarketDataset;
  }
  const loaded = await loadDataset(market);
  return loaded.dataset;
}

function planRequests(input: {
  cells: readonly WorldCell[];
  cursor: number;
  deferred: readonly number[];
  budget: number;
  freshCell: (cell: WorldCell) => boolean;
  reservedCell: (cell: WorldCell) => boolean;
}): WorldCell[] {
  if (input.budget <= 0) return [];
  const planned: WorldCell[] = [];
  const seen = new Set<number>();
  const indexes = [...input.deferred];
  for (let index = input.cursor; index < input.cells.length; index++) indexes.push(index);

  for (const index of indexes) {
    if (seen.has(index)) continue;
    seen.add(index);
    const cell = input.cells[index];
    if (!cell) continue;
    const action = cellAction({
      fresh: input.freshCell(cell),
      reserved: input.reservedCell(cell),
    });
    if (action !== "fetch") continue;
    planned.push(cell);
    if (planned.length >= input.budget) break;
  }
  return planned;
}

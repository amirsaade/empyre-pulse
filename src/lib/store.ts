/**
 * Persisted store for collected gross-earnings estimates.
 *
 * Records live in the repo as JSON so a collector can commit them and a
 * reviewer can read the diff. SQLite would be a binary blob with no useful
 * diff and no clean merge. Layout:
 *
 * - `data/collected/cells/<cell>__<query>__<hash>.json` — one record per cell
 *   and query. Upsert rewrites only that file.
 * - `data/collected/cursor.json` — grid resumption cursor, or `null` when idle.
 * - `data/collected/runs.jsonl` — append-only run log, one JSON object per line.
 *
 * `monthly`, `nightly`, and `nights` are gross booking figures, never net.
 * This module does not call Airbnb.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ESTIMATE_SOURCES = ["airbnb-host-estimate", "inside-airbnb"] as const;
export type EstimateSource = (typeof ESTIMATE_SOURCES)[number];

/** Normalized across both sources. Map Inside Airbnb labels before writing. */
export const STORED_ROOM_TYPE_CATEGORIES = [
  "ENTIRE_HOME",
  "PRIVATE_ROOM",
  "SHARED_ROOM",
  "HOTEL_ROOM",
] as const;
export type StoredRoomTypeCategory = (typeof STORED_ROOM_TYPE_CATEGORIES)[number];

/** A stored figure older than this is stale unless the caller passes another window. */
export const DEFAULT_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1000;

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

/** Identity of one collected figure. Upsert dedupes on these fields. */
export type EstimateKey = {
  cellId: string;
  roomTypeCategory: StoredRoomTypeCategory;
  bedrooms: number;
  currency: string;
  source: EstimateSource;
};

export type StoredEstimate = EstimateKey & {
  latitude: number;
  longitude: number;
  /** Gross monthly booking revenue. */
  monthly: number;
  /** Gross nightly rate behind `monthly`. */
  nightly: number;
  /** Nights booked behind the gross monthly figure. */
  nights: number;
  /** ISO-8601 time this figure was collected. */
  fetchedAt: string;
};

export type FreshnessOptions = {
  /** Defaults to {@link DEFAULT_FRESHNESS_MS} (30 days). */
  maxAgeMs?: number;
  now?: Date;
};

export type Freshness = {
  record: StoredEstimate | null;
  fetchedAt: string | null;
  /** Milliseconds since `fetchedAt`. Null when nothing is stored. */
  ageMs: number | null;
  /** True when a record exists and is within the freshness window. */
  fresh: boolean;
};

/** Where a grid sweep should resume. One cursor for the active sweep. */
export type GridCursor = {
  sweepId: string;
  /** Zero-based index of the next cell to collect. Equal to `total` when finished. */
  nextIndex: number;
  lastCellId: string | null;
  total: number | null;
  roomTypeCategory: StoredRoomTypeCategory;
  bedrooms: number;
  currency: string;
  source: EstimateSource;
  updatedAt: string;
};

export type GridCursorInput = Omit<GridCursor, "updatedAt">;

export type RunError = {
  /** HTTP status when the failure was an HTTP error, including 429 and 403. */
  status: number | null;
  message: string;
  /** How many times this error occurred in the run. */
  count: number;
};

export type RunLogEntry = {
  /** ISO-8601 time the run finished or stopped. */
  date: string;
  cellsCollected: number;
  errors: RunError[];
  /** True when the run halted before the sweep finished. */
  stopped: boolean;
  /** Pull requests opened for the data this run collected. */
  prsOpened: string[];
};

export type RunLogSummary = {
  runs: number;
  cellsCollected: number;
  lastRunAt: string | null;
  stoppedRuns: number;
  errorsByStatus: { status: number | null; count: number }[];
  prsOpened: string[];
};

export const collectedDir = path.join(process.cwd(), "data", "collected");
export const cellsDir = path.join(collectedDir, "cells");
export const cursorPath = path.join(collectedDir, "cursor.json");
export const runsPath = path.join(collectedDir, "runs.jsonl");

function fail(message: string): never {
  throw new StoreError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function displayPath(filePath: string): string {
  const relative = path.relative(process.cwd(), filePath);
  return relative.startsWith("..") ? filePath : relative;
}

function assertCellId(value: unknown): string {
  if (typeof value !== "string") fail("cellId must be a string");
  const cellId = value.trim();
  if (!cellId || cellId.length > 180 || /[\u0000-\u001F\u007F]/.test(cellId)) {
    fail("cellId must be 1–180 characters without control characters");
  }
  return cellId;
}

function assertRoomType(value: unknown): StoredRoomTypeCategory {
  if (
    value === "ENTIRE_HOME" ||
    value === "PRIVATE_ROOM" ||
    value === "SHARED_ROOM" ||
    value === "HOTEL_ROOM"
  ) {
    return value;
  }
  fail("roomTypeCategory must be ENTIRE_HOME, PRIVATE_ROOM, SHARED_ROOM, or HOTEL_ROOM");
}

function assertBedrooms(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 20) {
    fail("bedrooms must be an integer from 0 to 20");
  }
  return value;
}

function assertCurrency(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z]{3}$/.test(value)) {
    fail("currency must be a 3-letter ISO 4217 code");
  }
  return value.toUpperCase();
}

function assertSource(value: unknown): EstimateSource {
  if (value === "airbnb-host-estimate" || value === "inside-airbnb") return value;
  fail('source must be "airbnb-host-estimate" or "inside-airbnb"');
}

function assertLatitude(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < -90 || value > 90) {
    fail("latitude must be a number from -90 to 90");
  }
  return value;
}

function assertLongitude(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < -180 || value > 180) {
    fail("longitude must be a number from -180 to 180");
  }
  return value;
}

function assertGross(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`${label} must be a non-negative finite number (gross booking revenue)`);
  }
  return value;
}

function assertTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || Number.isNaN(Date.parse(value))) {
    fail(`${label} must be an ISO-8601 timestamp`);
  }
  return value.trim();
}

function assertCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(`${label} must be an integer >= 0`);
  }
  return value;
}

export function normalizeKey(key: {
  cellId: unknown;
  roomTypeCategory: unknown;
  bedrooms: unknown;
  currency: unknown;
  source: unknown;
}): EstimateKey {
  return {
    cellId: assertCellId(key.cellId),
    roomTypeCategory: assertRoomType(key.roomTypeCategory),
    bedrooms: assertBedrooms(key.bedrooms),
    currency: assertCurrency(key.currency),
    source: assertSource(key.source),
  };
}

/** Stable dedupe identity: cell id plus source, room type, bedrooms, and currency. */
export function estimateDedupeKey(key: EstimateKey): string {
  const normalized = normalizeKey(key);
  return [
    normalized.cellId,
    normalized.source,
    normalized.roomTypeCategory,
    String(normalized.bedrooms),
    normalized.currency,
  ].join("|");
}

function canonicalKey(key: EstimateKey): string {
  return [
    key.cellId,
    key.source,
    key.roomTypeCategory,
    String(key.bedrooms),
    key.currency,
  ].join("\0");
}

function estimateFileName(key: EstimateKey): string {
  const slug =
    key.cellId
      .replace(/[^A-Za-z0-9.-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64) || "cell";
  const hash = createHash("sha256").update(canonicalKey(key)).digest("hex").slice(0, 12);
  return `${slug}__${key.source}__${key.roomTypeCategory}__${key.bedrooms}__${key.currency}__${hash}.json`;
}

function normalizeEstimate(input: unknown): StoredEstimate {
  if (!isRecord(input)) fail("estimate must be an object");
  const key = normalizeKey({
    cellId: input.cellId,
    roomTypeCategory: input.roomTypeCategory,
    bedrooms: input.bedrooms,
    currency: input.currency,
    source: input.source,
  });
  return {
    cellId: key.cellId,
    latitude: assertLatitude(input.latitude),
    longitude: assertLongitude(input.longitude),
    monthly: assertGross(input.monthly, "monthly"),
    nightly: assertGross(input.nightly, "nightly"),
    nights: assertGross(input.nights, "nights"),
    currency: key.currency,
    roomTypeCategory: key.roomTypeCategory,
    bedrooms: key.bedrooms,
    source: key.source,
    fetchedAt: assertTimestamp(input.fetchedAt, "fetchedAt"),
  };
}

function writeAtomic(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, contents, "utf8");
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Nothing to clean up when the temp file was never created.
    }
    throw error;
  }
}

function readJson(filePath: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail(`${displayPath(filePath)} is not valid JSON`);
  }
}

function compareEstimates(a: StoredEstimate, b: StoredEstimate): number {
  return (
    a.cellId.localeCompare(b.cellId) ||
    a.source.localeCompare(b.source) ||
    a.roomTypeCategory.localeCompare(b.roomTypeCategory) ||
    a.bedrooms - b.bedrooms ||
    a.currency.localeCompare(b.currency)
  );
}

/** Every stored cell, sorted by cell id and query. Malformed files throw. */
export function readEstimates(): StoredEstimate[] {
  let names: string[];
  try {
    names = fs.readdirSync(cellsDir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const records: StoredEstimate[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const parsed = readJson(path.join(cellsDir, name));
    if (parsed === undefined) continue;
    let record: StoredEstimate;
    try {
      record = normalizeEstimate(parsed);
    } catch (error) {
      if (error instanceof StoreError) fail(`${name}: ${error.message}`);
      throw error;
    }
    if (estimateFileName(record) !== name) {
      fail(`${name} does not match the cell and query stored inside it`);
    }
    records.push(record);
  }
  records.sort(compareEstimates);
  return records;
}

/** The record for this cell and query, or null when it has never been stored. */
export function readEstimate(key: EstimateKey): StoredEstimate | null {
  const normalized = normalizeKey(key);
  const name = estimateFileName(normalized);
  const parsed = readJson(path.join(cellsDir, name));
  if (parsed === undefined) return null;
  let record: StoredEstimate;
  try {
    record = normalizeEstimate(parsed);
  } catch (error) {
    if (error instanceof StoreError) fail(`${name}: ${error.message}`);
    throw error;
  }
  if (estimateDedupeKey(record) !== estimateDedupeKey(normalized)) {
    fail(`${name} does not match the cell and query stored inside it`);
  }
  return record;
}

/**
 * Insert or replace the record for this cell and query.
 * Currency is stored uppercase. A second write of the same key overwrites.
 */
export function upsertEstimate(input: StoredEstimate): StoredEstimate {
  const record = normalizeEstimate(input);
  writeAtomic(
    path.join(cellsDir, estimateFileName(record)),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}

export function upsertEstimates(inputs: readonly StoredEstimate[]): StoredEstimate[] {
  return inputs.map((input) => upsertEstimate(input));
}

/**
 * Whether a future collector can skip this cell. Missing records are not fresh.
 * A `fetchedAt` in the future is not fresh.
 */
export function lookupFreshness(key: EstimateKey, options: FreshnessOptions = {}): Freshness {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_FRESHNESS_MS;
  if (typeof maxAgeMs !== "number" || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    fail("maxAgeMs must be a non-negative finite number");
  }
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) fail("now must be a valid date");

  const record = readEstimate(key);
  if (!record) {
    return { record: null, fetchedAt: null, ageMs: null, fresh: false };
  }
  const ageMs = now.getTime() - Date.parse(record.fetchedAt);
  return {
    record,
    fetchedAt: record.fetchedAt,
    ageMs,
    fresh: ageMs >= 0 && ageMs <= maxAgeMs,
  };
}

function assertSweepId(value: unknown): string {
  if (typeof value !== "string") fail("sweepId must be a string");
  const sweepId = value.trim();
  if (!sweepId || sweepId.length > 200 || /[\u0000-\u001F\u007F]/.test(sweepId)) {
    fail("sweepId must be 1–200 characters without control characters");
  }
  return sweepId;
}

function parseCursor(value: unknown): GridCursor {
  if (!isRecord(value)) fail("cursor must be an object");
  const cursor: GridCursor = {
    sweepId: assertSweepId(value.sweepId),
    nextIndex: assertCount(value.nextIndex, "nextIndex"),
    lastCellId: value.lastCellId === null ? null : assertCellId(value.lastCellId),
    total: value.total === null ? null : assertCount(value.total, "total"),
    roomTypeCategory: assertRoomType(value.roomTypeCategory),
    bedrooms: assertBedrooms(value.bedrooms),
    currency: assertCurrency(value.currency),
    source: assertSource(value.source),
    updatedAt: assertTimestamp(value.updatedAt, "updatedAt"),
  };
  if (cursor.total !== null && cursor.nextIndex > cursor.total) {
    fail("cursor nextIndex cannot be greater than total");
  }
  return cursor;
}

/** The active sweep cursor, or null when no sweep is in progress. */
export function readCursor(): GridCursor | null {
  const parsed = readJson(cursorPath);
  if (parsed === undefined || parsed === null) return null;
  return parseCursor(parsed);
}

/** Replace the cursor. `updatedAt` is set to the time of this write. */
export function writeCursor(input: GridCursorInput): GridCursor {
  const cursor = parseCursor({ ...input, updatedAt: new Date().toISOString() });
  writeAtomic(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`);
  return cursor;
}

/** Mark the sweep idle. The file stays in the repo as JSON `null`. */
export function clearCursor(): void {
  writeAtomic(cursorPath, "null\n");
}

function parseRunError(value: unknown, where: string): RunError {
  if (!isRecord(value)) fail(`${where} must be an object`);
  let status: number | null;
  if (value.status === null) {
    status = null;
  } else if (
    typeof value.status === "number" &&
    Number.isInteger(value.status) &&
    value.status >= 100 &&
    value.status <= 599
  ) {
    status = value.status;
  } else {
    fail(`${where}.status must be an HTTP status (including 429 or 403) or null`);
  }
  if (typeof value.message !== "string" || value.message.trim() === "" || value.message.length > 2000) {
    fail(`${where}.message must be a non-empty string`);
  }
  return {
    status,
    message: value.message.trim(),
    count: assertCount(value.count, `${where}.count`),
  };
}

function parseRun(value: unknown, where: string): RunLogEntry {
  if (!isRecord(value)) fail(`${where} must be an object`);
  if (!Array.isArray(value.errors)) fail(`${where}.errors must be an array`);
  if (!Array.isArray(value.prsOpened)) fail(`${where}.prsOpened must be an array`);
  if (typeof value.stopped !== "boolean") fail(`${where}.stopped must be a boolean`);
  const prsOpened = value.prsOpened.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "" || entry.length > 500) {
      fail(`${where}.prsOpened[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
  return {
    date: assertTimestamp(value.date, `${where}.date`),
    cellsCollected: assertCount(value.cellsCollected, `${where}.cellsCollected`),
    errors: value.errors.map((entry, index) => parseRunError(entry, `${where}.errors[${index}]`)),
    stopped: value.stopped,
    prsOpened,
  };
}

/** Append one run. Earlier lines are never rewritten. */
export function appendRun(input: RunLogEntry): RunLogEntry {
  const entry = parseRun(input, "run log entry");
  fs.mkdirSync(collectedDir, { recursive: true });
  let prefix = "";
  try {
    const stat = fs.statSync(runsPath);
    if (stat.size > 0) {
      const fd = fs.openSync(runsPath, "r");
      try {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, stat.size - 1);
        if (last[0] !== 0x0a) prefix = "\n";
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  fs.appendFileSync(runsPath, `${prefix}${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

/** Runs in file order, oldest first. */
export function readRuns(): RunLogEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(runsPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  if (text.trim() === "") return [];

  const runs: RunLogEntry[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      fail(`${displayPath(runsPath)} line ${index + 1} is not valid JSON`);
    }
    runs.push(parseRun(parsed, `${displayPath(runsPath)} line ${index + 1}`));
  }
  return runs;
}

/** Compact totals for the read-only API. Pass `runs` to avoid reading twice. */
export function summarizeRuns(runs: readonly RunLogEntry[] = readRuns()): RunLogSummary {
  const byStatus = new Map<number | null, number>();
  const prsOpened: string[] = [];
  let cellsCollected = 0;
  let stoppedRuns = 0;

  for (const run of runs) {
    cellsCollected += run.cellsCollected;
    if (run.stopped) stoppedRuns += 1;
    for (const error of run.errors) {
      byStatus.set(error.status, (byStatus.get(error.status) ?? 0) + error.count);
    }
    for (const pr of run.prsOpened) {
      if (!prsOpened.includes(pr)) prsOpened.push(pr);
    }
  }

  const errorsByStatus = [...byStatus.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => {
      if (a.status === null) return 1;
      if (b.status === null) return -1;
      return a.status - b.status;
    });

  return {
    runs: runs.length,
    cellsCollected,
    lastRunAt: runs.length > 0 ? runs[runs.length - 1].date : null,
    stoppedRuns,
    errorsByStatus,
    prsOpened,
  };
}

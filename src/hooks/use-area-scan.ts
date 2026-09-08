"use client";

import { useCallback, useRef, useState } from "react";

import type { Comparable, RoomTypeCategory } from "@/lib/airbnb-estimate";
import type { Bounds, ScanCell, ScanEvent } from "@/lib/scan";

export type ScanStatus = "idle" | "scanning" | "done" | "error";

export type ScanMeta = {
  total: number;
  rows: number;
  cols: number;
  cellHeight: number;
  cellWidth: number;
  currency: string;
};

export type ScanState = {
  status: ScanStatus;
  cells: ScanCell[];
  comparables: Comparable[];
  meta: ScanMeta | null;
  completed: number;
  failed: number;
  error: string | null;
  elapsedMs: number | null;
};

const INITIAL: ScanState = {
  status: "idle",
  cells: [],
  comparables: [],
  meta: null,
  completed: 0,
  failed: 0,
  error: null,
  elapsedMs: null,
};

export type ScanOptions = {
  bounds: Bounds;
  resolution: number;
  roomTypeCategory: RoomTypeCategory;
  bedrooms: number;
  currency: string;
};

/**
 * Drives a grid scan over the NDJSON stream from /api/scan, committing cells to
 * state as they land so the map paints progressively instead of blocking on the
 * full sweep.
 */
export function useAreaScan() {
  const [state, setState] = useState<ScanState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState((prev) =>
      prev.status === "scanning" ? { ...prev, status: prev.cells.length ? "done" : "idle" } : prev,
    );
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(INITIAL);
  }, []);

  const start = useCallback(async (options: ScanOptions) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ ...INITIAL, status: "scanning" });

    // Batch incoming cells into animation frames; committing 400 cells one
    // React render at a time would thrash the map.
    let pendingCells: ScanCell[] = [];
    let pendingComparables: Comparable[] = [];
    let pendingCompleted = 0;
    let pendingFailed = 0;
    let flushScheduled = false;

    const flush = () => {
      flushScheduled = false;
      if (
        pendingCells.length === 0 &&
        pendingComparables.length === 0 &&
        pendingCompleted === 0 &&
        pendingFailed === 0
      ) {
        return;
      }

      const cells = pendingCells;
      const comparables = pendingComparables;
      const completed = pendingCompleted;
      const failed = pendingFailed;
      pendingCells = [];
      pendingComparables = [];
      pendingCompleted = 0;
      pendingFailed = 0;

      setState((prev) => ({
        ...prev,
        cells: cells.length ? [...prev.cells, ...cells] : prev.cells,
        comparables: comparables.length ? [...prev.comparables, ...comparables] : prev.comparables,
        completed: prev.completed + completed,
        failed: prev.failed + failed,
      }));
    };

    const schedule = () => {
      if (flushScheduled) return;
      flushScheduled = true;
      requestAnimationFrame(flush);
    };

    const seenComparables = new Set<string>();

    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(options),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const detail = await response.json().catch(() => null);
        throw new Error(detail?.error ?? `Scan failed with status ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let event: ScanEvent;
          try {
            event = JSON.parse(line) as ScanEvent;
          } catch {
            continue;
          }

          switch (event.type) {
            case "meta":
              setState((prev) => ({
                ...prev,
                meta: {
                  total: event.total,
                  rows: event.rows,
                  cols: event.cols,
                  cellHeight: event.cellHeight,
                  cellWidth: event.cellWidth,
                  currency: event.currency,
                },
              }));
              break;
            case "cell":
              pendingCells.push(event.cell);
              pendingCompleted++;
              for (const comparable of event.comparables) {
                if (seenComparables.has(comparable.id)) continue;
                seenComparables.add(comparable.id);
                pendingComparables.push(comparable);
              }
              schedule();
              break;
            case "empty":
              pendingCompleted++;
              schedule();
              break;
            case "error":
              pendingCompleted++;
              pendingFailed++;
              schedule();
              break;
            case "done":
              flush();
              setState((prev) => ({ ...prev, status: "done", elapsedMs: event.elapsedMs }));
              break;
          }
        }
      }

      flush();
      setState((prev) => (prev.status === "scanning" ? { ...prev, status: "done" } : prev));
    } catch (error) {
      if (controller.signal.aborted) return;
      setState((prev) => ({
        ...prev,
        status: "error",
        error: error instanceof Error ? error.message : "Scan failed",
      }));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  return { state, start, cancel, reset };
}

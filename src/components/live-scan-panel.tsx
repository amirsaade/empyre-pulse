"use client";

import { Loader2, Radar, Search, Square, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Legend } from "@/components/legend";
import { StatTile } from "@/components/stat-tile";
import { magmaCss, normalize } from "@/lib/color";
import { formatCompactMoney, formatCount, formatMoney } from "@/lib/format";
import { RESOLUTION_OPTIONS } from "@/lib/scan";
import type { ScanCell } from "@/lib/scan";
import type { ScanState } from "@/hooks/use-area-scan";
import type { RoomTypeCategory } from "@/lib/airbnb-estimate";

export type ScanConfig = {
  bedrooms: number;
  roomTypeCategory: RoomTypeCategory;
  resolution: number;
  currency: string;
};

export const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "CHF", "SEK", "MXN", "BRL"];

type Props = {
  query: string;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  searching: boolean;
  placeError: string | null;
  areaName: string | null;
  config: ScanConfig;
  onConfigChange: (config: ScanConfig) => void;
  scan: ScanState;
  onScan: () => void;
  onCancel: () => void;
  domain: [number, number];
  stats: { median: number; max: number; min: number } | null;
  topCells: ScanCell[];
  showComparables: boolean;
  onShowComparablesChange: (value: boolean) => void;
  extruded: boolean;
  onExtrudedChange: (value: boolean) => void;
  onFocusCell: (cell: ScanCell) => void;
};

export function LiveScanPanel({
  query,
  onQueryChange,
  onSearch,
  searching,
  placeError,
  areaName,
  config,
  onConfigChange,
  scan,
  onScan,
  onCancel,
  domain,
  stats,
  topCells,
  showComparables,
  onShowComparablesChange,
  extruded,
  onExtrudedChange,
  onFocusCell,
}: Props) {
  const scanning = scan.status === "scanning";
  const progress = scan.meta ? Math.round((scan.completed / Math.max(1, scan.meta.total)) * 100) : 0;
  const currency = scan.meta?.currency ?? config.currency;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="place" className="text-xs text-muted-foreground">
          Jump to a place
        </Label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="place"
              value={query}
              placeholder="Lisbon, Austin, Poprad…"
              className="h-9 pl-8"
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onSearch();
              }}
            />
          </div>
          <Button variant="secondary" size="sm" className="h-9" onClick={onSearch} disabled={searching}>
            {searching ? <Loader2 className="size-3.5 animate-spin" /> : "Go"}
          </Button>
        </div>
        {placeError ? <p className="text-xs text-destructive">{placeError}</p> : null}
        {areaName && !placeError ? (
          <p className="text-xs text-muted-foreground">Framed on {areaName}. Pan or zoom to adjust.</p>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Bedrooms</Label>
          <Select
            value={String(config.bedrooms)}
            onValueChange={(value) => onConfigChange({ ...config, bedrooms: Number(value) })}
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">Studio</SelectItem>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} bedroom{n > 1 ? "s" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Listing type</Label>
          <Select
            value={config.roomTypeCategory}
            onValueChange={(value) =>
              onConfigChange({ ...config, roomTypeCategory: value as RoomTypeCategory })
            }
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ENTIRE_HOME">Entire place</SelectItem>
              <SelectItem value="PRIVATE_ROOM">Private room</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Detail</Label>
          <Select
            value={String(config.resolution)}
            onValueChange={(value) => onConfigChange({ ...config, resolution: Number(value) })}
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RESOLUTION_OPTIONS.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {option} × {option} grid
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Currency</Label>
          <Select
            value={config.currency}
            onValueChange={(value) => onConfigChange({ ...config, currency: value })}
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CURRENCIES.map((code) => (
                <SelectItem key={code} value={code}>
                  {code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {scanning ? (
        <Button variant="destructive" className="w-full gap-2" onClick={onCancel}>
          <Square className="size-3.5" />
          Stop scan · {progress}%
        </Button>
      ) : (
        <Button className="w-full gap-2" onClick={onScan}>
          <Radar className="size-4" />
          Scan this area
        </Button>
      )}

      {scan.meta ? (
        <div className="space-y-1.5">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
            <span>
              {formatCount(scan.completed)} / {formatCount(scan.meta.total)} cells
            </span>
            <span>
              {scan.status === "done" && scan.elapsedMs
                ? `done in ${(scan.elapsedMs / 1000).toFixed(1)}s`
                : scanning
                  ? "querying Airbnb…"
                  : null}
            </span>
          </div>
        </div>
      ) : null}

      {scan.error ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <X className="mt-0.5 size-3.5 shrink-0" />
          <span>{scan.error}</span>
        </div>
      ) : null}

      {stats && scan.cells.length > 0 ? (
        <>
          <div className="grid grid-cols-3 gap-2">
            <StatTile label="Median" value={formatCompactMoney(stats.median, currency)} hint="/ month" />
            <StatTile label="Best cell" value={formatCompactMoney(stats.max, currency)} hint="/ month" />
            <StatTile
              label="Spread"
              value={`${(stats.max / Math.max(1, stats.min)).toFixed(1)}×`}
              hint="best vs worst"
            />
          </div>

          <Legend domain={domain} currency={currency} label="Airbnb host estimate" unit="per month" />

          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-card/60 px-3 py-2">
            <Label htmlFor="comparables" className="text-xs font-normal text-muted-foreground">
              Show the {formatCount(scan.comparables.length)} comparable listings
            </Label>
            <Switch
              id="comparables"
              checked={showComparables}
              onCheckedChange={onShowComparablesChange}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-card/60 px-3 py-2">
            <Label htmlFor="extruded" className="text-xs font-normal text-muted-foreground">
              Raise cells into 3D columns
            </Label>
            <Switch id="extruded" checked={extruded} onCheckedChange={onExtrudedChange} />
          </div>

          {topCells.length > 0 ? (
            <div className="space-y-1.5">
              <div className="text-xs font-medium">Highest earning cells</div>
              <ul className="space-y-1">
                {topCells.map((cell, rank) => (
                  <li key={cell.index}>
                    <button
                      type="button"
                      onClick={() => onFocusCell(cell)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                    >
                      <span
                        className="size-2.5 shrink-0 rounded-[3px] ring-1 ring-white/20"
                        style={{
                          backgroundColor: magmaCss(
                            normalize(cell.monthly, domain[0], domain[1]),
                          ),
                        }}
                      />
                      <span className="w-4 shrink-0 font-mono text-[11px] text-muted-foreground">
                        {rank + 1}
                      </span>
                      <span className="flex-1 truncate font-mono text-xs tabular-nums">
                        {formatMoney(cell.monthly, currency)}
                      </span>
                      <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
                        {Math.round(cell.nights)} nts
                      </Badge>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}

      {scan.status === "idle" && !scan.meta ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Search a city or pan the map, then scan. Each grid cell asks Airbnb what a host in that
          exact spot earns per month, so the heatmap is built from Airbnb&apos;s own figures.
        </p>
      ) : null}
    </div>
  );
}

"use client";

import { Globe, Loader2 } from "lucide-react";

import { Legend } from "@/components/legend";
import { StatTile } from "@/components/stat-tile";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { RoomTypeCategory } from "@/lib/airbnb-estimate";
import type { CollectedResponse, MapEstimate } from "@/lib/estimate-record";
import { formatCompactMoney, formatCount, formatMoney } from "@/lib/format";

type Props = {
  loading: boolean;
  error: string | null;
  data: CollectedResponse | null;
  extruded: boolean;
  onExtrudedChange: (value: boolean) => void;
  onCurrencyChange: (currency: string) => void;
  onRoomTypeChange: (roomType: RoomTypeCategory) => void;
  onReload: () => void;
  onFrameWorld: () => void;
  onFocusCell: (cell: MapEstimate) => void;
  domain: [number, number];
};

function stopLabel(reason: string | null): string {
  switch (reason) {
    case "budget":
      return "Last run paused at its request budget";
    case "complete":
      return "Grid walk finished for this query";
    case "http_429":
      return "Stopped on HTTP 429";
    case "http_403":
      return "Stopped on HTTP 403";
    case "error_spike":
      return "Stopped after repeated errors";
    case "awaiting-markets":
      return "Waiting on Inside Airbnb markets";
    default:
      return "No collector run recorded yet";
  }
}

export function WorldPanel({
  loading,
  error,
  data,
  extruded,
  onExtrudedChange,
  onCurrencyChange,
  onRoomTypeChange,
  onReload,
  onFrameWorld,
  onFocusCell,
  domain,
}: Props) {
  const cells = data?.cells ?? [];
  const currency = data?.currency ?? "USD";
  const sorted = [...cells].sort((a, b) => b.monthly - a.monthly);
  const median = sorted.length > 0 ? sorted[sorted.length >> 1].monthly : null;
  const inside = data?.counts.find((row) => row.source === "inside-airbnb")?.count ?? 0;
  const airbnb = data?.counts.find((row) => row.source === "GetHostEstimateData")?.count ?? 0;

  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Every cell already in the store, at world scale. Figures are gross booking revenue for
        one currency at a time — nothing here is converted, and nothing is profit.
      </p>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Currency</Label>
          <Select value={currency} onValueChange={onCurrencyChange}>
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(data?.currencies.length ? data.currencies : [{ currency: "USD", count: 0 }]).map(
                (row) => (
                  <SelectItem key={row.currency} value={row.currency}>
                    {row.count > 0 ? `${row.currency} (${formatCount(row.count)})` : row.currency}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Listing type</Label>
          <Select
            value={data?.roomType ?? "ENTIRE_HOME"}
            onValueChange={(value) => onRoomTypeChange(value as RoomTypeCategory)}
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
      </div>

      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="world-extruded" className="text-xs font-normal text-muted-foreground">
          Raise cells into 3D columns
        </Label>
        <Switch id="world-extruded" checked={extruded} onCheckedChange={onExtrudedChange} />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Reading the store…
        </div>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      {data && cells.length > 0 ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <StatTile label="Cells" value={formatCount(cells.length)} hint="gross / month" />
            <StatTile
              label="Median"
              value={median === null ? "—" : formatCompactMoney(median, currency)}
              hint="gross booking revenue"
            />
          </div>
          <Legend domain={domain} currency={currency} label="Gross revenue" unit="per month" />
          <p className="text-[11px] text-muted-foreground">
            {formatCount(inside)} from Inside Airbnb · {formatCount(airbnb)} from Airbnb&apos;s host
            estimate. Colour stretches from the 5th to the 95th percentile.
          </p>
          <div className="space-y-1.5">
            <div className="text-xs font-medium">Highest gross cells</div>
            <ul className="space-y-1">
              {sorted.slice(0, 6).map((cell) => (
                <li key={`${cell.cellId}:${cell.source}:${cell.bedrooms}`}>
                  <button
                    type="button"
                    onClick={() => onFocusCell(cell)}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                  >
                    <span className="truncate text-xs">
                      {cell.marketSlug ?? `${cell.latitude.toFixed(1)}, ${cell.longitude.toFixed(1)}`}
                    </span>
                    <span className="shrink-0 font-mono text-xs tabular-nums">
                      {formatMoney(cell.monthly, currency)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}

      {data && !loading && cells.length === 0 ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Nothing stored for {currency} yet. Live scans accumulate here, and{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[11px]">npm run collect</code> walks
          the rest of the world in the background.
        </p>
      ) : null}

      <div className="space-y-1.5 rounded-lg border border-border/60 bg-card/40 px-3 py-2">
        <div className="text-xs font-medium">{stopLabel(data?.progress?.lastStopReason ?? null)}</div>
        {data?.progress?.lastStopDetail ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {data.progress.lastStopDetail}
          </p>
        ) : (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            The collector is one Airbnb request at a time, at least five seconds apart, and it
            stops on a 429 or 403.
          </p>
        )}
        {data?.progress ? (
          <p className="font-mono text-[11px] text-muted-foreground">
            cursor {formatCount(data.progress.gridCursor)}/{formatCount(data.progress.gridLength)} ·{" "}
            {formatCount(data.progress.totalAirbnbRequests)} Airbnb requests
          </p>
        ) : null}
      </div>

      <div className="flex gap-2">
        <Button variant="secondary" size="sm" className="flex-1" onClick={onFrameWorld}>
          <Globe className="size-3.5" />
          Frame world
        </Button>
        <Button variant="outline" size="sm" onClick={onReload} disabled={loading}>
          Reload
        </Button>
      </div>
    </div>
  );
}

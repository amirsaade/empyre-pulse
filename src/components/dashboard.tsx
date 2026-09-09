"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { HeatmapLayer, HexagonLayer } from "@deck.gl/aggregation-layers";
import { PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { Layer, PickingInfo } from "@deck.gl/core";
import { PanelLeftClose, SlidersHorizontal } from "lucide-react";
import Image from "next/image";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CityDataPanel } from "@/components/city-data-panel";
import { LiveScanPanel, type ScanConfig } from "@/components/live-scan-panel";
import { MapCanvas, type MapCanvasHandle } from "@/components/map-canvas";
import { MethodologyDialog } from "@/components/methodology-dialog";
import { useAreaScan } from "@/hooks/use-area-scan";
import { HEATMAP_COLOR_RANGE, colorDomain, magma, normalize } from "@/lib/color";
import { formatCompactMoney, formatCount, formatMoney } from "@/lib/format";
import {
  summarizeMarket,
  type ListingPoint,
  type MarketFilters,
  type MarketSummary,
} from "@/lib/market-stats";
import { boundsAround, type Bounds, type ScanCell } from "@/lib/scan";
import type { Comparable } from "@/lib/airbnb-estimate";
import { DEFAULT_MODEL, type Market, type MarketDataset, type ModelParams } from "@/lib/types";

type Mode = "live" | "city";

type Hover = {
  x: number;
  y: number;
  title: string;
  rows: { label: string; value: string }[];
  footer?: string;
};

const DEFAULT_CONFIG: ScanConfig = {
  bedrooms: 2,
  roomTypeCategory: "ENTIRE_HOME",
  resolution: 8,
  currency: "USD",
};

const DEFAULT_FILTERS: MarketFilters = {
  roomType: "all",
  activeOnly: true,
  minPrice: 0,
};

export function Dashboard({ markets }: { markets: Market[] }) {
  const [mode, setMode] = useState<Mode>("live");
  const [focus, setFocus] = useState<Bounds | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const mapHandle = useRef<MapCanvasHandle | null>(null);
  const viewBounds = useRef<Bounds | null>(null);

  // --- Live Airbnb scan ------------------------------------------------------
  const { state: scan, start, cancel, reset } = useAreaScan();
  const [config, setConfig] = useState<ScanConfig>(DEFAULT_CONFIG);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [areaName, setAreaName] = useState<string | null>(null);
  const [showComparables, setShowComparables] = useState(false);
  const [extruded, setExtruded] = useState(false);

  const handleSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) return;

    setSearching(true);
    setPlaceError(null);
    try {
      const res = await fetch(
        `/api/place?q=${encodeURIComponent(trimmed)}&currency=${config.currency}`,
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Lookup failed");

      reset();
      setAreaName(body.name as string);
      setFocus(body.bounds as Bounds);
      viewBounds.current = body.bounds as Bounds;
    } catch (error) {
      setPlaceError(error instanceof Error ? error.message : "Lookup failed");
    } finally {
      setSearching(false);
    }
  }, [query, config.currency, reset]);

  const handleScan = useCallback(() => {
    const bounds = mapHandle.current?.getBounds() ?? viewBounds.current;
    if (!bounds) return;
    void start({
      bounds,
      resolution: config.resolution,
      roomTypeCategory: config.roomTypeCategory,
      bedrooms: config.bedrooms,
      currency: config.currency,
    });
  }, [config, start]);

  const scanDomain = useMemo<[number, number]>(
    () => colorDomain(scan.cells.map((cell) => cell.monthly)),
    [scan.cells],
  );

  const scanStats = useMemo(() => {
    if (scan.cells.length === 0) return null;
    const sorted = scan.cells.map((c) => c.monthly).sort((a, b) => a - b);
    return {
      median: sorted[sorted.length >> 1],
      max: sorted[sorted.length - 1],
      min: sorted[0],
    };
  }, [scan.cells]);

  const topCells = useMemo(
    () => [...scan.cells].sort((a, b) => b.monthly - a.monthly).slice(0, 6),
    [scan.cells],
  );

  // The scan streams in whatever currency the server was asked for, which can
  // lag the dropdown until the next scan starts.
  const scanCurrency = scan.meta?.currency ?? config.currency;

  // --- Inside Airbnb market data --------------------------------------------
  const [market, setMarket] = useState<Market | null>(null);
  const [dataset, setDataset] = useState<MarketDataset | null>(null);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [model, setModel] = useState<ModelParams>(DEFAULT_MODEL);
  const [filters, setFilters] = useState<MarketFilters>(DEFAULT_FILTERS);

  const marketRequest = useRef(0);

  const selectMarket = useCallback(async (next: Market) => {
    const requestId = ++marketRequest.current;

    setMarket(next);
    setMarketLoading(true);
    setMarketError(null);
    setDataset(null);

    try {
      const res = await fetch(`/api/markets/${next.slug}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      if (marketRequest.current !== requestId) return;

      const data = body as MarketDataset;
      setDataset(data);
      setFocus(boundsAround(data.center.latitude, data.center.longitude, 14));
    } catch (error) {
      if (marketRequest.current !== requestId) return;
      setMarketError(error instanceof Error ? error.message : "Could not load market");
    } finally {
      if (marketRequest.current === requestId) setMarketLoading(false);
    }
  }, []);

  const summary = useMemo<MarketSummary | null>(
    () => (dataset ? summarizeMarket(dataset, model, filters) : null),
    [dataset, model, filters],
  );

  const marketDomain = useMemo<[number, number]>(
    () => colorDomain(summary?.points.map((p) => p.revenue) ?? [], 0.1, 0.9),
    [summary],
  );

  const focusNeighbourhood = useCallback(
    (name: string) => {
      const points = summary?.points.filter((p) => p.neighbourhood === name) ?? [];
      if (points.length === 0) return;
      setFocus({
        north: Math.max(...points.map((p) => p.latitude)),
        south: Math.min(...points.map((p) => p.latitude)),
        east: Math.max(...points.map((p) => p.longitude)),
        west: Math.min(...points.map((p) => p.longitude)),
      });
    },
    [summary],
  );

  // --- Layers ----------------------------------------------------------------
  const layers = useMemo<Layer[]>(() => {
    if (mode === "live") {
      if (!scan.meta || scan.cells.length === 0) return [];
      const [low, high] = scanDomain;
      const halfH = scan.meta.cellHeight / 2;
      const halfW = scan.meta.cellWidth / 2;
      const built: Layer[] = [];

      built.push(
        new PolygonLayer<ScanCell>({
          id: "scan-cells",
          data: scan.cells,
          pickable: true,
          extruded,
          filled: true,
          stroked: !extruded,
          getLineColor: [255, 255, 255, 28],
          getLineWidth: 1,
          lineWidthUnits: "pixels",
          getPolygon: (cell) => [
            [cell.longitude - halfW, cell.latitude - halfH],
            [cell.longitude + halfW, cell.latitude - halfH],
            [cell.longitude + halfW, cell.latitude + halfH],
            [cell.longitude - halfW, cell.latitude + halfH],
          ],
          getFillColor: (cell) => {
            const [r, g, b] = magma(normalize(cell.monthly, low, high));
            return [r, g, b, extruded ? 215 : 140];
          },
          getElevation: (cell) => normalize(cell.monthly, low, high) * 900,
          elevationScale: 1,
          material: { ambient: 0.6, diffuse: 0.6, shininess: 32 },
          updateTriggers: {
            getFillColor: [low, high, extruded],
            getElevation: [low, high],
          },
          onHover: (info: PickingInfo<ScanCell>) => {
            if (!info.object) return setHover(null);
            const cell = info.object;
            setHover({
              x: info.x,
              y: info.y,
              title: formatMoney(cell.monthly, scanCurrency),
              rows: [
                { label: "Per month", value: "Airbnb host estimate" },
                {
                  label: "Nightly rate",
                  value: formatMoney(cell.nightly, scanCurrency),
                },
                { label: "Nights booked", value: `${Math.round(cell.nights)} / month` },
              ],
              footer: `${cell.latitude.toFixed(4)}, ${cell.longitude.toFixed(4)}`,
            });
          },
        }),
      );

      if (showComparables && scan.comparables.length > 0) {
        built.push(
          new ScatterplotLayer({
            id: "scan-comparables",
            data: scan.comparables,
            pickable: true,
            radiusUnits: "pixels",
            getRadius: 3.5,
            radiusMinPixels: 2,
            getPosition: (d) => [d.longitude, d.latitude],
            getFillColor: [255, 255, 255, 190],
            getLineColor: [10, 10, 20, 220],
            lineWidthMinPixels: 0.5,
            stroked: true,
            onHover: (info: PickingInfo<Comparable>) => {
              if (!info.object) return setHover(null);
              const listing = info.object;
              setHover({
                x: info.x,
                y: info.y,
                title: listing.title,
                rows: [
                  {
                    label: "Nightly",
                    value: formatMoney(listing.nightly, scanCurrency),
                  },
                  {
                    label: "Rating",
                    value: listing.rating
                      ? `${listing.rating.toFixed(2)} · ${formatCount(listing.reviews)} reviews`
                      : "New listing",
                  },
                ],
                footer: listing.superhost ? "Superhost" : undefined,
              });
            },
          }),
        );
      }

      return built;
    }

    if (!summary || summary.points.length === 0) return [];
    const [low, high] = marketDomain;

    return [
      new HeatmapLayer({
        id: "market-heat",
        data: summary.points,
        getPosition: (d) => [d.longitude, d.latitude],
        getWeight: (d) => d.revenue,
        radiusPixels: 42,
        intensity: 1,
        threshold: 0.05,
        colorRange: HEATMAP_COLOR_RANGE.map(([r, g, b]) => [r, g, b, 190]),
        opacity: 0.55,
      }),
      new HexagonLayer<ListingPoint>({
        id: "market-hex",
        data: summary.points,
        pickable: true,
        radius: 220,
        coverage: 0.86,
        elevationScale: extruded ? 18 : 0,
        extruded,
        getPosition: (d) => [d.longitude, d.latitude],
        getColorWeight: (d) => d.revenue,
        colorAggregation: "MEAN",
        getElevationWeight: (d) => d.revenue,
        elevationAggregation: "MEAN",
        colorDomain: [low, high],
        colorRange: HEATMAP_COLOR_RANGE.map(([r, g, b]) => [r, g, b, 205]),
        updateTriggers: { colorDomain: [low, high] },
        // Returning a boolean satisfies deck.gl's composite-layer handler
        // signature; false means "not handled", so picking behaves normally.
        onHover: (info: PickingInfo): boolean => {
          const object = info.object as { points?: { source?: ListingPoint }[] } | undefined;
          const sources = object?.points?.map((p) => p.source).filter(Boolean) ?? [];
          if (sources.length === 0) {
            setHover(null);
            return false;
          }

          const revenues = sources.map((s) => s!.revenue).sort((a, b) => a - b);
          const median = revenues[revenues.length >> 1];
          const currency = market?.currency ?? "USD";

          setHover({
            x: info.x,
            y: info.y,
            title: formatMoney(median, currency),
            rows: [
              { label: "Median", value: "estimated revenue / year" },
              { label: "Listings", value: formatCount(sources.length) },
              { label: "Area", value: sources[0]!.neighbourhood },
            ],
          });
          return false;
        },
      }),
    ];
  }, [
    mode,
    scan.cells,
    scan.meta,
    scan.comparables,
    scanDomain,
    scanCurrency,
    extruded,
    showComparables,
    summary,
    marketDomain,
    market?.currency,
  ]);

  const panel = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 border-b border-border/60 px-4 py-3">
        <Image
          src="/empyre-emblem.png"
          alt="Empyre"
          width={512}
          height={512}
          priority
          className="size-7 shrink-0 object-contain"
        />
        <div className="flex-1">
          <div className="font-heading text-sm font-semibold leading-none">Empyre Pulse</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            Short-term rental earnings heatmaps
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="hidden size-7 lg:inline-flex"
          onClick={() => setPanelOpen(false)}
          aria-label="Hide panel"
        >
          <PanelLeftClose className="size-4" />
        </Button>
      </div>

      <div className="px-4 pt-3">
        <Tabs value={mode} onValueChange={(value) => setMode(value as Mode)}>
          <TabsList className="w-full">
            <TabsTrigger value="live" className="flex-1 text-xs">
              Airbnb live
            </TabsTrigger>
            <TabsTrigger value="city" className="flex-1 text-xs">
              City data
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <ScrollArea className="flex-1">
        <div className="px-4 py-4">
          {mode === "live" ? (
            <LiveScanPanel
              query={query}
              onQueryChange={setQuery}
              onSearch={handleSearch}
              searching={searching}
              placeError={placeError}
              areaName={areaName}
              config={config}
              onConfigChange={setConfig}
              scan={scan}
              onScan={handleScan}
              onCancel={cancel}
              domain={scanDomain}
              stats={scanStats}
              topCells={topCells}
              showComparables={showComparables}
              onShowComparablesChange={setShowComparables}
              extruded={extruded}
              onExtrudedChange={setExtruded}
              onFocusCell={(cell) =>
                setFocus(boundsAround(cell.latitude, cell.longitude, 3))
              }
            />
          ) : (
            <CityDataPanel
              markets={markets}
              selected={market}
              onSelect={(next) => void selectMarket(next)}
              loading={marketLoading}
              error={marketError}
              summary={summary}
              totalListings={dataset?.count ?? 0}
              model={model}
              onModelChange={setModel}
              filters={filters}
              onFiltersChange={setFilters}
              domain={marketDomain}
              onFocusNeighbourhood={focusNeighbourhood}
            />
          )}
        </div>
      </ScrollArea>

      <div className="border-t border-border/60 px-2 py-1.5">
        <MethodologyDialog />
      </div>
    </div>
  );

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-background">
      <MapCanvas
        layers={layers}
        focus={focus}
        pitched={extruded}
        onBoundsChange={(bounds) => {
          viewBounds.current = bounds;
        }}
        onReady={(handle) => {
          mapHandle.current = handle;
        }}
      />

      {hover ? (
        <div
          className="pointer-events-none absolute z-30 w-56 rounded-lg border border-border/70 bg-popover/95 p-3 shadow-xl backdrop-blur"
          style={{
            left: Math.min(hover.x + 14, typeof window === "undefined" ? 0 : window.innerWidth - 240),
            top: Math.min(hover.y + 14, typeof window === "undefined" ? 0 : window.innerHeight - 160),
          }}
        >
          <div className="truncate font-mono text-base font-semibold tabular-nums">
            {hover.title}
          </div>
          <dl className="mt-1.5 space-y-1">
            {hover.rows.map((row) => (
              <div key={row.label} className="flex justify-between gap-3 text-[11px]">
                <dt className="shrink-0 text-muted-foreground">{row.label}</dt>
                <dd className="truncate text-right">{row.value}</dd>
              </div>
            ))}
          </dl>
          {hover.footer ? (
            <div className="mt-1.5 font-mono text-[10px] text-muted-foreground">{hover.footer}</div>
          ) : null}
        </div>
      ) : null}

      {/* Desktop panel */}
      <aside
        className={`absolute left-4 top-4 z-20 hidden max-h-[calc(100dvh-2rem)] w-[364px] flex-col overflow-hidden rounded-xl border border-border/60 bg-background/85 shadow-2xl backdrop-blur-md lg:flex ${
          panelOpen ? "" : "pointer-events-none opacity-0"
        }`}
      >
        {panel}
      </aside>

      {!panelOpen ? (
        <Button
          className="absolute left-4 top-4 z-20 hidden gap-2 shadow-lg lg:inline-flex"
          onClick={() => setPanelOpen(true)}
        >
          <SlidersHorizontal className="size-4" />
          Controls
        </Button>
      ) : null}

      {/* Mobile panel */}
      <div className="absolute inset-x-4 top-4 z-20 flex items-center gap-2 lg:hidden">
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="secondary" className="gap-2 shadow-lg">
              <Image
                src="/empyre-emblem.png"
                alt=""
                width={512}
                height={512}
                className="size-5 shrink-0 object-contain"
              />
              Empyre Pulse
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[92vw] max-w-[380px] p-0">
            <SheetTitle className="sr-only">Controls</SheetTitle>
            {panel}
          </SheetContent>
        </Sheet>

        {mode === "live" && scanStats ? (
          <Badge variant="secondary" className="shadow-lg">
            median{" "}
            {formatCompactMoney(scanStats.median, scanCurrency)}/mo
          </Badge>
        ) : null}
      </div>
    </main>
  );
}

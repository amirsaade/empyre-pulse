"use client";

import { Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Legend } from "@/components/legend";
import { StatTile } from "@/components/stat-tile";
import { magmaCss, normalize } from "@/lib/color";
import {
  formatCompactMoney,
  formatCount,
  formatPercent,
  formatScrapeDate,
} from "@/lib/format";
import type { MarketFilters, MarketSummary } from "@/lib/market-stats";
import type { Market, ModelParams } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  markets: Market[];
  selected: Market | null;
  onSelect: (market: Market) => void;
  loading: boolean;
  error: string | null;
  summary: MarketSummary | null;
  totalListings: number;
  model: ModelParams;
  onModelChange: (model: ModelParams) => void;
  filters: MarketFilters;
  onFiltersChange: (filters: MarketFilters) => void;
  domain: [number, number];
  onFocusNeighbourhood: (name: string) => void;
};

export function CityDataPanel({
  markets,
  selected,
  onSelect,
  loading,
  error,
  summary,
  totalListings,
  model,
  onModelChange,
  filters,
  onFiltersChange,
  domain,
  onFocusNeighbourhood,
}: Props) {
  const [open, setOpen] = useState(false);
  const currency = selected?.currency ?? "USD";

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Market</Label>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              className="w-full justify-between font-normal"
            >
              <span className="truncate">
                {selected ? `${selected.city}, ${selected.country}` : "Choose a city…"}
              </span>
              <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
            <Command
              filter={(value, search) =>
                value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
              }
            >
              <CommandInput placeholder="Search 123 markets…" />
              <CommandList>
                <CommandEmpty>No market found.</CommandEmpty>
                <CommandGroup>
                  {markets.map((market) => (
                    <CommandItem
                      key={market.slug}
                      value={`${market.city} ${market.region ?? ""} ${market.country}`}
                      onSelect={() => {
                        onSelect(market);
                        setOpen(false);
                      }}
                    >
                      <Check
                        className={cn(
                          "size-3.5",
                          selected?.slug === market.slug ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span className="truncate">{market.city}</span>
                      <span className="ml-auto truncate text-xs text-muted-foreground">
                        {market.country}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {selected ? (
          <p className="text-[11px] text-muted-foreground">
            Inside Airbnb scrape from {formatScrapeDate(selected.scrapedAt)} · prices in{" "}
            {selected.currency}
          </p>
        ) : null}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-6 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Downloading and parsing listings…
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {summary && !loading ? (
        <>
          <div className="grid grid-cols-3 gap-2">
            <StatTile
              label="Median"
              value={formatCompactMoney(summary.medianRevenue, currency)}
              hint="per year"
            />
            <StatTile
              label="Nightly"
              value={formatCompactMoney(summary.medianPrice, currency)}
              hint="median"
            />
            <StatTile
              label="Listings"
              value={formatCount(summary.points.length)}
              hint={`of ${formatCount(totalListings)}`}
            />
          </div>

          <Legend
            domain={domain}
            currency={currency}
            label="Estimated revenue"
            unit="per listing / year"
          />

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Listing type</Label>
              <Select
                value={filters.roomType}
                onValueChange={(value) =>
                  onFiltersChange({ ...filters, roomType: value as MarketFilters["roomType"] })
                }
              >
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  <SelectItem value="Entire home/apt">Entire place</SelectItem>
                  <SelectItem value="Private room">Private room</SelectItem>
                  <SelectItem value="Hotel room">Hotel room</SelectItem>
                  <SelectItem value="Shared room">Shared room</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <div className="flex h-9 w-full items-center justify-between rounded-md border border-border/60 bg-card/60 px-3">
                <Label htmlFor="active" className="text-xs font-normal text-muted-foreground">
                  Booked recently
                </Label>
                <Switch
                  id="active"
                  checked={filters.activeOnly}
                  onCheckedChange={(checked) =>
                    onFiltersChange({ ...filters, activeOnly: checked })
                  }
                />
              </div>
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-border/60 bg-card/40 p-3">
            <div className="text-xs font-medium">Model assumptions</div>

            <SliderRow
              label="Stays that leave a review"
              value={formatPercent(model.reviewRate)}
              min={0.2}
              max={1}
              step={0.05}
              current={model.reviewRate}
              onChange={(value) => onModelChange({ ...model, reviewRate: value })}
            />
            <SliderRow
              label="Typical stay"
              value={`${model.averageStay.toFixed(1)} nights`}
              min={1}
              max={14}
              step={0.5}
              current={model.averageStay}
              onChange={(value) => onModelChange({ ...model, averageStay: value })}
            />
            <SliderRow
              label="Occupancy ceiling"
              value={formatPercent(model.maxOccupancy)}
              min={0.3}
              max={1}
              step={0.05}
              current={model.maxOccupancy}
              onChange={(value) => onModelChange({ ...model, maxOccupancy: value })}
            />
          </div>

          {summary.neighbourhoods.length > 0 ? (
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-medium">Neighbourhoods by median revenue</span>
                <span className="text-[11px] text-muted-foreground">
                  {summary.neighbourhoods.length}
                </span>
              </div>
              <ul className="space-y-0.5">
                {summary.neighbourhoods.slice(0, 12).map((n, rank) => (
                  <li key={n.name}>
                    <button
                      type="button"
                      onClick={() => onFocusNeighbourhood(n.name)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                    >
                      <span
                        className="size-2.5 shrink-0 rounded-[3px] ring-1 ring-white/20"
                        style={{
                          backgroundColor: magmaCss(
                            normalize(n.medianRevenue, domain[0], domain[1]),
                          ),
                        }}
                      />
                      <span className="w-4 shrink-0 font-mono text-[11px] text-muted-foreground">
                        {rank + 1}
                      </span>
                      <span className="flex-1 truncate text-xs">{n.name}</span>
                      <span className="shrink-0 font-mono text-xs tabular-nums">
                        {formatCompactMoney(n.medianRevenue, currency)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}

      {!selected && !loading ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Inside Airbnb publishes public-domain scrapes of every listing in 123 markets. Revenue is
          modelled from review volume rather than reported by Airbnb, so it covers far more
          properties but is an estimate you can tune.
        </p>
      ) : null}
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  current,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  max: number;
  step: number;
  current: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <Label className="text-[11px] font-normal text-muted-foreground">{label}</Label>
        <span className="font-mono text-[11px] tabular-nums">{value}</span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[current]}
        onValueChange={([next]) => onChange(next)}
      />
    </div>
  );
}

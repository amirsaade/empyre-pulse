"use client";

import { magmaCss } from "@/lib/color";
import { formatCompactMoney } from "@/lib/format";

type Props = {
  domain: [number, number];
  currency: string;
  label: string;
  unit: string;
};

const STOPS = Array.from({ length: 24 }, (_, i) => i / 23);

export function Legend({ domain, currency, label, unit }: Props) {
  const [low, high] = domain;
  const mid = (low + high) / 2;

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-foreground">{label}</span>
        <span className="text-[11px] text-muted-foreground">{unit}</span>
      </div>
      <div
        className="h-2.5 w-full rounded-full ring-1 ring-white/10"
        style={{
          backgroundImage: `linear-gradient(to right, ${STOPS.map(
            (t) => `${magmaCss(t)} ${(t * 100).toFixed(1)}%`,
          ).join(", ")})`,
        }}
      />
      <div className="flex justify-between font-mono text-[11px] text-muted-foreground tabular-nums">
        <span>{formatCompactMoney(low, currency)}</span>
        <span>{formatCompactMoney(mid, currency)}</span>
        <span>{formatCompactMoney(high, currency)}+</span>
      </div>
    </div>
  );
}

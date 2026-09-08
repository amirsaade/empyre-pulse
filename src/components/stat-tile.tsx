import { cn } from "@/lib/utils";

type Props = {
  label: string;
  value: string;
  hint?: string;
  className?: string;
};

export function StatTile({ label, value, hint, className }: Props) {
  return (
    <div className={cn("rounded-lg border border-border/60 bg-card/60 px-3 py-2", className)}>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-mono text-lg font-semibold tabular-nums text-foreground">{value}</div>
      {hint ? <div className="text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

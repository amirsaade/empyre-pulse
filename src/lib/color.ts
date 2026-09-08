export type RGB = [number, number, number];

/**
 * Magma. Perceptually uniform and it reads well on a dark basemap, where a
 * plain red-to-green ramp turns to mud in the mid range.
 */
const MAGMA: RGB[] = [
  [12, 8, 38],
  [59, 15, 112],
  [140, 41, 129],
  [222, 73, 104],
  [254, 159, 109],
  [252, 253, 191],
];

export function magma(t: number): RGB {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  const scaled = clamped * (MAGMA.length - 1);
  const i = Math.min(MAGMA.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = MAGMA[i];
  const b = MAGMA[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

export function magmaCss(t: number): string {
  const [r, g, b] = magma(t);
  return `rgb(${r}, ${g}, ${b})`;
}

/** deck.gl's HeatmapLayer wants the ramp as an explicit list of stops. */
export const HEATMAP_COLOR_RANGE: RGB[] = [0.1, 0.3, 0.5, 0.7, 0.85, 1].map(magma);

export function normalize(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  if (max <= min) return 0.5;
  return (value - min) / (max - min);
}

/**
 * Percentile bounds, so a single outlier neighbourhood cannot wash the whole
 * map out to one colour.
 */
export function colorDomain(values: number[], lowP = 0.05, highP = 0.95): [number, number] {
  if (values.length === 0) return [0, 1];
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))];
  const low = at(lowP);
  const high = at(highP);
  return high > low ? [low, high] : [sorted[0], sorted[sorted.length - 1] || sorted[0] + 1];
}

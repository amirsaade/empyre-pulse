// Bakes a market into data/snapshots/<slug>.json so the app still has something
// to show when Inside Airbnb is unreachable (offline dev, CI, rate limits).
//
//   npm run snapshot -- san-francisco-california paris-ile-de-france

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildDataset } from "@/lib/inside-airbnb";
import marketsJson from "@/data/markets.json";
import type { Market } from "@/lib/types";

const markets = marketsJson as Market[];
const slugs = process.argv.slice(2);

if (slugs.length === 0) {
  console.error("Usage: npm run snapshot -- <market-slug> [...]");
  console.error(`For example: ${markets.slice(0, 3).map((m) => m.slug).join(", ")}`);
  process.exit(1);
}

const outDir = path.join(process.cwd(), "data", "snapshots");
await mkdir(outDir, { recursive: true });

for (const slug of slugs) {
  const market = markets.find((m) => m.slug === slug);
  if (!market) {
    console.error(`Unknown market: ${slug}`);
    process.exitCode = 1;
    continue;
  }

  process.stdout.write(`Fetching ${market.city}… `);
  const res = await fetch(market.summaryUrl, {
    headers: {
      "user-agent": "airbnb-earnings-heatmap/1.0 (open source; insideairbnb snapshot)",
    },
  });

  if (!res.ok) {
    console.error(`failed (HTTP ${res.status})`);
    process.exitCode = 1;
    continue;
  }

  const dataset = buildDataset(market, await res.text());
  const file = path.join(outDir, `${slug}.json`);
  await writeFile(file, JSON.stringify(dataset), "utf8");
  console.log(`${dataset.count} listings → ${path.relative(process.cwd(), file)}`);
}

import { DEFAULT_BUDGET, DEFAULT_DELAY_MS, DEFAULT_JITTER_MS, runCollector } from "@/lib/collector";
import type { StoredRoomTypeCategory } from "@/lib/store";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function integerFlag(name: string, fallback: number): number {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

if (process.argv.includes("--help")) {
  console.log(`Usage: npm run collect -- [--budget ${DEFAULT_BUDGET}] [--delay-ms ${DEFAULT_DELAY_MS}] [--jitter-ms ${DEFAULT_JITTER_MS}] [--fresh-days 30] [--room ENTIRE_HOME] [--bedrooms 2] [--currency EUR]`);
  console.log("Budget is the number of Airbnb requests, including retries. It cannot exceed 60.");
  process.exit(0);
}

const room = (flag("--room") ?? "ENTIRE_HOME") as StoredRoomTypeCategory;
const freshDays = integerFlag("--fresh-days", 30);

let result;
try {
  result = await runCollector({
    budget: integerFlag("--budget", DEFAULT_BUDGET),
    delayMs: integerFlag("--delay-ms", DEFAULT_DELAY_MS),
    jitterMs: integerFlag("--jitter-ms", DEFAULT_JITTER_MS),
    freshMs: freshDays * 24 * 60 * 60 * 1000,
    roomTypeCategory: room,
    bedrooms: integerFlag("--bedrooms", 2),
    currency: flag("--currency") ?? "EUR",
    log: (message) => console.log(message),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

for (const attempt of result.attempts) {
  const outcome = attempt.empty ? "empty" : attempt.stored ? "stored" : "not-stored";
  console.log(
    `airbnb ${attempt.cellId} status ${attempt.status ?? "network"} ${outcome} waitedMs ${attempt.waitedMs}`,
  );
}

console.log(
  `stop ${result.stopReason} stopped ${result.stopped} attempts ${result.airbnbAttempts} inside-airbnb ${result.cellsBySource["inside-airbnb"]} airbnb-host-estimate ${result.cellsBySource["airbnb-host-estimate"]}`,
);
if (result.errors.length > 0) {
  console.log(`errors ${JSON.stringify(result.errors)}`);
}

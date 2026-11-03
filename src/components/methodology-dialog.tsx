"use client";

import { Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

export function MethodologyDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
          <Info className="size-3.5" />
          Where the numbers come from
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Where the numbers come from</DialogTitle>
          <DialogDescription>
            Two independent sources, with different trade-offs. Neither is a promise of what any
            individual property will earn.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh] pr-4">
          <div className="space-y-6 text-sm leading-relaxed">
            <section className="space-y-2">
              <h3 className="font-heading text-base font-semibold">
                Airbnb host estimate <span className="text-muted-foreground">(live)</span>
              </h3>
              <p className="text-muted-foreground">
                Airbnb&apos;s host landing page runs a GraphQL operation called{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">GetHostEstimateData</code>{" "}
                to answer &quot;how much could you earn?&quot;. Its location argument accepts a raw{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">lat,lng</code> string, so
                this app samples a grid of coordinates across the area you are viewing and asks
                Airbnb the same question once per cell.
              </p>
              <p className="text-muted-foreground">
                Each cell shows Airbnb&apos;s own answer: average monthly earnings for a home of
                the bedroom count and room type you picked, alongside the nightly rate and nights
                booked per month it used. Cells with no comparable supply nearby are left empty
                rather than guessed at.
              </p>
              <p className="text-muted-foreground">
                This is an internal endpoint, not a documented public API. It needs no login, only
                the public web API key that ships in Airbnb&apos;s front-end bundle, but it can
                change or disappear without notice. Scans are capped at 400 cells and run 8
                requests at a time to stay light.
              </p>
            </section>

            <section className="space-y-2">
              <h3 className="font-heading text-base font-semibold">
                Inside Airbnb <span className="text-muted-foreground">(modelled)</span>
              </h3>
              <p className="text-muted-foreground">
                <a
                  href="https://insideairbnb.com/get-the-data/"
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  Inside Airbnb
                </a>{" "}
                publishes public-domain (CC0) scrapes of every listing in 123 markets. Unlike the
                live estimate it covers each individual property, which is what makes the
                neighbourhood ranking possible — but Airbnb does not publish bookings, so revenue
                has to be reconstructed.
              </p>
              <p className="text-muted-foreground">
                We use the San Francisco Model that Inside Airbnb itself publishes. Only a share of
                stays leave a review, so reviews in the last 12 months divided by that review rate
                approximates bookings. Multiply by a typical stay length for nights booked, cap
                occupancy so unusually reviewed listings cannot exceed a plausible ceiling, and
                multiply by the nightly price. Every one of those inputs is adjustable in the panel
                so you can see how sensitive the result is.
              </p>
            </section>

            <section className="space-y-2">
              <h3 className="font-heading text-base font-semibold">
                World store <span className="text-muted-foreground">(accumulated)</span>
              </h3>
              <p className="text-muted-foreground">
                Live scans and the background collector write gross estimates into a local SQLite
                file. The World tab draws everything stored for one currency. Inside Airbnb cells
                are the median modelled gross for a 1° cell, divided down to a month. Airbnb cells
                are that endpoint&apos;s own monthly gross for the room type and bedroom count that
                was asked. Currencies are never converted, so the colour scale always stays inside
                one of them.
              </p>
              <p className="text-muted-foreground">
                The collector prefers Inside Airbnb wherever a market covers the cell, and only
                then calls Airbnb. Those calls go out one at a time, at least five seconds apart,
                and the run stops outright on an HTTP 429 or 403.
              </p>
            </section>

            <section className="space-y-2">
              <h3 className="font-heading text-base font-semibold">Reading it honestly</h3>
              <ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">
                <li>
                  Both figures are gross booking revenue. They exclude cleaning costs, Airbnb&apos;s
                  host fee, furnishing, management, taxes and mortgage.
                </li>
                <li>
                  Prices are whatever the source reports in the selected currency, and a scrape is a
                  single snapshot — seasonal pricing is baked in rather than averaged out.
                </li>
                <li>
                  Short-term rental rules vary by street, not just by city. A bright cell is not a
                  signal that letting is permitted there.
                </li>
              </ul>
            </section>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

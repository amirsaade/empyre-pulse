import { NextResponse } from "next/server";

import { MARKETS } from "@/lib/inside-airbnb";

export function GET() {
  return NextResponse.json({ markets: MARKETS });
}

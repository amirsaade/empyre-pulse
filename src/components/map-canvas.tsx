"use client";

import { useEffect, useMemo, useRef } from "react";
import { GeolocateControl, Map as MapLibreMap, NavigationControl } from "maplibre-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Layer } from "@deck.gl/core";

import "maplibre-gl/dist/maplibre-gl.css";
import type { Bounds } from "@/lib/scan";

// CARTO's dark basemap is free and needs no access token.
const BASEMAP_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

export type MapCanvasHandle = {
  getBounds: () => Bounds | null;
};

type Props = {
  layers: Layer[];
  /** Set this to fly the map to a new area; identity change triggers the move. */
  focus: Bounds | null;
  onBoundsChange?: (bounds: Bounds) => void;
  onReady?: (handle: MapCanvasHandle) => void;
};

export function MapCanvas({ layers, focus, onBoundsChange, onReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);

  // Keep callbacks in refs so the map is created exactly once.
  const onBoundsChangeRef = useRef(onBoundsChange);
  const onReadyRef = useRef(onReady);
  onBoundsChangeRef.current = onBoundsChange;
  onReadyRef.current = onReady;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new MapLibreMap({
      container: containerRef.current,
      style: BASEMAP_STYLE,
      center: [-118.35, 34.05],
      zoom: 10,
      minZoom: 2,
      maxZoom: 17,
      attributionControl: { compact: true },
    });
    map.addControl(new NavigationControl({ showCompass: true }), "bottom-right");
    map.addControl(new GeolocateControl({ trackUserLocation: false }), "bottom-right");

    const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
    map.addControl(overlay);

    mapRef.current = map;
    overlayRef.current = overlay;

    const readBounds = (): Bounds | null => {
      const b = map.getBounds();
      if (!b) return null;
      return { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
    };

    const emit = () => {
      const bounds = readBounds();
      if (bounds) onBoundsChangeRef.current?.(bounds);
    };

    map.on("moveend", emit);
    map.on("load", emit);
    onReadyRef.current?.({ getBounds: readBounds });

    return () => {
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, []);

  useEffect(() => {
    overlayRef.current?.setProps({ layers });
  }, [layers]);

  useEffect(() => {
    if (!focus || !mapRef.current) return;
    mapRef.current.fitBounds(
      [
        [focus.west, focus.south],
        [focus.east, focus.north],
      ],
      { padding: { top: 64, bottom: 64, left: 64, right: 64 }, duration: 1200, maxZoom: 15 },
    );
  }, [focus]);

  return useMemo(
    () => <div ref={containerRef} className="absolute inset-0 h-full w-full" />,
    [],
  );
}

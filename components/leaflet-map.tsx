"use client";

import { baseLogger } from "@/lib/logger";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import { MapContainer, TileLayer, ZoomControl, useMap } from "react-leaflet";

const MAP_BOUNDS_KEY = "pathfinder-map-bounds";

interface SavedMapBounds {
  center: { lat: number; lng: number };
  zoom: number;
}

function getSavedBounds(): SavedMapBounds | null {
  if (typeof window === "undefined") return null;
  try {
    const saved = localStorage.getItem(MAP_BOUNDS_KEY);
    if (saved) return JSON.parse(saved);
  } catch (e) {
    // Ignore parse errors
  }
  return null;
}

function saveBounds(center: L.LatLng, zoom: number) {
  try {
    localStorage.setItem(
      MAP_BOUNDS_KEY,
      JSON.stringify({ center: { lat: center.lat, lng: center.lng }, zoom })
    );
  } catch (e) {
    // Ignore storage errors
  }
}

// Component to persist map bounds to localStorage
function MapBoundsPersistence() {
  const map = useMap();

  useEffect(() => {
    // Save bounds on move/zoom
    const handleMoveEnd = () => {
      saveBounds(map.getCenter(), map.getZoom());
    };

    map.on("moveend", handleMoveEnd);
    map.on("zoomend", handleMoveEnd);

    return () => {
      map.off("moveend", handleMoveEnd);
      map.off("zoomend", handleMoveEnd);
    };
  }, [map]);

  return null;
}

// Component to handle map resize when container size changes
function MapResizeHandler() {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();

    // Handle resize observer for container size changes
    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        map.invalidateSize();
      });
    });

    resizeObserver.observe(container);

    // Also observe parent elements to catch flex layout changes
    let parent = container.parentElement;
    while (parent && parent !== document.body) {
      resizeObserver.observe(parent);
      parent = parent.parentElement;
    }

    // Handle transition end events on ancestors (for sidebar/dock animations)
    const handleTransitionEnd = () => {
      map.invalidateSize();
    };

    // Listen for transitions on the whole document
    document.addEventListener('transitionend', handleTransitionEnd);

    return () => {
      resizeObserver.disconnect();
      document.removeEventListener('transitionend', handleTransitionEnd);
    };
  }, [map]);

  return null;
}

interface LeafletMapProps {
  interactive?: boolean;
  children?: React.ReactNode;
}

export default function LeafletMap(props: LeafletMapProps) {
  // Get saved bounds or use defaults
  const saved = getSavedBounds();
  const initialCenter = saved 
    ? L.latLng(saved.center.lat, saved.center.lng)
    : L.latLng(39.977, -105.263);
  const initialZoom = saved?.zoom ?? 13;
  
  const mapRef = useRef<L.Map | null>(null);

  return (
    <MapContainer
      className="map-container"
      style={{ height: "100%", width: "100%" }}
      center={initialCenter}
      zoom={initialZoom}
      zoomControl={false}
      scrollWheelZoom={props.interactive}
      dragging={props.interactive}
      attributionControl={props.interactive}
      doubleClickZoom={props.interactive}
      zoomAnimation={props.interactive}
      ref={mapRef}
    >
      <TileLayer url={`https://tile.jawg.io/jawg-terrain/{z}/{x}/{y}{r}.png?access-token=${process.env.NEXT_PUBLIC_JAWG_ACCESS_TOKEN}`} />
      <MapResizeHandler />
      <MapBoundsPersistence />
      {props.interactive && <ZoomControl position="bottomright" />}
      {props.children}
    </MapContainer>
  );
}

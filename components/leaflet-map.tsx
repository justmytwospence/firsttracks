"use client";

import { baseLogger } from "@/lib/logger";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, ZoomControl, useMap } from "react-leaflet";

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
  const [defaultCenter] = useState<L.LatLng>(L.latLng(39.977, -105.263));
  const mapRef = useRef<L.Map | null>(null);

  return (
    <MapContainer
      className="map-container"
      style={{ height: "100%", width: "100%" }}
      center={defaultCenter}
      zoom={13}
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
      {props.interactive && <ZoomControl position="bottomright" />}
      {props.children}
    </MapContainer>
  );
}

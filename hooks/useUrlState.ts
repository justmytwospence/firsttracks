/**
 * useUrlState Hook
 *
 * React hook for syncing app state with URL search parameters to enable shareable links.
 * Encodes waypoints and path using Google's polyline algorithm for compact URLs.
 */

import type { Aspect } from "@/components/find-path-button";
import polyline from "@mapbox/polyline";
import type { LineString, Point } from "geojson";
import { useCallback, useEffect, useRef } from "react";

// URL parameter keys
const PARAM_WAYPOINTS = "w";
const PARAM_PATH = "p";
const PARAM_MAX_GRADIENT = "g";
const PARAM_EXCLUDED_ASPECTS = "a";

// Configuration constants
const MAX_GRADIENT_PRECISION = 2;
const URL_STATE_SYNC_DELAY_MS = 100;

// Aspect abbreviations for compact URL encoding
const ASPECT_ABBREVIATIONS: Record<Aspect, string> = {
	north: "n",
	northeast: "ne",
	east: "e",
	southeast: "se",
	south: "s",
	southwest: "sw",
	west: "w",
	northwest: "nw",
	flat: "f",
};

const ABBREVIATION_TO_ASPECT: Record<string, Aspect> = Object.fromEntries(
	Object.entries(ASPECT_ABBREVIATIONS).map(([k, v]) => [v, k as Aspect]),
);

export interface UrlState {
	waypoints: Point[];
	path: LineString | null;
	maxGradient: number;
	excludedAspects: Aspect[];
}

/**
 * Encode coordinates to polyline string
 * Note: polyline library expects [lat, lng] format, but GeoJSON uses [lng, lat]
 */
function encodeCoordinates(coords: number[][]): string {
	// Convert from GeoJSON [lng, lat, elevation?] to polyline [lat, lng]
	const latLngCoords = coords.map(
		(coord) => [coord[1], coord[0]] as [number, number],
	);
	return polyline.encode(latLngCoords);
}

/**
 * Decode polyline string to coordinates
 * Returns GeoJSON format [lng, lat]
 */
function decodeCoordinates(encoded: string): number[][] {
	const latLngCoords = polyline.decode(encoded);
	// Convert from polyline [lat, lng] to GeoJSON [lng, lat]
	return latLngCoords.map(([lat, lng]) => [lng, lat]);
}

/**
 * Parse URL state from search params
 */
export function parseUrlState(
	searchParams: URLSearchParams,
): Partial<UrlState> {
	const result: Partial<UrlState> = {};

	// Parse waypoints
	const waypointsParam = searchParams.get(PARAM_WAYPOINTS);
	if (waypointsParam) {
		try {
			const coords = decodeCoordinates(waypointsParam);
			result.waypoints = coords.map((coord) => ({
				type: "Point" as const,
				coordinates: coord,
			}));
		} catch (e) {
			console.warn("Failed to parse waypoints from URL:", e);
		}
	}

	// Parse path
	const pathParam = searchParams.get(PARAM_PATH);
	if (pathParam) {
		try {
			const coords = decodeCoordinates(pathParam);
			result.path = {
				type: "LineString",
				coordinates: coords,
			};
		} catch (e) {
			console.warn("Failed to parse path from URL:", e);
		}
	}

	// Parse max gradient
	const gradientParam = searchParams.get(PARAM_MAX_GRADIENT);
	if (gradientParam) {
		const gradient = Number.parseFloat(gradientParam);
		if (!Number.isNaN(gradient) && gradient > 0) {
			result.maxGradient = gradient;
		}
	}

	// Parse excluded aspects
	const aspectsParam = searchParams.get(PARAM_EXCLUDED_ASPECTS);
	if (aspectsParam) {
		const abbreviations = aspectsParam.split(",").filter(Boolean);
		const aspects = abbreviations
			.map((abbr) => ABBREVIATION_TO_ASPECT[abbr])
			.filter((aspect): aspect is Aspect => aspect !== undefined);
		if (aspects.length > 0) {
			result.excludedAspects = aspects;
		}
	}

	return result;
}

/**
 * Serialize state to URL search params
 */
export function serializeUrlState(state: Partial<UrlState>): URLSearchParams {
	const params = new URLSearchParams();

	// Encode waypoints
	if (state.waypoints && state.waypoints.length > 0) {
		const coords = state.waypoints.map((wp) => wp.coordinates as number[]);
		params.set(PARAM_WAYPOINTS, encodeCoordinates(coords));
	}

	// Encode path
	if (state.path && state.path.coordinates.length > 0) {
		// Only encode lng/lat, not elevation (to keep URL compact)
		const coords = state.path.coordinates.map((c) => [c[0], c[1]]);
		params.set(PARAM_PATH, encodeCoordinates(coords));
	}

	// Encode max gradient
	if (state.maxGradient !== undefined) {
		params.set(
			PARAM_MAX_GRADIENT,
			state.maxGradient.toFixed(MAX_GRADIENT_PRECISION),
		);
	}

	// Encode excluded aspects
	if (state.excludedAspects && state.excludedAspects.length > 0) {
		const abbreviations = state.excludedAspects.map(
			(a) => ASPECT_ABBREVIATIONS[a],
		);
		params.set(PARAM_EXCLUDED_ASPECTS, abbreviations.join(","));
	}

	return params;
}

interface UseUrlStateOptions {
	waypoints: Point[];
	path: LineString | null;
	maxGradient: number;
	excludedAspects: Aspect[];
	onStateFromUrl: (state: Partial<UrlState>) => void;
}

/**
 * Hook to sync app state with URL
 */
export function useUrlState({
	waypoints,
	path,
	maxGradient,
	excludedAspects,
	onStateFromUrl,
}: UseUrlStateOptions) {
	const isInitializedRef = useRef(false);
	const isUpdatingFromUrlRef = useRef(false);

	// Read initial state from URL on mount
	useEffect(() => {
		if (isInitializedRef.current) return;
		isInitializedRef.current = true;

		if (typeof window === "undefined") return;

		const searchParams = new URLSearchParams(window.location.search);
		if (searchParams.toString()) {
			const urlState = parseUrlState(searchParams);
			if (Object.keys(urlState).length > 0) {
				isUpdatingFromUrlRef.current = true;
				onStateFromUrl(urlState);
				// Reset flag after delay to allow state updates to propagate
				setTimeout(() => {
					isUpdatingFromUrlRef.current = false;
				}, URL_STATE_SYNC_DELAY_MS);
			}
		}
	}, [onStateFromUrl]);

	// Update URL when state changes
	useEffect(() => {
		// Don't update URL while loading from URL
		if (isUpdatingFromUrlRef.current) return;
		if (typeof window === "undefined") return;

		const state: Partial<UrlState> = {};

		// Only include non-default values
		if (waypoints.length > 0) {
			state.waypoints = waypoints;
		}
		if (path && path.coordinates.length > 0) {
			state.path = path;
		}
		// Always include maxGradient if we have waypoints
		if (waypoints.length > 0) {
			state.maxGradient = maxGradient;
		}
		if (excludedAspects.length > 0) {
			state.excludedAspects = excludedAspects;
		}

		const params = serializeUrlState(state);
		const newSearch = params.toString();
		const currentSearch = window.location.search.replace(/^\?/, "");

		// Only update if changed
		if (newSearch !== currentSearch) {
			const newUrl = newSearch
				? `${window.location.pathname}?${newSearch}`
				: window.location.pathname;
			window.history.replaceState(null, "", newUrl);
		}
	}, [waypoints, path, maxGradient, excludedAspects]);

	/**
	 * Get the current shareable URL
	 */
	const getShareableUrl = useCallback((): string => {
		if (typeof window === "undefined") return "";

		const state: Partial<UrlState> = {
			waypoints,
			maxGradient,
			excludedAspects,
		};

		// Only include path if it exists
		if (path) {
			state.path = path;
		}

		const params = serializeUrlState(state);
		const search = params.toString();
		return search
			? `${window.location.origin}${window.location.pathname}?${search}`
			: window.location.href;
	}, [waypoints, path, maxGradient, excludedAspects]);

	return { getShareableUrl };
}

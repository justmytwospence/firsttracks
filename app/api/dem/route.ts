import { type NextRequest, NextResponse } from "next/server";

type OpenTopoDataset = "USGS1m" | "USGS10m" | "USGS30m";

// Maximum area limits in km² from OpenTopography API docs
const MAX_AREA_KM2: Record<OpenTopoDataset, number> = {
  "USGS1m": 250,
  "USGS10m": 25000,
  "USGS30m": 225000,
};

// Calculate approximate area in km² from lat/lng bounds
function calculateAreaKm2(north: number, south: number, east: number, west: number): number {
  const latDiff = north - south;
  const lngDiff = east - west;
  // Average latitude for more accurate calculation
  const avgLat = (north + south) / 2;
  // km per degree latitude is ~111
  const latKm = latDiff * 111;
  // km per degree longitude varies with latitude
  const lngKm = lngDiff * 111 * Math.cos(avgLat * Math.PI / 180);
  return latKm * lngKm;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  
  const north = searchParams.get("north");
  const south = searchParams.get("south");
  const east = searchParams.get("east");
  const west = searchParams.get("west");
  const datasetName = (searchParams.get("dataset") || "USGS10m") as OpenTopoDataset;
  
  if (!north || !south || !east || !west) {
    return NextResponse.json(
      { error: "Missing required bounds parameters" },
      { status: 400 }
    );
  }
  
  const northNum = Number.parseFloat(north);
  const southNum = Number.parseFloat(south);
  const eastNum = Number.parseFloat(east);
  const westNum = Number.parseFloat(west);
  
  // Check area limit
  const areaKm2 = calculateAreaKm2(northNum, southNum, eastNum, westNum);
  const maxArea = MAX_AREA_KM2[datasetName];
  
  if (areaKm2 > maxArea) {
    return NextResponse.json(
      { 
        error: `Requested area (${Math.round(areaKm2)} km²) exceeds maximum allowed for ${datasetName} (${maxArea} km²)`,
        areaKm2,
        maxArea,
      },
      { status: 400 }
    );
  }
  
  const apiKey = process.env.OPEN_TOPO_API_KEY || "";
  
  if (!apiKey) {
    console.error("OPEN_TOPO_API_KEY is not set");
    return NextResponse.json(
      { error: "Server configuration error: Missing API key" },
      { status: 500 }
    );
  }
  
  const baseUrl = "https://portal.opentopography.org/API/usgsdem";
  const url = `${baseUrl}?datasetName=${datasetName}&south=${south}&north=${north}&west=${west}&east=${east}&outputFormat=GTiff&API_Key=${apiKey}`;
  
  console.log(`[DEM API] Fetching with key: ${apiKey.substring(0, 8)}... (length: ${apiKey.length})`);
  
  try {
    const response = await fetch(url);
    
    console.log(`[DEM API] Response: ${response.status} ${response.statusText}`);
    
    if (!response.ok) {
      // Try to get more details from response body
      let errorBody = "";
      try {
        errorBody = await response.text();
        console.error(`[DEM API] Error body: ${errorBody}`);
      } catch {
        // ignore
      }
      return NextResponse.json(
        { error: `OpenTopo API error: ${response.status} - ${errorBody || response.statusText}` },
        { status: response.status }
      );
    }
    
    const buffer = await response.arrayBuffer();
    
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": buffer.byteLength.toString(),
        // Allow caching for 1 hour
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    console.error("Error fetching DEM:", error);
    return NextResponse.json(
      { error: "Failed to fetch DEM data" },
      { status: 500 }
    );
  }
}

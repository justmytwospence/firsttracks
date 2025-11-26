import { type NextRequest, NextResponse } from "next/server";

type OpenTopoDataset = "USGS1m" | "USGS10m" | "USGS30m";

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
  
  const apiKey = process.env.OPEN_TOPO_API_KEY || "";
  const baseUrl = "https://portal.opentopography.org/API/usgsdem";
  const url = `${baseUrl}?datasetName=${datasetName}&south=${south}&north=${north}&west=${west}&east=${east}&outputFormat=GTiff&API_Key=${apiKey}`;
  
  try {
    const response = await fetch(url);
    
    if (!response.ok) {
      return NextResponse.json(
        { error: `OpenTopo API error: ${response.statusText}` },
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

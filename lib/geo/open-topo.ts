import { baseLogger } from "@/lib/logger";

type OpenTopoDataset = "USGS1m" | "USGS10m" | "USGS30m";

export async function getTopo(
  bounds: { north: number; south: number; east: number; west: number },
  datasetName: OpenTopoDataset = "USGS10m",
  outputFormat = "GTiff",
  apiKey = process.env.OPEN_TOPO_API_KEY || ""
): Promise<Buffer> {
  const baseUrl = "https://portal.opentopography.org/API/usgsdem";
  const { north, south, east, west } = bounds;
  const url = `${baseUrl}?datasetName=${datasetName}&south=${south}&north=${north}&west=${west}&east=${east}&outputFormat=${outputFormat}&API_Key=${apiKey}`;
  baseLogger.debug(
    `Fetching Open Topo API data from ${url}`
  );
  const response = await fetch(url);
  baseLogger.debug(
    `Open Topo API response: ${response.status} ${response.statusText}`
  );
  if (!response.ok) {
    throw new Error(`Error fetching data: ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

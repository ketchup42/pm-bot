import { REST_DEFAULT_HOST_GEO } from "./hosts.js";

/**
 * Response structure from Polymarket's geoblocking endpoint.
 * The API returns information about the requesting IP address
 * and whether access is blocked from its country.
 */
export interface GeoblockResponseRaw {
    blocked: boolean;   // true if the IP is in a restricted region (e.g., Russia, Belarus)
    ip: string;         // The public IP address of the requester
    country: string;    // Two‑letter country code (e.g., 'RU', 'US')
    region: string;     // Region or state name, if available
}

/**
 * Fetches the geoblocking status for the current machine from Polymarket.
 * Uses the REST endpoint defined in `REST_DEFAULT_HOST_GEO`.
 * @returns Promise resolving to the raw geoblock response object.
 * @throws Network errors or if the response is not valid JSON.
 */
async function checkGeoblock(): Promise<GeoblockResponseRaw> {
  const response = await fetch(REST_DEFAULT_HOST_GEO);
  return response.json();
}

/**
 * Convenience function that returns only the boolean `blocked` flag.
 * Use this when you only need to know if the current IP is restricted.
 * @returns Promise<boolean> - true if access from this region is blocked.
 */
export async function isMeBlocked(): Promise<boolean> {
    return (await checkGeoblock()).blocked;
}
import { calculateDistanceMiles, getOutwardPostcode } from "./utils";

export interface GeoPoint {
  lat: number;
  lng: number;
}

/**
 * Representative geodesic centroids (WGS84 lat/lng) for UK postcode areas (1-2 letter prefixes).
 * Used as deterministic fallback when exact lat/lng coordinates are not stored on a trader or search profile.
 */
export const UK_POSTCODE_AREA_CENTROIDS: Record<string, GeoPoint> = {
  AB: { lat: 57.1497, lng: -2.0943 },
  AL: { lat: 51.7520, lng: -0.3360 },
  B: { lat: 52.4862, lng: -1.8904 },
  BA: { lat: 51.3758, lng: -2.3599 },
  BB: { lat: 53.7486, lng: -2.4849 },
  BD: { lat: 53.7960, lng: -1.7594 },
  BH: { lat: 50.7192, lng: -1.8808 },
  BL: { lat: 53.5769, lng: -2.4282 },
  BN: { lat: 50.8225, lng: -0.1372 },
  BR: { lat: 51.4060, lng: 0.0132 },
  BS: { lat: 51.4545, lng: -2.5879 },
  BT: { lat: 54.5973, lng: -5.9301 },
  CA: { lat: 54.8925, lng: -2.9329 },
  CB: { lat: 52.2053, lng: 0.1218 },
  CF: { lat: 51.4816, lng: -3.1791 },
  CH: { lat: 53.1934, lng: -2.8931 },
  CM: { lat: 51.7356, lng: 0.4685 },
  CO: { lat: 51.8959, lng: 0.8919 },
  CR: { lat: 51.3762, lng: -0.0982 },
  CT: { lat: 51.2802, lng: 1.0789 },
  CV: { lat: 52.4068, lng: -1.5197 },
  CW: { lat: 53.0988, lng: -2.4405 },
  DA: { lat: 51.4462, lng: 0.2186 },
  DD: { lat: 56.4620, lng: -2.9707 },
  DE: { lat: 52.9225, lng: -1.4746 },
  DG: { lat: 55.0709, lng: -3.6051 },
  DH: { lat: 54.7753, lng: -1.5849 },
  DL: { lat: 54.5236, lng: -1.5594 },
  DN: { lat: 53.5228, lng: -1.1285 },
  DT: { lat: 50.7112, lng: -2.4412 },
  DY: { lat: 52.5123, lng: -2.0811 },
  E: { lat: 51.5390, lng: -0.0050 },
  EC: { lat: 51.5155, lng: -0.0922 },
  EH: { lat: 55.9533, lng: -3.1883 },
  EN: { lat: 51.6523, lng: -0.0832 },
  EX: { lat: 50.7184, lng: -3.5339 },
  FK: { lat: 56.0019, lng: -3.7839 },
  FY: { lat: 53.8175, lng: -3.0357 },
  G: { lat: 55.8642, lng: -4.2518 },
  GL: { lat: 51.8642, lng: -2.2382 },
  GU: { lat: 51.2362, lng: -0.5704 },
  HA: { lat: 51.5806, lng: -0.3420 },
  HD: { lat: 53.6458, lng: -1.7850 },
  HG: { lat: 53.9921, lng: -1.5418 },
  HP: { lat: 51.7526, lng: -0.4692 },
  HR: { lat: 52.0567, lng: -2.7160 },
  HS: { lat: 58.2094, lng: -6.3849 },
  HU: { lat: 53.7676, lng: -0.3274 },
  HX: { lat: 53.7248, lng: -1.8658 },
  IG: { lat: 51.5590, lng: 0.0741 },
  IP: { lat: 52.0567, lng: 1.1482 },
  IV: { lat: 57.4778, lng: -4.2247 },
  KA: { lat: 55.6111, lng: -4.4957 },
  KT: { lat: 51.4123, lng: -0.3007 },
  KW: { lat: 58.4396, lng: -3.0937 },
  KY: { lat: 56.1107, lng: -3.1674 },
  L: { lat: 53.4084, lng: -2.9916 },
  LA: { lat: 54.0466, lng: -2.8007 },
  LD: { lat: 52.2412, lng: -3.3792 },
  LE: { lat: 52.6369, lng: -1.1398 },
  LL: { lat: 53.3241, lng: -3.8276 },
  LN: { lat: 53.2307, lng: -0.5406 },
  LS: { lat: 53.8008, lng: -1.5491 },
  LU: { lat: 51.8787, lng: -0.4200 },
  M: { lat: 53.4808, lng: -2.2426 },
  ME: { lat: 51.3883, lng: 0.5083 },
  MK: { lat: 52.0406, lng: -0.7594 },
  ML: { lat: 55.7891, lng: -3.9915 },
  N: { lat: 51.5685, lng: -0.1062 },
  NE: { lat: 54.9783, lng: -1.6178 },
  NG: { lat: 52.9548, lng: -1.1581 },
  NN: { lat: 52.2405, lng: -0.9027 },
  NP: { lat: 51.5842, lng: -2.9977 },
  NR: { lat: 52.6309, lng: 1.2974 },
  NW: { lat: 51.5495, lng: -0.2000 },
  OL: { lat: 53.5409, lng: -2.1114 },
  OX: { lat: 51.7520, lng: -1.2577 },
  PA: { lat: 55.8456, lng: -4.4239 },
  PE: { lat: 52.5695, lng: -0.2405 },
  PH: { lat: 56.3950, lng: -3.4308 },
  PL: { lat: 50.3755, lng: -4.1427 },
  PO: { lat: 50.8198, lng: -1.0880 },
  PR: { lat: 53.7632, lng: -2.7031 },
  RG: { lat: 51.4543, lng: -0.9781 },
  RH: { lat: 51.2403, lng: -0.1703 },
  RM: { lat: 51.5779, lng: 0.1801 },
  S: { lat: 53.3811, lng: -1.4701 },
  SA: { lat: 51.6214, lng: -3.9436 },
  SE: { lat: 51.4741, lng: -0.0350 },
  SG: { lat: 51.9022, lng: -0.2026 },
  SK: { lat: 53.4106, lng: -2.1575 },
  SL: { lat: 51.5105, lng: -0.5950 },
  SM: { lat: 51.3618, lng: -0.1945 },
  SN: { lat: 51.5558, lng: -1.7797 },
  SO: { lat: 50.9097, lng: -1.4044 },
  SP: { lat: 51.0688, lng: -1.7945 },
  SR: { lat: 54.9069, lng: -1.3838 },
  SS: { lat: 51.5459, lng: 0.7077 },
  ST: { lat: 53.0027, lng: -2.1794 },
  SW: { lat: 51.4648, lng: -0.1687 },
  SY: { lat: 52.7073, lng: -2.7553 },
  TA: { lat: 51.0150, lng: -3.1003 },
  TD: { lat: 55.6167, lng: -2.7833 },
  TF: { lat: 52.6766, lng: -2.4469 },
  TN: { lat: 51.1324, lng: 0.2637 },
  TQ: { lat: 50.4619, lng: -3.5253 },
  TR: { lat: 50.2632, lng: -5.0510 },
  TS: { lat: 54.5742, lng: -1.2350 },
  TW: { lat: 51.4446, lng: -0.3352 },
  UB: { lat: 51.5465, lng: -0.4781 },
  W: { lat: 51.5136, lng: -0.1900 },
  WA: { lat: 53.3900, lng: -2.5970 },
  WC: { lat: 51.5194, lng: -0.1270 },
  WD: { lat: 51.6565, lng: -0.3903 },
  WF: { lat: 53.6833, lng: -1.4977 },
  WN: { lat: 53.5451, lng: -2.6325 },
  WR: { lat: 52.1936, lng: -2.2216 },
  WS: { lat: 52.5862, lng: -1.9829 },
  WV: { lat: 52.5870, lng: -2.1288 },
  YO: { lat: 53.9591, lng: -1.0815 },
  ZE: { lat: 60.1546, lng: -1.1494 },
};

/**
 * Extracts explicit lat/lng coordinates from a record if present and finite.
 */
export function extractExplicitGeoPoint(entity: any): GeoPoint | null {
  if (!entity || typeof entity !== "object") return null;
  const lat = Number(entity.lat ?? entity.latitude ?? entity.coordinates?.lat ?? entity.coordinates?.latitude ?? entity.location?.lat);
  const lng = Number(entity.lng ?? entity.longitude ?? entity.coordinates?.lng ?? entity.coordinates?.longitude ?? entity.location?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    return { lat, lng };
  }
  return null;
}

/**
 * Resolves a UK postcode / outward code / postcode area prefix to a geodesic centroid.
 */
export function resolvePostcodeCentroid(postcode?: string | null): GeoPoint | null {
  if (!postcode || typeof postcode !== "string") return null;
  const trimmed = postcode.trim().toUpperCase();
  if (!trimmed) return null;

  const outward = getOutwardPostcode(trimmed);
  const candidate = outward && outward !== "Area Hidden" ? outward : trimmed.replace(/[^A-Z0-9]/g, "");
  const areaMatch = candidate.match(/^([A-Z]{1,2})/);
  if (!areaMatch) return null;

  const prefix = areaMatch[1].toUpperCase();
  if (UK_POSTCODE_AREA_CENTROIDS[prefix]) {
    return UK_POSTCODE_AREA_CENTROIDS[prefix];
  }
  return null;
}

/**
 * Computes true geodesic Haversine distance in miles between two locations (explicit coords preferred, UK postcode centroid fallback).
 * Returns null if either endpoint cannot be geolocated.
 */
export function computeGeodesicDistanceMiles(
  origin: { coords?: GeoPoint | null; postcode?: string | null },
  destination: { coords?: GeoPoint | null; postcode?: string | null }
): number | null {
  const originPoint = origin.coords || resolvePostcodeCentroid(origin.postcode);
  const destPoint = destination.coords || resolvePostcodeCentroid(destination.postcode);
  if (!originPoint || !destPoint) return null;

  if (originPoint.lat === destPoint.lat && originPoint.lng === destPoint.lng) {
    return 0;
  }
  return calculateDistanceMiles(originPoint.lat, originPoint.lng, destPoint.lat, destPoint.lng);
}

/**
 * AT-ADS-12: Real geodesic radius filter for promoted ad placements.
 * - "nationwide" or unspecified/non-positive radius => matches nationwide.
 * - Finite radiusMiles > 0 => computes geodesic distance (explicit lat/lng first, UK postcode centroid fallback)
 *   and requires distance <= radiusMiles. Fails closed when a search location is supplied and either side cannot match within radius.
 */
export function isWithinAdRadiusMiles(params: {
  promotionRadius?: string | number | null;
  traderCoords?: GeoPoint | null;
  traderPostcode?: string | null;
  searchCoords?: GeoPoint | null;
  searchPostcode?: string | null;
}): { withinRadius: boolean; distanceMiles: number | null } {
  const { promotionRadius, traderCoords, traderPostcode, searchCoords, searchPostcode } = params;

  if (!promotionRadius || String(promotionRadius).toLowerCase() === "nationwide") {
    return { withinRadius: true, distanceMiles: null };
  }

  const radiusMiles = Number(promotionRadius);
  if (!Number.isFinite(radiusMiles) || radiusMiles <= 0) {
    return { withinRadius: true, distanceMiles: null };
  }

  const hasSearchLocation = Boolean(searchCoords || (searchPostcode && searchPostcode.trim().length > 0));
  if (!hasSearchLocation) {
    // No viewer location known — cannot prove out-of-radius, allow nationwide fallback only if no strict search filter
    return { withinRadius: true, distanceMiles: null };
  }

  const distance = computeGeodesicDistanceMiles(
    { coords: traderCoords || null, postcode: traderPostcode || null },
    { coords: searchCoords || null, postcode: searchPostcode || null }
  );

  if (distance === null) {
    // Fail closed when search location is specified but trader/search cannot be geolocated
    return { withinRadius: false, distanceMiles: null };
  }

  return {
    withinRadius: distance <= radiusMiles,
    distanceMiles: distance,
  };
}

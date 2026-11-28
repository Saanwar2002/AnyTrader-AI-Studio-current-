export interface OfferIntelligenceInput {
  pickupAddress?: string;
  dropoffAddress?: string;
  pickupLat?: number | null;
  pickupLng?: number | null;
  dropoffLat?: number | null;
  dropoffLng?: number | null;
  fareEstimate?: number | null;
  distanceMiles?: number | null;
  durationMinutes?: number | null;
}

export interface OfferIntelligence {
  pickupDeadheadMiles: number;
  totalTripMiles: number;
  estimatedTotalMinutes: number;
  estimatedGbpPerHour: number;
  estimatedGbpPerMile: number;
  compassShort: string;
  compassLabel: string;
  isHeadingTowardHome: boolean;
  smartTag: "AIRPORT" | "RAIL STATION" | "LONG TRIP" | null;
}

const AIRPORT_KEYWORDS = [
  "airport",
  "heathrow",
  "gatwick",
  "stansted",
  "luton",
  "london city",
  "manchester terminal",
  "birmingham airport",
  "edinburgh airport",
  "glasgow airport",
  "bristol airport",
  "east midlands",
  "newcastle airport",
  "liverpool john lennon",
  "leeds bradford",
  "terminal 1",
  "terminal 2",
  "terminal 3",
  "terminal 4",
  "terminal 5",
];

const STATION_KEYWORDS = [
  "station",
  "king's cross",
  "kings cross",
  "st pancras",
  "euston",
  "paddington",
  "waterloo",
  "victoria coach",
  "victoria station",
  "liverpool street",
  "marylebone",
  "piccadilly",
  "new street",
  "waverley",
  "central station",
  "temple meads",
  "lime street",
];

export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.7613;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function computeBearingDegrees(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaLambda = toRad(lng2 - lng1);
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  const theta = (Math.atan2(y, x) * 180) / Math.PI;
  return (theta + 360) % 360;
}

function angularDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function bearingToCompass(deg: number): [string, string] {
  const normalized = ((deg % 360) + 360) % 360;
  if (normalized < 22.5 || normalized >= 337.5) return ["N", "North"];
  if (normalized < 67.5) return ["NE", "North-East"];
  if (normalized < 112.5) return ["E", "East"];
  if (normalized < 157.5) return ["SE", "South-East"];
  if (normalized < 202.5) return ["S", "South"];
  if (normalized < 247.5) return ["SW", "South-West"];
  if (normalized < 292.5) return ["W", "West"];
  return ["NW", "North-West"];
}

export function analyzeOfferIntelligence(params: {
  offer: OfferIntelligenceInput;
  driverLat?: number | null;
  driverLng?: number | null;
  hasRealDriverFix?: boolean;
  homeLat?: number | null;
  homeLng?: number | null;
}): OfferIntelligence {
  const { offer, driverLat, driverLng, hasRealDriverFix = true, homeLat, homeLng } = params;

  const pLat = Number(offer.pickupLat || 0);
  const pLng = Number(offer.pickupLng || 0);
  const dLat = Number(offer.dropoffLat || 0);
  const dLng = Number(offer.dropoffLng || 0);
  const hasPickup = Number.isFinite(pLat) && Number.isFinite(pLng) && (pLat !== 0 || pLng !== 0);
  const hasDropoff = Number.isFinite(dLat) && Number.isFinite(dLng) && (dLat !== 0 || dLng !== 0);

  const deadheadMiles =
    hasRealDriverFix &&
    hasPickup &&
    typeof driverLat === "number" &&
    typeof driverLng === "number" &&
    Number.isFinite(driverLat) &&
    Number.isFinite(driverLng)
      ? haversineMiles(driverLat, driverLng, pLat, pLng)
      : 0;

  const rawTripMiles = Number(offer.distanceMiles || 0);
  const tripMiles =
    rawTripMiles > 0.05
      ? rawTripMiles
      : hasPickup && hasDropoff
        ? haversineMiles(pLat, pLng, dLat, dLng) * 1.25
        : 1.0;

  const totalMiles = Math.max(0.5, deadheadMiles + tripMiles);

  // Average UK urban pickup approach ~18 mph => ~3.3 min/mile
  const pickupMins = Math.max(deadheadMiles > 0.1 ? 2 : 0, Math.floor(deadheadMiles * 3.3));
  const rawRideMins = Number(offer.durationMinutes || 0);
  const rideMins = rawRideMins > 0 ? rawRideMins : Math.max(5, Math.floor(tripMiles * 3.2));
  const totalMins = Math.max(5, pickupMins + rideMins);

  const fare = Number(offer.fareEstimate || 0);
  const gbpPerHour = fare > 0 ? Math.min(250, Math.max(0, fare / (totalMins / 60))) : 0;
  const gbpPerMile = fare > 0 ? Math.min(50, Math.max(0, fare / totalMiles)) : 0;

  const bearingDeg = hasPickup && hasDropoff ? computeBearingDegrees(pLat, pLng, dLat, dLng) : null;
  const [compassShort, compassLabel] = bearingDeg !== null ? bearingToCompass(bearingDeg) : ["", ""];

  let isHeadingTowardHome = false;
  if (
    bearingDeg !== null &&
    hasPickup &&
    typeof homeLat === "number" &&
    typeof homeLng === "number" &&
    (homeLat !== 0 || homeLng !== 0)
  ) {
    const homeBearing = computeBearingDegrees(pLat, pLng, homeLat, homeLng);
    const diff = angularDiff(bearingDeg, homeBearing);
    const distBefore = haversineMiles(pLat, pLng, homeLat, homeLng);
    const distAfter = haversineMiles(dLat, dLng, homeLat, homeLng);
    isHeadingTowardHome = diff <= 38 && distAfter < distBefore;
  }

  const combined = `${offer.pickupAddress || ""} ${offer.dropoffAddress || ""}`.toLowerCase();
  let smartTag: OfferIntelligence["smartTag"] = null;
  if (AIRPORT_KEYWORDS.some((kw) => combined.includes(kw))) {
    smartTag = "AIRPORT";
  } else if (STATION_KEYWORDS.some((kw) => combined.includes(kw))) {
    smartTag = "RAIL STATION";
  } else if (tripMiles >= 15 || rideMins >= 30) {
    smartTag = "LONG TRIP";
  }

  return {
    pickupDeadheadMiles: Number(deadheadMiles.toFixed(1)),
    totalTripMiles: Number(tripMiles.toFixed(1)),
    estimatedTotalMinutes: totalMins,
    estimatedGbpPerHour: Number(gbpPerHour.toFixed(1)),
    estimatedGbpPerMile: Number(gbpPerMile.toFixed(2)),
    compassShort,
    compassLabel,
    isHeadingTowardHome,
    smartTag,
  };
}

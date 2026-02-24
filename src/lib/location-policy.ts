import type { LocationPolicy, LocationSource } from "../types.js";

export interface StartupLocationDecision {
  shouldRefreshWithIp: boolean;
  shouldRunBrowserLocate: boolean;
  reason?: string;
  driftKm?: number;
}

export interface StartupLocationRecommendation {
  shouldRunBrowserLocate: boolean;
  reason?: string;
  driftKm?: number;
}

const LOCATION_POLICIES: readonly LocationPolicy[] = ["smart", "ip-only", "manual-only"];
const LOCATION_STARTUP_TTL_DEFAULT_OR_IP_MS = 30 * 60 * 1000;
const LOCATION_STARTUP_TTL_BROWSER_MS = 6 * 60 * 60 * 1000;
const LOCATION_STARTUP_TTL_MANUAL_MS = 24 * 60 * 60 * 1000;
const LOCATION_STARTUP_DRIFT_REFRESH_KM = 50;
const LOCATION_STARTUP_MANUAL_DRIFT_KM = 80;

export function isLocationPolicy(value: unknown): value is LocationPolicy {
  return typeof value === "string" && LOCATION_POLICIES.includes(value as LocationPolicy);
}

export function normalizeLocationPolicy(
  value: unknown,
  fallback: LocationPolicy = "smart"
): LocationPolicy {
  return isLocationPolicy(value) ? value : fallback;
}

export function evaluateSmartStartupLocationDecision(input: {
  source: LocationSource;
  updatedAt?: string;
  latitude: number;
  longitude: number;
  resolvedLatitude?: number;
  resolvedLongitude?: number;
}): StartupLocationDecision {
  const { source } = input;
  const updatedAtMs = parseTimestampMs(input.updatedAt);
  const now = Date.now();
  const ageMs = updatedAtMs !== undefined ? Math.max(0, now - updatedAtMs) : undefined;
  const driftKm =
    input.resolvedLatitude !== undefined &&
    input.resolvedLongitude !== undefined &&
    Number.isFinite(input.latitude) &&
    Number.isFinite(input.longitude)
      ? haversineDistanceKm(
          input.latitude,
          input.longitude,
          input.resolvedLatitude,
          input.resolvedLongitude
        )
      : undefined;

  const isDefaultOrIp = source === "default" || source === "ip";
  let reason: string | undefined;

  if (updatedAtMs === undefined) {
    if (isDefaultOrIp || source === "browser") {
      reason = "missing";
    }
  } else if (isDefaultOrIp && ageMs !== undefined && ageMs > LOCATION_STARTUP_TTL_DEFAULT_OR_IP_MS) {
    reason = "ttl";
  } else if (source === "browser" && ageMs !== undefined && ageMs > LOCATION_STARTUP_TTL_BROWSER_MS) {
    reason = "ttl";
  } else if (
    source === "manual" &&
    ageMs !== undefined &&
    ageMs > LOCATION_STARTUP_TTL_MANUAL_MS &&
    driftKm !== undefined &&
    driftKm > LOCATION_STARTUP_MANUAL_DRIFT_KM
  ) {
    reason = "ttl+drift";
  }

  if (!reason && driftKm !== undefined && driftKm > LOCATION_STARTUP_DRIFT_REFRESH_KM) {
    reason = "drift";
  }

  const decision: StartupLocationDecision = {
    shouldRefreshWithIp: Boolean(
      reason &&
        input.resolvedLatitude !== undefined &&
        input.resolvedLongitude !== undefined
    ),
    shouldRunBrowserLocate: Boolean(reason)
  };

  if (reason !== undefined) {
    decision.reason = reason;
  }
  if (driftKm !== undefined) {
    decision.driftKm = driftKm;
  }
  return decision;
}

function parseTimestampMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

function haversineDistanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return 6371 * c;
}

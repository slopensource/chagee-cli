import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateSmartStartupLocationDecision,
  normalizeLocationPolicy
} from "../src/lib/location-policy.js";

test("normalizeLocationPolicy falls back for invalid values", () => {
  assert.equal(normalizeLocationPolicy("smart"), "smart");
  assert.equal(normalizeLocationPolicy("ip-only"), "ip-only");
  assert.equal(normalizeLocationPolicy("manual-only"), "manual-only");
  assert.equal(normalizeLocationPolicy("unknown"), "smart");
});

test("smart location policy marks stale default/ip source by ttl", () => {
  const oldUpdatedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  const decision = evaluateSmartStartupLocationDecision({
    source: "ip",
    updatedAt: oldUpdatedAt,
    latitude: 1.3521,
    longitude: 103.8198,
    resolvedLatitude: 1.3001,
    resolvedLongitude: 103.8001
  });

  assert.equal(decision.shouldRunBrowserLocate, true);
  assert.equal(decision.shouldRefreshWithIp, true);
  assert.equal(decision.reason, "ttl");
});

test("smart location policy marks large drift as stale", () => {
  const updatedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const decision = evaluateSmartStartupLocationDecision({
    source: "browser",
    updatedAt,
    latitude: 3.139,
    longitude: 101.6869,
    resolvedLatitude: 1.3521,
    resolvedLongitude: 103.8198
  });

  assert.equal(decision.shouldRunBrowserLocate, true);
  assert.equal(decision.shouldRefreshWithIp, true);
  assert.equal(decision.reason, "drift");
  assert.equal(typeof decision.driftKm, "number");
});

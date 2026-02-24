import test from "node:test";
import assert from "node:assert/strict";

import { createInitialState, derivePhase, nextCartVersion, resetForStoreSwitch } from "../src/lib/state.js";

test("initial state starts unauthenticated and dry-run", () => {
  const state = createInitialState();
  assert.equal(derivePhase(state), "UNAUTH");
  assert.equal(state.session.mode, "dry-run");
  assert.equal(state.cart.length, 0);
});

test("nextCartVersion clears quote and staged payload", () => {
  const state = createInitialState();
  state.quote = {
    at: new Date().toISOString(),
    raw: {}
  };
  state.pendingCreatePayload = { test: 1 };
  nextCartVersion(state);
  assert.equal(state.cartVersion, 1);
  assert.equal(state.quote, undefined);
  assert.equal(state.pendingCreatePayload, undefined);
});

test("resetForStoreSwitch clears order/payment/cart state", () => {
  const state = createInitialState();
  state.cart = [
    {
      lineId: "a",
      skuId: "sku-1",
      qty: 1
    }
  ];
  state.quote = {
    at: new Date().toISOString(),
    raw: {}
  };
  state.pendingCreatePayload = { foo: "bar" };
  state.order = {
    orderNo: "ORD123",
    createdAt: new Date().toISOString()
  };
  state.payment = { status: "pending" };

  resetForStoreSwitch(state);

  assert.equal(state.cart.length, 0);
  assert.equal(state.quote, undefined);
  assert.equal(state.pendingCreatePayload, undefined);
  assert.equal(state.order, undefined);
  assert.equal(state.payment, undefined);
});

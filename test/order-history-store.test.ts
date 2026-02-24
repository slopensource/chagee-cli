import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  appendOrderHistory,
  clearOrderHistory,
  loadOrderHistory,
  orderHistoryFilePath
} from "../src/lib/order-history-store.js";

async function withHistoryHome(run: () => Promise<void>): Promise<void> {
  const tempHome = await mkdtemp(join(tmpdir(), "chagee-order-history-"));
  const previous = process.env.CHAGEE_CLI_HOME;
  process.env.CHAGEE_CLI_HOME = tempHome;
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env.CHAGEE_CLI_HOME;
    } else {
      process.env.CHAGEE_CLI_HOME = previous;
    }
  }
}

test("order history append/load/clear works and dedupes by orderNo", async () => {
  await withHistoryHome(async () => {
    assert.equal(orderHistoryFilePath().endsWith("order-history.json"), true);
    await clearOrderHistory();

    await appendOrderHistory({
      id: "entry-a",
      at: "2026-02-24T12:00:00.000Z",
      orderNo: "ORD-100",
      region: "SG",
      storeNo: "S001",
      storeName: "Marina Bay",
      total: "6.90",
      items: [{ skuId: "SKU-1", qty: 1 }]
    });

    await appendOrderHistory({
      id: "entry-b",
      at: "2026-02-24T12:05:00.000Z",
      orderNo: "ORD-100",
      region: "SG",
      storeNo: "S001",
      storeName: "Marina Bay",
      total: "7.20",
      items: [{ skuId: "SKU-1", qty: 2 }]
    });

    const loaded = await loadOrderHistory();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.id, "entry-b");
    assert.equal(loaded[0]?.total, "7.20");

    await clearOrderHistory();
    const cleared = await loadOrderHistory();
    assert.deepEqual(cleared, []);
  });
});

test("order history loader drops invalid entries and sanitizes item selections", async () => {
  await withHistoryHome(async () => {
    const file = orderHistoryFilePath();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify(
        {
          schemaVersion: 1,
          entries: [
            {
              id: "invalid-no-order",
              at: "2026-02-24T12:00:00.000Z",
              region: "SG",
              items: [{ skuId: "SKU-X", qty: 1 }]
            },
            {
              id: "valid-entry",
              at: "2026-02-24T12:10:00.000Z",
              orderNo: "ORD-200",
              region: "SG",
              items: [
                { skuId: "SKU-DROP", qty: 0 },
                {
                  skuId: "SKU-KEEP",
                  qty: 1,
                  specList: [{ specId: "s1", specOptionId: "o1" }, { specId: "bad" }],
                  attributeList: [{ attributeOptionId: "a1" }, { foo: "bar" }]
                }
              ]
            }
          ]
        },
        null,
        2
      )
    );

    const loaded = await loadOrderHistory();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.id, "valid-entry");
    assert.equal(loaded[0]?.items.length, 1);
    assert.deepEqual(loaded[0]?.items[0]?.specList, [{ specId: "s1", specOptionId: "o1" }]);
    assert.deepEqual(loaded[0]?.items[0]?.attributeList, [{ attributeOptionId: "a1" }]);
  });
});

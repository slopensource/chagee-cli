import test from "node:test";
import assert from "node:assert/strict";

import { parseBool, parseKeyValueTokens, parseNum, tokenize } from "../src/lib/parser.js";

test("tokenize supports quoted segments and escapes", () => {
  const out = tokenize(String.raw`add 123 name="Jasmine Milk Tea" note=hello\ world`);
  assert.deepEqual(out, ["add", "123", "name=Jasmine Milk Tea", "note=hello world"]);
});

test("parseKeyValueTokens splits args and key-value options", () => {
  const parsed = parseKeyValueTokens(["watch", "on", "interval=10", "quiet=1", "sort=distance"]);
  assert.deepEqual(parsed.args, ["watch", "on"]);
  assert.deepEqual(parsed.opts, {
    interval: "10",
    quiet: "1",
    sort: "distance"
  });
});

test("parseBool handles known boolean literals", () => {
  assert.equal(parseBool("1"), true);
  assert.equal(parseBool("true"), true);
  assert.equal(parseBool("off", true), false);
  assert.equal(parseBool("unknown", true), true);
});

test("parseNum returns fallback for invalid values", () => {
  assert.equal(parseNum("12", 5), 12);
  assert.equal(parseNum("NaN", 5), 5);
  assert.equal(parseNum(undefined, 5), 5);
});

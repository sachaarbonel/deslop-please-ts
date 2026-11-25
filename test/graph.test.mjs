import assert from "node:assert/strict";
import test from "node:test";
import { components } from "../dist/graph.js";

test("a long chain and its closed cycle use iterative component traversal", () => {
  const count = 20_000;
  const edges = Array.from({ length: count }, (_, index) => (index + 1 < count ? [index + 1] : []));
  assert.deepEqual(components(edges), []);
  edges[count - 1].push(0);
  assert.deepEqual(components(edges), [Array.from({ length: count }, (_, index) => index)]);
});

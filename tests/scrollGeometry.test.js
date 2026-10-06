import test from "node:test";
import assert from "node:assert/strict";

import {
  clampScrollTop,
  getElementScrollBounds,
} from "../content/timeline/scrollGeometry.js";

test("current ChatGPT column-reverse containers expose a negative scroll range", () => {
  const container = {
    clientHeight: 600,
    scrollHeight: 3000,
    flexDirection: "column-reverse",
  };

  const bounds = getElementScrollBounds(container);
  assert.deepEqual(bounds, { min: -2400, max: 0 });
  assert.equal(clampScrollTop(-900, bounds), -900);
  assert.equal(clampScrollTop(200, bounds), 0);
});

test("legacy top-down containers keep their non-negative scroll range", () => {
  const bounds = getElementScrollBounds({ clientHeight: 600, scrollHeight: 3000 });
  assert.deepEqual(bounds, { min: 0, max: 2400 });
  assert.equal(clampScrollTop(-200, bounds), 0);
  assert.equal(clampScrollTop(900, bounds), 900);
});

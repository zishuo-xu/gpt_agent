import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { greet } from "../src/utils/greeting.js";

describe("greet", () => {
  it("returns Hello followed by the given name", () => {
    assert.equal(greet("World"), "Hello World");
  });

  it("works with empty string", () => {
    assert.equal(greet(""), "Hello ");
  });
});

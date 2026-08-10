import assert from "node:assert/strict";
import test from "node:test";
import { BoundedLruMap } from "../server/bounded-lru-map.js";

test("bounded LRU map evicts the least recently used entry once over capacity", () => {
  const cache = new BoundedLruMap<string, string>(3);
  cache.set("a", "1");
  cache.set("b", "2");
  cache.set("c", "3");
  cache.set("d", "4");
  assert.equal(cache.size, 3);
  assert.equal(cache.get("a"), undefined, "oldest entry is evicted first");
  assert.equal(cache.get("b"), "2");
  assert.equal(cache.get("c"), "3");
  assert.equal(cache.get("d"), "4");
});

test("bounded LRU map refreshes recency on both get and set", () => {
  const cache = new BoundedLruMap<string, string>(2);
  cache.set("a", "1");
  cache.set("b", "2");
  cache.get("a"); // touch "a" so "b" becomes the oldest
  cache.set("c", "3");
  assert.equal(cache.get("b"), undefined, "least recently touched entry is evicted");
  assert.equal(cache.get("a"), "1");
  assert.equal(cache.get("c"), "3");
});

test("bounded LRU map delete and clear remove entries", () => {
  const cache = new BoundedLruMap<string, string>(2);
  cache.set("a", "1");
  cache.delete("a");
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.size, 0);
  cache.set("a", "1");
  cache.set("b", "2");
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get("a"), undefined);
});

test("bounded LRU map rejects a non-positive-integer capacity", () => {
  assert.throws(() => new BoundedLruMap<string, string>(0));
  assert.throws(() => new BoundedLruMap<string, string>(-1));
  assert.throws(() => new BoundedLruMap<string, string>(1.5));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { groupOf, makeBreakers } from "../scripts/archive/breakers.js";
import { unknownModel } from "../scripts/archive/previous-runs.js";

test("each source and each Open-Meteo model has its own breaker", () => {
  assert.equal(groupOf({ kind: "ots" }), "ots");
  assert.equal(groupOf({ kind: "snotel" }), "snotel");
  assert.equal(groupOf({ kind: "om", model: "gem_seamless" }), "om:gem_seamless");
  assert.notEqual(groupOf({ kind: "om", model: "gem_seamless" }), groupOf({ kind: "om", model: "ecmwf_ifs025" }));
});

test("a broken source switches off after 3 in a row, and leaves the others running", () => {
  const b = makeBreakers();
  assert.equal(b.failure("ots", "HTTP 404"), false);
  assert.equal(b.failure("ots", "HTTP 404"), false);
  assert.equal(b.failure("ots", "HTTP 404"), true);
  assert.ok(b.isOpen("ots"));
  assert.ok(!b.isOpen("om:ecmwf_ifs025"));
  assert.match(b.opened()[0][1], /3 failures in a row \(last: HTTP 404\)/);
});

test("a success resets the count", () => {
  const b = makeBreakers();
  b.failure("snotel", "x"); b.failure("snotel", "x");
  b.success("snotel");
  b.failure("snotel", "x"); b.failure("snotel", "x");
  assert.ok(!b.isOpen("snotel"));
});

test("trip switches a source off at once", () => {
  const b = makeBreakers();
  b.trip("om:gem_seamless", "bad name");
  assert.ok(b.isOpen("om:gem_seamless"));
});

test("Open-Meteo's real wording for a bad model name counts as unknown model", () => {
  assert.ok(unknownModel(400, '{"error":true,"reason":"Cannot initialize MultiDomains from invalid String value gem_seamless."}'));
  assert.ok(unknownModel(400, "unknown model"));
  assert.ok(!unknownModel(400, '{"error":true,"reason":"Parameter start_date is out of range"}'));
  assert.ok(!unknownModel(200, "model"));
});

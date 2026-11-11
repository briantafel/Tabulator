import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHeader, toUnit, sample, tarEntries, productOf, urlFor } from "../scripts/archive/snodas.js";

const HDR = `Data units: Meters / 1000.000000
Data slope: 0.001
Data intercept: 0
No data value: -9999
Number of columns: 4
Number of rows: 3
Minimum x-axis coordinate: -112
Maximum y-axis coordinate: 41
X-axis resolution: 0.5
Y-axis resolution: 0.5`;

test("SNODAS header, units and sampling", () => {
  const h = parseHeader(HDR);
  assert.equal(h.cols, 4);
  assert.equal(toUnit("11036", 1234, h), 123.4); // 1.234 m depth -> 123.4 cm
  assert.equal(toUnit("11034", 250, h), 250);   // 0.25 m SWE -> 250 mm
  assert.equal(toUnit("11036", -9999, h), null);
  const g = Buffer.alloc(24);
  [0, 5, 9, 1, 2, 3, 4, 8, -9999, 6, 7, 1].forEach((v, i) => g.writeInt16BE(v, 2 * i));
  const s = sample(g, h, 40.6, -111.2); // row 0, col 1
  assert.deepEqual([s.row, s.col, s.cell, s.max], [0, 1, 5, 9]);
  assert.equal(sample(g, h, 10, -111), null);
  assert.throws(() => parseHeader("Data units: x"), /format changed/);
});

test("SNODAS tar reading and file names", () => {
  const body = Buffer.from("hello");
  const head = Buffer.alloc(512);
  head.write("us_ssmv11036tS__T0001TTNATS2026111005HP001.dat.gz", 0, "latin1");
  head.write(body.length.toString(8).padStart(11, "0"), 124, "latin1");
  const tar = Buffer.concat([head, body, Buffer.alloc(512 - body.length), Buffer.alloc(1024)]);
  const e = tarEntries(tar);
  assert.equal(e.length, 1);
  assert.equal(productOf(e[0].name), "11036");
  assert.equal(urlFor(new Date("2026-11-09T12:00:00Z")).split("/").slice(-3).join("/"), "2026/11_Nov/SNODAS_unmasked_20261109.tar");
});

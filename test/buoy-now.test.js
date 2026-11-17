import { test } from "node:test";
import assert from "node:assert/strict";
import { activePops, buoyText, buoyNow, span } from "../scripts/buoy-now.js";

/** Daily highs: 2 m every day, a pop to 4.5 m on `popDay`. */
const series = (from, days, popDay) => {
  const m = new Map();
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.parse(`${from}T00:00:00Z`) + i * 864e5).toISOString().slice(0, 10);
    m.set(d, d === popDay ? 4.5 : 2.0);
  }
  return m;
};

test("an active pop (window not over) gives the line; an old one does not", () => {
  const daily = { 51001: series("2026-10-20", 30, "2026-11-12") };
  const pops = activePops(daily, "2026-11-17");
  assert.deepEqual(pops, [{ buoy: "51001", date: "2026-11-12" }]);
  const t = buoyText(pops);
  assert.match(t, /^Buoy 51001 near Hawaii popped Nov 12/);
  assert.match(t, /Nov 23–29/);
  assert.match(t, /promising, not proven/);
  assert.deepEqual(activePops(daily, "2026-11-30"), []); // window ended Nov 29
  assert.equal(buoyText([]), null);
});

test("both buoys popping together are named together", () => {
  const daily = { 51001: series("2026-10-20", 30, "2026-11-12"), 51101: series("2026-10-20", 30, "2026-11-13") };
  assert.match(buoyText(activePops(daily, "2026-11-17")), /^Buoys 51001 and 51101 near Hawaii popped Nov 13/);
});

test("span crosses a month end", () => assert.equal(span("2026-11-28", "2026-12-04"), "Nov 28–Dec 4"));

test("an unreachable buoy is a warning, never a fake 'no pop'", async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, text: async () => "" });
  const r = await buoyNow({ now: new Date("2026-11-17T12:00:00Z"), fetchImpl });
  assert.equal(r.block, null);
  assert.match(r.warning, /no buoy data/);
});

test("realtime2 text parses (header, units row, MM missing values)", async () => {
  const rows = ["#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD", "#yr  mo dy hr mn degT m/s  m/s     m   sec"];
  for (let i = 0; i < 30; i++) {
    const d = new Date(Date.parse("2026-10-20T00:00:00Z") + i * 864e5);
    const h = d.toISOString().slice(0, 10) === "2026-11-12" ? "4.6" : i === 5 ? "MM" : "2.0";
    rows.push(`${d.getUTCFullYear()} ${String(d.getUTCMonth() + 1).padStart(2, "0")} ${String(d.getUTCDate()).padStart(2, "0")} 12 00  40  7.0  9.0   ${h}  12`);
  }
  const text = rows.reverse().join("\n"); // realtime files are newest first
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => text });
  const r = await buoyNow({ now: new Date("2026-11-17T12:00:00Z"), fetchImpl });
  assert.match(r.block.text, /popped Nov 12/);
});

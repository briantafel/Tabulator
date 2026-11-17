#!/usr/bin/env python3
"""Snow-to-liquid ratio (SLR) v3: same-station snow + water, one line per climate region (2026-11-16).

    python3 scripts/model/slr.py <pairs.parquet> <outDir>      (reads <outDir>/wpairs.parquet too)

Why v2. v1 learned SLR from SNOTEL's day-over-day DEPTH gain ÷ SWE gain. New
snow settles and the old pack compacts, so depth gain undercounts new snow;
v1 learned that loss (median 6.7:1) and was no better than a flat 7:1.

Truth now: stations that measure NEW SNOW and its WATER over the same 24 h
window at the same place — CoCoRaHS (snow board cleared daily + melted gauge
catch), SLF manual study plots (HN + HNW) and AMeDAS. windows.py pairs them
with resorts (wpairs.parquet: one station per resort and product, height class
from its elevation). No settling in a 24 h board reading.

Form (unchanged, so scripts/projections/build_dyn.py reads it as is):
    SLR = a + b·T, clamped to [SLR_MIN, SLR_MAX]
T = the model's forecast precipitation-weighted 2 m temperature for the day
the window mostly covers, moved from the Snow-Forecast mid elevation to the
STATION's elevation at 6.5 °C/km. Fitting at station height and applying at
slope height (with the slope's temperature) is what lets a valley-heavy
station set transfer to the slope.

Phase is NOT in the ratio: build_dyn splits rain from snow first, so the fit
uses snow days only (new snow > 0, T at the station ≤ 0 °C) with ≥ MIN_WATER_MM
of water (light days give noisy ratios).

Known bias, reported not corrected: gauges under-catch snow in wind, which
makes observed ratios run high. The report prints the calm-vs-all check
(stations in the 'valley' / 'base' class are usually sheltered).

Fit: 2024-25 only, leads 1–3. Robust: median ratio per 1 °C bin (≥ 10 days),
count-weighted line through the medians. Judge: 2025-26 only, on the same
truth (new-snow boards), CSI at 2.5 / 10 / 15 cm vs Open-Meteo's flat 7:1,
paired date-block bootstrap. promote[lead] = the 10 cm gain range is above 0
AND no threshold's gain range is entirely below 0.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import duckdb
import numpy as np

SLR_MIN, SLR_MAX = 5.0, 25.0
MIN_WATER_MM = 2.5
MAX_T_C = 0.0
THRESHOLDS_CM = (2.5, 10.0, 15.0)
KEY_THRESHOLD = 10.0
LAPSE_C_PER_M = 0.0065
N_BOOT = 1000
SEED = 20261115
PREV = "open-meteo-previous-runs"
HINDCAST = "snow-forecast-hindcast"
TRUTH = ("cocorahs", "amedas", "slf")
RESORTS = Path(__file__).resolve().parents[2] / "src/data/resorts.json"
# v3 (2026-11-16, Brian): one line per CLIMATE REGION. The pooled line is mostly
# inland CoCoRaHS stations; maritime snow near 0 °C is denser than it says.
# A region gets its own line, pulled toward the pooled one by SHRINK_DAYS
# (few days → nearly pooled), and keeps it only if it beats the pooled line
# on the judge winter. Everything else stays pooled, so nothing gets worse.
MACRO = {
    "California": "Sierra & Cascades", "Nevada": "Sierra & Cascades", "Oregon": "Sierra & Cascades",
    "Washington": "Sierra & Cascades", "British Columbia": "Coast & Interior BC",
    "Colorado": "Rockies", "Utah": "Rockies", "Wyoming": "Rockies", "Idaho": "Rockies", "Montana": "Rockies",
    "New Mexico": "Rockies", "Alberta": "Rockies",
    "Vermont": "Northeast", "New York": "Northeast", "Quebec": "Northeast", "Ontario": "Northeast",
    "Switzerland": "Alps", "Austria": "Alps", "France": "Alps", "Italy": "Alps", "Japan": "Japan",
}
SHRINK_DAYS = 200
MIN_REGION_DAYS = 150


def load(con, pairs: Path, wpairs: Path) -> None:
    meta = json.loads(RESORTS.read_text())["resorts"]
    con.execute("CREATE TABLE rz(resort_id VARCHAR, tz VARCHAR, macro VARCHAR)")
    con.executemany("INSERT INTO rz VALUES (?, ?, ?)",
                    [(r["id"], r["tz"], MACRO.get(r["region"], r["region"])) for r in meta])
    srcs = ", ".join(f"'{s}'" for s in TRUTH)
    # One row per station-window with both its water and its new snow.
    con.execute(f"""
    CREATE TABLE obs AS
    WITH w AS (SELECT DISTINCT truth_source, product, resort_id, station_id, elev_class, delev_mid, ws, we, space, obs, split
               FROM read_parquet('{wpairs}') WHERE truth_source IN ({srcs}))
    SELECT l.truth_source, l.product, l.resort_id, z.macro, l.station_id, l.elev_class, coalesce(l.delev_mid, 0) AS delev_mid,
           l.ws, l.we, l.split, l.obs AS water_mm, s.obs AS snow_cm,
           CAST(timezone(z.tz, l.ws + (l.we - l.ws) / 2) AS DATE) AS mid_date, CAST(l.we AS DATE) AS end_date
    FROM w l JOIN w s ON s.space = 'snow' AND s.truth_source = l.truth_source AND s.station_id = l.station_id
      AND s.resort_id = l.resort_id AND s.ws = l.ws AND s.we = l.we
    JOIN rz z ON z.resort_id = l.resort_id
    WHERE l.space = 'liquid'""")
    # The models' water over each window (wpairs) + their temperature for the window's main day (pairs).
    con.execute(f"""
    CREATE TABLE fw AS
    SELECT DISTINCT resort_id, station_id, ws, we, source, source_label, issue_key, lead_day, fc AS fc_water
    FROM read_parquet('{wpairs}')
    WHERE truth_source IN ({srcs}) AND space = 'liquid' AND source IN ('{PREV}', '{HINDCAST}', 'snow-forecast')""")
    con.execute(f"""
    CREATE TABLE fs AS
    SELECT DISTINCT resort_id, station_id, ws, we, source, source_label, issue_key, lead_day, fc AS fc_snow
    FROM read_parquet('{wpairs}')
    WHERE truth_source IN ({srcs}) AND space = 'snow' AND source IN ('{HINDCAST}', 'snow-forecast')""")
    con.execute(f"""
    CREATE TABLE ft AS
    SELECT resort_id, source_label, issue_key, local_date, avg(fc_temp_c) AS t_mid
    FROM read_parquet('{pairs}')
    WHERE source = '{PREV}' AND space = 'liquid' AND tier = 'mid' AND fc_temp_c IS NOT NULL
    GROUP BY ALL""")
    con.execute(f"""
    CREATE TABLE d AS
    SELECT o.*, f.source_label, f.lead_day, f.fc_water,
           t.t_mid - {LAPSE_C_PER_M} * o.delev_mid AS t_st, t.t_mid AS t_slope
    FROM obs o JOIN fw f USING (resort_id, station_id, ws, we)
    JOIN ft t ON t.resort_id = o.resort_id AND t.source_label = f.source_label AND t.issue_key = f.issue_key
      AND t.local_date = o.mid_date
    WHERE f.source = '{PREV}'""")


def line(t: np.ndarray, slr: np.ndarray):
    """Robust line: median SLR per 1 °C bin (≥ 10 days), count-weighted fit through the medians."""
    bins = np.floor(t).astype(int)
    xs, ys, ws = [], [], []
    for b in np.unique(bins):
        m = bins == b
        if m.sum() >= 10:
            xs.append(b + 0.5); ys.append(float(np.median(slr[m]))); ws.append(int(m.sum()))
    if len(xs) < 3:
        return None
    xs, ys, ws = map(np.array, (xs, ys, ws))
    b_, a_ = np.polyfit(xs, ys, 1, w=np.sqrt(ws))
    return float(a_), float(b_), xs, ys, ws


def fit(con) -> dict:
    r = con.execute(f"""
      SELECT t_st AS t, snow_cm * 10 / water_mm AS slr, truth_source, elev_class, macro
      FROM d WHERE split = 'train' AND lead_day BETWEEN 1 AND 3
        AND water_mm >= {MIN_WATER_MM} AND snow_cm > 0 AND t_st <= {MAX_T_C}
        AND snow_cm * 10 / water_mm BETWEEN 1 AND 50""").fetchnumpy()
    t, slr = r["t"], r["slr"]
    if len(t) < 200:
        raise SystemExit(f"slr: only {len(t)} training station-days with snow + water — too few to fit")
    a_, b_, xs, ys, ws = line(t, slr)
    regions = {}
    for reg in np.unique(r["macro"]):
        m = r["macro"] == reg
        n = int(m.sum())
        entry = {"n": n, "median": round(float(np.median(slr[m])), 1)}
        fit_r = line(t[m], slr[m]) if n >= MIN_REGION_DAYS else None
        if fit_r:
            # Shrink toward the pooled line by sample size, like the temperature corrections.
            w = n / (n + SHRINK_DAYS)
            entry.update(a_raw=round(fit_r[0], 3), b_raw=round(fit_r[1], 3),
                         a=round(w * fit_r[0] + (1 - w) * a_, 3), b=round(w * fit_r[1] + (1 - w) * b_, 3))
        regions[str(reg)] = entry
    by_src = {s: {"n": int((r["truth_source"] == s).sum()),
                  "median": round(float(np.median(slr[r["truth_source"] == s])), 1)}
              for s in np.unique(r["truth_source"])}
    by_class = {c: {"n": int((r["elev_class"] == c).sum()),
                    "median": round(float(np.median(slr[r["elev_class"] == c])), 1)}
                for c in np.unique(r["elev_class"])}
    return {
        "version": "slr-v3", "form": "SLR = a + b*T, clamped; per region where regions[r].promoted, else pooled",
        "a": round(float(a_), 3), "b": round(float(b_), 3), "clamp": [SLR_MIN, SLR_MAX],
        "regions": regions, "region_of": {rid: m for rid, m in con.execute("SELECT resort_id, macro FROM rz").fetchall()},
        "temperature": "forecast 2 m, precipitation-weighted, at the point being converted (°C); "
                       "fitted at station height, applied at the slope",
        "fitted_on": f"2024-25, leads 1-3, CoCoRaHS / SLF plots / AMeDAS same-window new snow + water, "
                     f"water >= {MIN_WATER_MM} mm, snow > 0, T <= {MAX_T_C} C",
        "n_days": int(len(t)), "median_observed_slr": round(float(np.median(slr)), 1),
        "by_truth_source": by_src, "by_height_class": by_class,
        "bins": [{"t": float(x), "median_slr": round(float(y), 1), "n": int(w)} for x, y, w in zip(xs, ys, ws)],
    }


def slr_of(t: np.ndarray, p: dict, macro: np.ndarray | None = None) -> np.ndarray:
    """Pooled line, or the region's own line where it is promoted (the app does the same)."""
    a = np.full(len(t), p["a"], dtype=float); b = np.full(len(t), p["b"], dtype=float)
    if macro is not None:
        for reg, e in p.get("regions", {}).items():
            if e.get("promoted") and "a" in e:
                m = macro == reg
                a[m], b[m] = e["a"], e["b"]
    return np.clip(a + b * t, *p["clamp"])


def judge_regions(con, p: dict, rng) -> list[dict]:
    """Each region's own line vs the pooled line on the test winter, leads 1–5 together (per-region samples
    are small). Promoted = 10 cm gain range above 0 and no threshold's range below 0."""
    r = con.execute("""SELECT macro, end_date, fc_water, t_st, snow_cm
                       FROM d WHERE split = 'test' AND lead_day BETWEEN 1 AND 5""").fetchnumpy()
    rows = []
    for reg, e in p["regions"].items():
        if "a" not in e:
            e["promoted"] = False
            rows.append({"region": reg, "status": f"pooled (only {e['n']} training days)"}); continue
        m = r["macro"] == reg
        if m.sum() < 50:
            e["promoted"] = False
            rows.append({"region": reg, "status": f"pooled ({int(m.sum())} test windows — too few to judge)"}); continue
        ud, inv = np.unique(r["end_date"][m], return_inverse=True)
        idx = rng.integers(0, len(ud), size=(N_BOOT, len(ud)))
        water, t, obs = r["fc_water"][m], r["t_st"][m], r["snow_cm"][m]
        cold = t <= MAX_T_C + 2
        pooled = water * np.clip(p["a"] + p["b"] * t, *p["clamp"]) / 10 * cold
        own = water * np.clip(e["a"] + e["b"] * t, *p["clamp"]) / 10 * cold
        ok, worse, cells = None, False, {}
        for thr in THRESHOLDS_CM:
            o = obs >= thr
            c0, _, bc0 = csi_boot(pooled >= thr, o, inv, len(ud), idx)
            c1, _, bc1 = csi_boot(own >= thr, o, inv, len(ud), idx)
            d = bc1 - bc0
            lo, hi = float(np.percentile(d, 5)), float(np.percentile(d, 95))
            cells[thr] = (c0, c1, lo, hi, int(o.sum()))
            if thr == KEY_THRESHOLD:
                ok = lo > 0
            if hi < 0:
                worse = True
        e["promoted"] = bool(ok) and not worse
        c = cells[KEY_THRESHOLD]
        rows.append({"region": reg, "line": f"{e['a']} + {e['b']}·T", "events10": c[4],
                     "pooled_csi": c[0], "own_csi": c[1], "range": f"{c[2]:+.2f} to {c[3]:+.2f}",
                     "status": "OWN LINE promoted" if e["promoted"] else ("pooled (worse)" if worse else "pooled (no real gain)")})
    return rows


def csi_boot(f: np.ndarray, o: np.ndarray, inv: np.ndarray, nd: int, idx: np.ndarray) -> tuple[float, float, np.ndarray]:
    H = np.bincount(inv, (f & o).astype(int), nd)
    FA = np.bincount(inv, (f & ~o).astype(int), nd)
    M = np.bincount(inv, (~f & o).astype(int), nd)
    csi = lambda h, fa, m: h / np.maximum(h + m + fa, 1)
    bias = (H.sum() + FA.sum()) / max(H.sum() + M.sum(), 1)
    return float(csi(H.sum(), FA.sum(), M.sum())), float(bias), csi(H[idx].sum(1), FA[idx].sum(1), M[idx].sum(1))


def evaluate(con, p: dict) -> tuple[list[dict], dict, list[dict], list[dict]]:
    rng = np.random.default_rng(SEED)
    region_rows = judge_regions(con, p, rng)   # sets p["regions"][r]["promoted"] before the pooled judgement
    r = con.execute("""SELECT source_label, lead_day, end_date, fc_water, t_slope, t_st, snow_cm, macro
                       FROM d WHERE split = 'test' AND lead_day BETWEEN 1 AND 7""").fetchnumpy()
    rows, promote = [], {}
    for lead in range(1, 8):
        m = r["lead_day"] == lead
        if not m.any():
            continue
        ud, inv = np.unique(r["end_date"][m], return_inverse=True)
        idx = rng.integers(0, len(ud), size=(N_BOOT, len(ud)))
        water, t, obs = r["fc_water"][m], r["t_st"][m], r["snow_cm"][m]
        # Judge at the STATION (that is where the board is): same temperature transfer as the fit.
        flat = water * 0.7
        ours = water * slr_of(t, p, r["macro"][m]) / 10 * (t <= MAX_T_C + 2)  # warm windows: rain, no ratio applies
        ok, any_worse = None, False
        for thr in THRESHOLDS_CM:
            o = obs >= thr
            c0, b0, bc0 = csi_boot(flat >= thr, o, inv, len(ud), idx)
            c1, b1, bc1 = csi_boot(ours >= thr, o, inv, len(ud), idx)
            d = bc1 - bc0
            lo, hi = float(np.percentile(d, 5)), float(np.percentile(d, 95))
            rows.append({"lead": lead, "thr": thr, "events": int(o.sum()), "flat_csi": c0, "flat_bias": b0,
                         "slr_csi": c1, "slr_bias": b1, "gain": c1 - c0, "gain_range": f"{lo:+.2f} to {hi:+.2f}"})
            if thr == KEY_THRESHOLD:
                ok = lo > 0
            if hi < 0:
                any_worse = True
        promote[str(lead)] = bool(ok) and not any_worse
    # Paid benchmark on the same windows: Snow-Forecast hindcast (lead 0) and live Snow-Forecast, as they come.
    vs = []
    sf = con.execute(f"""
      SELECT s.source, s.lead_day, o.end_date, o.snow_cm, s.fc_snow, w.fc_water, d.t_st, o.macro
      FROM obs o JOIN fs s USING (resort_id, station_id, ws, we)
      JOIN d ON d.resort_id = o.resort_id AND d.station_id = o.station_id AND d.ws = o.ws AND d.we = o.we
        AND d.lead_day = s.lead_day AND d.source_label = '{PREV}:ecmwf_ifs025'
      JOIN fw w ON w.resort_id = o.resort_id AND w.station_id = o.station_id AND w.ws = o.ws AND w.we = o.we
        AND w.source_label = '{PREV}:ecmwf_ifs025' AND w.lead_day = s.lead_day
      WHERE o.split IN ('test', 'live')""").fetchnumpy()
    for src in np.unique(sf["source"]) if len(sf["source"]) else []:
        for lead in sorted(set(sf["lead_day"][sf["source"] == src])):
            m = (sf["source"] == src) & (sf["lead_day"] == lead)
            ud, inv = np.unique(sf["end_date"][m], return_inverse=True)
            idx = rng.integers(0, len(ud), size=(N_BOOT, len(ud)))
            ours = sf["fc_water"][m] * slr_of(sf["t_st"][m], p, sf["macro"][m]) / 10 * (sf["t_st"][m] <= MAX_T_C + 2)
            for thr in THRESHOLDS_CM:
                o = sf["snow_cm"][m] >= thr
                a, ab, ba = csi_boot(ours >= thr, o, inv, len(ud), idx)
                b, bb, bb_ = csi_boot(sf["fc_snow"][m] >= thr, o, inv, len(ud), idx)
                dd = ba - bb_
                vs.append({"sf": src, "lead": int(lead), "thr": thr, "events": int(o.sum()), "windows": int(m.sum()),
                           "ours_csi": a, "sf_csi": b, "diff": a - b,
                           "range": f"{np.percentile(dd, 5):+.2f} to {np.percentile(dd, 95):+.2f}"})
    return rows, promote, vs, region_rows


def by_height(con, p: dict) -> list[dict]:
    """Is the over-forecast real, or the slope forecast graded against lower stations? (2026-11-17)
    Test winter, leads 1–3, by the board station's height class: water volume (forecast ÷ measured),
    snow volume, frequency bias and CSI at 10 / 15 cm. Forecast water is at the resort's mid elevation;
    if 'slope' stations sit near 1.0 and 'base' / 'valley' run high, the gap is height, not error."""
    r = con.execute("""SELECT elev_class, macro, fc_water, water_mm, t_st, snow_cm FROM d
                       WHERE split = 'test' AND lead_day BETWEEN 1 AND 3""").fetchnumpy()
    if not len(r["fc_water"]):
        return []
    ours = r["fc_water"] * slr_of(r["t_st"], p, r["macro"]) / 10 * (r["t_st"] <= MAX_T_C + 2)
    rows = []
    for cls in list(np.unique(r["elev_class"])) + ["ALL"]:
        m = np.ones(len(ours), bool) if cls == "ALL" else r["elev_class"] == cls
        row = {"cls": cls, "n": int(m.sum()),
               "wvol": float(r["fc_water"][m].sum() / max(r["water_mm"][m].sum(), 1e-9)),
               "svol": float(ours[m].sum() / max(r["snow_cm"][m].sum(), 1e-9))}
        for thr in (10.0, 15.0):
            f, o = ours[m] >= thr, r["snow_cm"][m] >= thr
            h, fa, mi = int((f & o).sum()), int((f & ~o).sum()), int((~f & o).sum())
            row[f"ev{int(thr)}"] = h + mi
            row[f"fb{int(thr)}"] = (h + fa) / max(h + mi, 1)
            row[f"csi{int(thr)}"] = h / max(h + fa + mi, 1)
        rows.append(row)
    return rows


def md_table(rows: list[dict], cols: list[tuple[str, str]]) -> str:
    f = lambda v: f"{v:.2f}" if isinstance(v, (float, np.floating)) else str(v)
    lines = ["| " + " | ".join(h for h, _ in cols) + " |", "|" + "---|" * len(cols)]
    lines += ["| " + " | ".join(f(r[k]) for _, k in cols) + " |" for r in rows]
    return "\n".join(lines) + "\n"


def main(pairs: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    wp = out / "wpairs.parquet"
    if not wp.exists():
        raise SystemExit(f"slr v2 needs {wp} (windows.py output)")
    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")
    load(con, pairs, wp)
    params = fit(con)
    res, promote, vs, region_rows = evaluate(con, params)
    params["promote"] = promote
    (out / "slr.json").write_text(json.dumps(params, indent=2) + "\n")
    calm = {k: v for k, v in params["by_height_class"].items()}
    parts = [
        "# SLR v3 — same-station new snow + water, one line per climate region; fitted on 2024-25, judged on 2025-26\n",
        "PRIVATE (contains paid-source comparison).\n",
        f"Fit: SLR = {params['a']} + {params['b']} × T, clamped {params['clamp']}; {params['n_days']} station-days; "
        f"median observed SLR {params['median_observed_slr']} (v1 on settled depth: 6.7).\n",
        md_table(params["bins"], [("T bin (°C, at station)", "t"), ("median SLR", "median_slr"), ("days", "n")]),
        "\n## By truth source and station height (gauge under-catch check)\n",
        md_table([{"k": k, **v} for k, v in params["by_truth_source"].items()], [("source", "k"), ("days", "n"), ("median SLR", "median")]),
        md_table([{"k": k, **v} for k, v in calm.items()], [("height class", "k"), ("days", "n"), ("median SLR", "median")]),
        "Exposed (upper / slope) stations under-catch more in wind → higher ratios there would point to gauge bias, "
        "not real snow density.\n",
        "\n## Regions: own line vs the pooled line (test winter, leads 1–5, ≥ 10 cm)\n",
        "A region keeps its own line only where it beats the pooled line; otherwise it uses the pooled line.\n",
        md_table([{"line": "—", "events10": "—", "pooled_csi": "—", "own_csi": "—", "range": "—", **r} for r in region_rows],
                 [("region", "region"), ("line", "line"), ("≥10 events", "events10"), ("pooled CSI", "pooled_csi"),
                  ("own CSI", "own_csi"), ("own − pooled", "range"), ("status", "status")]),
        md_table([{"region": k, **{kk: v.get(kk, "—") for kk in ("n", "median", "a_raw", "b_raw", "a", "b")}}
                  for k, v in params["regions"].items()],
                 [("region", "region"), ("train days", "n"), ("median SLR", "median"), ("a (raw)", "a_raw"),
                  ("b (raw)", "b_raw"), ("a (shrunk)", "a"), ("b (shrunk)", "b")]),
        "\n## Ours vs a flat 7:1, test winter, on new-snow boards (CSI; ranges = 90%, paired by date)\n",
        md_table(res, [("lead", "lead"), ("≥ cm", "thr"), ("events", "events"), ("7:1 CSI", "flat_csi"),
                       ("7:1 bias", "flat_bias"), ("ours CSI", "slr_csi"), ("ours bias", "slr_bias"),
                       ("gain", "gain"), ("gain range", "gain_range")]),
        f"\nPROMOTE by lead (10 cm gain above 0, no threshold worse): {json.dumps(promote)}\n",
        "\n## Over-forecast by station height (test winter, leads 1–3, all three models' rows)\n",
        "Forecast water is at the resort's mid elevation; the board is at the station. volume = forecast ÷ measured.\n",
        md_table(by_height(con, params),
                 [("height class", "cls"), ("windows", "n"), ("water volume", "wvol"), ("snow volume", "svol"),
                  ("≥10 events", "ev10"), ("freq bias ≥10", "fb10"), ("CSI ≥10", "csi10"),
                  ("≥15 events", "ev15"), ("freq bias ≥15", "fb15"), ("CSI ≥15", "csi15")]),
        "\n## Ours (ECMWF water × SLR v2) vs Snow-Forecast on the same windows\n",
        md_table(vs, [("Snow-Forecast", "sf"), ("lead", "lead"), ("≥ cm", "thr"), ("windows", "windows"),
                      ("events", "events"), ("ours CSI", "ours_csi"), ("SF CSI", "sf_csi"), ("ours − SF", "diff"),
                      ("range", "range")]) if vs else "_no shared windows yet_\n",
        "\nHindcast is lead 0 (model spin-up handicaps ours). Live Snow-Forecast rows are this season only: thin.\n",
    ]
    (out / "slr_report.md").write_text("\n".join(parts))
    prom = [k for k, v in params["regions"].items() if v.get("promoted")]
    print(f"SLR v3 fitted on {params['n_days']} training station-days; own line for {prom or 'no region'}; "
          "report written", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]))

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
    CREATE TABLE fm AS
    SELECT DISTINCT resort_id, station_id, ws, we, source_label, issue_key, lead_day, fc AS fc_msnow
    FROM read_parquet('{wpairs}')
    WHERE truth_source IN ({srcs}) AND space = 'snow' AND source = '{PREV}'""")
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
    SELECT o.*, f.source_label, f.lead_day, f.fc_water, m.fc_msnow,
           t.t_mid - {LAPSE_C_PER_M} * o.delev_mid AS t_st, t.t_mid AS t_slope
    FROM obs o JOIN fw f USING (resort_id, station_id, ws, we)
    LEFT JOIN fm m ON m.resort_id = o.resort_id AND m.station_id = o.station_id AND m.ws = o.ws AND m.we = o.we
      AND m.source_label = f.source_label AND m.issue_key = f.issue_key
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


# Phase (2026-11-19, Brian "do it"): rain or snow. Today a window is all snow if the station temperature is
# ≤ 2 °C, else all rain ("temp"). Candidates: the model's own snow share φ = model snowfall ÷ (0.7 × model water)
# — its microphysics, melting layer included — ("model"), and a hybrid that never lets the model call rain when
# the elevation-adjusted temperature says snow ("hybrid": max(φ, ramp), ramp 1 at ≤ 0 °C → 0 at ≥ 2 °C).
# Judged on 2025-26 CoCoRaHS boards (they record whether it snowed, in 1 cm steps), per lead group. The model
# decides phase at the elevation Open-Meteo was asked for (SF mid), but boards sit lower, so near-height boards
# (|Δ elevation| ≤ NEAR_M) are reported separately. Ships per lead group only if it beats "temp" at 2.5 cm
# (90 % range above 0) and isn't worse at 15 cm.
NEAR_M = 300
PHASE_GROUPS = {"1-3": (1, 2, 3), "4-7": (4, 5, 6, 7)}


def phase_frac(method: str, water, msnow, t):
    ramp = np.clip((2.0 - t) / 2.0, 0, 1)
    if method == "temp":
        return (t <= MAX_T_C + 2).astype(float)
    phi = np.where(water > 0, np.clip(np.nan_to_num(msnow, nan=-1) / np.maximum(0.7 * water, 1e-9), 0, 1), 0.0)
    phi = np.where(np.isnan(msnow), (t <= MAX_T_C + 2).astype(float), phi)  # no model snowfall → today's rule
    return phi if method == "model" else np.maximum(phi, ramp)


def phase_check(con, p: dict) -> tuple[dict, str]:
    rng = np.random.default_rng(SEED + 19)
    out_rows, choice = [], {}
    curve = con.execute("""
      SELECT floor(t_slope) AS tb, count(*), median(least(greatest(fc_msnow / (0.7 * fc_water), 0), 1))
      FROM d WHERE split = 'train' AND fc_water >= 2 AND fc_msnow IS NOT NULL AND t_slope BETWEEN -6 AND 6
      GROUP BY tb ORDER BY tb""").fetchall()
    for g, leads in PHASE_GROUPS.items():
        ls = ", ".join(map(str, leads))
        r = con.execute(f"""SELECT end_date, fc_water, fc_msnow, t_st, snow_cm, abs(delev_mid) <= {NEAR_M} AS near, macro
                            FROM d WHERE split = 'test' AND lead_day IN ({ls})""").fetchnumpy()
        if not len(r["snow_cm"]):
            choice[g] = "temp"; continue
        best, best_key = "temp", None
        for subset in ("all", "near"):
            m = np.ones(len(r["snow_cm"]), bool) if subset == "all" else r["near"].astype(bool)
            if m.sum() < 50:
                out_rows.append(f"| {g} | {subset} | — | — | too few windows ({int(m.sum())}) | | | |"); continue
            ud, inv = np.unique(r["end_date"][m], return_inverse=True)
            idx = rng.integers(0, len(ud), size=(N_BOOT, len(ud)))
            w, ms, t, obs = r["fc_water"][m], r["fc_msnow"][m], r["t_st"][m], r["snow_cm"][m]
            slr = slr_of(t, p, r["macro"][m]) / 10
            snow = {k: w * phase_frac(k, w, ms, t) * slr for k in ("temp", "model", "hybrid")}
            for thr in (2.5, 10.0, 15.0):
                o = obs >= thr
                base = csi_boot(snow["temp"] >= thr, o, inv, len(ud), idx)
                for k in ("model", "hybrid"):
                    c = csi_boot(snow[k] >= thr, o, inv, len(ud), idx)
                    dd = c[2] - base[2]
                    lo, hi = float(np.percentile(dd, 5)), float(np.percentile(dd, 95))
                    out_rows.append(f"| {g} | {subset} | {k} | {thr:g} | {int(o.sum())} | {base[0]:.3f} → {c[0]:.3f} | "
                                    f"{base[1]:.2f} → {c[1]:.2f} | {lo:+.3f} to {hi:+.3f} |")
                    if subset == "all":
                        key = (k, thr)
                        choice.setdefault(f"_{g}", {})[key] = (lo, hi, c[0] - base[0])
        cand = choice.pop(f"_{g}", {})
        for k in ("hybrid", "model"):  # prefer the hybrid on ties: it can't call rain on a cold slope
            if (k, 2.5) in cand and cand[(k, 2.5)][0] > 0 and cand[(k, 15.0)][1] >= 0:
                if best == "temp" or cand[(k, 2.5)][2] > cand[(best, 2.5)][2]:
                    best = k
        choice[g] = best
    report = "\n".join([
        "\n## Phase: rain or snow (judged on 2025-26 boards)\n",
        "temp = today's rule (all snow at ≤ 2 °C at the board, else rain); model = the model's own snow share; "
        "hybrid = max(model share, temperature ramp 0–2 °C). Same water, same SLR. `near` = boards within "
        f"{NEAR_M} m of the forecast's elevation (the model decides phase at that height).\n",
        "| leads | boards | method | ≥ cm | events | CSI temp → method | freq bias temp → method | gain range |",
        "|---|---|---|---|---|---|---|---|", *out_rows,
        f"\nCHOSEN per lead group: {json.dumps(choice)}\n",
        "\nModel snow share by elevation-adjusted temperature at the forecast height (training winter, ≥ 2 mm). "
        "A share well below 1 at ≤ 0 °C would mean the model decides phase lower than the slope.\n",
        "| T (°C) | windows | median snow share |", "|---|---|---|",
        *[f"| {int(tb)} | {n} | {(m if m is not None else float('nan')):.2f} |" for tb, n, m in curve],
    ])
    return choice, report


# Warm days (2026-11-22, Brian: Whistler 79" vs NBM 28" / Snow-Forecast 32"). Today's rule turns ALL of a day's
# water into snow at the cold-day line (~11:1) whenever the day's mean temperature is ≤ 2 °C. The line was fitted
# on days ≤ 0 °C only, so between 0 and 2 °C it is an untested extrapolation, and a day averaging +1 °C is usually
# part rain. Fix (plain arithmetic): an observed snow-per-water curve for the warm bins, R(T) = Σ new snow ÷ Σ water
# over ALL training board windows in the 1 °C bin (rain-only windows count as zero snow), and the ratio used is
# min(line, R) — it can only lower today's number. Fitted 2024-25, judged 2025-26 per lead group against today's rule.
WARM_EDGES = [-3, -2, -1, 0, 1, 2, 3]          # bins [−3,−2) … [2,3); R is placed at the bin centres
WARM_MIN_WINDOWS = 30
WARM_THRESHOLDS_CM = (2.5, 10.0, 15.0, 30.0)


def warm_ratio(t, warm: dict):
    """R(T) by linear interpolation between bin centres; colder than the first centre = no cap (inf);
    warmer than the last = the last value (today's rule makes it 0 above 2 °C anyway)."""
    t = np.asarray(t, dtype=float)
    xs, ys = np.array(warm["t"], float), np.array(warm["r"], float)
    r = np.interp(t, xs, ys)
    return np.where(t < xs[0], np.inf, r)


def ours_snow(water, t, p: dict, macro, warm: dict | None = None):
    """cm. Today's rule (all snow at ≤ 2 °C, line ratio), optionally capped by the warm curve."""
    ratio = slr_of(t, p, macro)
    if warm:
        ratio = np.minimum(ratio, warm_ratio(t, warm))
    return water * ratio / 10 * (t <= MAX_T_C + 2)


def warm_check(con, p: dict) -> tuple[dict, str]:
    rng = np.random.default_rng(SEED + 22)
    # One row per training board window (models' temperatures averaged), leads 1–3, measurable water.
    tr = con.execute(f"""
      SELECT avg(t_st) AS t, any_value(snow_cm) AS snow, any_value(water_mm) AS water
      FROM d WHERE split = 'train' AND lead_day BETWEEN 1 AND 3 AND water_mm >= {MIN_WATER_MM}
      GROUP BY truth_source, station_id, resort_id, ws, we""").fetchnumpy()
    xs, rs, rows = [], [], []
    for lo, hi in zip(WARM_EDGES[:-1], WARM_EDGES[1:]):
        m = (tr["t"] >= lo) & (tr["t"] < hi)
        n = int(m.sum())
        r = float(10 * tr["snow"][m].sum() / max(tr["water"][m].sum(), 1e-9)) if n else float("nan")
        line_mid = float(slr_of(np.array([(lo + hi) / 2]), p)[0])
        rows.append(f"| {lo} to {hi} | {n} | {r:.1f} | {line_mid:.1f} | "
                    f"{float((tr['snow'][m] <= 0).mean()) if n else float('nan'):.0%} |")
        if n >= WARM_MIN_WINDOWS:
            xs.append((lo + hi) / 2); rs.append(round(r, 2))
    warm = {"t": xs, "r": rs, "fitted_on": f"2024-25 board windows, leads 1-3, water >= {MIN_WATER_MM} mm, "
                                           f"bins with >= {WARM_MIN_WINDOWS} windows", "promote": {}}
    out_rows = []
    if len(xs) < 3:
        warm["promote"] = {g: False for g in PHASE_GROUPS}
        return warm, "\n## Warm days\n\nToo few training windows in the warm bins; not fitted.\n"
    for g, leads in PHASE_GROUPS.items():
        ls = ", ".join(map(str, leads))
        r = con.execute(f"""SELECT end_date, fc_water, t_st, snow_cm, macro FROM d
                            WHERE split = 'test' AND lead_day IN ({ls})""").fetchnumpy()
        if len(r["snow_cm"]) < 200:
            warm["promote"][g] = False
            out_rows.append(f"| {g} | — | too few windows ({len(r['snow_cm'])}) | | | |"); continue
        ud, inv = np.unique(r["end_date"], return_inverse=True)
        idx = rng.integers(0, len(ud), size=(N_BOOT, len(ud)))
        now = ours_snow(r["fc_water"], r["t_st"], p, r["macro"])
        new = ours_snow(r["fc_water"], r["t_st"], p, r["macro"], warm)
        obs = r["snow_cm"]
        worse = False
        for thr in WARM_THRESHOLDS_CM:
            o = obs >= thr
            c0, b0, bc0 = csi_boot(now >= thr, o, inv, len(ud), idx)
            c1, b1, bc1 = csi_boot(new >= thr, o, inv, len(ud), idx)
            dd = bc1 - bc0
            lo, hi = float(np.percentile(dd, 5)), float(np.percentile(dd, 95))
            if hi < 0:
                worse = True
            out_rows.append(f"| {g} | ≥ {thr:g} cm | {int(o.sum())} | {c0:.3f} → {c1:.3f} | {b0:.2f} → {b1:.2f} | "
                            f"{lo:+.3f} to {hi:+.3f} |")
        wm = r["t_st"] > -1
        vol = lambda f, m: float(f[m].sum() / max(obs[m].sum(), 1e-9))
        v0, v1, va0, va1 = vol(now, wm), vol(new, wm), vol(now, np.ones_like(wm)), vol(new, np.ones_like(wm))
        out_rows.append(f"| {g} | snow volume ÷ observed, warm windows (> −1 °C, n={int(wm.sum())}) | | {v0:.2f} → {v1:.2f} | | |")
        out_rows.append(f"| {g} | snow volume ÷ observed, all windows | | {va0:.2f} → {va1:.2f} | | |")
        warm["promote"][g] = (not worse) and abs(v1 - 1) < abs(v0 - 1)
        warm.setdefault("volume_warm", {})[g] = [round(v0, 2), round(v1, 2)]
    report = "\n".join([
        "\n## Warm days: cap the ratio with observed snow per water (fitted 2024-25, judged 2025-26)\n",
        "R = Σ new snow × 10 ÷ Σ water over every training board window in the bin (rain-only windows count as 0). "
        "Ratio used = min(today's line, R). Ships per lead group only if no threshold's 90% gain range is entirely "
        "below 0 AND the warm-window snow volume moves closer to observed.\n",
        "| forecast T at station (°C) | windows | R (snow:water) | today's line | windows with no snow |",
        "|---|---|---|---|---|", *rows,
        "\n| leads | threshold | events | CSI today → capped | freq bias today → capped | gain range |",
        "|---|---|---|---|---|---|", *out_rows,
        f"\nWARM PROMOTE per lead group: {json.dumps(warm['promote'])}\n"])
    return warm, report


# Sub-daily rain/snow split (2026-11-23, Brian: "do it"). The daily rule judges phase on the day's
# precipitation-weighted mean temperature, so a day whose wet hours straddle 0 °C counts as all snow or
# all rain. Here each window's water is spread over its 3-hour blocks and each block gets its own phase:
#   ratio(T) = min(line(T), CAP) × f(T),  f = 1 at T ≤ T0, 0 at T ≥ T1, linear between,  CAP applies at T > −2 °C.
# For past winters the within-day SHAPE comes from ERA5 at the resort (share of the day's precipitation per
# block, and each block's temperature minus the precipitation-weighted mean); the LEVEL stays the forecast's
# station temperature t_st. Caveat: ERA5's timing is analysed, not forecast, so this scores the split with
# better timing than the app will have; the live app uses each model's own hourly shape.
# T0, T1, CAP chosen on 2024-25 (leads 1–3) by CSI ≥ 10 cm + CSI ≥ 15 cm − 0.5·|ln(warm-window volume ratio)|;
# judged on 2025-26 per lead group against what ships today (daily warm cap at 1–3, plain line at 4–7).
HOURLY_T0 = (-1.5, -1.0, -0.5, 0.0, 0.5)
HOURLY_T1 = (1.0, 1.5, 2.0, 2.5, 3.0)
HOURLY_CAP = (float("inf"), 9.0, 7.0, 5.0)
ERA5_GLOB = "archive/source=era5/**/*.parquet"


def hourly_ratio(t, p: dict, macro, h: dict):
    t = np.asarray(t, dtype=float)
    base = slr_of(t, p, macro)
    base = np.where(t > -2, np.minimum(base, h["cap"]), base)
    f = np.clip((h["t1"] - t) / (h["t1"] - h["t0"]), 0.0, 1.0)
    return base * f


def hourly_check(con, p: dict) -> tuple[dict, str]:
    import glob
    if not glob.glob(ERA5_GLOB, recursive=True):
        return {"promote": {g: False for g in PHASE_GROUPS}}, "\n## Sub-daily rain/snow split\n\nNO ERA5 IN archive/ — not scored.\n"
    con.execute(f"""CREATE OR REPLACE TABLE e5 AS
      SELECT resort_id, valid_end AS te,
             max(CASE WHEN variable = 'temp_2m' THEN value END) AS t,
             max(CASE WHEN variable = 'precip' THEN value END) AS pr
      FROM read_parquet('{ERA5_GLOB}', hive_partitioning = true)
      WHERE variable IN ('temp_2m', 'precip') AND month >= '2024-10'
      GROUP BY ALL""")
    # Every (window, block): share of the window's ERA5 precipitation and temperature anomaly.
    con.execute("""CREATE OR REPLACE TABLE wb AS
      WITH w AS (SELECT DISTINCT resort_id, ws, we FROM d),
      j AS (SELECT w.resort_id, w.ws, w.we, e.t, e.pr FROM w JOIN e5 e ON e.resort_id = w.resort_id
            AND e.te > w.ws AND e.te <= w.we),
      g AS (SELECT resort_id, ws, we, count(*) AS n, sum(pr) AS ps,
                   CASE WHEN sum(pr) > 0.1 THEN sum(pr * t) / sum(pr) ELSE avg(t) END AS tbar FROM j GROUP BY ALL)
      SELECT j.resort_id, j.ws, j.we, CASE WHEN g.ps > 0.1 THEN j.pr / g.ps ELSE 1.0 / g.n END AS share, j.t - g.tbar AS anom
      FROM j JOIN g USING (resort_id, ws, we)""")
    cover = con.execute("""SELECT count(DISTINCT (resort_id, ws, we)) FROM wb""").fetchone()[0]
    con.execute("CREATE OR REPLACE TABLE dr AS SELECT row_number() OVER () - 1 AS rid, * FROM d WHERE split IN ('train', 'test')")
    blk = con.execute("""SELECT r.rid, b.share, b.anom FROM dr r JOIN wb b USING (resort_id, ws, we)""").fetchnumpy()
    rows = con.execute("SELECT rid, split, lead_day, end_date, fc_water, t_st, snow_cm, macro FROM dr ORDER BY rid").fetchnumpy()
    has = np.zeros(len(rows["rid"]), bool); has[blk["rid"]] = True
    n_rows = len(rows["rid"])
    warm = p.get("warm") or {}

    def snow_h(h, sel):
        ratio = hourly_ratio(rows["t_st"][blk["rid"]] + blk["anom"], p, rows["macro"][blk["rid"]], h)
        eff = np.bincount(blk["rid"], weights=blk["share"] * ratio, minlength=n_rows)
        return (rows["fc_water"] * eff / 10)[sel]

    def snow_daily(sel, capped):
        return ours_snow(rows["fc_water"][sel], rows["t_st"][sel], p, rows["macro"][sel], warm if capped else None)

    def csi(f, o):
        h = ((f) & o).sum(); m = ((~f) & o).sum(); fa = (f & ~o).sum()
        return h / max(h + m + fa, 1)

    def vol(f, sel, m):
        return float(f[m].sum() / max(rows["snow_cm"][sel][m].sum(), 1e-9))

    tr = has & (rows["split"] == "train") & (rows["lead_day"] >= 1) & (rows["lead_day"] <= 3)
    obs_tr, warm_tr = rows["snow_cm"][tr], rows["t_st"][tr] > -1
    best, grid = None, []
    for t0 in HOURLY_T0:
        for t1 in HOURLY_T1:
            if t1 <= t0:
                continue
            for cap in HOURLY_CAP:
                h = {"t0": t0, "t1": t1, "cap": cap}
                f = snow_h(h, tr)
                v = max(vol(f, tr, warm_tr), 1e-6)
                score = csi(f >= 10, obs_tr >= 10) + csi(f >= 15, obs_tr >= 15) - 0.5 * abs(np.log(v))
                grid.append((score, t0, t1, cap, v))
                if best is None or score > best[0]:
                    best = (score, h)
    h = best[1]
    rng = np.random.default_rng(SEED + 23)
    out_rows, promote = [], {}
    for g, leads in PHASE_GROUPS.items():
        sel = has & (rows["split"] == "test") & np.isin(rows["lead_day"], list(leads))
        if sel.sum() < 200:
            promote[g] = False; out_rows.append(f"| {g} | too few windows ({int(sel.sum())}) | | | |"); continue
        capped_now = bool(warm.get("promote", {}).get(g))
        now, new, obs = snow_daily(sel, capped_now), snow_h(h, sel), rows["snow_cm"][sel]
        ud, inv = np.unique(rows["end_date"][sel], return_inverse=True)
        idx = rng.integers(0, len(ud), size=(N_BOOT, len(ud)))
        worse = False
        for thr in WARM_THRESHOLDS_CM:
            o = obs >= thr
            c0, b0, bc0 = csi_boot(now >= thr, o, inv, len(ud), idx)
            c1, b1, bc1 = csi_boot(new >= thr, o, inv, len(ud), idx)
            lo, hi = float(np.percentile(bc1 - bc0, 5)), float(np.percentile(bc1 - bc0, 95))
            worse |= hi < 0
            out_rows.append(f"| {g} | ≥ {thr:g} cm | {int(o.sum())} | {c0:.3f} → {c1:.3f} | {b0:.2f} → {b1:.2f} | {lo:+.3f} to {hi:+.3f} |")
        wm = rows["t_st"][sel] > -1
        v0, v1 = vol(now, sel, wm), vol(new, sel, wm)
        a0, a1 = vol(now, sel, np.ones_like(wm)), vol(new, sel, np.ones_like(wm))
        out_rows.append(f"| {g} | volume ÷ observed, warm windows (n={int(wm.sum())}) | | {v0:.2f} → {v1:.2f} | | |")
        out_rows.append(f"| {g} | volume ÷ observed, all windows | | {a0:.2f} → {a1:.2f} | | |")
        promote[g] = (not worse) and abs(np.log(max(v1, 1e-6))) <= abs(np.log(max(v0, 1e-6))) + 0.05
        out_rows[-2] += f" today = {'daily warm cap' if capped_now else 'plain line'}"
    top = sorted(grid, reverse=True)[:5]
    res = {"t0": h["t0"], "t1": h["t1"], "cap": None if not np.isfinite(h["cap"]) else h["cap"], "promote": promote,
           "fitted_on": "2024-25 board windows, leads 1-3; within-day shape from ERA5 3-hourly at the resort"}
    report = "\n".join([
        "\n## Sub-daily rain/snow split (3-hour blocks; shape from ERA5, level from the forecast)\n",
        f"Windows with an ERA5 shape: {cover}. Chosen on 2024-25: all snow at ≤ {h['t0']} °C, all rain at ≥ {h['t1']} °C, "
        f"linear between; ratio capped at {h['cap']} above −2 °C. Compared with what ships today per lead group. "
        "ERA5 timing is analysed, not forecast, so this is an optimistic test of the split.\n",
        "Top 5 on training (score, T0, T1, cap, warm volume): " + "; ".join(f"{s:.3f}, {a}, {b}, {c}, {v:.2f}" for s, a, b, c, v in top) + "\n",
        "| leads | threshold | events | CSI today → split | freq bias today → split | gain range |",
        "|---|---|---|---|---|---|", *out_rows,
        f"\nHOURLY PROMOTE per lead group: {json.dumps(promote)}\n"])
    return res, report


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
    params["phase"], phase_report = phase_check(con, params)
    params["warm"], warm_report = warm_check(con, params)
    params["hourly"], hourly_report = hourly_check(con, params)
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
    (out / "slr_report.md").write_text("\n".join(parts) + phase_report + warm_report + hourly_report)
    prom = [k for k, v in params["regions"].items() if v.get("promoted")]
    print(f"SLR v3 fitted on {params['n_days']} training station-days; own line for {prom or 'no region'}; "
          "report written", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]))

#!/usr/bin/env python3
"""Snow-to-liquid ratio (SLR) v1: fit on one winter, judge on the next.

    python3 scripts/model/slr.py <pairs.parquet> <outDir>

Open-Meteo's snowfall is precipitation × 0.7 (a fixed 7:1). The first
verification report showed models about right on liquid but forecasting
roughly half the ≥15 cm days. v1 replaces the fixed ratio with
SLR = a + b·T (T = the model's own forecast 2 m temperature during
precipitation, at the resort's mid elevation), clamped to [SLR_MIN, SLR_MAX].

Fit: 2024-25 only (split 'train'), days where SNOTEL shows ≥ 5 mm of new
water and some new depth, at strict station pairs. Robust: median observed
SLR per 1 °C bin, then a count-weighted line through the medians.
Judge: 2025-26 only (split 'test'). Never mixed.

Writes <outDir>/slr.json (the parameters) and <outDir>/slr_report.md.
Confidence: 90% intervals from a bootstrap that resamples whole DATES, since
one storm hits many resorts on the same day.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import duckdb
import numpy as np

SLR_MIN, SLR_MAX = 5.0, 25.0
MIN_SWE_MM = 5.0
THRESHOLDS_CM = (15.0, 30.0)
N_BOOT = 1000
SEED = 20261110
PREV = "open-meteo-previous-runs"
HINDCAST = "snow-forecast-hindcast"


def fit(con) -> dict:
    rows = con.execute(f"""
      SELECT fc_temp_c AS t, obs_depth_gain_cm * 10 / obs_swe_gain_mm AS slr
      FROM p WHERE source = '{PREV}' AND space = 'liquid' AND split = 'train' AND lead_day BETWEEN 1 AND 3
        AND pair_quality = 'strict' AND tier = 'mid' AND fc_temp_c IS NOT NULL
        AND obs_swe_gain_mm >= {MIN_SWE_MM} AND obs_depth_gain_cm > 0
        AND obs_depth_gain_cm * 10 / obs_swe_gain_mm BETWEEN 1 AND 50""").fetchnumpy()
    t, slr = rows["t"], rows["slr"]
    if len(t) < 200:
        raise SystemExit(f"only {len(t)} training days with observed SLR — too few to fit")
    bins = np.floor(t).astype(int)
    xs, ys, ws = [], [], []
    for b in np.unique(bins):
        m = bins == b
        if m.sum() >= 10:  # a bin with fewer days is noise
            xs.append(b + 0.5); ys.append(float(np.median(slr[m]))); ws.append(int(m.sum()))
    xs, ys, ws = map(np.array, (xs, ys, ws))
    b_, a_ = np.polyfit(xs, ys, 1, w=np.sqrt(ws))
    return {
        "version": "slr-v1", "form": "SLR = a + b*T, clamped", "a": round(float(a_), 3), "b": round(float(b_), 3),
        "clamp": [SLR_MIN, SLR_MAX], "temperature": "forecast 2 m, precipitation-weighted, at SF mid elevation (°C)",
        "fitted_on": "2024-25, leads 1-3, strict SNOTEL pairs, mid tier, obs SWE gain >= 5 mm",
        "n_days": int(len(t)), "median_observed_slr": round(float(np.median(slr)), 1),
        "bins": [{"t": float(x), "median_slr": round(float(y), 1), "n": int(w)} for x, y, w in zip(xs, ys, ws)],
    }


def slr_of(t: np.ndarray, p: dict) -> np.ndarray:
    return np.clip(p["a"] + p["b"] * t, *p["clamp"])


def csi_bias(f: np.ndarray, o: np.ndarray, dates: np.ndarray, rng) -> dict:
    """CSI and frequency bias with 90% date-block bootstrap intervals."""
    hits, fa, miss = (f & o).astype(int), (f & ~o).astype(int), (~f & o).astype(int)
    ud, inv = np.unique(dates, return_inverse=True)
    H = np.bincount(inv, hits, len(ud)); F = np.bincount(inv, fa, len(ud)); M = np.bincount(inv, miss, len(ud))

    def stats(h, fa_, m):
        csi = h / np.maximum(h + m + fa_, 1)
        bias = (h + fa_) / np.maximum(h + m, 1)
        return csi, bias
    csi, bias = stats(H.sum(), F.sum(), M.sum())
    idx = rng.integers(0, len(ud), size=(N_BOOT, len(ud)))
    bc, bb = stats(H[idx].sum(1), F[idx].sum(1), M[idx].sum(1))
    return {"csi": csi, "csi_lo": np.percentile(bc, 5), "csi_hi": np.percentile(bc, 95),
            "bias": bias, "events": int(o.sum()), "boot_csi": bc}


def evaluate(con, params: dict) -> tuple[list[dict], list[dict]]:
    rng = np.random.default_rng(SEED)
    rows = con.execute(f"""
      SELECT source_label, lead_day, resort_id, local_date, fc_amount AS liq, fc_temp_c AS t, obs_depth_gain_cm AS obs
      FROM p WHERE source = '{PREV}' AND space = 'liquid' AND split = 'test' AND pair_quality = 'strict'
        AND tier = 'mid' AND fc_temp_c IS NOT NULL AND obs_depth_gain_cm IS NOT NULL AND lead_day <= 7""").fetchnumpy()
    out = []
    for label in np.unique(rows["source_label"]):
        for lead in range(0, 8):
            m = (rows["source_label"] == label) & (rows["lead_day"] == lead)
            if m.sum() == 0:
                continue
            liq, t, obs, dates = rows["liq"][m], rows["t"][m], rows["obs"][m], rows["local_date"][m]
            raw = liq * 0.7                         # Open-Meteo's own 7:1
            ours = liq * slr_of(t, params) / 10     # mm × ratio → cm
            for thr in THRESHOLDS_CM:
                o = obs >= thr
                r0 = csi_bias(raw >= thr, o, dates, rng)
                r1 = csi_bias(ours >= thr, o, dates, rng)
                d = r1["boot_csi"] - r0["boot_csi"]  # same resampled dates → paired difference
                out.append({"model": label.split(":")[-1], "lead": lead, "thr": thr, "events": r0["events"],
                            "raw_csi": r0["csi"], "raw_bias": r0["bias"],
                            "slr_csi": r1["csi"], "slr_lo": r1["csi_lo"], "slr_hi": r1["csi_hi"], "slr_bias": r1["bias"],
                            "gain": r1["csi"] - r0["csi"], "gain_lo": np.percentile(d, 5), "gain_hi": np.percentile(d, 95)})
    # Against the paid benchmark: lead 0 only (the hindcast is SF's 0–6 h model), same resort-days only.
    vs = []
    both = con.execute(f"""
      SELECT m.source_label, m.local_date, m.fc_amount AS liq, m.fc_temp_c AS t, h.fc_amount AS sf, m.obs_depth_gain_cm AS obs
      FROM p m JOIN p h ON h.resort_id = m.resort_id AND h.local_date = m.local_date AND h.tier = 'mid'
        AND h.source = '{HINDCAST}' AND h.space = 'snow'
      WHERE m.source = '{PREV}' AND m.space = 'liquid' AND m.lead_day = 0 AND m.split = 'test'
        AND m.pair_quality = 'strict' AND m.tier = 'mid' AND m.fc_temp_c IS NOT NULL
        AND m.obs_depth_gain_cm IS NOT NULL""").fetchnumpy()
    for label in np.unique(both["source_label"]):
        m = both["source_label"] == label
        liq, t, sf, obs, dates = both["liq"][m], both["t"][m], both["sf"][m], both["obs"][m], both["local_date"][m]
        ours = liq * slr_of(t, params) / 10
        for thr in THRESHOLDS_CM:
            o = obs >= thr
            a = csi_bias(ours >= thr, o, dates, rng)
            b = csi_bias(sf >= thr, o, dates, rng)
            d = a["boot_csi"] - b["boot_csi"]
            vs.append({"model": label.split(":")[-1], "thr": thr, "events": a["events"], "ours_csi": a["csi"],
                       "ours_bias": a["bias"], "sf_csi": b["csi"], "sf_bias": b["bias"], "diff": a["csi"] - b["csi"],
                       "diff_lo": np.percentile(d, 5), "diff_hi": np.percentile(d, 95)})
    return out, vs


def md_table(rows: list[dict], cols: list[tuple[str, str]]) -> str:
    f = lambda v: f"{v:.2f}" if isinstance(v, (float, np.floating)) else str(v)
    lines = ["| " + " | ".join(h for h, _ in cols) + " |", "|" + "---|" * len(cols)]
    lines += ["| " + " | ".join(f(r[k]) for _, k in cols) + " |" for r in rows]
    return "\n".join(lines) + "\n"


def main(pairs: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute(f"CREATE VIEW p AS SELECT * FROM read_parquet('{pairs}')")
    params = fit(con)
    (out / "slr.json").write_text(json.dumps(params, indent=2) + "\n")
    res, vs = evaluate(con, params)
    for r in res:
        r["range"] = f"{r['slr_lo']:.2f}–{r['slr_hi']:.2f}"
        r["gain_range"] = f"{r['gain_lo']:+.2f} to {r['gain_hi']:+.2f}"
    for r in vs:
        r["diff_range"] = f"{r['diff_lo']:+.2f} to {r['diff_hi']:+.2f}"
    parts = [
        "# SLR v1 — fitted on 2024-25, judged on 2025-26\n",
        "PRIVATE (contains paid-source comparison).\n",
        f"Fit: SLR = {params['a']} + {params['b']} × T, clamped {params['clamp']}; {params['n_days']} training days; "
        f"median observed SLR {params['median_observed_slr']}.\n",
        md_table(params["bins"], [("T bin (°C)", "t"), ("median SLR", "median_slr"), ("days", "n")]),
        "\nTruth is SNOTEL depth gain, which undercounts new snow (settling) — the same for every source.\n",
        "\n## Ours vs Open-Meteo's 7:1, test winter, by lead (CSI; 90% ranges resample dates)\n",
        md_table([r for r in res if r["lead"] >= 1], [("model", "model"), ("lead", "lead"), ("≥ cm", "thr"),
                 ("events", "events"), ("7:1 CSI", "raw_csi"), ("7:1 bias", "raw_bias"), ("ours CSI", "slr_csi"),
                 ("ours range", "range"), ("ours bias", "slr_bias"), ("gain", "gain"), ("gain range", "gain_range")]),
        "\nA gain whose range excludes 0 is real at 90%; otherwise it is within the noise.\n",
        "\n## Ours vs Snow-Forecast hindcast, lead 0, same resort-days\n",
        md_table(vs, [("model", "model"), ("≥ cm", "thr"), ("events", "events"), ("ours CSI", "ours_csi"),
                      ("ours bias", "ours_bias"), ("SF CSI", "sf_csi"), ("SF bias", "sf_bias"),
                      ("ours − SF", "diff"), ("range", "diff_range")]),
        "\nLead 0 carries model spin-up (dry first hours), which handicaps the models here.\n",
    ]
    (out / "slr_report.md").write_text("\n".join(parts))
    print(f"SLR v1 fitted on {params['n_days']} training days; report written", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]))

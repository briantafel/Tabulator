#!/usr/bin/env python3
"""NBM at interior Canada: stored zeros or real? Backfilled winters, scored against observations (read-only, no app change).

Why (2026-11-25): the live-forecast coverage check was inconclusive (history too short, controls THIN). NBM has two backfilled
winters (2024-11-01 .. 2026-04-30) already paired with observations in verify's pairs table, so test it there.

RULE (fixed before any number is read).
Population: pairs.parquet, source 'nbm', space liquid, pair_quality strict, tier mid, obs and fc_amount present, lead_day 1-3,
months 11-4, issued 2024-11-01 .. 2026-04-30 at 00z/12z with lead_hours > 0; one row per resort x local_date x lead_day (latest issue).
Only public truth is in pairs for this population; no paid source is read or named.
WET DAY: obs >= 5.0 mm liquid. Per resort: n_wet; Z = share of wet-day rows where NBM fc_amount is EXACTLY 0.0; R = sum(fc)/sum(obs) on wet days.
Verdict per resort:
  THIN         n_wet < 20 (not judged).
  STORED ZERO  Z >= 0.50 and Z >= (largest control Z) + 0.30. NBM says exactly zero on days the gauge got >= 5 mm: a missing value written as zero, or no data at that point.
  DRY BIAS     not STORED ZERO and R < 0.5. Real values, but the model badly under-forecasts the wet days (a model skill problem, not a data fault).
  PLAUSIBLE    anything else.
METHOD CHECK: the controls (alta, jackson-hole) must each have n_wet >= 20 and Z < 0.10; otherwise the whole run is void.
Interior resorts: panorama kimberley fernie kicking-horse norquay sunshine lake-louise marmot. Also reported: rows, dates with NBM rows, share of ALL rows exactly 0.0, by winter.
AMENDMENT 2026-11-25 (LOOSE mode, committed before its run; the strict rule above is unchanged and stays the default):
the strict run left seven interior resorts with no pairs (THIN, 0 rows). LOOSE mode changes ONLY the population: pair_quality strict OR loose,
station_km <= 40, nearest station kept when several share a resort x date x lead (ties by latest issue). Wet day, Z, R, the verdict thresholds, the
controls and the method check are identical. The controls (alta, jackson-hole) are scored in loose mode too and must still pass. Reported extra:
truth_source mix and median station_km per resort, because loose truth can sit in a valley and under-catch snow: that lowers wet-day counts and R,
never Z. A loose-mode STORED ZERO verdict is judged by Z alone; a loose-mode R is NOT judged (DRY BIAS is printed as 'R LOW, truth loose').
Usage: nbm_interior_zero.py <pairs.parquet> <outDir> [loose]
"""
import sys, os
import duckdb

POOL = ("panorama", "kimberley", "fernie", "kicking-horse", "norquay", "sunshine", "lake-louise", "marmot")
CONTROL = ("alta", "jackson-hole")
WET_MM, MIN_WET, CTRL_Z, ZERO_MIN, ZERO_GAP, DRY_R = 5.0, 20, 0.10, 0.50, 0.30, 0.5
FROM, TO = "2024-11-01", "2026-05-01"

def build(con, pairs, loose=False):
    q = "pair_quality IN ('strict', 'loose') AND station_km <= 40" if loose else "pair_quality = 'strict'"
    order = "issue_ts DESC, station_km ASC" if loose else "issue_ts DESC"
    extra = ", truth_source, station_km" if loose else ""
    con.execute(f"""CREATE TABLE n AS SELECT resort_id, local_date, lead_day, fc_amount AS fc, obs{extra},
        CASE WHEN month(local_date) >= 11 THEN year(local_date) ELSE year(local_date) - 1 END AS winter
      FROM read_parquet('{pairs}')
      WHERE source = 'nbm' AND space = 'liquid' AND {q} AND tier = 'mid' AND obs IS NOT NULL AND fc_amount IS NOT NULL
        AND lead_day BETWEEN 1 AND 3 AND month(local_date) IN (11,12,1,2,3,4)
        AND issue_ts >= TIMESTAMP '{FROM}' AND issue_ts < TIMESTAMP '{TO}' AND hour(issue_ts) IN (0, 12) AND lead_hours > 0
      QUALIFY row_number() OVER (PARTITION BY resort_id, local_date, lead_day ORDER BY {order}) = 1""")

def stats(con, resort):
    r = con.execute(f"""SELECT count(*), count(DISTINCT local_date), avg((fc = 0)::INT),
        count(*) FILTER (WHERE obs >= {WET_MM}), avg((fc = 0)::INT) FILTER (WHERE obs >= {WET_MM}),
        sum(fc) FILTER (WHERE obs >= {WET_MM}) / nullif(sum(obs) FILTER (WHERE obs >= {WET_MM}), 0)
      FROM n WHERE resort_id = ?""", [resort]).fetchone()
    by = con.execute(f"""SELECT winter, count(*) FILTER (WHERE obs >= {WET_MM}), avg((fc = 0)::INT) FILTER (WHERE obs >= {WET_MM})
      FROM n WHERE resort_id = ? GROUP BY 1 ORDER BY 1""", [resort]).fetchall()
    return dict(resort=resort, rows=r[0], dates=r[1], zero_all=r[2], n_wet=r[3], Z=r[4], R=r[5], by=by)

def main(pairs, out, loose=False):
    os.makedirs(out, exist_ok=True)
    con = duckdb.connect(); build(con, pairs, loose)
    S = {r: stats(con, r) for r in POOL + CONTROL}
    bad = [f"{c}: n_wet {S[c]['n_wet']}, Z {S[c]['Z']}" for c in CONTROL if S[c]["n_wet"] < MIN_WET or S[c]["Z"] is None or S[c]["Z"] >= CTRL_Z]
    zc = max([S[c]["Z"] for c in CONTROL if S[c]["Z"] is not None] or [0.0])
    for r, s in S.items():
        if s["n_wet"] < MIN_WET: s["verdict"] = "THIN"
        elif s["Z"] >= ZERO_MIN and s["Z"] >= zc + ZERO_GAP: s["verdict"] = "STORED ZERO"
        elif s["R"] is not None and s["R"] < DRY_R: s["verdict"] = "R LOW, truth loose" if loose else "DRY BIAS"
        else: s["verdict"] = "PLAUSIBLE"
    f = lambda v, d=2: "" if v is None else f"{v:.{d}f}"
    L = ["# NBM interior Canada: stored zeros or real? (backfilled winters, vs observations)" + (" [LOOSE truth]" if loose else ""), "",
         "Rule in the script docstring. Wet day = obs >= 5 mm liquid, lead days 1-3. Z = share of wet-day rows where NBM is exactly 0.0; R = sum(NBM)/sum(obs) on wet days.", ""]
    if bad: L += ["**METHOD CHECK FAILED, run void: " + "; ".join(bad) + "**", ""]
    L += ["| resort | role | verdict | rows | dates | exactly 0 (all rows) | wet-day rows | Z | R | by winter: wet rows / Z |", "|---|---|---|---:|---:|---:|---:|---:|---:|---|"]
    for r in POOL + CONTROL:
        s = S[r]; w = "; ".join(f"{int(a)}: {b}/{f(c)}" for a, b, c in s["by"])
        L.append(f"| {r} | {'control' if r in CONTROL else 'interior'} | {s['verdict']} | {s['rows']} | {s['dates']} | {f(s['zero_all'])} | {s['n_wet']} | {f(s['Z'])} | {f(s['R'])} | {w} |")
    if loose:
        L += ["", "Truth mix (loose mode): resort | truth_source | rows | median station_km"]
        for r in POOL + CONTROL:
            for ts, n, km in con.execute("SELECT truth_source, count(*), median(station_km) FROM n WHERE resort_id = ? GROUP BY 1 ORDER BY 2 DESC", [r]).fetchall():
                L.append(f"- {r} | {ts} | {n} | {km:.1f}")
    md = "\n".join(L); open(os.path.join(out, "nbm_interior_zero_loose.md" if loose else "nbm_interior_zero.md"), "w").write(md); print(md)
    return S, bad

if __name__ == "__main__":
    if len(sys.argv) not in (3, 4): raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2], len(sys.argv) > 3 and sys.argv[3] == "loose")

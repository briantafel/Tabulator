#!/usr/bin/env python3
"""Is blend-v1's day-1 lead over NBM and HRRR flattered by Open-Meteo previous_day1 timing? (2026-11-24, Opus 5.5)

    python3 scripts/diag/om_day1_tilt.py <pairs.parquet> <timing.json> <outDir>

Report only: no change to the app, the blend, build.py or any switch. Public models and SNOTEL/BC truth only.
<timing.json> is the output of scripts/diag/om_prev_timing.py (which run fills each hour).

VERDICT RULE, written and committed 2026-11-24 BEFORE any number below was computed (template: blend_nbm.py)
=========================================================================================================
Data, the same as blend_hrrr.py / blend_nbm.py: fit 2024-25 ('train'), judge 2025-26 ('test'), Nov–Apr, strict
SNOTEL/BC pairs, mid tier, liquid. v1 = blend.py fit() unchanged. NBM: 00z/12z, issued 2024-11-01 → 2026-04-30,
cycle rules `latest` and `earliest` exactly as blend_nbm.py. HRRR (noaa-hrrr): `latest` and `first` exactly as
blend_hrrr.py. 90% bootstrap over 7-day date blocks, 1000 resamples, fixed seed.

Part 1, analytic (needs the timing verdict). If timing.json says H_step for all three models, compute for each
time zone in the scored set the share of a local day's scored water weight (verify's pro-rata split of 6-hour UTC
blocks, uniform over hours) that comes from runs initialised (i) at or after the local day start, (ii) after the
comparator's run (NBM latest 00z, NBM earliest 12z, HRRR latest/first by their own rule). No data, arithmetic only.

Part 2, conservative head-to-head (always run): v1 built from previous_day2 (its lead-2 forecast of local day D,
lead-2 weights and factors from the train winter) against each comparator's LEAD-1 forecast of the same day D.
Under any timing hypothesis every Open-Meteo run in previous_day2 for day D is issued ≥ 24 h before the runs in
previous_day1, so this comparison is tilted AGAINST v1. Same resort-days for every column of one comparator: ECMWF,
GFS, GEM at lead 2 and the comparator at lead 1. Also reported on the same days: v1 at lead 1 (the original).

  per comparator X ∈ {NBM latest, NBM earliest, HRRR latest, HRRR first}, ≥ 10 mm and ≥ 2.5 mm:
    "v1 lead robust"         v1@2 − X@1, ≥ 10 mm CSI 5th percentile > 0
    "X beats stale v1"       ≥ 10 mm 95th percentile < 0
    "no clear difference"    otherwise
  A cell needs ≥ 300 test resort-days with ≥ 10 mm observed and ≥ 10 resorts, else INSUFFICIENT (claims nothing).
  HRRR covers lead 1 only, so its common days are lead-1 HRRR days that also have Open-Meteo lead 2.

Answer to "is v1's day-1 lead real?" for comparator X (whose earlier verdict had v1 ahead or level):
  REAL                timing H_step for all three models AND analytic share (i) < 5% of the day's weight,
                      OR Part 2 says "v1 lead robust".
  PARTLY AN ARTIFACT  timing H_late (some hours use runs with step < 24 h) AND Part 2 says "X beats stale v1".
  UNKNOWABLE          anything else (e.g. timing UNKNOWN and Part 2 "no clear difference"). We say so.
Does an earlier verdict change? Only if the answer for that comparator is PARTLY AN ARTIFACT. The HRRR and NBM
gates themselves are not re-run or re-judged here (blend_hrrr.py and blend_nbm.py stay as committed).

Not gated, reported: ≥ 20 mm, MAE, volume, the v1@1 − v1@2 gap (what one day of Open-Meteo freshness is worth).
"""

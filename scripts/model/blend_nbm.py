#!/usr/bin/env python3
"""Head-to-head: NBM as a fourth blend member, and NBM alone as the US bar (plan-near-term-models-2026-11-22, step 3).

    python3 scripts/model/blend_nbm.py <pairs.parquet> <outDir>

Report only, no app change. Writes blend_nbm_report.md and blend_nbm.json. Public models and SNOTEL/BC truth only.

GATE, written and committed 2026-11-24 BEFORE any NBM-vs-blend number was computed (the template is blend_hrrr.py)
=================================================================================================================
Data (the same for every column)
  - Fit on 2024-25 ('train'), judge on 2025-26 ('test'). Strict SNOTEL/BC pairs, mid tier, liquid water.
  - Local days in Nov–Apr only, and NBM issued 2024-11-01 → 2026-04-30 at 00z or 12z: the nbm-3 history backfill.
    Rows outside that range are dropped, not scored as zero.
  - Same resort-day-leads for every column: ECMWF, GFS, GEM (Open-Meteo Previous Runs) AND NBM must all have a
    forecast. In practice this means resorts on NBM's CONUS grid. Coverage by resort is reported.
  - v1 = the blend-v1 method (blend.py fit(), unchanged) refitted on those days with ECMWF, GFS and GEM.
    v2 = the same plus NBM as a fourth member (its own region factor and inverse-MSE weight).
  - Leakage rule: every NBM row used must be issued before the start of its local valid day (lead_hours > 0) and
    must be a 00z or 12z cycle. Any violation aborts the run. It is never filtered quietly.

NBM cycle rules (NBM history is 00z/12z only). Both are reported, and the gate needs BOTH.
  latest   = the last NBM cycle issued on the lead's resort-local issue date (00z UTC ≈ 16–17 h local). This is
             what a blend built late in that day would use.
  earliest = the first cycle issued on that date (12z UTC ≈ 04–05 h local). It is conservative: no freshness edge
             over the once-a-day Open-Meteo runs.
  If a gain shows up only under `latest`, it comes from freshness, not from NBM (the HRRR lesson). Verdict
  FRESHNESS-ONLY, not passed.

Significance: 90% bootstrap over 7-day date blocks (1000 resamples, fixed seed). The blocks are weeks, not days,
because pooled leads put one storm on several dates.

(a) NBM as a fourth member, leads 1–3 pooled, under EACH cycle rule:
  A1  water ≥ 10 mm:  v2 − v1 CSI, 5th percentile > 0
  A2  water ≥ 2.5 mm: v2 − v1 CSI, 5th percentile > −0.02   (not worse on light days)
  A3  no single lead (1, 2 or 3) at ≥ 10 mm has its v2 − v1 95th percentile < 0   (not clearly worse at any lead)
  (a) PASSES only if A1, A2 and A3 all hold under `latest` AND under `earliest`.

(b) NBM alone (raw, as issued) vs v1, and vs ECMWF, GFS and GEM raw, by lead group 1–3 and 4–7, same days:
  NBM beats X     ≥ 10 mm NBM − X 5th percentile > 0, and ≥ 2.5 mm NBM − X 5th percentile > −0.02
  X beats NBM     ≥ 10 mm NBM − X 95th percentile < 0
  otherwise       no clear difference
  (b) PASSES (NBM alone is a better US days-1–3 forecast than blend-v1) only if "NBM beats v1" in group 1–3 under
  BOTH cycle rules. Group 4–7 and the single-model rows are the bar for the record, not gated.

Enough events. A gated cell needs ≥ 300 test resort-days with ≥ 10 mm observed and ≥ 10 resorts. At CSI ≈ 0.5,
300 events give a paired-difference 90% range of roughly ±0.02 to ±0.03, enough to see the +0.02 to +0.03 gains
that would matter. With fewer, the verdict is INSUFFICIENT, not FAIL, and nothing is claimed. A per-lead cell
(A3) with < 100 events is reported as thin and cannot fail A3.

Reported but NOT gated: ≥ 20 mm, MAE, volume (Σfc ÷ Σobs), frequency bias, NBM bias-corrected by the v2 factors,
NBM's v2 weight by lead, and coverage by resort and region. Nothing reported but not gated is a claim.

Product caveat (known before running): the train winter is NBM v4.2 (operational 2024-05-15), the test winter
is v4.3 (May 2025; no core QPF change), and NBM went to v5.0 on about 2026-05-05 (QPF weighting, winter
suite and inputs changed). A pass here describes v4.3, not the v5.0 NBM now being collected live. Any rollout
must re-check on live v5.0 pairs first.
"""

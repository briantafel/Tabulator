#!/usr/bin/env python3
"""Does blend-v1 over-forecast water in the Kootenays and Canadian Rockies? (2026-11-25, Opus 5.5)

    python3 scripts/diag/canada_interior_wet.py <pairs.parquet> <eccc_truth.parquet> <outDir>

Report only: no change to the app, the blend, build.py or any switch. Public models and public truth only (Open-Meteo,
NBM, HRRR, HRDPS; BC ASWS pillows, ECCC gauges, resort-reported new snow). Writes canada_interior_wet.md / .json.

Why: at Panorama the live blend was about 3x NBM (1.42 in vs 0.47 in, 2026-11-23). NBM has no history there, so the
past winters cannot say whether NBM is right, but they can say whether blend-v1 runs wet in this part of Canada.
blend-v1's "Canada" region factors (ECMWF x1.44 at lead 1) were fitted on the few Canadian resorts with strict pairs,
which may not describe the interior.

PRE-REGISTERED RULE, written and committed 2026-11-25 BEFORE any number below was computed
==========================================================================================
Resorts (the pool): panorama, kimberley, fernie, kicking-horse, norquay, sunshine, lake-louise, marmot. Each is also
shown on its own; nothing is hidden by pooling. Mid tier. Leads 1-3 pooled (lead 1 shown too). Nov-Apr local days.

blend-v1 = the PUBLISHED public/blend.json (weights by lead, factor model|lead|region, else pooled factor), applied to
Open-Meteo Previous Runs ecmwf_ifs025 / gfs_seamless / gem_seamless water; a missing model is dropped and the weights
re-normalised (never zero). Judged in each of 2024-25 and 2025-26. These resorts are not in v1's strict-pair fit unless
the report's coverage table shows strict pairs for them; it says which.

Truth types (each judged separately; missing is never zero; a station with no value that day is dropped):
  SWE    BC ASWS pillow daily SWE gain paired by verify (truth_source bc-asws, any pair quality, station <= 40 km).
  GAUGE  ECCC daily total precipitation: per resort the candidate station with the lowest km/25 + |delev|/300 that
         has >= 60% coverage, station <= 40 km (eccc_truth.parquet; flags already applied by verify). Valley gauges
         under-catch snow (20-50%), so their bar is wider.
  REPORT resort-reported new snow (OnTheSnow, verify's next-day rule), in cm, against v1 water x the published SLR
         (public/slr.json, the app's daily rule: 0 above 2 C, the clamped line, the warm cap where promoted) at the
         mean of the three models' day temperature. Reports and the ratio are both uncertain, so its bar is wider.

Statistic: volume ratio V = sum(v1) / sum(obs) over resort-day-leads with both present, 90% bootstrap over 7-day date
blocks (1000 resamples, fixed seed). Per truth type and winter:
  SWE    TOO WET if V 5th pct > 1.20;  TOO DRY if V 95th pct < 0.80
  GAUGE  TOO WET if V 5th pct > 1.50;  TOO DRY if V 95th pct < 0.80
  REPORT TOO WET if V 5th pct > 1.50;  TOO DRY if V 95th pct < 0.67
  otherwise NO CLEAR BIAS.
Enough data: a truth type x winter is USABLE only with >= 60 resort-days at lead 1 with obs >= 2.5 mm (REPORT: >= 5 cm)
over >= 3 resorts; else INSUFFICIENT and it claims nothing.

Answer per winter: TOO WET if >= 2 usable truth types say TOO WET and none says TOO DRY; NOT TOO WET if >= 2 usable
types say NO CLEAR BIAS or TOO DRY and none says TOO WET; fewer than 2 usable types -> INSUFFICIENT; else MIXED.
Final answer: the two winters' answers if they agree; WINTER-DEPENDENT if both are decided and differ; otherwise
whatever was decided, marked as one winter only.

Reported, NOT gated (no claim): Panorama on its own; each raw model's V; v1 with the pooled (all-region) factors
instead of the Canada factor (is the Canada factor the cause?); frequency bias and CSI at 10 mm / 10 cm; the live
2026-27 season so far, v1 vs NBM vs HRRR vs HRDPS vs truth on common days (thin, ranges not meaningful with < 4 weeks).
"""

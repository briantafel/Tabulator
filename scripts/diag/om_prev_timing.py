#!/usr/bin/env python3
"""Which model run fills each hour of Open-Meteo Previous Runs `previous_day1`? (2026-11-24, Opus 5.5)

    python3 scripts/diag/om_prev_timing.py <bucket> <account_id> <outDir>

Read-only probe, report only. Public models only (Open-Meteo, our archive's open-meteo-previous-runs rows); no paid
source is read. Writes om_prev_timing.md / .json.

Why: build.py stamps previous_dayN as lead_hours = 24*N with no issue time. NBM and HRRR are scored by their real
issue time. If Open-Meteo built hour V of previous_day1 from a run issued AFTER the resort-local day started, blend-v1
at lead 1 held information NBM/HRRR did not, and the head-to-heads (HRRR FAIL 2026-11-22, NBM FAIL 2026-11-24) are
tilted toward v1.

What the docs say (2026-11-24): previous-runs-api page: "_previous_day1 is the value that was predicted 24 hours
before valid time". Open-Meteo blog 2024-04-19: "the initial 24 hours of each weather model run are disregarded. In
models updating every 3 hours, time steps 24, 25, and 26 are utilized to form a continuous time-series." Nothing
says how 6- or 12-hourly models or the seamless models (gfs_seamless, gem_seamless) are handled. Hence this test.

TEST DESIGN, written and committed BEFORE the probe was run
===========================================================
Hypotheses for model M with cycle c (6 h ECMWF/GFS, 6 or 12 h GEM):
  H_step  hour V comes from the newest run with step V − init ≥ 24 h, i.e. init = floor_c(V − 24 h). Steps 24..24+c−1.
          Inits change at fixed UTC hours; for any resort the newest run used for local day D is issued ≤ 1 h before
          D starts (last hour of D minus 24 h). No hour of previous_day1 uses a run issued after D starts.
  H_day   one run per (UTC or local) day: all hours of a day share one init; steps span ≥ 23 h within the day.
  H_late  some hours come from runs with step < 24 h (fresher than "24 h before"); these are the ones that could
          leak runs issued after the local day started.

Test A (decisive for the mechanism, live dates): for 2 resorts (alta, America/Denver; palisades, America/Los_Angeles),
2 UTC days (2026-11-18, 2026-11-19, the Wasatch storm), each model: fetch hourly precipitation + temperature_2m
`previous_day1` from the Previous Runs API, and every candidate run 2026-11-16 00Z → 2026-11-19 18Z (every 6 h) from
the Single Runs API (archived from April 2026), same lat/lon/elevation as our archived rows. For each hour, the runs
whose temperature AND precipitation both equal previous_day1 (|Δ| ≤ 0.051) are its matches. Outcomes:
  H_step  ≥ 95% of uniquely matched hours have init = floor_c(V − 24 h) (c = 6, or 12 for GEM if 6-hourly runs
          are not offered), AND ≥ 80% of hours have at least one match.
  H_day   ≥ 95% of uniquely matched hours of each UTC day share one init (and steps span ≥ 12 h).
  H_late  ≥ 5% of uniquely matched hours have step < 24 h.
  UNKNOWN anything else, including < 80% of hours matched (e.g. the two APIs interpolate differently): then the
          mechanism is NOT pinned by this test and we say so.

Test B (our archive is what the API serves): (i) archived hourly `temp` rows, previous_day1, om-prev-2, for the same
resort-days must equal the API fetch (|Δ| ≤ 0.051) on ≥ 99% of hours; (ii) archived 6-hour `precip` blocks,
previous_day1, for 2025-01-05 → 2025-01-31 and 2026-01-05 → 2026-01-31 (the scored winters) must equal the API
re-fetch summed into the same blocks (|Δ| ≤ 0.11 mm) on ≥ 99% of blocks. If (ii) holds, the rows we scored are the
product Open-Meteo serves today for those dates, so Test C on a re-fetch speaks for them.

Test C (the scored winters, indirect): Single Runs history starts April 2026, so the winters 2024-25/2025-26 cannot
be matched run-by-run. Run boundaries leave a step in an hourly series. For hourly temperature_2m_previous_day1 over
the two January windows above (and 2026-11-01 → 11-22 as calibration, where Test A gives the truth), per model and
resort: s(h) = standard deviation over days of ΔT(V) = T(V) − T(V − 1 h), for UTC hour h of V.
  boundary ratio  R_b = median s(h) at h ∈ {0, 6, 12, 18} ÷ median s(h) at the other hours (GEM: {0, 12} if
                  Test A shows 12-hourly use)
  local-midnight  R_m = s(local midnight hour) ÷ median s(h) at the hours that are neither boundary nor midnight
  Consistent with H_step: R_b ≥ 1.3 and R_m < 1.3.   Consistent with H_day (local): R_m ≥ 1.3 and R_b < 1.3.
  Otherwise inconclusive. Evidence, not proof: it shows where runs change, not which run.
  The calibration window must show the Test-A answer; if it does not, Test C is reported as uninformative.

Failures are loud: a non-400 HTTP error after retries, an empty response, or no archived rows aborts with exit 1.
A 400 for a run that is not offered is counted and reported, never treated as zero.
"""

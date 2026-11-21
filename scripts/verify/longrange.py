#!/usr/bin/env python3
"""Long-range verification: how far out do our ensembles still know anything?

    python3 scripts/verify/longrange.py <archiveDir> <outDir> [--resorts src/data/resorts.json]

Needs <outDir>/truth_daily.parquet and <outDir>/pairs.parquet from build.py.

Brian, 2026-11-21: "start scoring forecasts as far out as we have data and
projections. This is important to the critical function of the app."

What is scored (public models + public truth only; nothing paid, so the
report is published unsealed like blend/bands/temps):
- dynamical-ens: ECMWF IFS ENS (51), NOAA GEFS (31), ECMWF AIFS ENS (51), 00z
  inits, days 0–15, read STRAIGHT FROM THE ARCHIVE one month at a time, so
  the past winters build.py has to skip (out of memory) are scored too. That
  is two full winters (2024-25 train, 2025-26 test) plus this season (live).
- open-meteo-ensemble (ECMWF + GFS members): the source of the app's purple
  days 7–10. Live season only (archived since 2026-10-29). From pairs.parquet.
- nbm: NOAA's calibrated blend, deterministic, to day 11 (US baseline). From pairs.parquet.

How (project rules: missing is never zero; score yes/no events, not plain error):
- Liquid water, mm, against SNOTEL / BC ASWS SWE gain at strict mid-tier pairs.
  Liquid is the primary measure (snow truth loses snow to settling).
- A forecast day counts only if its periods cover the whole resort-local day;
  partial days are absent. A 72 h window counts only if all three days exist,
  in the forecast AND in the truth.
- Two windows: 24 h (≥ 2.5 / 10 / 20 mm) and 72 h (≥ 10 / 25 / 50 mm). At long
  lead a storm a day early or late is a timing miss on the day but a hit on
  the window. 72 h is closest to how a skier uses day 7–10 ("is something coming?").
- Probability = share of members at or over the threshold. Brier score, and
  Brier SKILL vs climatology: the same resort and calendar month's rate in the
  OTHER winter(s) (out of sample; regional × month if a resort has < 20 days).
  BSS > 0 means better than knowing only how often it usually snows there.
- 90% ranges from a date-block bootstrap (all resorts on a date move together).
- Useful horizon: the last lead, counting up from day 1 without a gap, where
  the BSS range's low end is above 0.
- Resort vs region: the same forecast averaged over all resorts in the macro
  region, scored against each resort's own truth. Where the resort's own
  probability no longer beats the regional one, resort-level numbers stop
  earning their place (the calendar's region-first cutoff, 2026-11-17 decision).
- Lead day counts from the init's resort-local date to the valid date, as in
  build.py. A 00z init is the previous evening in the Americas.

Writes longrange_scores.csv, longrange_reliability.csv, longrange_region.csv,
longrange_horizon.csv and longrange_report.md. Failures are loud.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import duckdb
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from digest import MACRO  # noqa: E402

THR = {24: (2.5, 10.0, 20.0), 72: (10.0, 25.0, 50.0)}  # mm per window
DYN_MODELS = ("ecmwf_ifs_ens", "gefs", "ecmwf_aifs_ens")
PAIRS_SOURCES = ("open-meteo-ensemble", "nbm")
PAID = ("snow-forecast", "snow-forecast-hindcast")
MAX_LEAD = 15
CLIM_MIN_DAYS = 20
THIN_EVENTS = 20
N_BOOT = 400
SEED = 20261121
REL_BINS = [0.0, 0.05, 0.2, 0.4, 0.6, 0.8, 0.95, 1.0001]
MATCHED = [("open-meteo-ensemble:ecmwf_ifs025", "dynamical-ens:ecmwf_ifs_ens"),
           ("open-meteo-ensemble:gfs025", "dynamical-ens:gefs")]
LEAD_GROUPS = {"1-3": (1, 3), "4-7": (4, 7), "8-10": (8, 10), "11-15": (11, 15)}


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


HIST_FIRST = 2020  # SNOTEL daily truth backfilled from winter 2020-21 (2026-11-21); GEFS history from 2020-11


def split_of(winter_sql: str) -> str:
    """train = 2024-25, test = 2025-26, live = this season; older winters are 'w<start year>'."""
    return (f"CASE WHEN {winter_sql} = 2024 THEN 'train' WHEN {winter_sql} = 2025 THEN 'test' "
            f"WHEN {winter_sql} >= 2026 THEN 'live' "
            f"WHEN {winter_sql} >= {HIST_FIRST} THEN 'w' || CAST({winter_sql} AS VARCHAR) END")


def setup(con, out: Path, resorts_path: Path) -> None:
    con.execute("SET TimeZone = 'UTC'")
    meta = json.loads(resorts_path.read_text())["resorts"]
    con.execute("CREATE TABLE rz(resort_id VARCHAR, region VARCHAR, macro VARCHAR, tz VARCHAR)")
    con.executemany("INSERT INTO rz VALUES (?, ?, ?, ?)",
                    [(r["id"], r["region"], MACRO.get(r["region"], r["region"]), r["tz"]) for r in meta])
    tp = out / "truth_daily.parquet"
    if not tp.exists():
        raise SystemExit(f"{tp} missing — run build.py first")
    con.execute(f"""
    CREATE TABLE tr AS
    SELECT t.resort_id, z.macro, t.local_date, t.obs, {split_of('t.winter')} AS split
    FROM read_parquet('{tp}') t JOIN rz z USING (resort_id)
    WHERE {split_of('t.winter')} IS NOT NULL""")
    n = con.execute("SELECT count(*) FROM tr").fetchone()[0]
    if not n:
        raise SystemExit("truth_daily.parquet has no usable days")
    # 72 h truth: all three days present.
    con.execute("""
    CREATE TABLE tr3 AS
    SELECT resort_id, macro, local_date, split, obs FROM (
      SELECT resort_id, macro, local_date, split,
             sum(obs) OVER w AS obs, count(*) OVER w AS k
      FROM tr WINDOW w AS (PARTITION BY resort_id ORDER BY local_date RANGE BETWEEN INTERVAL 2 DAY PRECEDING AND CURRENT ROW))
    WHERE k = 3""")
    con.execute("""
    CREATE TABLE truth AS
    SELECT resort_id, macro, local_date, split, 24 AS win, obs FROM tr
    UNION ALL SELECT resort_id, macro, local_date, split, 72, obs FROM tr3""")
    log(f"truth: {n} resort-days, {con.execute('SELECT count(DISTINCT resort_id) FROM tr').fetchone()[0]} resorts")


def climatology(con) -> None:
    """Base rate per resort × month × window × threshold, from the OTHER winter(s)."""
    con.execute("CREATE TABLE thr(win INTEGER, k INTEGER, t DOUBLE)")
    con.executemany("INSERT INTO thr VALUES (?, ?, ?)", [(w, k, t) for w, ts in THR.items() for k, t in enumerate(ts)])
    con.execute("CREATE TABLE sp(split VARCHAR, ref VARCHAR)")
    # Reference winters: every OTHER past winter that has truth (2026-11-21: was the single other
    # one of train/test; with older winters loaded the base rate comes from up to five winters).
    pasts = [r[0] for r in con.execute("SELECT DISTINCT split FROM truth WHERE split <> 'live'").fetchall()]
    con.executemany("INSERT INTO sp VALUES (?, ?)", [(a, b) for a in pasts + ["live"] for b in pasts if a != b])
    con.execute("""
    CREATE TABLE clim_r AS
    SELECT s.split, t.resort_id, any_value(t.macro) AS macro, month(t.local_date) AS mon, t.win, h.k,
           avg(CAST(t.obs >= h.t AS DOUBLE)) AS rate, count(*) AS n
    FROM truth t JOIN thr h USING (win) JOIN sp s ON s.ref = t.split
    GROUP BY s.split, t.resort_id, month(t.local_date), t.win, h.k""")
    con.execute("""
    CREATE TABLE clim_m AS
    SELECT s.split, t.macro, month(t.local_date) AS mon, t.win, h.k, avg(CAST(t.obs >= h.t AS DOUBLE)) AS rate
    FROM truth t JOIN thr h USING (win) JOIN sp s ON s.ref = t.split
    GROUP BY s.split, t.macro, month(t.local_date), t.win, h.k""")


DAY_SPLIT = """
    WITH x AS (
      SELECT f.*, r.tz,
             CAST(timezone(r.tz, f.valid_start) AS DATE) AS d0,
             CAST(timezone(r.tz, f.valid_end - INTERVAL 1 SECOND) AS DATE) AS d1
      FROM {src} f JOIN rz r USING (resort_id)
    ), y AS (
      SELECT x.*, CAST(unnest(generate_series(CAST(d0 AS TIMESTAMP), CAST(d1 AS TIMESTAMP), INTERVAL 1 DAY)) AS DATE) AS local_date
      FROM x
    ), z AS (
      SELECT y.*, timezone(tz, CAST(local_date AS TIMESTAMP)) AS day_start,
             timezone(tz, CAST(local_date AS TIMESTAMP) + INTERVAL 1 DAY) AS day_end
      FROM y
    )
    SELECT source_label, resort_id, issue_key, issue_date, member, local_date,
           sum(value * epoch(least(valid_end, day_end) - greatest(valid_start, day_start))
                     / epoch(valid_end - valid_start)) AS amt,
           sum(epoch(least(valid_end, day_end) - greatest(valid_start, day_start))) / 3600 AS cov_h,
           any_value(epoch(day_end - day_start) / 3600) AS day_h
    FROM z GROUP BY source_label, resort_id, issue_key, issue_date, member, local_date"""


def ens_rows(con, member_table: str, out_path: Path) -> int:
    """Member-day amounts → per forecast day and window: member count, mean, P(≥ t) for each threshold."""
    con.execute(f"""
    CREATE OR REPLACE TEMP TABLE mw AS
    SELECT source_label, resort_id, issue_key, issue_date, member, local_date, 24 AS win, amt FROM {member_table}
    UNION ALL
    SELECT source_label, resort_id, issue_key, issue_date, member, local_date, 72, a3 FROM (
      SELECT *, sum(amt) OVER w AS a3, count(*) OVER w AS k FROM {member_table}
      WINDOW w AS (PARTITION BY source_label, resort_id, issue_key, member ORDER BY local_date
                   RANGE BETWEEN INTERVAL 2 DAY PRECEDING AND CURRENT ROW))
    WHERE k = 3""")
    con.execute(f"""
    COPY (
      SELECT m.source_label, m.resort_id, m.issue_key, datediff('day', m.issue_date, m.local_date) AS lead_day,
             m.local_date, m.win, count(*) AS n_mem, avg(m.amt) AS mean,
             avg(CASE WHEN m.amt >= h.t0 THEN 1.0 ELSE 0.0 END) AS p0,
             avg(CASE WHEN m.amt >= h.t1 THEN 1.0 ELSE 0.0 END) AS p1,
             avg(CASE WHEN m.amt >= h.t2 THEN 1.0 ELSE 0.0 END) AS p2
      FROM mw m JOIN (SELECT win, max(t) FILTER (WHERE k = 0) AS t0, max(t) FILTER (WHERE k = 1) AS t1,
                             max(t) FILTER (WHERE k = 2) AS t2 FROM thr GROUP BY win) h USING (win)
      WHERE datediff('day', m.issue_date, m.local_date) BETWEEN 0 AND {MAX_LEAD}
      GROUP BY ALL
    ) TO '{out_path}' (FORMAT parquet)""")
    return con.execute(f"SELECT count(*) FROM read_parquet('{out_path}')").fetchone()[0]


def dynamical(con, archive: Path, tmp: Path) -> list[Path]:
    """dynamical-ens, month by month (members aggregated before anything is joined)."""
    lo, hi = con.execute("SELECT min(local_date) - 20, max(local_date) + 1 FROM tr").fetchone()
    months = sorted((archive / "source=dynamical-ens").glob("month=*"))
    if not months:
        raise SystemExit("no dynamical-ens months in the archive — long-range scoring needs them")
    outs, skipped = [], []
    for mdir in months:
        m = mdir.name.split("=")[1]
        files = sorted(str(p) for p in mdir.glob("*.parquet"))
        if not files or m < lo.strftime("%Y-%m") or m > hi.strftime("%Y-%m"):
            skipped.append(m)
            continue
        fl = "[" + ", ".join("'" + f.replace("'", "''") + "'" for f in files) + "]"
        con.execute(f"""
        CREATE OR REPLACE TEMP TABLE blk AS
        SELECT 'dynamical-ens:' || model AS source_label, resort_id,
               strftime(CAST(issued_at AS TIMESTAMPTZ), '%Y-%m-%dT%H') AS issue_key,
               CAST(issued_at AS TIMESTAMPTZ) AS issued_at, member,
               CAST(valid_start AS TIMESTAMPTZ) AS valid_start, CAST(valid_end AS TIMESTAMPTZ) AS valid_end,
               arg_max(value, CAST(fetched_at AS TIMESTAMPTZ)) AS value
        FROM read_parquet({fl}, union_by_name = true, hive_partitioning = false)
        WHERE source = 'dynamical-ens' AND kind = 'forecast' AND variable = 'precip' AND value IS NOT NULL
          AND model IN {DYN_MODELS} AND hour(CAST(issued_at AS TIMESTAMPTZ)) = 0
          AND CAST(valid_end AS TIMESTAMPTZ) > CAST(valid_start AS TIMESTAMPTZ)
          AND resort_id IN (SELECT DISTINCT resort_id FROM tr)
        GROUP BY ALL""")
        con.execute("""
        CREATE OR REPLACE TEMP TABLE blk2 AS
        SELECT b.*, CAST(timezone(r.tz, b.issued_at) AS DATE) AS issue_date FROM blk b JOIN rz r USING (resort_id)""")
        nb = con.execute("SELECT count(*) FROM blk2").fetchone()[0]
        if not nb:
            skipped.append(m)
            continue
        con.execute("CREATE OR REPLACE TEMP TABLE md0 AS " + DAY_SPLIT.format(src="blk2"))
        over = con.execute("SELECT count(*) FROM md0 WHERE cov_h > day_h + 0.01").fetchone()[0]
        if over:
            raise SystemExit(f"dynamical-ens {m}: {over} member-days covered more than once (overlapping blocks)")
        con.execute("CREATE OR REPLACE TEMP TABLE md AS SELECT * FROM md0 WHERE cov_h >= day_h - 0.01")
        p = tmp / f"dyn-{m}.parquet"
        n = ens_rows(con, "md", p)
        log(f"dynamical-ens {m}: {nb:,} blocks → {n:,} forecast days/windows")
        outs.append(p)
    if skipped:
        log(f"dynamical-ens: {len(skipped)} months outside the truth period or empty, not scored: {', '.join(skipped)}")
    return outs


def from_pairs(con, out: Path, tmp: Path) -> list[Path]:
    pp = out / "pairs.parquet"
    if not pp.exists():
        raise SystemExit(f"{pp} missing — run build.py first")
    con.execute(f"""
    CREATE OR REPLACE TEMP TABLE pm AS
    SELECT source_label, resort_id, issue_key,
           CAST(local_date AS DATE) - CAST(lead_day AS INTEGER) AS issue_date, member,
           CAST(local_date AS DATE) AS local_date, avg(fc_amount) AS amt
    FROM read_parquet('{pp}')
    WHERE source IN {PAIRS_SOURCES} AND NOT paid AND space = 'liquid' AND tier = 'mid' AND fc_amount IS NOT NULL
    GROUP BY ALL""")
    p = tmp / "pairs-ens.parquet"
    n = ens_rows(con, "pm", p)
    log(f"open-meteo-ensemble + nbm: {n:,} forecast days/windows")
    return [p]


def score(con, parts: list[Path], out: Path) -> None:
    fl = "[" + ", ".join(f"'{p}'" for p in parts) + "]"
    con.execute(f"CREATE TABLE fc AS SELECT * FROM read_parquet({fl}, union_by_name = true)")
    bad = con.execute(f"SELECT DISTINCT source_label FROM fc WHERE split_part(source_label, ':', 1) IN {PAID}").fetchall()
    if bad:
        raise SystemExit("a paid source reached the long-range scorer; it is public-only")
    # Long form: one row per forecast × threshold. Several issues of one local issue day
    # (twice-daily archive runs) are averaged so each lead day counts once.
    con.execute("""
    CREATE TABLE fl0 AS
    WITH u AS (
      SELECT source_label, resort_id, lead_day, local_date, win, n_mem, mean, 0 AS k, p0 AS p FROM fc
      UNION ALL SELECT source_label, resort_id, lead_day, local_date, win, n_mem, mean, 1, p1 FROM fc
      UNION ALL SELECT source_label, resort_id, lead_day, local_date, win, n_mem, mean, 2, p2 FROM fc
    )
    SELECT u.source_label, u.resort_id, t.macro, t.split, u.lead_day, u.local_date, u.win, u.k, h.t,
           avg(u.p) AS p, avg(u.mean) AS mean, max(u.n_mem) AS n_mem, any_value(t.obs) AS obs,
           CAST(any_value(t.obs) >= h.t AS DOUBLE) AS o
    FROM u JOIN truth t ON t.resort_id = u.resort_id AND t.local_date = u.local_date AND t.win = u.win
    JOIN thr h ON h.win = u.win AND h.k = u.k
    GROUP BY u.source_label, u.resort_id, t.macro, t.split, u.lead_day, u.local_date, u.win, u.k, h.t""")
    # Climatology (resort × month if ≥ CLIM_MIN_DAYS days, else region × month) and the
    # regional probability: the same source, lead and day averaged over the region's resorts (≥ 3).
    con.execute(f"""
    CREATE TABLE fl AS
    SELECT f.*, coalesce(r.rate, m.rate) AS c,
           CASE WHEN count(*) OVER g >= 3 THEN avg(f.p) OVER g END AS p_reg
    FROM fl0 f
    LEFT JOIN clim_r r ON r.split = f.split AND r.resort_id = f.resort_id AND r.mon = month(f.local_date)
      AND r.win = f.win AND r.k = f.k AND r.n >= {CLIM_MIN_DAYS}
    LEFT JOIN clim_m m ON m.split = f.split AND m.macro = f.macro AND m.mon = month(f.local_date)
      AND m.win = f.win AND m.k = f.k
    WINDOW g AS (PARTITION BY f.source_label, f.macro, f.lead_day, f.local_date, f.win, f.k)""")
    con.execute("DROP TABLE fl0")
    nfl = con.execute("SELECT count(*) FROM fl").fetchone()[0]
    if not nfl:
        raise SystemExit("no long-range forecast found its truth")
    log(f"long-range pairs (forecast × threshold with truth): {nfl:,}")

    rng = np.random.default_rng(SEED)
    rows = con.execute("""
      SELECT source_label, split, coalesce(macro, 'ALL') AS macro, lead_day, win, t, local_date,
             sum(power(p - o, 2)) AS sf, sum(power(c - o, 2)) AS sc,
             sum(CASE WHEN p_reg IS NOT NULL THEN power(p - o, 2) END) AS sfr,
             sum(power(p_reg - o, 2)) AS sr,
             count(*) AS n, sum(o) AS ev,
             sum(CASE WHEN mean >= t AND o = 1 THEN 1 ELSE 0 END) AS hit,
             sum(CASE WHEN mean < t AND o = 1 THEN 1 ELSE 0 END) AS miss,
             sum(CASE WHEN mean >= t AND o = 0 THEN 1 ELSE 0 END) AS fa,
             max(n_mem) AS n_mem
      FROM fl WHERE c IS NOT NULL
      GROUP BY GROUPING SETS ((source_label, split, macro, lead_day, win, t, local_date),
                              (source_label, split, lead_day, win, t, local_date))""").fetchall()
    groups: dict[tuple, list] = {}
    for r in rows:  # one record per date: the bootstrap resamples whole dates
        groups.setdefault(r[:6], []).append(r[7:])
    out_rows, reg_rows = [], []
    for key, recs in sorted(groups.items(), key=lambda kv: tuple(str(x) for x in kv[0])):
        a = np.array([[x if x is not None else np.nan for x in rec] for rec in recs], dtype=float)
        sf, sc, sfr, sr = a[:, 0], a[:, 1], a[:, 2], a[:, 3]
        n, ev, hit, miss, fa = a[:, 4].sum(), a[:, 5].sum(), a[:, 6].sum(), a[:, 7].sum(), a[:, 8].sum()
        D = len(a)
        idx = rng.integers(0, D, size=(N_BOOT, D))
        bss = 1 - sf.sum() / sc.sum() if sc.sum() > 0 else np.nan
        with np.errstate(all="ignore"):
            bb = 1 - sf[idx].sum(1) / sc[idx].sum(1)
        lo, hi = (np.nanpercentile(bb, 5), np.nanpercentile(bb, 95)) if sc.sum() > 0 else (np.nan, np.nan)
        out_rows.append(key + (int(n), int(ev), ev / n if n else None, sf.sum() / n, sc.sum() / n, bss, lo, hi,
                               hit / (hit + miss) if hit + miss else None, fa / (hit + fa) if hit + fa else None,
                               hit / (hit + miss + fa) if hit + miss + fa else None,
                               (hit + fa) / (hit + miss) if hit + miss else None,
                               int(np.nanmax(a[:, 9])), bool(ev < THIN_EVENTS)))
        ok = ~np.isnan(sr)
        if ok.sum() >= 10 and np.nansum(sr) > 0:
            sfr2, sr2 = np.nan_to_num(sfr), np.nan_to_num(sr)
            gain = 1 - sfr2.sum() / sr2.sum()
            with np.errstate(all="ignore"):
                gb = 1 - sfr2[idx].sum(1) / sr2[idx].sum(1)
            reg_rows.append(key + (int(n), int(ev), gain, np.nanpercentile(gb, 5), np.nanpercentile(gb, 95)))
    cols = ("source_label VARCHAR, split VARCHAR, macro VARCHAR, lead_day INTEGER, win INTEGER, threshold DOUBLE, "
            "n INTEGER, events INTEGER, base_rate DOUBLE, brier DOUBLE, brier_clim DOUBLE, bss DOUBLE, bss_lo DOUBLE, "
            "bss_hi DOUBLE, pod DOUBLE, far DOUBLE, csi DOUBLE, freq_bias DOUBLE, members INTEGER, thin BOOLEAN")
    con.execute(f"CREATE TABLE scores ({cols})")
    con.executemany(f"INSERT INTO scores VALUES ({', '.join('?' * 20)})", out_rows)
    con.execute("""CREATE TABLE region (source_label VARCHAR, split VARCHAR, macro VARCHAR, lead_day INTEGER, win INTEGER,
                   threshold DOUBLE, n INTEGER, events INTEGER, resort_gain DOUBLE, gain_lo DOUBLE, gain_hi DOUBLE)""")
    if reg_rows:
        con.executemany(f"INSERT INTO region VALUES ({', '.join('?' * 11)})", reg_rows)

    # Reliability: forecast probability bins vs what happened, by lead group, ALL regions.
    cases = " ".join(f"WHEN lead_day BETWEEN {a} AND {b} THEN '{g}'" for g, (a, b) in LEAD_GROUPS.items())
    bins = " ".join(f"WHEN p < {REL_BINS[i + 1]} THEN '{REL_BINS[i]:.2f}–{min(REL_BINS[i + 1], 1):.2f}'"
                    for i in range(len(REL_BINS) - 1))
    con.execute(f"""
    CREATE TABLE rel AS
    SELECT source_label, split, win, t AS threshold, CASE {cases} END AS leads, CASE {bins} END AS p_bin,
           count(*) AS n, avg(p) AS mean_p, avg(o) AS observed
    FROM fl WHERE lead_day >= 1 AND n_mem > 1 GROUP BY ALL""")

    # Useful horizon: last lead from day 1 with no gap where the BSS low end is above 0.
    hz = []
    for src, split, win, t in con.execute("""SELECT DISTINCT source_label, split, win, threshold FROM scores
                                             WHERE macro = 'ALL'""").fetchall():
        res = dict(con.execute("""SELECT lead_day, bss_lo FROM scores WHERE source_label = ? AND split = ? AND win = ?
                                  AND threshold = ? AND macro = 'ALL' AND NOT thin""", [src, split, win, t]).fetchall())
        # Counting starts at the first lead the window can exist (day 1 for 24 h, day 3 for 72 h:
        # a 72 h window needs three whole forecast days, and day 0 is never whole).
        first = max(1, win // 24)
        h = 0
        for lead in range(first, MAX_LEAD + 1):
            if res.get(lead) is not None and res[lead] > 0:
                h = lead
            else:
                break
        cut = 0
        rg = dict(con.execute("""SELECT lead_day, gain_lo FROM region WHERE source_label = ? AND split = ? AND win = ?
                                 AND threshold = ? AND macro = 'ALL'""", [src, split, win, t]).fetchall())
        for lead in range(first, MAX_LEAD + 1):
            if rg.get(lead) is not None and rg[lead] > 0:
                cut = lead
            else:
                break
        hz.append((src, split, win, t, h, cut, max(res) if res else None))
    con.execute("""CREATE TABLE horizon (source_label VARCHAR, split VARCHAR, win INTEGER, threshold DOUBLE,
                   skill_through_day INTEGER, resort_beats_region_through_day INTEGER, last_scored_lead INTEGER)""")
    if hz:
        con.executemany("INSERT INTO horizon VALUES (?, ?, ?, ?, ?, ?, ?)", hz)

    # Same model, two pipes (live season): the app's days 7–10 come from Open-Meteo's copy; is it
    # as good as dynamical.org's on IDENTICAL resort-days? Different start dates (Oct 29 vs Nov 11)
    # mean different weather, so the plain live tables can't answer this.
    h2h = []
    for a_src, b_src in MATCHED:
        recs = con.execute("""
          WITH a AS (SELECT * FROM fl WHERE source_label = ? AND split = 'live' AND c IS NOT NULL),
               b AS (SELECT * FROM fl WHERE source_label = ? AND split = 'live' AND c IS NOT NULL)
          SELECT a.lead_day, a.win, a.t, a.local_date,
                 sum(power(a.p - a.o, 2)), sum(power(b.p - b.o, 2)), sum(power(a.c - a.o, 2)), count(*), sum(a.o)
          FROM a JOIN b USING (resort_id, lead_day, local_date, win, k)
          GROUP BY a.lead_day, a.win, a.t, a.local_date""", [a_src, b_src]).fetchall()
        g: dict[tuple, list] = {}
        for r in recs:
            g.setdefault(r[:3], []).append(r[4:])
        for (lead, win, t), v in sorted(g.items()):
            x = np.array(v, dtype=float)
            idx = rng.integers(0, len(x), size=(N_BOOT, len(x)))
            ba, bb, bc = x[:, 0], x[:, 1], x[:, 2]
            if bc.sum() <= 0:
                continue
            d = (bb.sum() - ba.sum()) / bc.sum()  # BSS(a) − BSS(b)
            with np.errstate(all="ignore"):
                db = (bb[idx].sum(1) - ba[idx].sum(1)) / bc[idx].sum(1)
            h2h.append((a_src, b_src, lead, win, t, int(x[:, 3].sum()), int(x[:, 4].sum()),
                        1 - ba.sum() / bc.sum(), 1 - bb.sum() / bc.sum(), d,
                        float(np.nanpercentile(db, 5)), float(np.nanpercentile(db, 95))))
    con.execute("""CREATE TABLE h2h (a VARCHAR, b VARCHAR, lead_day INTEGER, win INTEGER, threshold DOUBLE, n INTEGER,
                   events INTEGER, bss_a DOUBLE, bss_b DOUBLE, diff DOUBLE, diff_lo DOUBLE, diff_hi DOUBLE)""")
    if h2h:
        con.executemany(f"INSERT INTO h2h VALUES ({', '.join('?' * 12)})", h2h)

    model = calibrate(con, rng)
    (out / "ens_calib.json").write_text(json.dumps(model, indent=1) + "\n")
    lowo = calibrate_lowo(con, rng)
    (out / "ens_calib_lowo.json").write_text(json.dumps(lowo, indent=1) + "\n")

    for name in ("scores", "region", "rel", "horizon", "h2h", "calib", "calrel", "lowo", "lowo_w", "winter_bss"):
        fname = {"rel": "reliability", "calrel": "reliability_calibrated", "calib": "calibration",
                 "lowo": "calibration_lowo", "lowo_w": "calibration_lowo_by_winter"}.get(name, name)
        con.execute(f"COPY (SELECT * FROM {name} ORDER BY ALL) TO '{out / f'longrange_{fname}.csv'}' (HEADER)")


# ------------------------------------------------------------------ calibration (2026-11-21)
# Brian: "Yes" to calibrating ensemble probabilities. Reliability showed the ensembles are
# overconfident at high probability (0.99 → ~0.78) and underconfident at low (0.11 → ~0.25).
# Method (plain arithmetic, two/three numbers per cell): extended logistic recalibration,
#   logit(p') = a + b·logit(p̃) + c·logit(climatology),   p̃ = (p·n + 0.5) / (n + 1)
# fitted per source × lead day × window × threshold by maximum likelihood (Newton, tiny ridge).
# Judged out of sample BOTH ways (fit 2024-25 → judge 2025-26, and the reverse), so one lucky
# winter can't promote it. A cell is promoted only if the Brier gain's 90% range is above 0
# in both directions. The same fits (on both winters) are also applied to Open-Meteo's copy of
# the same model — the app's days 7–10 — and judged on the live season (thin; report only).
CAL_SELF = ("dynamical-ens:ecmwf_ifs_ens", "dynamical-ens:gefs")
CAL_TRANSFER = {"open-meteo-ensemble:ecmwf_ifs025": "dynamical-ens:ecmwf_ifs_ens",
                "open-meteo-ensemble:gfs025": "dynamical-ens:gefs"}
CAL_RIDGE = 1e-3
CAL_MIN_EVENTS = 30


def _logit(x):
    x = np.clip(x, 1e-4, 1 - 1e-4)
    return np.log(x / (1 - x))


def _features(p, n, c):
    pt = (p * n + 0.5) / (n + 1)
    return np.column_stack([np.ones_like(p), _logit(pt), _logit(np.clip(c, 0.005, 0.995))])


def fit_logistic(X, y, ridge=CAL_RIDGE, iters=50):
    w = np.zeros(X.shape[1])
    R = ridge * len(y) * np.diag([0.0] + [1.0] * (X.shape[1] - 1))
    for _ in range(iters):
        z = np.clip(X @ w, -30, 30)
        q = 1 / (1 + np.exp(-z))
        g = X.T @ (q - y) + R @ w
        H = (X * (q * (1 - q))[:, None]).T @ X + R + 1e-9 * np.eye(X.shape[1])
        step = np.linalg.solve(H, g)
        w -= step
        if np.max(np.abs(step)) < 1e-8:
            break
    return w


def apply_logistic(w, X):
    return 1 / (1 + np.exp(-np.clip(X @ w, -30, 30)))


def calibrate(con, rng) -> dict:
    srcs = tuple(CAL_SELF) + tuple(CAL_TRANSFER)
    r = con.execute(f"""SELECT source_label, split, lead_day, win, t, datediff('day', DATE '1970-01-01', local_date) AS d,
                               p, CAST(n_mem AS DOUBLE) AS n, c, o FROM fl
                        WHERE c IS NOT NULL AND n_mem > 1 AND lead_day >= 1 AND source_label IN {srcs}
                        ORDER BY source_label, lead_day, win, t, split""").fetchnumpy()
    if not len(r["p"]):
        return {}
    keys = np.char.add(np.char.add(r["source_label"].astype(str), "|"),
                       np.char.add(np.char.add(r["lead_day"].astype(str), "|"),
                                   np.char.add(np.char.add(r["win"].astype(str), "|"), r["t"].astype(str))))
    split = r["split"].astype(str)
    data = np.column_stack([r["d"], r["p"], r["n"], r["c"], r["o"]]).astype(float)
    arr: dict[tuple, dict] = {}
    # Rows arrive sorted by cell, so each cell is one contiguous run.
    uk, start = np.unique(keys, return_index=True)
    order = np.argsort(start)
    starts = start[order]
    ends = np.append(starts[1:], len(keys))
    for i, lo_, hi_ in zip(order, starts, ends):
        src, lead, win, t = uk[i].split("|")
        sp = split[lo_:hi_]
        arr[(src, int(lead), int(win), float(t))] = {s: data[lo_:hi_][sp == s] for s in np.unique(sp)}

    def judge(w, a):
        X = _features(a[:, 1], a[:, 2], a[:, 3])
        q = apply_logistic(w, X)
        o, p, c, d = a[:, 4], a[:, 1], a[:, 3], a[:, 0]
        days, inv = np.unique(d, return_inverse=True)
        sr = np.bincount(inv, (p - o) ** 2, len(days))
        sq = np.bincount(inv, (q - o) ** 2, len(days))
        sc = np.bincount(inv, (c - o) ** 2, len(days))
        if sc.sum() <= 0:
            return None
        idx = rng.integers(0, len(days), size=(N_BOOT, len(days)))
        db = (sr[idx].sum(1) - sq[idx].sum(1)) / sc[idx].sum(1)
        return (len(a), int(o.sum()), 1 - sr.sum() / sc.sum(), 1 - sq.sum() / sc.sum(),
                (sr.sum() - sq.sum()) / sc.sum(), float(np.percentile(db, 5)), float(np.percentile(db, 95)), q)

    out, coef, rel = [], {}, []
    for (src, lead, win, t), sp in sorted(arr.items(), key=lambda kv: tuple(str(x) for x in kv[0])):
        if src not in CAL_SELF:
            continue
        for fit_s, judge_s in (("train", "test"), ("test", "train")):
            a, b = sp.get(fit_s), sp.get(judge_s)
            if a is None or b is None or a[:, 4].sum() < CAL_MIN_EVENTS:
                continue
            w = fit_logistic(_features(a[:, 1], a[:, 2], a[:, 3]), a[:, 4])
            j = judge(w, b)
            if j is None:
                continue
            out.append((src, src, fit_s, judge_s, lead, win, t, *j[:7], *w))
            if fit_s == "train" and judge_s == "test":
                for lo, hi_ in zip(REL_BINS[:-1], REL_BINS[1:]):
                    m = (j[7] >= lo) & (j[7] < hi_)
                    if m.any():
                        rel.append((src + " (calibrated)", win, t, lead, f"{lo:.2f}–{min(hi_, 1):.2f}", int(m.sum()),
                                    float(j[7][m].mean()), float(b[m, 4].mean())))
        both = [x for s in ("train", "test") if (x := sp.get(s)) is not None]
        if both:
            a = np.vstack(both)
            if a[:, 4].sum() >= CAL_MIN_EVENTS:
                coef[(src, lead, win, t)] = fit_logistic(_features(a[:, 1], a[:, 2], a[:, 3]), a[:, 4])
    # Transfer: the both-winters fit of the same model, applied to Open-Meteo's copy, judged live.
    for (src, lead, win, t), sp in arr.items():
        base = CAL_TRANSFER.get(src)
        if base is None or (base, lead, win, t) not in coef or "live" not in sp:
            continue
        j = judge(coef[(base, lead, win, t)], sp["live"])
        if j is not None:
            out.append((base, src, "train+test", "live", lead, win, t, *j[:7], *coef[(base, lead, win, t)]))
    # Dynamical's own live check of the both-winters fit (what would ship).
    for src in CAL_SELF:
        for (s2, lead, win, t), w in coef.items():
            if s2 != src or "live" not in arr.get((src, lead, win, t), {}):
                continue
            j = judge(w, arr[(src, lead, win, t)]["live"])
            if j is not None:
                out.append((src, src, "train+test", "live", lead, win, t, *j[:7], *w))
    con.execute("""CREATE TABLE calib (fit_source VARCHAR, apply_source VARCHAR, fit VARCHAR, judged VARCHAR,
                   lead_day INTEGER, win INTEGER, threshold DOUBLE, n INTEGER, events INTEGER, bss_raw DOUBLE,
                   bss_cal DOUBLE, gain DOUBLE, gain_lo DOUBLE, gain_hi DOUBLE, a DOUBLE, b DOUBLE, c DOUBLE)""")
    if out:
        con.executemany(f"INSERT INTO calib VALUES ({', '.join('?' * 17)})", out)
    con.execute("""CREATE TABLE calrel (source_label VARCHAR, win INTEGER, threshold DOUBLE, lead_day INTEGER,
                   p_bin VARCHAR, n INTEGER, mean_p DOUBLE, observed DOUBLE)""")
    if rel:
        con.executemany("INSERT INTO calrel VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rel)
    # Promotion: gain range above 0 in BOTH directions.
    prom = {}
    for src, lead, win, t, ok in con.execute("""
        SELECT fit_source, lead_day, win, threshold, count(*) = 2 AND bool_and(gain_lo > 0)
        FROM calib WHERE fit_source = apply_source AND judged IN ('test', 'train')
        GROUP BY ALL""").fetchall():
        prom[(src, lead, win, t)] = bool(ok)
    model = {"version": "ens-calib-v1",
             "form": "logit(p') = a + b*logit((p*n+0.5)/(n+1)) + c*logit(clim); clim = resort x month base rate",
             "fitted_on": "2024-25 + 2025-26 winters, SNOTEL/BC liquid, strict mid pairs",
             "promote_rule": "Brier gain 90% range > 0 judged both ways (fit 2024-25 -> 2025-26 and reverse)",
             "cells": [{"source": s, "lead_day": lead, "window_h": win, "threshold_mm": t,
                        "a": round(float(w[0]), 4), "b": round(float(w[1]), 4), "c": round(float(w[2]), 4),
                        "promoted": prom.get((s, lead, win, t), False)}
                       for (s, lead, win, t), w in sorted(coef.items(), key=lambda kv: tuple(str(x) for x in kv[0]))]}
    n_prom = sum(c["promoted"] for c in model["cells"])
    log(f"calibration: {len(model['cells'])} cells fitted, {n_prom} promoted (gain real both ways)")
    return model


LOWO_SOURCE = "dynamical-ens:gefs"  # the only ensemble with history before 2024-25
# Three forms, simplest first. "spread" only stretches or squeezes the member share (it can't
# learn a wet/dry year); "slope" adds a constant; "full" is ens-calib-v1's form.
LOWO_FORMS = {"spread": [1], "slope": [0, 1], "full": [0, 1, 2]}
LOWO_MIN_WINTERS = 4


def calibrate_lowo(con, rng) -> dict:
    """GEFS, leave one winter out: fit on every other past winter, judge on the one left out.

    A cell (form × lead × window × threshold) is promoted only if the pooled Brier gain over raw
    has a 90% date-block range above 0 AND the gain is positive in at least all-but-one of the
    held-out winters. This is the test ens-calib-v1 could not run with two winters.
    """
    r = con.execute(f"""SELECT split, lead_day, win, t, datediff('day', DATE '1970-01-01', local_date) AS d,
                               p, CAST(n_mem AS DOUBLE) AS n, c, o FROM fl
                        WHERE source_label = '{LOWO_SOURCE}' AND split <> 'live' AND c IS NOT NULL
                          AND n_mem > 1 AND lead_day >= 1""").fetchnumpy()
    con.execute("""CREATE TABLE winter_bss AS
        SELECT source_label, split AS winter, win, threshold, lead_day, n, events, bss, bss_lo, bss_hi
        FROM scores WHERE macro = 'ALL' AND split <> 'live' AND source_label = ?""", [LOWO_SOURCE])
    con.execute("""CREATE TABLE lowo (form VARCHAR, lead_day INTEGER, win INTEGER, threshold DOUBLE, winters INTEGER,
                   winters_better INTEGER, n INTEGER, events INTEGER, bss_raw DOUBLE, bss_cal DOUBLE, gain DOUBLE,
                   gain_lo DOUBLE, gain_hi DOUBLE, promote BOOLEAN)""")
    con.execute("""CREATE TABLE lowo_w (form VARCHAR, lead_day INTEGER, win INTEGER, threshold DOUBLE, winter VARCHAR,
                   n INTEGER, events INTEGER, gain DOUBLE)""")
    if not len(r["p"]):
        log("calibration LOWO: no GEFS rows")
        return {}
    sp = r["split"].astype(str)
    winters = sorted(set(sp))
    if len(winters) < LOWO_MIN_WINTERS:
        log(f"calibration LOWO: only {len(winters)} winters with GEFS + truth ({', '.join(winters)}); "
            f"needs {LOWO_MIN_WINTERS}. Not judged.")
        return {"winters": winters, "judged": False}
    X_all = _features(r["p"], r["n"], r["c"])
    o_all, p_all, c_all, d_all = r["o"].astype(float), r["p"].astype(float), r["c"].astype(float), r["d"]
    cell = np.char.add(np.char.add(r["lead_day"].astype(str), "|"),
                       np.char.add(np.char.add(r["win"].astype(str), "|"), r["t"].astype(str)))
    rows, wrows, cells_out = [], [], []
    for key in np.unique(cell):
        m = cell == key
        lead, win, t = key.split("|")
        lead, win, t = int(lead), int(win), float(t)
        for form, cols in LOWO_FORMS.items():
            X = X_all[m][:, cols]
            o, p, c, d, w_ = o_all[m], p_all[m], c_all[m], d_all[m], sp[m]
            q = np.full(len(o), np.nan)
            better = used = 0
            for held in winters:
                tr, te = w_ != held, w_ == held
                if te.sum() == 0 or o[tr].sum() < CAL_MIN_EVENTS:
                    continue
                if form == "spread":
                    # No intercept: logit q = b·logit p.
                    w = fit_logistic(np.column_stack([np.zeros(tr.sum()), X[tr]]), o[tr])
                    q[te] = apply_logistic(np.r_[0.0, w[1:]], np.column_stack([np.zeros(te.sum()), X[te]]))
                else:
                    w = fit_logistic(X[tr], o[tr])
                    q[te] = apply_logistic(w, X[te])
                g = (((p[te] - o[te]) ** 2).sum() - ((q[te] - o[te]) ** 2).sum()) / max(((c[te] - o[te]) ** 2).sum(), 1e-12)
                wrows.append((form, lead, win, t, held, int(te.sum()), int(o[te].sum()), float(g)))
                used += 1
                better += g > 0
            ok = ~np.isnan(q)
            if used < LOWO_MIN_WINTERS or not ok.any():
                continue
            days, inv = np.unique(d[ok], return_inverse=True)
            sr = np.bincount(inv, (p[ok] - o[ok]) ** 2, len(days))
            sq = np.bincount(inv, (q[ok] - o[ok]) ** 2, len(days))
            sc = np.bincount(inv, (c[ok] - o[ok]) ** 2, len(days))
            if sc.sum() <= 0:
                continue
            idx = rng.integers(0, len(days), size=(N_BOOT, len(days)))
            gb = (sr[idx].sum(1) - sq[idx].sum(1)) / sc[idx].sum(1)
            gain, lo, hi = (sr.sum() - sq.sum()) / sc.sum(), float(np.percentile(gb, 5)), float(np.percentile(gb, 95))
            prom = bool(lo > 0 and better >= used - 1)
            rows.append((form, lead, win, t, used, int(better), int(ok.sum()), int(o[ok].sum()),
                         1 - sr.sum() / sc.sum(), 1 - sq.sum() / sc.sum(), gain, lo, hi, prom))
            if prom:
                w = fit_logistic(X, o) if form != "spread" else fit_logistic(np.column_stack([np.zeros(len(o)), X]), o)
                cells_out.append({"form": form, "lead_day": lead, "window_h": win, "threshold_mm": t,
                                  "coef": [round(float(x), 4) for x in (w if form != "spread" else w[1:])]})
    if rows:
        con.executemany(f"INSERT INTO lowo VALUES ({', '.join('?' * 14)})", rows)
    if wrows:
        con.executemany(f"INSERT INTO lowo_w VALUES ({', '.join('?' * 8)})", wrows)
    log(f"calibration LOWO (GEFS, {len(winters)} winters: {', '.join(winters)}): "
        f"{len(rows)} cells judged, {sum(x[-1] for x in rows)} promoted")
    return {"version": "ens-calib-lowo-v1", "source": LOWO_SOURCE, "winters": winters, "judged": True,
            "forms": {k: [("intercept", "logit p", "logit clim")[i] for i in v] for k, v in LOWO_FORMS.items()},
            "promote_rule": "pooled leave-one-winter-out Brier gain 90% range > 0 and gain > 0 in all but at most one winter",
            "promoted_cells_fit_on_all_winters": cells_out}


def md(con, sql: str, empty: str = "_no data yet_") -> str:
    rel = con.execute(sql)
    cols = [d[0] for d in rel.description]
    rows = rel.fetchall()
    if not rows:
        return empty + "\n"
    fmt = lambda v: "—" if v is None or (isinstance(v, float) and np.isnan(v)) else (
        f"{v:.2f}" if isinstance(v, float) else str(v))
    lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    lines += ["| " + " | ".join(fmt(v) for v in r) + " |" for r in rows]
    return "\n".join(lines) + "\n"


def bss_pivot(con, split: str, win: int, t: float) -> str:
    leads = ", ".join(f"'{lead}'" for lead in range(0, MAX_LEAD + 1))
    return md(con, f"""
      PIVOT (SELECT source_label AS source, CAST(lead_day AS VARCHAR) AS lead,
                    CASE WHEN thin THEN printf('%.2f*', bss) ELSE printf('%.2f', bss) END ||
                    CASE WHEN bss_lo > 0 THEN '' ELSE ' ~' END AS v
             FROM scores WHERE split = '{split}' AND macro = 'ALL' AND win = {win} AND threshold = {t})
      ON lead IN ({leads}) USING any_value(v) GROUP BY source ORDER BY source""")


def cal_pivot(con, fit: str, judged: str) -> str:
    leads = ", ".join(f"'{lead}'" for lead in range(1, MAX_LEAD + 1))
    return md(con, f"""
      PIVOT (SELECT fit_source || ' ' || win || 'h≥' || threshold AS row, CAST(lead_day AS VARCHAR) AS lead,
                    printf('%+.2f', gain) || CASE WHEN gain_lo > 0 OR gain_hi < 0 THEN '' ELSE ' ~' END AS v
             FROM calib WHERE fit = '{fit}' AND judged = '{judged}' AND fit_source = apply_source)
      ON lead IN ({leads}) USING any_value(v) GROUP BY row ORDER BY row""")


def report(con) -> str:
    p = ["# Long-range verification (days 0–15)\n",
         "Public models + public truth only. Liquid water vs SNOTEL / BC ASWS SWE gain, strict mid-tier pairs.",
         "**BSS** = Brier skill vs the same resort and month's rate in the other winter(s): above 0 beats climatology.",
         "`~` = the 90% range includes 0 (not shown to beat climatology). `*` = fewer than 20 observed events (thin).",
         "Lead = days from the init's resort-local date. Truth: 2024-25 = train, 2025-26 = test, 2026-27 = live.\n",
         "## Useful horizon (last day, counting up from day 1, where skill over climatology is real at 90%)\n",
         md(con, """SELECT source_label AS source, split, win || ' h' AS hours, threshold AS mm,
                    skill_through_day AS skill_thru, resort_beats_region_through_day AS resort_beats_region_thru,
                    last_scored_lead AS last_lead
                    FROM horizon WHERE split IN ('test', 'train', 'live') ORDER BY split DESC, hours, mm, source"""),
         ]
    for split in ("test", "live"):
        for win, ts in THR.items():
            for t in ts[1:]:
                p += [f"\n## BSS by lead — {split}, {win} h ≥ {t:g} mm\n", bss_pivot(con, split, win, t)]
    p += ["\n## GEFS, winter by winter: raw BSS (one row per winter; stable skill = similar rows)\n",
          md(con, """PIVOT (SELECT win || 'h≥' || threshold AS cell, winter, 'd' || lead_day AS lead,
                            printf('%.2f', bss) || CASE WHEN bss_lo > 0 THEN '' ELSE ' ~' END AS v
                     FROM winter_bss WHERE (win = 24 AND threshold = 10) OR (win = 72 AND threshold = 25))
                     ON lead IN ('d1', 'd3', 'd5', 'd7', 'd8', 'd10', 'd12', 'd14', 'd15') USING any_value(v)
                     GROUP BY cell, winter ORDER BY cell, winter"""),
          "\n## Calibration, GEFS leave-one-winter-out (fit on the other winters, judged on each in turn)\n",
          "gain = pooled BSS(calibrated) − BSS(raw); `better` = held-out winters where it helped. ✓ = promoted",
          "(pooled gain range > 0 and helped in all but at most one winter). Forms: spread = b·logit p;",
          "slope = a + b·logit p; full = a + b·logit p + c·logit clim.\n",
          md(con, """PIVOT (SELECT form || ' ' || win || 'h≥' || threshold AS row, 'd' || lead_day AS lead,
                            printf('%+.2f', gain) || ' ' || winters_better || '/' || winters ||
                            CASE WHEN promote THEN ' ✓' WHEN gain_lo > 0 OR gain_hi < 0 THEN '' ELSE ' ~' END AS v
                     FROM lowo WHERE threshold IN (10, 20, 25, 50))
                     ON lead IN ('d1', 'd3', 'd5', 'd7', 'd8', 'd10', 'd12', 'd14', 'd15') USING any_value(v)
                     GROUP BY row ORDER BY row""", "_not judged: fewer than 4 winters with GEFS and truth_"),
          "\n## Calibration (ens-calib-v1): Brier skill gain over the raw ensemble, judged out of sample\n",
          "gain = BSS(calibrated) − BSS(raw). `~` = 90% range includes 0. Promoted = real gain in BOTH directions.\n",
          "Fit 2024-25 → judged 2025-26:\n",
          cal_pivot(con, "train", "test"),
          "\nFit 2025-26 → judged 2024-25 (the reverse, so one winter can't carry it):\n",
          cal_pivot(con, "test", "train"),
          "\nPromoted cells (of fitted):\n",
          md(con, """SELECT fit_source AS source, win || ' h' AS hours, threshold AS mm,
                     count(*) FILTER (WHERE ok) AS promoted, count(*) AS leads,
                     string_agg(CASE WHEN ok THEN CAST(lead_day AS VARCHAR) END, ',' ORDER BY lead_day) AS promoted_leads
                     FROM (SELECT fit_source, win, threshold, lead_day, count(*) = 2 AND bool_and(gain_lo > 0) AS ok
                           FROM calib WHERE fit_source = apply_source AND judged IN ('test', 'train') GROUP BY ALL)
                     GROUP BY ALL ORDER BY source, hours, mm"""),
          "\nBoth-winter fit applied live: dynamical.org's own ensembles, and Open-Meteo's copy (the app's days 7–10). Thin.\n",
          md(con, """SELECT apply_source AS source, win || ' h' AS hours, threshold AS mm, lead_day AS lead, n, events,
                     round(bss_raw, 2) AS raw, round(bss_cal, 2) AS cal,
                     printf('%.2f', gain) || CASE WHEN gain_lo > 0 OR gain_hi < 0 THEN '' ELSE ' ~' END AS gain
                     FROM calib WHERE judged = 'live' AND ((win = 24 AND threshold = 10) OR (win = 72 AND threshold = 25))
                       AND lead_day IN (1, 3, 5, 7, 8, 9, 10, 12, 14) ORDER BY source, hours, lead"""),
          "\nReliability after calibration (fit 2024-25, judged 2025-26), 72 h ≥ 25 mm, days 4–10 pooled:\n",
          md(con, """SELECT source_label AS source, p_bin, sum(n) AS n, round(sum(mean_p * n) / sum(n), 2) AS forecast,
                     round(sum(observed * n) / sum(n), 2) AS happened
                     FROM calrel WHERE win = 72 AND threshold = 25 AND lead_day BETWEEN 4 AND 10
                     GROUP BY ALL ORDER BY source, p_bin"""),
          "\n## Same model, two pipes, live season, identical resort-days (a = what the app's days 7–10 use)\n",
          "diff = BSS(a) − BSS(b); `~` = its 90% range includes 0.\n",
          md(con, """SELECT a, b, win || ' h' AS hours, threshold AS mm, lead_day AS lead, n, events,
                     round(bss_a, 2) AS bss_a, round(bss_b, 2) AS bss_b,
                     printf('%.2f', diff) || CASE WHEN diff_lo > 0 OR diff_hi < 0 THEN '' ELSE ' ~' END AS diff
                     FROM h2h WHERE (win = 24 AND threshold = 10) OR (win = 72 AND threshold = 25)
                     ORDER BY a, hours, mm, lead"""),
          "\n## Ensemble-mean hit rates, test winter, 72 h ≥ 25 mm, ALL\n",
          md(con, """SELECT source_label AS source, lead_day AS lead, n, events, round(base_rate, 2) AS base,
                     round(pod, 2) AS pod, round(far, 2) AS far, round(csi, 2) AS csi, round(freq_bias, 2) AS bias
                     FROM scores WHERE split = 'test' AND macro = 'ALL' AND win = 72 AND threshold = 25
                     AND lead_day IN (1, 3, 5, 7, 8, 10, 12, 15) ORDER BY source, lead"""),
          "\n## By region, test winter, 72 h ≥ 25 mm: BSS at days 3 / 7 / 10 / 14\n",
          md(con, """PIVOT (SELECT source_label AS source, macro AS region, 'd' || lead_day AS lead,
                            printf('%.2f', bss) || CASE WHEN bss_lo > 0 THEN '' ELSE ' ~' END AS v
                     FROM scores WHERE split = 'test' AND win = 72 AND threshold = 25 AND macro <> 'ALL'
                       AND lead_day IN (3, 7, 10, 14))
                     ON lead IN ('d3', 'd7', 'd10', 'd14') USING any_value(v) GROUP BY source, region ORDER BY region, source"""),
          "\n## Resort vs region: skill of the resort's own probability over its region's average (test, ALL)\n",
          "Above 0 (and not `~`) = resort-level numbers add information at that lead.\n",
          md(con, """PIVOT (SELECT source_label || ' ' || win || 'h≥' || threshold AS row, 'd' || lead_day AS lead,
                            printf('%.2f', resort_gain) || CASE WHEN gain_lo > 0 THEN '' ELSE ' ~' END AS v
                     FROM region WHERE split = 'test' AND macro = 'ALL' AND threshold IN (10, 25))
                     ON lead IN ('d1', 'd3', 'd5', 'd7', 'd8', 'd10', 'd12', 'd15') USING any_value(v)
                     GROUP BY row ORDER BY row"""),
          "\n## Reliability, test winter, 72 h ≥ 25 mm (does a 40% chance happen 40% of the time?)\n",
          md(con, """SELECT source_label AS source, leads, p_bin, n, round(mean_p, 2) AS forecast, round(observed, 2) AS happened
                     FROM rel WHERE split = 'test' AND win = 72 AND threshold = 25 AND leads IN ('4-7', '8-10', '11-15')
                     ORDER BY source, leads, p_bin"""),
          "\n## Sample size\n",
          md(con, """SELECT source_label AS source, split, min(local_date) AS first_day, max(local_date) AS last_day,
                     count(DISTINCT resort_id) AS resorts, max(lead_day) AS max_lead, count(*) AS forecast_days
                     FROM fl WHERE win = 24 AND k = 1 GROUP BY ALL ORDER BY split, source"""),
          ]
    return "\n".join(p) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("archive", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--resorts", type=Path, default=Path("src/data/resorts.json"))
    a = ap.parse_args()
    con = duckdb.connect()
    con.execute("SET preserve_insertion_order = false")
    setup(con, a.out, a.resorts)
    climatology(con)
    tmp = a.out / "longrange_tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    parts = dynamical(con, a.archive, tmp) + from_pairs(con, a.out, tmp)
    score(con, parts, a.out)
    (a.out / "longrange_report.md").write_text(report(con))
    log("wrote longrange_report.md")


if __name__ == "__main__":
    main()

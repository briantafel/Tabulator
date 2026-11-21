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


def split_of(winter_sql: str) -> str:
    return f"CASE WHEN {winter_sql} = 2024 THEN 'train' WHEN {winter_sql} = 2025 THEN 'test' WHEN {winter_sql} >= 2026 THEN 'live' END"


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
    con.executemany("INSERT INTO sp VALUES (?, ?)", [("train", "test"), ("test", "train"), ("live", "train"), ("live", "test")])
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

    for name in ("scores", "region", "rel", "horizon", "h2h"):
        fname = {"rel": "reliability"}.get(name, name)
        con.execute(f"COPY (SELECT * FROM {name} ORDER BY ALL) TO '{out / f'longrange_{fname}.csv'}' (HEADER)")


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
    p += ["\n## Same model, two pipes, live season, identical resort-days (a = what the app's days 7–10 use)\n",
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

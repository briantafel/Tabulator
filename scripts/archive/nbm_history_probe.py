#!/usr/bin/env python3
"""NBM history probe (plan-near-term-models step 2, 2026-11-23). READ-ONLY: lists NOAA's bucket, downloads a few
byte ranges for timing, uploads and marks nothing. Decides nothing; Brian decides on the backfill from this report.

    python3 scripts/archive/nbm_history_probe.py <outDir> [--start 2024-11-01] [--end 2026-04-30] [--days 1,8,15,22]
                                                 [--time-cycles 2024111512,2025021000,...] [--recent]

1. Listing: for each sample date and each of the 00/06/12/18z cycles, what is in blend.YYYYMMDD/HH/core/ :
   number of CONUS core files, last lead, whether every 6 h lead 6..120 is there (what the terrain map needs), total
   size of all core.co files (what a full-file download would cost), and the .idx size.
2. Timing: for a few cycles, run the real collector (nbm.collect_cycle) on the bucket, count the bytes it downloads
   and the seconds it takes, and say whether the old files still parse (snow level / SLR / ASNOW names, grid).
3. --recent: yesterday and today, every cycle, to see the 06z/18z horizon now.
Writes <outDir>/nbm_history.md (also appended to $GITHUB_STEP_SUMMARY).
"""
from __future__ import annotations

import re
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import nbm  # noqa: E402

CYCLES = (0, 6, 12, 18)
NEED = list(range(6, 121, 6))


def parse_listing(xml: str) -> dict:
    """ListObjectsV2 XML for blend.DATE/HH/core/ -> {'leads': {lead: size}, 'idx': {lead: size}, 'truncated': bool}.
    Only the CONUS (co) core GRIB files count; their .idx files are tallied apart."""
    leads, idx = {}, {}
    for key, size in re.findall(r"<Key>([^<]+)</Key>.*?<Size>(\d+)</Size>", xml, re.S):
        m = re.search(r"core\.f(\d{3})\.co\.grib2(\.idx)?$", key)
        if not m:
            continue
        (idx if m.group(2) else leads)[int(m.group(1))] = int(size)
    return {"leads": leads, "idx": idx, "truncated": "<IsTruncated>true</IsTruncated>" in xml}


def list_cycle(day: date, hour: int) -> dict:
    """Follows continuation tokens: a cycle's core/ folder holds more than 1000 keys (regional files, .idx), and the
    first probe run stopped at the first page, which cut the last lead of every 00z/12z cycle short."""
    prefix = f"blend.{day:%Y%m%d}/{hour:02d}/core/"
    out, token = {"leads": {}, "idx": {}, "truncated": False}, None
    for _ in range(20):
        q = f"?list-type=2&prefix={prefix}&max-keys=1000" + (f"&continuation-token={urllib.parse.quote(token)}" if token else "")
        xml = nbm.http(f"{nbm.BUCKET_URL}/{q}").decode()
        page = parse_listing(xml)
        out["leads"].update(page["leads"])
        out["idx"].update(page["idx"])
        nxt = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", xml)
        if not nxt:
            break
        token = nxt.group(1)
    else:
        out["truncated"] = True   # 20 pages and still more: say so rather than report a short cycle as complete
    out["day"], out["hour"] = day, hour
    return out


def cycle_exists(day: date, hour: int) -> bool:
    prefix = f"blend.{day:%Y%m%d}/{hour:02d}/core/"
    xml = nbm.http(f"{nbm.BUCKET_URL}/?list-type=2&prefix={prefix}&max-keys=5").decode()
    return "<Key>" in xml


def all_days_scan(start: date, end: date) -> str:
    """Does every day's 00/06/12/18z cycle exist? One max-keys=5 listing each (~2,200 requests)."""
    days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    jobs = [(d, h) for d in days for h in CYCLES]

    def run(job):
        try:
            return job, cycle_exists(*job)
        except Exception as e:  # noqa: BLE001
            return job, f"error {str(e)[:40]}"

    with ThreadPoolExecutor(max_workers=8) as pool:
        res = list(pool.map(run, jobs))
    by: dict[tuple[str, int], list[int]] = {}
    bad = []
    for (d, h), ok in res:
        by.setdefault((f"{d:%Y-%m}", h), []).append(1 if ok is True else 0)
        if ok is not True:
            bad.append(f"{d} {h:02d}z ({ok if ok is not False else 'missing'})")
    months = sorted({k[0] for k in by})
    lines = [f"Every day {start} .. {end}: cycles present / days in month", "", "| month | 00z | 06z | 12z | 18z |", "|---|---|---|---|---|"]
    for m in months:
        lines.append(f"| {m} | " + " | ".join(f"{sum(by[(m, h)])}/{len(by[(m, h)])}" for h in CYCLES) + " |")
    lines += ["", f"{len(bad)} missing of {len(jobs)} cycles." + (" First 40: " + ", ".join(bad[:40]) if bad else "")]
    return "\n".join(lines)


def summarize(entry: dict) -> dict:
    leads = entry["leads"]
    return {"files": len(leads), "last": max(leads) if leads else None,
            "has_120": all(l in leads for l in NEED), "grib_mb": sum(leads.values()) / 1e6,
            "idx_kb": sum(entry["idx"].values()) / 1e3, "truncated": entry["truncated"]}


def sample_days(start: date, end: date, dom: list[int]) -> list[date]:
    out, d = [], date(start.year, start.month, 1)
    while d <= end:
        for n in dom:
            try:
                x = date(d.year, d.month, n)
            except ValueError:
                continue
            if start <= x <= end:
                out.append(x)
        d = date(d.year + (d.month == 12), d.month % 12 + 1, 1)
    return out


def listing_table(days: list[date], cycles=CYCLES) -> tuple[str, list[dict]]:
    jobs = [(d, h) for d in days for h in cycles]

    def run(job):
        try:
            return list_cycle(*job)
        except Exception as e:  # a 403/404 on an old prefix is an answer, not a crash
            return {"day": job[0], "hour": job[1], "leads": {}, "idx": {}, "truncated": False, "error": str(e)[:80]}

    with ThreadPoolExecutor(max_workers=8) as pool:
        entries = list(pool.map(run, jobs))
    lines = ["| date | cycle | core files | last lead | leads 6..120 all there | core GRIB total MB | note |", "|---|---|---:|---:|---|---:|---|"]
    for e in entries:
        s = summarize(e)
        note = e.get("error") or ("listing truncated at 1000 keys" if s["truncated"] else "")
        lines.append(f"| {e['day']} | {e['hour']:02d}z | {s['files']} | {s['last'] if s['last'] is not None else '-'} | "
                     f"{'yes' if s['has_120'] else 'no'} | {s['grib_mb']:.0f} | {note} |")
    return "\n".join(lines), entries


def coverage_by_month(entries: list[dict]) -> str:
    """cycle x month: how many sampled cycles exist (files > 0) of how many sampled."""
    by: dict[tuple[str, int], list[int]] = {}
    for e in entries:
        k = (f"{e['day']:%Y-%m}", e["hour"])
        by.setdefault(k, []).append(1 if e["leads"] else 0)
    months = sorted({k[0] for k in by})
    lines = ["| month | 00z | 06z | 12z | 18z |", "|---|---|---|---|---|"]
    for m in months:
        cells = []
        for h in CYCLES:
            v = by.get((m, h), [])
            cells.append(f"{sum(v)}/{len(v)}" if v else "-")
        lines.append(f"| {m} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


class ByteCounter:
    def __init__(self):
        self.n = 0
        self._orig = nbm.http

    def __enter__(self):
        def counting(url, headers=None, retries=3, timeout=60):
            b = self._orig(url, headers=headers, retries=retries, timeout=timeout)
            self.n += len(b)
            return b
        nbm.http = counting
        return self

    def __exit__(self, *a):
        nbm.http = self._orig


def time_cycles(cycles: list[datetime]) -> str:
    import json
    resorts = [r for r in json.loads((nbm.ROOT / "src/data/resorts.json").read_text())["resorts"] if r.get("latlon") or r.get("nws")]
    for r in resorts:
        r["latlon"] = r.get("latlon") or r.get("nws")
    resorts = [r for r in resorts if 15 < r["latlon"][0] < 60 and -140 < r["latlon"][1] < -50]
    lines = ["| cycle | result | rows | variables | seconds | MB downloaded |", "|---|---|---:|---|---:|---:|"]
    for c in cycles:
        t = time.time()
        with ByteCounter() as bc:
            try:
                rows = nbm.collect_cycle(c, resorts, nbm.iso(datetime.now(timezone.utc)), "probe")
                res, soft = "parsed", ""
            except nbm.MissingSnowLevel as e:
                rows, res, soft = e.rows, "parsed, NO snow level", ""
            except Exception as e:  # noqa: BLE001
                rows, res, soft = [], f"FAILED: {str(e)[:90]}", ""
        v = sorted({r["variable"] for r in rows})
        lines.append(f"| {c:%Y-%m-%d %Hz} | {res} | {len(rows)} | {', '.join(v)} | {time.time() - t:.0f} | {bc.n / 1e6:.0f} |")
        print(lines[-1], file=sys.stderr, flush=True)
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    out = Path(argv[0])
    out.mkdir(parents=True, exist_ok=True)

    def opt(name, default):
        return argv[argv.index(name) + 1] if name in argv else default

    start, end = date.fromisoformat(opt("--start", "2024-11-01")), date.fromisoformat(opt("--end", "2026-04-30"))
    dom = [int(x) for x in opt("--days", "1,8,15,22").split(",")]
    md = [f"# NBM bucket history probe ({datetime.now(timezone.utc):%Y-%m-%d %H:%MZ})", ""]
    days = sample_days(start, end, dom)
    table, entries = listing_table(days)
    md += [f"## Sampled dates {start} .. {end} (days {dom} of each month): do the cycles exist?", "", coverage_by_month(entries), ""]
    have = [e for e in entries if e["leads"]]
    md += [f"{len(have)} of {len(entries)} sampled cycles have core CONUS files.", ""]
    if have:
        sizes = [summarize(e)["grib_mb"] for e in have]
        md += [f"Whole core files per cycle: median {sorted(sizes)[len(sizes) // 2]:.0f} MB (the collector reads only byte ranges, see the timing table).", ""]
    md += ["<details><summary>Every sampled cycle</summary>", "", table, "", "</details>", ""]
    if "--all-days" in argv:
        md += ["## Existence of every cycle, day by day", "", all_days_scan(start, end), ""]
    if "--recent" in argv:
        today = datetime.now(timezone.utc).date()
        rt, _ = listing_table([today - timedelta(days=1), today])
        md += ["## Yesterday and today, every cycle (the 06z/18z horizon now)", "", rt, ""]
    tc = opt("--time-cycles", "")
    if tc:
        cyc = [datetime.strptime(x, "%Y%m%d%H").replace(tzinfo=timezone.utc) for x in tc.split(",") if x]
        md += ["## Real collector on old cycles: does it parse, how long, how many bytes?", "", time_cycles(cyc), ""]
    text = "\n".join(md) + "\n"
    (out / "nbm_history.md").write_text(text)
    print(text)
    import os
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

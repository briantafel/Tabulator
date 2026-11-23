"""Tests for nbm_history_probe.py's pure parts (no network). Run as a plain script: python3 scripts/archive/test_nbm_history_probe.py"""
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import nbm_history_probe as p  # noqa: E402

XML = """<ListBucketResult><IsTruncated>false</IsTruncated>
<Contents><Key>blend.20250115/12/core/blend.t12z.core.f006.co.grib2</Key><LastModified>x</LastModified><Size>1000000</Size></Contents>
<Contents><Key>blend.20250115/12/core/blend.t12z.core.f006.co.grib2.idx</Key><LastModified>x</LastModified><Size>5000</Size></Contents>
<Contents><Key>blend.20250115/12/core/blend.t12z.core.f006.ak.grib2</Key><LastModified>x</LastModified><Size>999</Size></Contents>
<Contents><Key>blend.20250115/12/core/blend.t12z.core.f012.co.grib2</Key><LastModified>x</LastModified><Size>2000000</Size></Contents>
</ListBucketResult>"""


def main():
    e = p.parse_listing(XML)
    assert e["leads"] == {6: 1000000, 12: 2000000}, e          # CONUS only: the .ak file and the .idx do not count
    assert e["idx"] == {6: 5000}, e
    e["day"], e["hour"] = date(2025, 1, 15), 12
    s = p.summarize(e)
    assert s["files"] == 2 and s["last"] == 12 and not s["has_120"] and abs(s["grib_mb"] - 3.0) < 1e-9, s
    full = {"leads": {l: 1 for l in p.NEED}, "idx": {}, "truncated": False}
    assert p.summarize(full)["has_120"]
    assert not p.summarize({"leads": {}, "idx": {}, "truncated": False})["files"]
    days = p.sample_days(date(2024, 11, 1), date(2025, 1, 10), [1, 8, 15, 22])
    assert days[0] == date(2024, 11, 1) and days[-1] == date(2025, 1, 8) and len(days) == 4 + 4 + 2, days
    assert p.sample_days(date(2025, 2, 2), date(2025, 2, 20), [30, 8]) == [date(2025, 2, 8)]   # no Feb 30
    cov = p.coverage_by_month([{"day": date(2025, 1, 1), "hour": 0, "leads": {6: 1}}, {"day": date(2025, 1, 8), "hour": 0, "leads": {}}])
    assert "| 2025-01 | 1/2 | - | - | - |" in cov, cov
    # a cycle's core/ folder is longer than one 1000-key page: the listing must follow the continuation token
    pages = iter([
        '<R><Contents><Key>blend.20250115/12/core/blend.t12z.core.f006.co.grib2</Key><Size>10</Size></Contents>'
        '<NextContinuationToken>T1</NextContinuationToken></R>',
        '<R><Contents><Key>blend.20250115/12/core/blend.t12z.core.f264.co.grib2</Key><Size>20</Size></Contents></R>'])
    urls, orig = [], p.nbm.http
    p.nbm.http = lambda url, **k: (urls.append(url), next(pages).encode())[1]
    try:
        e2 = p.list_cycle(date(2025, 1, 15), 12)
    finally:
        p.nbm.http = orig
    assert e2["leads"] == {6: 10, 264: 20} and not e2["truncated"], e2
    assert len(urls) == 2 and "continuation-token=T1" in urls[1], urls
    print("nbm history probe: all checks passed")


if __name__ == "__main__":
    main()

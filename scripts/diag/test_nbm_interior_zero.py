import sys, os, tempfile, datetime as dt, random
import pandas as pd, duckdb
sys.path.insert(0, os.path.dirname(__file__))
import nbm_interior_zero as Z
random.seed(1)
rows = []
def add(resort, fcf, n=60, obs=8.0, pq="strict"):
    for i in range(n):
        d = dt.date(2025, 1, 1) + dt.timedelta(days=i)
        rows.append(dict(source="nbm", space="liquid", pair_quality=pq, tier="mid", resort_id=resort, local_date=d, lead_day=1, lead_hours=14.0,
                         issue_ts=dt.datetime(d.year, d.month, d.day) - dt.timedelta(hours=12), obs=obs, fc_amount=fcf(i), station_km=10.0, truth_source='bc-asws'))
add("alta", lambda i: 6.0); add("jackson-hole", lambda i: 4.0)
add("fernie", lambda i: 0.0)                      # stored zero
add("sunshine", lambda i: 1.5)                    # real but dry bias
add("panorama", lambda i: 6.0)                    # plausible
add("kimberley", lambda i: 6.0, n=5)              # thin
add("norquay", lambda i: 0.0, pq="loose")         # only loose truth
df = pd.DataFrame(rows); p = os.path.join(tempfile.mkdtemp(), "pairs.parquet")
duckdb.sql(f"COPY (SELECT * FROM df) TO '{p}' (FORMAT PARQUET)")
S, bad = Z.main(p, os.path.join(os.path.dirname(p), "out"))
v = {k: s["verdict"] for k, s in S.items()}
assert v["fernie"] == "STORED ZERO" and v["sunshine"] == "DRY BIAS" and v["panorama"] == "PLAUSIBLE" and v["kimberley"] == "THIN", v
assert not bad, bad
print("OK")

v2 = {k: s["verdict"] for k, s in Z.main(p, os.path.join(os.path.dirname(p), "out2"), True)[0].items()}
assert v2["norquay"] == "STORED ZERO" and v["norquay"] == "THIN" and v2["fernie"] == "STORED ZERO", (v, v2)
print("OK loose")

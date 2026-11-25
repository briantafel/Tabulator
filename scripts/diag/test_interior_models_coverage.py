import sys, os, tempfile, datetime as dt
import pandas as pd, duckdb
sys.path.insert(0, os.path.dirname(__file__))
import interior_models_coverage as I

def rows(src, resort, vals, run="r1"):
    t0 = dt.datetime(2026, 11, 12)
    return [dict(kind="forecast", source=src, resort_id=resort, variable="precip", value=v, run_id=run, model=src,
                 valid_start=t0 + dt.timedelta(hours=6 * i), valid_end=t0 + dt.timedelta(hours=6 * (i + 1))) for i, v in enumerate(vals)]

d = tempfile.mkdtemp()
def put(src, rs):
    p = os.path.join(d, f"source={src}", "month=2026-11"); os.makedirs(p, exist_ok=True)
    df = pd.DataFrame(rs); duckdb.sql(f"COPY (SELECT * FROM df) TO '{os.path.join(p, 'a.parquet')}' (FORMAT PARQUET)")
wet = [2.0] * 40
put("open-meteo-forecast", sum((rows("open-meteo-forecast", r, wet) for r in I.POOL + ("alta", "jackson-hole", "whistler", "revelstoke")), []))
nbm = rows("nbm", "fernie", [0.0] * 40) + rows("nbm", "marmot", [0.0] * 40) + rows("nbm", "sunshine", [1.5] * 40)
nbm += rows("nbm", "alta", [2.5] * 40) + rows("nbm", "jackson-hole", [1.0] * 40) + rows("nbm", "kimberley", [0.0] * 5)
put("nbm", nbm); put("noaa-hrrr", rows("noaa-hrrr", "alta", [2.0] * 40) + rows("noaa-hrrr", "jackson-hole", [2.0] * 40))
put("msc-hrdps", rows("msc-hrdps", "whistler", [2.0] * 40) + rows("msc-hrdps", "revelstoke", [2.0] * 40))
r, bad = I.main(d, os.path.join(d, "out"))
v = {(x["src"], x["resort"]): x["verdict"] for x in r}
assert v[("nbm", "fernie")] == "STORED ZERO" and v[("nbm", "marmot")] == "STORED ZERO", v
assert v[("nbm", "sunshine")] == "PLAUSIBLE"
assert v[("nbm", "panorama")] == "NO ROWS"
assert v[("nbm", "kimberley")] == "THIN"
assert not bad, bad
print("OK")

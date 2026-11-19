"""Check how NBM GRIB values line up with eccodes' latitudes/longitudes (maps sketch
showed E-W streaks over a N-S ridge). Prints grid keys and a smoothness test."""
import os, sys, math
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "archive"))
import nbm, eccodes
from datetime import datetime, timedelta, timezone

now = datetime.now(timezone.utc)
for back in range(4):
    c = (now - timedelta(hours=3 + 12 * back)).replace(minute=0, second=0, microsecond=0)
    cycle = c.replace(hour=0 if c.hour < 12 else 12)
    leads = nbm.list_leads(cycle)
    if 24 in leads:
        break
key = leads[24]
idx = nbm.parse_idx(nbm.http(f"{nbm.BUCKET_URL}/{key}.idx").decode())
for var, lvl, fc in [("ASNOW", "surface", "18-24 hour acc fcst"), ("TMP", "2 m above ground", "24 hour fcst")]:
    rng = nbm.pick(idx, var, lvl, fc)
    raw = nbm.http(f"{nbm.BUCKET_URL}/{key}", headers={"Range": f"bytes={rng[0]}-{rng[1]}"})
    g = eccodes.codes_new_from_message(raw)
    ks = {k: eccodes.codes_get(g, k) for k in ["gridType", "Nx", "Ny", "iScansNegatively", "jScansPositively",
          "jPointsAreConsecutive", "alternativeRowScanning", "scanningMode", "numberOfDataPoints",
          "bitmapPresent", "packingType"]}
    v = np.asarray(eccodes.codes_get_values(g))
    lat = np.asarray(eccodes.codes_get_array(g, "latitudes")); lon = np.asarray(eccodes.codes_get_array(g, "longitudes"))
    lon = np.where(lon > 180, lon - 360, lon)
    print(cycle, var, ks, "nvals", v.size, "nlat", lat.size)
    nx, ny = ks["Nx"], ks["Ny"]
    print("  lat/lon[0], [1], [Nx]:", (lat[0], lon[0]), (lat[1], lon[1]), (lat[nx], lon[nx]))
    # Wasatch: value at Alta by nearest point, and roughness along +1 vs +Nx index in a box
    d = (lat - 40.58) ** 2 + ((lon + 111.63) * 0.76) ** 2
    i = int(np.argmin(d)); print("  nearest Alta idx", i, lat[i], lon[i], "val", v[i])
    A = v.reshape(ny, nx); r, c = divmod(i, nx)
    sub = A[r - 30:r + 30, c - 30:c + 30]
    print("  mean |diff| along i (x):", np.abs(np.diff(sub, axis=1)).mean(), " along j (y):", np.abs(np.diff(sub, axis=0)).mean())
    print("  T row through Alta:", np.round(A[r, c - 6:c + 7] - 273.15, 1))
    print("  T col through Alta:", np.round(A[r - 6:r + 7, c] - 273.15, 1))
    eccodes.codes_release(g)

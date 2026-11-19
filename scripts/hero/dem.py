"""Heightmap for a hero-mountain render: USGS 3DEP 1/3" (~10 m), Copernicus 30 m fallback.
Writes OUT.npy (metres, north up) + OUT.json (bounds, cell size)."""
import json, math, sys
import numpy as np
import rasterio
from rasterio.merge import merge
from rasterio.enums import Resampling

def main(out, lat, lon, half_km, n):
    dlat = half_km / 111.32
    dlon = half_km / (111.32 * math.cos(math.radians(lat)))
    W, S, E, N = lon - dlon, lat - dlat, lon + dlon, lat + dlat
    res = ((E - W) / n, (N - S) / n)
    def tiles_usgs():
        t = []
        for la in range(math.floor(S), math.floor(N) + 1):
            for lo in range(math.floor(W), math.floor(E) + 1):
                name = f"n{la + 1:02d}w{-lo:03d}"
                t.append(f"/vsicurl/https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current/{name}/USGS_13_{name}.tif")
        return t
    def tiles_cop():
        t = []
        for la in range(math.floor(S), math.floor(N) + 1):
            for lo in range(math.floor(W), math.floor(E) + 1):
                ns = f"N{la:02d}" if la >= 0 else f"S{-la:02d}"
                ew = f"W{-lo:03d}" if lo < 0 else f"E{lo:03d}"
                k = f"Copernicus_DSM_COG_10_{ns}_00_{ew}_00_DEM"
                t.append(f"/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/{k}/{k}.tif")
        return t
    for name, tiles in (("usgs-3dep-10m", tiles_usgs()), ("copernicus-30m", tiles_cop())):
        try:
            srcs = [rasterio.open(u) for u in tiles]
            arr, _ = merge(srcs, bounds=(W, S, E, N), res=res, resampling=Resampling.bilinear, nodata=-9999)
            z = arr[0][:n, :n].astype("float32")
            if (z < -500).mean() > 0.001:
                raise RuntimeError(f"{(z < -500).mean():.1%} nodata")
            break
        except Exception as e:
            print(f"{name}: {e}", file=sys.stderr)
    else:
        sys.exit("no DEM")
    np.save(out + ".npy", z)
    cell_m = 2 * half_km * 1000 / n
    json.dump({"source": name, "bounds": [W, S, E, N], "cell_m": cell_m, "min_m": float(z.min()), "max_m": float(z.max()),
               "peak": [lat, lon]}, open(out + ".json", "w"), indent=1)
    print(name, z.shape, f"{z.min():.0f}–{z.max():.0f} m, cell {cell_m:.1f} m")

if __name__ == "__main__":
    main(sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), int(sys.argv[5]))

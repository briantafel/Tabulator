"""Anchor a terrain map's totals to the forecast the sheet shows (Brian 2026-11-22: "There can never be a discrepancy
between the totals on the map and the forecast").

The map used to be a plain NBM 5-day total from the cycle start: a different window, model and snow ratio from the
sheet's number (Tabulator blend, local calendar days from today), so the two could disagree by inches on the same day.
Anchored, the map keeps NBM's PATTERN (where in the resort the snow falls: elevation, aspect, the terrain step) and
takes its AMOUNT from the blend:

  1. Window = the sheet's forecast days: forecast.json's non-projected dates from the resort's local today on, i.e.
     exactly the days the sheet's headline total sums (App.jsx scoreFull). NBM is summed over the 6 h blocks whose
     middle falls inside those local days (blocks end at 00/06/12/18Z, so the edges are off by up to 3 h; only the
     pattern comes from NBM, the amount does not).
  2. Total  = sum of blend-forecast.json snow (cm) over those dates. All or nothing: a date missing from the blend means
     no anchored map (never a partial sum shown as the total).
  3. Height profile (2026-11-23, replaces the single multiplier). The blend's own snow at EVERY height, day by day:
     s_d(H) = snow_d x ratio(T_d(H)) / ratio(t_d)  (water_d x ratio / 10 if it rains at mid),  T_d(H) = t_d - 0.0065 C/m x (H - mid),
     the same ratio rule the sheet uses (scripts/blend/lib.js snowFrom: rain above 2 C, the SLR line, the warm cap
     where promoted), the same lapse rate the scoring uses (slr.py). At mid it IS the sheet's number.
     The map = S(H) x rho, S = the window's sum of s_d, rho = (NBM's field + c) / (NBM's own line at the blend point
     for that height + c), c = 0.5 in, clamped 0..1.5 (Cypress, first run: an unsoftened ratio over a 1.8 in NBM line
     drew 151 in; and the old hard switch at the floor jumped between cells). NBM supplies only WHERE across the
     resort snow is heavier or lighter at a given height; how much falls at each height, rain line included, is ours.
     Why (Brian, 2026-11-23, Whistler 0 in at the base / 122 in at the top): one multiplier set at mid-mountain
     stretched the whole slope by the blend-vs-NBM disagreement, which was about rain vs snow near the freezing level,
     not about the summit; the summit went to 122 in while the blend's own summit number was ~86 in.

Plain arithmetic, auditable from the numbers recorded in the map's json. Everything here fails loudly; no anchored map
beats a wrong one."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

CM_PER_IN = 2.54
NBM_FLOOR_IN = 0.1      # NBM below this at the blend point while the blend has snow: no pattern to scale -> refuse
SCALE_WARN = (0.25, 4.0)
LOW_IN = 1.0            # a sheet total under this with no NBM pattern to scale: draw the map flat at the total (Brian 2026-11-23)


LAPSE_C_PER_M = 0.0065  # slr.py LAPSE_C_PER_M: the scoring's station-height rule
RAIN_ABOVE_C = 2.0      # scripts/blend/lib.js RAIN_ABOVE_C
RHO_MAX = 1.5           # NBM's local pattern may raise the blend's amount at a height by at most half (or take it to 0)
RHO_C_IN = 0.5          # softening: rho = (N + c) / (n + c), so a near-zero NBM line at the blend point can't blow it up
FT_PER_M = 3.28084


class AnchorError(SystemExit):
    pass


def sheet_dates(forecast: dict, rid: str, today: date) -> list[str]:
    """The forecast days the sheet's headline sums: non-projected dates from today on."""
    r = next((x for x in forecast.get("resorts", []) if x.get("id") == rid), None)
    if not r:
        raise AnchorError(f"anchor: {rid} not in forecast.json")
    ds = [d["date"] for d in r.get("days", []) if not d.get("projected") and d.get("date") and d["date"] >= today.isoformat()]
    if not ds:
        raise AnchorError(f"anchor: {rid} has no forecast days from {today} on")
    return ds


def mid_elevation_m(forecast: dict, rid: str) -> float:
    r = next((x for x in forecast.get("resorts", []) if x.get("id") == rid), None)
    z = (r or {}).get("elevation", {}).get("mid")
    if not isinstance(z, (int, float)) or z <= 0:
        raise AnchorError(f"anchor: {rid} has no mid elevation (the blend's fetch height); cannot place the anchor")
    return float(z)


def blend_total_cm(blend: dict, rid: str, dates: list[str]) -> float:
    days = {d["date"]: d.get("snow") for d in (blend.get("resorts", {}).get(rid) or {}).get("days", [])}
    gone = [d for d in dates if not isinstance(days.get(d), (int, float))]
    if gone:
        raise AnchorError(f"anchor: blend has no snow for {rid} on {', '.join(gone)}; not drawing a partial total")
    return round(sum(days[d] for d in dates), 2)


def window_utc(dates: list[str], tz: str) -> tuple[datetime, datetime]:
    z = ZoneInfo(tz)
    a = datetime.combine(date.fromisoformat(dates[0]), time(0), z).astimezone(timezone.utc)
    b = datetime.combine(date.fromisoformat(dates[-1]) + timedelta(days=1), time(0), z).astimezone(timezone.utc)
    return a, b


def nbm_leads(cycle: datetime, start: datetime, end: datetime) -> list[int]:
    """6 h block end-leads (6, 12, ...) whose block middle lies in [start, end). Blocks before the cycle don't exist."""
    out, t = [], 6
    while True:
        mid = cycle + timedelta(hours=t - 3)
        if mid >= end:
            break
        if mid >= start:
            out.append(t)
        t += 6
    if not out:
        raise AnchorError(f"anchor: NBM {cycle:%Y-%m-%d %HZ} has no 6 h block inside {start:%Y-%m-%d %HZ}..{end:%Y-%m-%d %HZ}")
    return out


def scale(nbm_ref_in: float, total_cm: float) -> float | None:
    """Multiplier for the NBM pattern so its value at the anchor point equals the blend total. None = no pattern and a
    total under LOW_IN: the map is drawn flat at the total instead (still equal to the sheet, never an invented pattern)."""
    total_in = total_cm / CM_PER_IN
    if total_in <= 0:
        return 0.0                      # the blend has no snow: the map shows none (its nosnow path)
    if nbm_ref_in < NBM_FLOOR_IN and total_in < LOW_IN:
        return None                     # too little snow to have a pattern: the map is flat at the sheet's total ("Under 1 in")
    if nbm_ref_in < NBM_FLOOR_IN:
        raise AnchorError(f"anchor: NBM has {nbm_ref_in:.2f} in at the blend point but the blend has {total_in:.1f} in; "
                          "no snow pattern to scale, so no map rather than an invented one")
    return total_in / nbm_ref_in


def label(dates: list[str]) -> str:
    a, b = date.fromisoformat(dates[0]), date.fromisoformat(dates[-1])
    if a == b:
        return f"{a:%b} {a.day}"
    return f"{a:%b} {a.day}–{b.day}" if a.month == b.month else f"{a:%b} {a.day} – {b:%b} {b.day}"


# ---------------------------------------------------------------- the blend's height profile (twin of blend/lib.js)
def line_for(slr: dict, rid: str) -> dict:
    """projections/lib.js slrLineFor: the region's own line if promoted, else the pooled one."""
    reg = (slr.get("region_of") or {}).get(rid)
    e = (slr.get("regions") or {}).get(reg) if reg else None
    if e and e.get("promoted") and isinstance(e.get("a"), (int, float)) and isinstance(e.get("b"), (int, float)):
        return {"a": e["a"], "b": e["b"], "clamp": slr.get("clamp") or [5, 25], "warm": slr.get("warm")}
    if not isinstance(slr.get("a"), (int, float)):
        raise AnchorError("anchor: slr.json has no SLR line; cannot build the height profile")
    return {"a": slr["a"], "b": slr["b"], "clamp": slr.get("clamp") or [5, 25], "warm": slr.get("warm")}


def warm_ratio(t: float, warm: dict) -> float:
    xs, ys = (warm or {}).get("t") or [], (warm or {}).get("r") or []
    if len(xs) < 2 or t < xs[0]:
        return float("inf")
    if t >= xs[-1]:
        return float(ys[-1])
    i = 0
    while t >= xs[i + 1]:
        i += 1
    return ys[i] + (ys[i + 1] - ys[i]) * (t - xs[i]) / (xs[i + 1] - xs[i])


def ratio(t: float, line: dict, lead: int) -> float:
    """snowFrom's ratio (daily rule): 0 above 2 C; the clamped line; the warm cap where promoted for the lead group."""
    if t > RAIN_ABOVE_C:
        return 0.0
    lo, hi = line["clamp"]
    r = min(hi, max(lo, line["a"] + line["b"] * t))
    w = line.get("warm") or {}
    if (w.get("promote") or {}).get("1-3" if lead <= 3 else "4-7"):
        r = min(r, warm_ratio(t, w))
    return r


def height_profile(blend: dict, rid: str, dates: list[str], slr: dict, mid_m: float, heights_m) -> dict:
    """{date: [snow cm at each height]} — at mid exactly the blend's (sheet's) number for the day."""
    if any(((slr.get("hourly") or {}).get("promote") or {}).values()):
        raise AnchorError("anchor: slr.json promotes the sub-daily split; height_profile still uses the daily rule — update it first")
    days = {d["date"]: d for d in (blend.get("resorts", {}).get(rid) or {}).get("days", [])}
    line = line_for(slr, rid)
    out = {}
    for ds in dates:
        d = days.get(ds) or {}
        snow, water, t, lead = d.get("snow"), d.get("water"), d.get("t"), d.get("lead")
        if not all(isinstance(v, (int, float)) for v in (snow, water, t, lead)):
            raise AnchorError(f"anchor: blend day {rid} {ds} lacks snow/water/t/lead; no height profile (missing is not zero)")
        r0 = ratio(t, line, lead)
        rs = [ratio(t - LAPSE_C_PER_M * (h - mid_m), line, lead) for h in heights_m]
        # the sheet's number x (ratio here / ratio at mid): exact at mid, 0 where it rains. Rain at mid but snow higher
        # up (the sheet shows 0 there): the blend's water x the ratio at that height.
        out[ds] = [round(snow * r / r0, 3) if r0 > 0 else round(water * r / 10, 3) for r in rs]
    return out


def profile_heights(lo_m: float, hi_m: float, mid_m: float, n: int = 64) -> list[float]:
    """n heights spanning the map's terrain (with margin), plus the blend's own height exactly."""
    lo, hi = min(lo_m, mid_m) - 50.0, max(hi_m, mid_m) + 50.0
    hs = sorted(set([round(lo + (hi - lo) * i / (n - 1), 1) for i in range(n)] + [round(mid_m, 1)]))
    return hs


def interp_profile(hs_kft, S_in, H_kft):
    """S at heights H (kft), linear between nodes, clamped at the ends. numpy twin of terrainField.js profileAt."""
    import numpy as np
    return np.interp(H_kft, hs_kft, S_in)

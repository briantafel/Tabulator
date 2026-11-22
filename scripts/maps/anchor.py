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
  3. Scale  = blend total / NBM-downscaled snow at the blend's own point (resorts.json nws/latlon) and elevation
     (forecast.json mid, which is the elevation the blend's models are fetched at). One multiplier for the whole map,
     so the order (base < top) and the shape are NBM's, and the map's value at that point and height IS the sheet total.

Plain arithmetic, auditable from the numbers recorded in the map's json. Everything here fails loudly; no anchored map
beats a wrong one."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

CM_PER_IN = 2.54
NBM_FLOOR_IN = 0.1      # NBM below this at the blend point while the blend has snow: no pattern to scale -> refuse
SCALE_WARN = (0.25, 4.0)


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


def scale(nbm_ref_in: float, total_cm: float) -> float:
    """Multiplier for the NBM pattern so its value at the anchor point equals the blend total."""
    total_in = total_cm / CM_PER_IN
    if total_in <= 0:
        return 0.0                      # the blend has no snow: the map shows none (its nosnow path)
    if nbm_ref_in < NBM_FLOOR_IN:
        raise AnchorError(f"anchor: NBM has {nbm_ref_in:.2f} in at the blend point but the blend has {total_in:.1f} in; "
                          "no snow pattern to scale, so no map rather than an invented one")
    return total_in / nbm_ref_in


def label(dates: list[str]) -> str:
    a, b = date.fromisoformat(dates[0]), date.fromisoformat(dates[-1])
    if a == b:
        return f"{a:%b} {a.day}"
    return f"{a:%b} {a.day}–{b.day}" if a.month == b.month else f"{a:%b} {a.day} – {b:%b} {b.day}"

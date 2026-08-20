import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";

/* ------------------------------------------------------------------ *
 * Tabulator — v3
 * Rebuilt in the prototype's visual language: white, heavy grotesque,
 * one coral accent, minimal chrome. Live data from Open-Meteo across
 * 23 resorts, 3 days of history plus a 16-day forecast.
 * ------------------------------------------------------------------ */

const RESORTS = [
  { name: "Palisades Tahoe", region: "California", lat: 39.1967, lon: -120.2356, elev: 2100 },
  { name: "Heavenly", region: "California", lat: 38.9353, lon: -119.94, elev: 2600 },
  { name: "Kirkwood", region: "California", lat: 38.6849, lon: -120.0653, elev: 2600 },
  { name: "Mammoth", region: "California", lat: 37.6308, lon: -119.0326, elev: 2900 },
  { name: "Telluride", region: "Colorado", lat: 37.9375, lon: -107.8123, elev: 3200 },
  { name: "Crested Butte", region: "Colorado", lat: 38.8991, lon: -106.9656, elev: 3200 },
  { name: "Aspen Highlands", region: "Colorado", lat: 39.1821, lon: -106.8556, elev: 3200 },
  { name: "Steamboat", region: "Colorado", lat: 40.4572, lon: -106.8045, elev: 2700 },
  { name: "Snowbird", region: "Utah", lat: 40.583, lon: -111.6556, elev: 2700 },
  { name: "Alta", region: "Utah", lat: 40.5883, lon: -111.6358, elev: 2700 },
  { name: "Jackson Hole", region: "Wyoming", lat: 43.5875, lon: -110.8279, elev: 2400 },
  { name: "Grand Targhee", region: "Wyoming", lat: 43.788, lon: -110.9596, elev: 2600 },
  { name: "Sun Valley", region: "Idaho", lat: 43.6714, lon: -114.3517, elev: 2400 },
  { name: "Big Sky", region: "Montana", lat: 45.2856, lon: -111.4014, elev: 2500 },
  { name: "Taos", region: "New Mexico", lat: 36.5959, lon: -105.45, elev: 3300 },
  { name: "Revelstoke", region: "Canada", lat: 50.9583, lon: -118.1636, elev: 1700 },
  { name: "Whistler", region: "Canada", lat: 50.0594, lon: -122.9574, elev: 1500 },
  { name: "Lake Louise", region: "Canada", lat: 51.4419, lon: -116.1653, elev: 2100 },
  { name: "Kicking Horse", region: "Canada", lat: 51.298, lon: -117.0492, elev: 1900 },
  { name: "Whiteface", region: "New York", lat: 44.3658, lon: -73.9026, elev: 1000 },
  { name: "Stowe", region: "Vermont", lat: 44.5303, lon: -72.7814, elev: 900 },
  { name: "Killington", region: "Vermont", lat: 43.6045, lon: -72.8201, elev: 900 },
  { name: "Jay Peak", region: "Vermont", lat: 44.9243, lon: -72.5253, elev: 900 },
];

const PAST = 3;              // days of history, for the "before" column
const HORIZON = 16;          // Open-Meteo's free forecast ceiling
const TODAY_IDX = PAST;      // today's index inside the combined series
const WIND_LIMIT = 35;       // lifts commonly go on hold around here
const WARM_LIMIT = 34;       // above this, precipitation turns unreliable
const COLD_LIMIT = 0;        // below this, it stops being fun

const SERIES = ["#EF4A38", "#4A90E2", "#63C2A8", "#E8B62C", "#8E7CC3"];

/* ------------------------------- utils ------------------------------- */

const toCm = (i) => i * 2.54;
const toC = (f) => ((f - 32) * 5) / 9;
const toKmh = (m) => m * 1.60934;

const snowTxt = (inches, metric) => {
  const v = metric ? toCm(inches) : inches;
  if (v < 0.05) return "0";
  return v < 10 ? v.toFixed(1) : Math.round(v).toString();
};
const tempTxt = (f, metric) => (f == null ? "—" : Math.round(metric ? toC(f) : f).toString());
const windTxt = (m, metric) => (m == null ? "—" : Math.round(metric ? toKmh(m) : m).toString());

const iso = (d) => d.toISOString().slice(0, 10);
const fromIso = (s) => new Date(s + "T12:00:00");
const monthName = (d) => d.toLocaleDateString(undefined, { month: "long" });
const shortDate = (s) => fromIso(s).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/* ------------------------------ fetching ------------------------------ */

function buildUrl() {
  const p = new URLSearchParams({
    latitude: RESORTS.map((r) => r.lat).join(","),
    longitude: RESORTS.map((r) => r.lon).join(","),
    elevation: RESORTS.map((r) => r.elev).join(","),
    daily: "snowfall_sum,precipitation_sum,temperature_2m_max,temperature_2m_min,wind_speed_10m_max",
    timezone: "auto",
    past_days: String(PAST),
    forecast_days: String(HORIZON),
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch",
  });
  return `https://api.open-meteo.com/v1/forecast?${p}`;
}

const shapeDays = (raw) => {
  const d = raw.daily;
  return d.time.map((t, i) => ({
    date: t,
    snow: d.snowfall_sum[i] ?? 0,
    precip: d.precipitation_sum[i] ?? 0,
    hi: d.temperature_2m_max[i],
    lo: d.temperature_2m_min[i],
    wind: d.wind_speed_10m_max[i],
  }));
};

/** Everything recomputes against the chosen window. `before` is the snow that
 *  fell in the three days prior — the base you'd be landing on. */
function score(resort, a, b) {
  const win = resort.all.slice(a, b + 1);
  const prior = resort.all.slice(Math.max(0, a - 3), a);
  let cum = 0;
  return {
    ...resort,
    win,
    cumulative: win.map((x) => (cum += x.snow)),
    before: prior.reduce((s, x) => s + x.snow, 0),
    total: win.reduce((s, x) => s + x.snow, 0),
    hi: Math.max(...win.map((x) => x.hi)),
    lo: Math.min(...win.map((x) => x.lo)),
    wind: Math.max(0, ...win.map((x) => x.wind ?? 0)),
  };
}

const flags = (r) => ({
  wind: r.wind >= WIND_LIMIT,
  warm: r.hi >= WARM_LIMIT,
  cold: r.lo <= COLD_LIMIT,
});

/* ---------------------------- days picker ---------------------------- */

/** Horizontal number wheel. The selected value sits centre-stage; its
 *  neighbours bleed off both edges so the range is felt, not read. */
function DaysWheel({ value, onChange }) {
  const ref = useRef(null);
  const opts = Array.from({ length: 13 }, (_, i) => i + 2);
  const settle = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const item = el.children[opts.indexOf(value)];
    if (item) el.scrollLeft = item.offsetLeft - (el.clientWidth - item.clientWidth) / 2;
  }, []); // centre once on mount

  const onScroll = () => {
    clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const mid = el.scrollLeft + el.clientWidth / 2;
      let best = 0, bestD = Infinity;
      Array.from(el.children).forEach((c, i) => {
        const d = Math.abs(c.offsetLeft + c.clientWidth / 2 - mid);
        if (d < bestD) { bestD = d; best = i; }
      });
      if (opts[best] !== value) onChange(opts[best]);
    }, 90);
  };

  return (
    <div className="wheel" ref={ref} onScroll={onScroll} role="group" aria-label="Number of days">
      {opts.map((n) => (
        <button
          key={n}
          className={`wheel-n${n === value ? " on" : ""}`}
          onClick={() => onChange(n)}
          aria-pressed={n === value}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------- month picker ---------------------------- */

function MonthGrid({ dates, a, b, onPick }) {
  const [cursor, setCursor] = useState(() => fromIso(dates[TODAY_IDX]));
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const pad = (first.getDay() + 6) % 7; // Monday-first
  const count = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const window = dates.slice(TODAY_IDX);

  const cells = [
    ...Array.from({ length: pad }, () => null),
    ...Array.from({ length: count }, (_, i) =>
      iso(new Date(cursor.getFullYear(), cursor.getMonth(), i + 1, 12))),
  ];

  const step = (n) => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + n, 1));
  const inRange = (d) => {
    const i = dates.indexOf(d);
    return i >= a && i <= b;
  };

  return (
    <div className="cal">
      <div className="cal-nav">
        <button onClick={() => step(-1)} aria-label="Previous month">←</button>
        <button onClick={() => step(1)} aria-label="Next month">→</button>
      </div>
      <div className="cal-grid">
        {cells.map((d, i) => {
          if (!d) return <span key={`p${i}`} />;
          const day = fromIso(d).getDate();
          const avail = window.includes(d);
          const idx = dates.indexOf(d);
          return (
            <button
              key={d}
              className={`cal-d${avail ? "" : " off"}${inRange(d) ? " in" : ""}${idx === a ? " start" : ""}`}
              disabled={!avail}
              onClick={() => onPick(idx)}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------- results ------------------------------ */

function Dot({ kind, label }) {
  return <span className={`dot dot-${kind}`} title={label} aria-label={label} />;
}

function Table({ data, metric, onOpen }) {
  return (
    <div className="table">
      <div className="t-head">
        <span>Resort</span>
        <span>before</span>
        <span>snow</span>
        <span>temp</span>
        <span>wind</span>
      </div>
      {data.map((r, i) => {
        const f = flags(r);
        return (
          <button key={r.name} className={`t-row${i === 0 ? " best" : ""}`} onClick={() => onOpen(r)}>
            <span className="t-name">{r.name}</span>
            <span className="t-num t-before">{snowTxt(r.before, metric)}"</span>
            <span className="t-num t-snow">{snowTxt(r.total, metric)}"</span>
            <span className="t-num">
              {tempTxt(r.hi, metric)}°
              {f.warm && <Dot kind="red" label="Warm enough to fall as rain" />}
              {f.cold && <Dot kind="amber" label="Brutally cold" />}
            </span>
            <span className="t-num">
              {windTxt(r.wind, metric)}
              {f.wind && <Dot kind="red" label="Wind at lift-hold levels" />}
            </span>
          </button>
        );
      })}
      <p className="t-key">
        <Dot kind="red" /> above {WARM_LIMIT}° or over {WIND_LIMIT} mph &nbsp;·&nbsp;
        <Dot kind="amber" /> below {COLD_LIMIT}° &nbsp;·&nbsp; <b>before</b> is the snow that
        fell in the three days prior — the base you'd be landing on.
      </p>
    </div>
  );
}

function Chart({ data, metric }) {
  const top = data.slice(0, 5);
  const len = top[0]?.cumulative.length ?? 1;
  const max = Math.max(1, ...top.map((r) => r.total));
  const W = 300, H = 190, L = 30, B = 22;

  const path = (r) => {
    const pts = [[L, H - B], ...r.cumulative.map((v, i) => [
      L + ((i + 1) / len) * (W - L),
      (H - B) - (v / max) * (H - B - 8),
    ])];
    // Smooth with midpoint curves — matches the eased look of the prototype.
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
      const [px, py] = pts[i - 1], [x, y] = pts[i];
      d += ` C${(px + x) / 2},${py} ${(px + x) / 2},${y} ${x},${y}`;
    }
    return d;
  };

  const grid = [0.25, 0.5, 0.75, 1];

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" aria-label="Cumulative snowfall by resort">
        {grid.map((g) => {
          const y = (H - B) - g * (H - B - 8);
          return (
            <g key={g}>
              <line x1={L} x2={W} y1={y} y2={y} className="c-grid" />
              <text x={L - 6} y={y + 3} className="c-tick">{snowTxt(max * g, metric)}</text>
            </g>
          );
        })}
        <line x1={L} x2={W} y1={H - B} y2={H - B} className="c-axis" />
        {top.map((r, i) => (
          <path key={r.name} d={path(r)} className="c-line"
                style={{ stroke: SERIES[i], strokeDasharray: i === 3 ? "5 4" : "none" }} />
        ))}
      </svg>
      <div className="chart-key">
        {top.map((r, i) => (
          <span key={r.name} className="ck">
            <i style={{ background: SERIES[i] }} />{r.name}
          </span>
        ))}
      </div>
      <p className="t-key">
        Cumulative snowfall across the window, in {metric ? "centimetres" : "inches"}.
        Five deepest only — the rest are in the table.
      </p>
    </div>
  );
}

function Detail({ r, metric, onClose }) {
  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  if (!r) return null;
  const dayMax = Math.max(1, ...r.win.map((d) => d.snow));
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={r.name}>
        <div className="sheet-grab" />
        <div className="sheet-head">
          <div>
            <h2>{r.name}</h2>
            <p>{r.region} · {shortDate(r.win[0].date)}–{shortDate(r.win[r.win.length - 1].date)}</p>
          </div>
          <span className="sheet-total">{snowTxt(r.total, metric)}"</span>
        </div>
        {r.win.map((d) => (
          <div className="sd" key={d.date}>
            <span className="sd-day">{fromIso(d.date).toLocaleDateString(undefined, { weekday: "short" })}</span>
            <span className="sd-bar"><span style={{ width: `${(d.snow / dayMax) * 100}%` }} /></span>
            <span className="sd-n">{snowTxt(d.snow, metric)}"</span>
            <span className="sd-n muted">{tempTxt(d.hi, metric)}°</span>
            <span className={`sd-n muted${d.wind >= WIND_LIMIT ? " hot" : ""}`}>{windTxt(d.wind, metric)}</span>
          </div>
        ))}
        <button className="sheet-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

/* -------------------------------- radar ------------------------------- */

/** Where and when snow lands across the whole network, so you can spot a
 *  storm before you've committed to dates. */
function Radar({ raw, dates, metric, onJump }) {
  const rows = useMemo(() => {
    return [...raw]
      .map((r) => ({
        name: r.name,
        days: r.all.slice(TODAY_IDX),
        total: r.all.slice(TODAY_IDX).reduce((s, d) => s + d.snow, 0),
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 12);
  }, [raw]);
  const max = Math.max(0.5, ...rows.flatMap((r) => r.days.map((d) => d.snow)));
  const days = dates.slice(TODAY_IDX);

  return (
    <div className="radar">
      <h2 className="screen-h">Where it's snowing</h2>
      <p className="screen-p">Next {days.length} days. Darker means deeper. Tap a column to start a trip there.</p>
      <div className="rd-scroll">
        <div className="rd-grid" style={{ gridTemplateColumns: `92px repeat(${days.length}, 20px)` }}>
          <span />
          {days.map((d, i) => (
            <button key={d} className="rd-col" onClick={() => onJump(TODAY_IDX + i)}>
              {fromIso(d).getDate()}
            </button>
          ))}
          {rows.map((r) => (
            <React.Fragment key={r.name}>
              <span className="rd-name">{r.name}</span>
              {r.days.map((d) => (
                <span key={d.date} className="rd-cell"
                      style={{ background: d.snow < 0.05 ? "transparent" : `rgba(239,74,56,${0.12 + (d.snow / max) * 0.88})` }}
                      title={`${snowTxt(d.snow, metric)}"`} />
              ))}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- app -------------------------------- */

export default function Tabulator() {
  const [raw, setRaw] = useState(null);
  const [err, setErr] = useState(null);
  const [metric, setMetric] = useState(false);
  const [tab, setTab] = useState("mountains");
  const [mode, setMode] = useState("days");      // days | calendar
  const [days, setDays] = useState(4);
  const [a, setA] = useState(TODAY_IDX);
  const [b, setB] = useState(TODAY_IDX + 3);
  const [shown, setShown] = useState(false);      // results revealed
  const [page, setPage] = useState(0);            // 0 table, 1 chart
  const [open, setOpen] = useState(null);
  const [trips, setTrips] = useState([]);
  const [settings, setSettings] = useState(false);

  useEffect(() => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700;800&display=swap";
    document.head.appendChild(l);
    return () => { try { document.head.removeChild(l); } catch (e) {} };
  }, []);

  const load = useCallback(async () => {
    setErr(null); setRaw(null);
    try {
      const res = await fetch(buildUrl());
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json();
      const arr = Array.isArray(json) ? json : [json];
      setRaw(arr.map((x, i) => ({ ...RESORTS[i], all: shapeDays(x) })));
    } catch (e) { setErr(e.message || "unknown"); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const dates = useMemo(() => (raw ? raw[0].all.map((d) => d.date) : []), [raw]);

  // Days mode drives the window from today; calendar mode sets it explicitly.
  const [wa, wb] = mode === "days"
    ? [TODAY_IDX, Math.min(TODAY_IDX + days - 1, dates.length - 1)]
    : [a, b];

  const data = useMemo(
    () => (raw ? raw.map((r) => score(r, wa, wb)).sort((x, y) => y.total - x.total) : null),
    [raw, wa, wb]
  );

  const pick = (i) => {
    if (a !== null && b !== null && a === b && i > a) { setB(i); return; }
    setA(i); setB(i);
  };

  const label = dates.length
    ? `${shortDate(dates[wa])}${wb > wa ? `–${shortDate(dates[wb])}` : ""}`
    : "";

  return (
    <div className="app">
      <style>{CSS}</style>
      <div className="phone">

        <header className="bar">
          <span className="mark">Tabulator</span>
          <button className="gear" onClick={() => setSettings((s) => !s)} aria-label="Settings">⚙</button>
        </header>

        {settings && (
          <div className="settings">
            <span>Units</span>
            <div className="pill sm">
              <button className={!metric ? "on" : ""} onClick={() => setMetric(false)}>in / °F</button>
              <button className={metric ? "on" : ""} onClick={() => setMetric(true)}>cm / °C</button>
            </div>
            <button className="link" onClick={load}>Refresh forecast</button>
          </div>
        )}

        <main className="body">
          {err && (
            <div className="msg">
              <strong>The forecast service didn't respond.</strong>
              <span>Error {err}. Data comes from Open-Meteo.</span>
              <button className="link" onClick={load}>Try again</button>
            </div>
          )}
          {!raw && !err && <div className="loading">Reading the models…</div>}

          {data && tab === "mountains" && (
            <>
              <p className="ask">
                Find me snow {mode === "days" ? "in" : "on"}{" "}
                {mode === "calendar" && <em>{monthName(fromIso(dates[wa]))}</em>}
              </p>

              {mode === "days"
                ? <DaysWheel value={days} onChange={(n) => { setDays(n); setShown(false); }} />
                : <MonthGrid dates={dates} a={wa} b={wb} onPick={(i) => { pick(i); setShown(false); }} />}

              <div className="go">
                <div className="pill">
                  <button className={mode === "days" ? "on" : ""} onClick={() => setMode("days")}>
                    {mode === "days" ? "days" : "☀"}
                  </button>
                  <button className={mode === "calendar" ? "on" : ""} onClick={() => setMode("calendar")}>
                    {mode === "calendar" ? label : "▦"}
                  </button>
                </div>
                <button className="arrow" onClick={() => setShown(true)} aria-label="Show results">→</button>
              </div>

              {shown && (
                <>
                  <div className="pages">
                    {page === 0
                      ? <Table data={data} metric={metric} onOpen={setOpen} />
                      : <Chart data={data} metric={metric} />}
                  </div>
                  <div className="dots">
                    {[0, 1].map((i) => (
                      <button key={i} className={page === i ? "on" : ""} onClick={() => setPage(i)}
                              aria-label={i === 0 ? "Table" : "Chart"} />
                    ))}
                  </div>
                  <button className="save" onClick={() => setTrips((t) =>
                    t.find((x) => x.label === label) ? t : [...t, { label, top: data[0].name, snow: data[0].total }])}>
                    Save this window
                  </button>
                </>
              )}
            </>
          )}

          {data && tab === "radar" && (
            <Radar raw={raw} dates={dates} metric={metric}
                   onJump={(i) => { setMode("calendar"); setA(i); setB(Math.min(i + 3, dates.length - 1)); setTab("mountains"); setShown(true); }} />
          )}

          {data && tab === "trips" && (
            <div className="trips">
              <h2 className="screen-h">Saved windows</h2>
              {trips.length === 0
                ? <p className="screen-p">Nothing saved yet. Pick a window on Mountains and save it to compare later.</p>
                : trips.map((t) => (
                    <div className="trip" key={t.label}>
                      <span className="trip-when">{t.label}</span>
                      <span className="trip-top">{t.top}</span>
                      <span className="trip-n">{snowTxt(t.snow, metric)}"</span>
                    </div>
                  ))}
              {trips.length > 0 && <p className="screen-p sm">Saved for this session only.</p>}
            </div>
          )}
        </main>

        <nav className="tabs">
          {[["trips", "▤"], ["mountains", "⛰"], ["radar", "◎"]].map(([k, g]) => (
            <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              <span className="tg">{g}</span><span className="tl">{k}</span>
            </button>
          ))}
        </nav>
      </div>

      <Detail r={open} metric={metric} onClose={() => setOpen(null)} />
    </div>
  );
}

/* -------------------------------- css -------------------------------- */

const CSS = `
.app{--ink:#111;--ghost:#C6C6C6;--fill:#DCDCDC;--line:#ECECEC;--red:#EF4A38;--amber:#F0B429;
  background:#F2F2F2;min-height:100vh;display:flex;justify-content:center;
  font-family:'Inter Tight',system-ui,sans-serif;color:var(--ink);
  font-feature-settings:'tnum' 1;-webkit-font-smoothing:antialiased;}
.app *,.app *::before,.app *::after{box-sizing:border-box;}
.app button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;}
.app :focus-visible{outline:2px solid var(--red);outline-offset:2px;}

.phone{width:100%;max-width:430px;background:#fff;min-height:100vh;
  display:flex;flex-direction:column;position:relative;}

.bar{display:flex;justify-content:space-between;align-items:center;padding:20px 22px 8px;}
.mark{font-size:19px;font-weight:700;letter-spacing:-.02em;}
.gear{font-size:19px;line-height:1;opacity:.85;}

.settings{display:flex;align-items:center;gap:12px;flex-wrap:wrap;
  padding:12px 22px 14px;border-bottom:1px solid var(--line);font-size:13px;color:#666;}
.link{color:var(--red);font-weight:600;font-size:13px;}

.body{flex:1;padding:16px 22px 30px;}
.loading{padding:80px 0;text-align:center;color:var(--ghost);font-size:15px;}
.msg{padding:26px 0;display:grid;gap:7px;justify-items:start;font-size:14px;}
.msg span{color:#777;font-size:13px;}

.ask{text-align:center;font-size:21px;font-weight:600;letter-spacing:-.02em;margin:14px 0 4px;}
.ask em{font-style:normal;color:var(--red);}

/* days wheel */
.wheel{display:flex;gap:34px;overflow-x:auto;scroll-snap-type:x mandatory;
  padding:8px calc(50% - 52px);scrollbar-width:none;margin:0 -22px;}
.wheel::-webkit-scrollbar{display:none;}
.wheel-n{scroll-snap-align:center;flex:0 0 auto;font-size:132px;font-weight:700;
  letter-spacing:-.05em;line-height:1.12;color:var(--ghost);transition:color .2s,opacity .2s;
  opacity:.5;}
.wheel-n.on{color:var(--ink);opacity:1;}

/* calendar */
.cal{padding:4px 0 2px;}
.cal-nav{display:flex;justify-content:flex-end;gap:16px;font-size:15px;color:#999;padding-bottom:6px;}
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px 0;}
.cal-d{aspect-ratio:1;border-radius:50%;font-size:20px;font-weight:600;letter-spacing:-.02em;
  transition:background .15s;}
.cal-d.off{color:var(--ghost);cursor:default;}
.cal-d.in{background:var(--fill);}
.cal-d.start{color:var(--red);}

/* go row */
.go{display:flex;align-items:center;justify-content:center;gap:18px;margin:26px 0 4px;}
.pill{display:inline-flex;background:var(--fill);border-radius:999px;overflow:hidden;}
.pill button{padding:13px 26px;font-size:17px;font-weight:700;letter-spacing:-.01em;color:#555;}
.pill button.on{background:var(--ink);color:#fff;border-radius:999px;}
.pill.sm button{padding:6px 14px;font-size:12px;}
.arrow{font-size:23px;line-height:1;}

/* table */
.pages{padding-top:26px;}
.table{font-size:15px;}
.t-head,.t-row{display:grid;grid-template-columns:1fr 52px 52px 58px 52px;
  align-items:center;gap:6px;text-align:right;}
.t-head{font-size:12px;color:#8A8A8A;font-weight:500;padding-bottom:10px;}
.t-head span:first-child{text-align:left;}
.t-row{width:100%;padding:9px 0;border-bottom:1px solid var(--line);font-weight:600;
  letter-spacing:-.01em;}
.t-row.best{color:var(--red);}
.t-name{text-align:left;}
.t-num{white-space:nowrap;}
.t-before{color:#9A9A9A;font-weight:500;}
.t-row.best .t-before{color:var(--red);opacity:.75;}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-left:4px;
  vertical-align:middle;}
.dot-red{background:var(--red);}
.dot-amber{background:var(--amber);}
.t-key{margin:16px 0 0;font-size:11.5px;line-height:1.7;color:#8A8A8A;}
.t-key b{color:#555;font-weight:600;}

/* chart */
.chart-svg{width:100%;height:auto;overflow:visible;}
.c-grid{stroke:var(--line);stroke-width:1;}
.c-axis{stroke:#DDD;stroke-width:1;}
.c-tick{font-size:8px;fill:#AAA;text-anchor:end;}
.c-line{fill:none;stroke-width:2.2;stroke-linecap:round;}
.chart-key{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:14px;font-size:12px;color:#555;}
.ck{display:inline-flex;align-items:center;gap:6px;}
.ck i{width:14px;height:2.5px;border-radius:2px;}

.dots{display:flex;justify-content:center;gap:8px;padding:22px 0 6px;}
.dots button{width:8px;height:8px;border-radius:50%;background:var(--fill);}
.dots button.on{background:var(--ink);}
.save{display:block;margin:0 auto;font-size:13px;font-weight:600;color:var(--red);}

/* radar */
.screen-h{font-size:24px;font-weight:700;letter-spacing:-.03em;margin:10px 0 4px;}
.screen-p{color:#8A8A8A;font-size:13px;line-height:1.6;margin:0 0 18px;}
.screen-p.sm{font-size:11.5px;margin-top:14px;}
.rd-scroll{overflow-x:auto;margin:0 -22px;padding:0 22px;scrollbar-width:none;}
.rd-scroll::-webkit-scrollbar{display:none;}
.rd-grid{display:grid;gap:2px;align-items:center;}
.rd-col{font-size:10px;color:#AAA;padding-bottom:4px;}
.rd-name{font-size:12px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;padding-right:8px;}
.rd-cell{height:18px;border-radius:2px;background:transparent;box-shadow:inset 0 0 0 1px var(--line);}

/* trips */
.trip{display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:baseline;
  padding:12px 0;border-bottom:1px solid var(--line);}
.trip-when{font-weight:600;}
.trip-top{color:#777;font-size:13px;}
.trip-n{font-weight:700;color:var(--red);}

/* tabs */
.tabs{position:sticky;bottom:0;background:#fff;display:grid;grid-template-columns:repeat(3,1fr);
  border-top:1px solid var(--line);padding:10px 0 16px;}
.tabs button{display:flex;flex-direction:column;align-items:center;gap:3px;color:#9A9A9A;}
.tabs button.on{color:var(--red);}
.tg{font-size:19px;line-height:1;}
.tl{font-size:11px;}

/* detail sheet */
.scrim{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:flex-end;
  justify-content:center;z-index:50;animation:fade .18s both;}
@keyframes fade{from{opacity:0;}}
.sheet{width:100%;max-width:430px;background:#fff;border-radius:18px 18px 0 0;
  padding:10px 22px 26px;max-height:86vh;overflow-y:auto;
  animation:up .26s cubic-bezier(.2,.8,.3,1) both;}
@keyframes up{from{transform:translateY(26px);}}
.sheet-grab{width:36px;height:4px;border-radius:2px;background:var(--fill);margin:0 auto 14px;}
.sheet-head{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;
  padding-bottom:14px;border-bottom:1px solid var(--line);}
.sheet-head h2{margin:0;font-size:23px;font-weight:700;letter-spacing:-.03em;}
.sheet-head p{margin:3px 0 0;font-size:12.5px;color:#8A8A8A;}
.sheet-total{font-size:30px;font-weight:700;color:var(--red);letter-spacing:-.03em;}
.sd{display:grid;grid-template-columns:38px 1fr 42px 40px 34px;gap:9px;align-items:center;
  padding:10px 0;border-bottom:1px solid var(--line);font-size:13px;}
.sd-day{color:#8A8A8A;font-size:12px;}
.sd-bar{height:5px;background:var(--line);border-radius:3px;overflow:hidden;}
.sd-bar span{display:block;height:100%;background:var(--red);}
.sd-n{text-align:right;font-weight:600;}
.sd-n.muted{color:#9A9A9A;font-weight:500;}
.sd-n.hot{color:var(--red);font-weight:700;}
.sheet-close{display:block;width:100%;margin-top:20px;padding:14px;background:var(--fill);
  border-radius:999px;font-weight:600;}

@media (prefers-reduced-motion:reduce){
  .app *,.app *::before,.app *::after{animation-duration:.01ms!important;transition-duration:.01ms!important;}
}
`;

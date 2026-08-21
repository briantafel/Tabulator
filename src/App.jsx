import { useState, useEffect, useMemo, useCallback } from "react";

import DaysWheel from "./components/DaysWheel.jsx";
import MonthGrid from "./components/MonthGrid.jsx";
import Table from "./components/Table.jsx";
import Chart from "./components/Chart.jsx";
import Radar from "./components/Radar.jsx";
import Detail from "./components/Detail.jsx";
import Trips from "./components/Trips.jsx";

import { loadForecast } from "./lib/forecast.js";
import { score } from "./lib/scoring.js";
import { HORIZON_DAYS } from "./lib/constants.js";
import { fromIso, monthName, shortDate } from "./lib/dates.js";

/* ------------------------------------------------------------------ *
 * Tabulator
 * "I can take these days off — where should I go?" The comparison
 * across resorts, scoped to a date window, is the whole product.
 *
 * Data is a static forecast.json committed by a scheduled scrape of
 * Snow-Forecast. Indices here address days 0…5 of that file; there is
 * no past/forecast combined series any more, so no TODAY_IDX.
 * ------------------------------------------------------------------ */

const TABS = [
  ["trips", "▤"],
  ["mountains", "⛰"],
  ["radar", "◎"],
];

export default function Tabulator() {
  const [feed, setFeed] = useState(null);
  const [err, setErr] = useState(null);

  const [metric, setMetric] = useState(false);
  const [settings, setSettings] = useState(false);

  const [tab, setTab] = useState("mountains");
  const [mode, setMode] = useState("days"); // days | calendar
  const [days, setDays] = useState(4);
  const [a, setA] = useState(0);
  const [b, setB] = useState(3);

  const [shown, setShown] = useState(false);
  const [page, setPage] = useState(0); // 0 table, 1 chart
  const [open, setOpen] = useState(null);
  const [trips, setTrips] = useState([]);

  const load = useCallback(async () => {
    setErr(null);
    setFeed(null);
    try {
      setFeed(await loadForecast());
    } catch (e) {
      setErr(e.message || "unknown");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const dates = feed?.dates ?? [];

  // Days mode runs from the first forecast day; calendar mode sets the window
  // explicitly. Both clamp to the horizon.
  const last = Math.max(0, dates.length - 1);
  const [wa, wb] =
    mode === "days" ? [0, Math.min(days - 1, last)] : [Math.min(a, last), Math.min(b, last)];

  const data = useMemo(
    () =>
      feed
        ? feed.resorts
            .map((r) => score(r, wa, wb, feed.history))
            .sort((x, y) => y.total - x.total)
        : null,
    [feed, wa, wb]
  );

  const pick = (i) => {
    if (i < 0) return;
    if (a === b && i > a) { setB(i); return; }
    setA(i);
    setB(i);
  };

  const label = dates.length
    ? `${shortDate(dates[wa])}${wb > wa ? `–${shortDate(dates[wb])}` : ""}`
    : "";

  const saveWindow = () =>
    setTrips((t) =>
      t.find((x) => x.label === label)
        ? t
        : [...t, { label, top: data[0].name, snow: data[0].total }]
    );

  const jumpToDate = (i) => {
    setMode("calendar");
    setA(i);
    setB(Math.min(i + 3, last));
    setTab("mountains");
    setShown(true);
  };

  return (
    <div className="app">
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
            <button className="link" onClick={load}>Reload forecast</button>
            {feed?.generatedAt && (
              <span className="stamp">
                scraped {new Date(feed.generatedAt).toLocaleString(undefined, {
                  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                })}
              </span>
            )}
          </div>
        )}

        <main className="body">
          {err && (
            <div className="msg">
              <strong>No forecast available.</strong>
              <span>{err}. The scheduled scrape writes forecast.json — check the Actions tab.</span>
              <button className="link" onClick={load}>Try again</button>
            </div>
          )}

          {!feed && !err && <div className="loading">Reading the forecast…</div>}

          {/* Silent staleness is what let the spreadsheet rot. Say it out loud. */}
          {feed?.stale && <p className="banner">This forecast is over a day old — the scrape may be failing.</p>}
          {feed?.synthetic && <p className="banner">Sample data, not a real forecast.</p>}

          {data && tab === "mountains" && (
            <>
              <p className="ask">
                Find me snow {mode === "days" ? "in" : "on"}{" "}
                {mode === "calendar" && dates[wa] && <em>{monthName(fromIso(dates[wa]))}</em>}
              </p>

              {mode === "days" ? (
                <DaysWheel value={days} onChange={(n) => { setDays(n); setShown(false); }} />
              ) : (
                <MonthGrid dates={dates} a={wa} b={wb} onPick={(i) => { pick(i); setShown(false); }} />
              )}

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

                  <button className="save" onClick={saveWindow}>Save this window</button>
                </>
              )}
            </>
          )}

          {feed && tab === "radar" && (
            <Radar resorts={feed.resorts} dates={dates} metric={metric} onJump={jumpToDate} />
          )}

          {feed && tab === "trips" && <Trips trips={trips} metric={metric} />}
        </main>

        <nav className="tabs">
          {TABS.map(([k, g]) => (
            <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              <span className="tg">{g}</span>
              <span className="tl">{k}</span>
            </button>
          ))}
        </nav>
      </div>

      <Detail r={open} metric={metric} onClose={() => setOpen(null)} />
    </div>
  );
}

import { useState, useEffect, useMemo, useCallback } from "react";

import DaysWheel from "./components/DaysWheel.jsx";
import MonthGrid from "./components/MonthGrid.jsx";
import Table from "./components/Table.jsx";
import Chart from "./components/Chart.jsx";
import Radar from "./components/Radar.jsx";
import Detail from "./components/Detail.jsx";
import Trips from "./components/Trips.jsx";

import { fetchForecast } from "./lib/openMeteo.js";
import { score } from "./lib/scoring.js";
import { TODAY_IDX } from "./lib/constants.js";
import { fromIso, monthName, shortDate } from "./lib/dates.js";

/* ------------------------------------------------------------------ *
 * Tabulator
 * A ski trip decision tool. The question it answers is "I can take
 * these days off — where should I go?" — not "what's the weather at
 * Alta." The comparison across resorts, scoped to a date window, is
 * the whole product.
 * ------------------------------------------------------------------ */

const TABS = [
  ["trips", "▤"],
  ["mountains", "⛰"],
  ["radar", "◎"],
];

export default function Tabulator() {
  const [raw, setRaw] = useState(null);
  const [err, setErr] = useState(null);

  const [metric, setMetric] = useState(false);
  const [settings, setSettings] = useState(false);

  const [tab, setTab] = useState("mountains");
  const [mode, setMode] = useState("days"); // days | calendar
  const [days, setDays] = useState(4);
  const [a, setA] = useState(TODAY_IDX);
  const [b, setB] = useState(TODAY_IDX + 3);

  const [shown, setShown] = useState(false); // results revealed
  const [page, setPage] = useState(0); // 0 table, 1 chart
  const [open, setOpen] = useState(null);
  const [trips, setTrips] = useState([]);

  const load = useCallback(async () => {
    setErr(null);
    setRaw(null);
    try {
      setRaw(await fetchForecast());
    } catch (e) {
      setErr(e.message || "unknown");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dates = useMemo(() => (raw ? raw[0].all.map((d) => d.date) : []), [raw]);

  // Days mode drives the window from today; calendar mode sets it explicitly.
  const [wa, wb] =
    mode === "days"
      ? [TODAY_IDX, Math.min(TODAY_IDX + days - 1, dates.length - 1)]
      : [a, b];

  const data = useMemo(
    () => (raw ? raw.map((r) => score(r, wa, wb)).sort((x, y) => y.total - x.total) : null),
    [raw, wa, wb]
  );

  const pick = (i) => {
    if (a !== null && b !== null && a === b && i > a) {
      setB(i);
      return;
    }
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
    setB(Math.min(i + 3, dates.length - 1));
    setTab("mountains");
    setShown(true);
  };

  return (
    <div className="app">
      <div className="phone">
        <header className="bar">
          <span className="mark">Tabulator</span>
          <button className="gear" onClick={() => setSettings((s) => !s)} aria-label="Settings">
            ⚙
          </button>
        </header>

        {settings && (
          <div className="settings">
            <span>Units</span>
            <div className="pill sm">
              <button className={!metric ? "on" : ""} onClick={() => setMetric(false)}>
                in / °F
              </button>
              <button className={metric ? "on" : ""} onClick={() => setMetric(true)}>
                cm / °C
              </button>
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

              {mode === "days" ? (
                <DaysWheel
                  value={days}
                  onChange={(n) => {
                    setDays(n);
                    setShown(false);
                  }}
                />
              ) : (
                <MonthGrid
                  dates={dates}
                  a={wa}
                  b={wb}
                  onPick={(i) => {
                    pick(i);
                    setShown(false);
                  }}
                />
              )}

              <div className="go">
                <div className="pill">
                  <button className={mode === "days" ? "on" : ""} onClick={() => setMode("days")}>
                    {mode === "days" ? "days" : "☀"}
                  </button>
                  <button
                    className={mode === "calendar" ? "on" : ""}
                    onClick={() => setMode("calendar")}
                  >
                    {mode === "calendar" ? label : "▦"}
                  </button>
                </div>
                <button className="arrow" onClick={() => setShown(true)} aria-label="Show results">
                  →
                </button>
              </div>

              {shown && (
                <>
                  <div className="pages">
                    {page === 0 ? (
                      <Table data={data} metric={metric} onOpen={setOpen} />
                    ) : (
                      <Chart data={data} metric={metric} />
                    )}
                  </div>

                  <div className="dots">
                    {[0, 1].map((i) => (
                      <button
                        key={i}
                        className={page === i ? "on" : ""}
                        onClick={() => setPage(i)}
                        aria-label={i === 0 ? "Table" : "Chart"}
                      />
                    ))}
                  </div>

                  <button className="save" onClick={saveWindow}>Save this window</button>
                </>
              )}
            </>
          )}

          {data && tab === "radar" && (
            <Radar raw={raw} dates={dates} metric={metric} onJump={jumpToDate} />
          )}

          {data && tab === "trips" && <Trips trips={trips} metric={metric} />}
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

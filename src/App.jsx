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

/* Brian's own icons, exported from Figma. Filled paths on a 32x32 grid;
   the clipPath wrapper Figma emits clipped nothing and is dropped.
   `fill: currentColor` in CSS is what lets the active tab change colour. */
const ICON = {
  trips:
    "M26.0032 4.00048H22.0027V2.00024H20.0024V4.00048H12.0015V2.00024H10.0012V4.00048H6.00076C4.90063 4.00048 4.00052 4.90059 4.00052 6.00072V26.0031C4.00052 27.1033 4.90063 28.0034 6.00076 28.0034H26.0032C27.1033 28.0034 28.0034 27.1033 28.0034 26.0031V6.00072C28.0034 4.90059 27.1033 4.00048 26.0032 4.00048ZM26.0032 26.0031H6.00076V12.0014H26.0032V26.0031ZM26.0032 10.0012H6.00076V6.00072H10.0012V8.00096H12.0015V6.00072H20.0024V8.00096H22.0027V6.00072H26.0032V10.0012Z",
  mountains:
    "M27.6376 26.003L17.791 5.10604C17.6239 4.77205 17.3667 4.49148 17.0485 4.29611C16.7303 4.10073 16.3637 3.99834 15.9903 4.00052C15.6168 4.00271 15.2515 4.10938 14.9356 4.30847C14.6196 4.50756 14.3657 4.79112 14.2026 5.12704L4.36626 26.003H2.00027V28.0033H30.0036V26.003H27.6376ZM15.992 5.97964L20.9498 16.5019L19.0023 17.8L16.002 15.7997L13.0016 17.8L11.0463 16.4965L15.992 5.97964ZM10.1859 18.3268L13.0016 20.2044L16.002 18.2042L19.0023 20.2044L21.8117 18.3312L25.4264 26.003H6.57602L10.1859 18.3268Z",
  radar:
    "M30.0036 3.41451L28.5893 2.00024L15.2948 15.2948C15.1127 15.4835 15.0119 15.7361 15.0141 15.9983C15.0164 16.2606 15.1216 16.5114 15.307 16.6968C15.4925 16.8823 15.7433 16.9874 16.0055 16.9897C16.2678 16.992 16.5204 16.8912 16.709 16.709L20.8895 12.5293C21.6669 13.6258 22.0534 14.9516 21.9869 16.294C21.9205 17.6365 21.4049 18.9177 20.523 19.932C19.6411 20.9463 18.444 21.6348 17.1238 21.8872C15.8036 22.1396 14.4369 21.9411 13.2431 21.3235C12.0492 20.706 11.0975 19.7053 10.5406 18.482C9.98367 17.2588 9.8539 15.8838 10.1721 14.578C10.4903 13.2721 11.238 12.111 12.2952 11.281C13.3524 10.451 14.6578 10.0003 16.0019 10.0012V8.00096C14.1909 7.99848 12.4324 8.60968 11.0132 9.73487C9.59411 10.8601 8.59807 12.4329 8.18754 14.1968C7.77701 15.9607 7.97623 17.8117 8.75269 19.4479C9.52916 21.0841 10.8371 22.4089 12.4631 23.2064C14.0892 24.0038 15.9374 24.2268 17.7065 23.8391C19.4756 23.4513 21.0611 22.4755 22.2044 21.071C23.3478 19.6665 23.9816 17.916 24.0024 16.105C24.0232 14.2941 23.4299 12.5295 22.3191 11.099L25.1661 8.252C27.0074 10.4134 28.0139 13.1626 28.0034 16.0019C28.0034 18.3756 27.2995 20.6959 25.9808 22.6696C24.662 24.6432 22.7877 26.1814 20.5947 27.0898C18.4017 27.9982 15.9886 28.2358 13.6606 27.7728C11.3325 27.3097 9.19406 26.1667 7.51563 24.4882C5.8372 22.8098 4.69417 20.6713 4.23109 18.3433C3.76802 16.0152 4.00568 13.6021 4.91405 11.4092C5.82241 9.2162 7.36066 7.34183 9.33429 6.02309C11.3079 4.70436 13.6283 4.00048 16.0019 4.00048V2.00024C13.2327 2.00024 10.5256 2.82143 8.22301 4.35995C5.92045 5.89848 4.12582 8.08524 3.06606 10.6437C2.00631 13.2022 1.72903 16.0175 2.26929 18.7335C2.80955 21.4496 4.14308 23.9444 6.10125 25.9026C8.05942 27.8608 10.5543 29.1943 13.2703 29.7346C15.9864 30.2748 18.8017 29.9975 21.3601 28.9378C23.9186 27.878 26.1054 26.0834 27.6439 23.7808C29.1824 21.4783 30.0036 18.7712 30.0036 16.0019C30.0147 12.6325 28.7979 9.37447 26.5808 6.83722L30.0036 3.41451Z",
};
const TABS = ["trips", "mountains", "radar"];

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
  const [favs, setFavs] = useState([]);

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

  /* A trip is a NAMED container with its own date range and a list of resorts
     in it — "VSC trip 2027 · Jan 21–Jan 24", per the Add-to-trip design. It is
     not a bare saved window any more, which is what it was before.
     { id, name, label, resorts: [{ name, total }] } */
  const newTrip = (resort) =>
    setTrips((t) => {
      /* Brian names his own trips — the design shows "VSC trip 2027". Nothing
         in it says how he types that, so new trips get a neutral placeholder
         and renaming still needs a UI. Deriving the name from the window
         would just repeat the date line printed underneath it. */
      const n = t.length + 1;
      return [...t, { id: `trip-${n}`, name: `Trip ${n}`, label,
                      resorts: resort ? [resort] : [] }];
    });

  const addToTrip = (id, resort) =>
    setTrips((t) =>
      t.map((x) =>
        x.id !== id || x.resorts.some((r) => r.name === resort.name)
          ? x
          : { ...x, resorts: [...x.resorts, resort] }
      )
    );

  const saveWindow = () => newTrip({ name: data[0].name, total: data[0].total });

  /* The star favourites a resort; the calendar-plus saves the window. Two
     different actions, which is why the sheet carries both icons.
     Nothing consumes `favs` yet — see RESUME-HERE, it needs Brian's intent. */
  const toggleFav = (name) =>
    setFavs((f) => (f.includes(name) ? f.filter((x) => x !== name) : [...f, name]));

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
          <button className="gear" onClick={() => setSettings((s) => !s)} aria-label="Settings">
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <path d="M27.0033 16.7619C27.0033 16.5119 27.0033 16.2619 27.0033 16.0018C27.0033 15.7418 27.0033 15.4918 27.0033 15.2317L28.9235 13.5515C29.2775 13.2396 29.5097 12.8125 29.5793 12.3458C29.6488 11.8791 29.5512 11.4029 29.3035 11.0012L26.9433 7.00076C26.7679 6.69698 26.5157 6.44467 26.212 6.26913C25.9083 6.09359 25.5638 6.001 25.213 6.00064C24.9957 5.99897 24.7795 6.03275 24.573 6.10065L22.1427 6.92075C21.7231 6.64192 21.2854 6.39134 20.8325 6.17066L20.3225 3.65036C20.231 3.18991 19.9805 2.77629 19.6148 2.48192C19.2492 2.18754 18.7916 2.03117 18.3222 2.04016H13.6417C13.1723 2.03117 12.7147 2.18754 12.3491 2.48192C11.9834 2.77629 11.7329 3.18991 11.6414 3.65036L11.1314 6.17066C10.6752 6.39128 10.2342 6.64186 9.8112 6.92075L7.43092 6.06064C7.22219 6.00626 7.00604 5.986 6.79084 6.00064C6.44007 6.001 6.09557 6.09359 5.79188 6.26913C5.4882 6.44467 5.23602 6.69698 5.06063 7.00076L2.70035 11.0012C2.46691 11.4023 2.38016 11.872 2.45497 12.33C2.52977 12.7879 2.76148 13.2056 3.1104 13.5115L5.00062 15.2417C5.00062 15.4918 5.00062 15.7418 5.00062 16.0018C5.00062 16.2619 5.00062 16.5119 5.00062 16.7719L3.1104 18.4521C2.75162 18.7602 2.51358 19.1853 2.43852 19.6522C2.36345 20.1191 2.45621 20.5975 2.70035 21.0024L5.06063 25.0029C5.23602 25.3067 5.4882 25.559 5.79188 25.7345C6.09557 25.9101 6.44007 26.0027 6.79084 26.003C7.00822 26.0047 7.22441 25.9709 7.43092 25.903L9.86121 25.0829C10.2808 25.3618 10.7185 25.6123 11.1714 25.833L11.6814 28.3533C11.7729 28.8138 12.0234 29.2274 12.3891 29.5218C12.7547 29.8161 13.2123 29.9725 13.6817 29.9635H18.4022C18.8716 29.9725 19.3292 29.8161 19.6948 29.5218C20.0605 29.2274 20.311 28.8138 20.4025 28.3533L20.9125 25.833C21.3687 25.6124 21.8097 25.3618 22.2327 25.0829L24.653 25.903C24.8595 25.9709 25.0757 26.0047 25.2931 26.003C25.6438 26.0027 25.9883 25.9101 26.292 25.7345C26.5957 25.559 26.8479 25.3067 27.0233 25.0029L29.3035 21.0024C29.537 20.6014 29.6237 20.1317 29.5489 19.6737C29.4741 19.2158 29.2424 18.798 28.8935 18.4921L27.0033 16.7619ZM25.213 24.0028L21.7826 22.8427C20.9796 23.5228 20.0618 24.0545 19.0723 24.4128L18.3622 28.0033H13.6417L12.9316 24.4529C11.9499 24.0844 11.0371 23.5536 10.2313 22.8827L6.79084 24.0028L4.43056 20.0023L7.15088 17.602C6.96596 16.5668 6.96596 15.5069 7.15088 14.4717L4.43056 12.0014L6.79084 8.00088L10.2213 9.16102C11.0243 8.48083 11.9421 7.94913 12.9316 7.59083L13.6417 4.0004H18.3622L19.0723 7.55082C20.054 7.91929 20.9668 8.45007 21.7726 9.12101L25.213 8.00088L27.5733 12.0014L24.853 14.4016C25.0379 15.4369 25.0379 16.4968 24.853 17.532L27.5733 20.0023L25.213 24.0028Z" />
              <path d="M16.0019 22.0027C14.8151 22.0027 13.6549 21.6507 12.6681 20.9914C11.6813 20.332 10.9122 19.3948 10.458 18.2983C10.0038 17.2018 9.88497 15.9953 10.1165 14.8313C10.348 13.6672 10.9196 12.598 11.7588 11.7588C12.598 10.9196 13.6672 10.3481 14.8312 10.1165C15.9953 9.88499 17.2018 10.0038 18.2983 10.458C19.3948 10.9122 20.332 11.6813 20.9913 12.6681C21.6507 13.6549 22.0026 14.8151 22.0026 16.0019C22.0107 16.7922 21.8609 17.5761 21.5622 18.3078C21.2635 19.0394 20.8218 19.7042 20.263 20.263C19.7041 20.8218 19.0394 21.2635 18.3078 21.5622C17.5761 21.861 16.7922 22.0107 16.0019 22.0027ZM16.0019 12.0015C15.4732 11.9891 14.9475 12.0842 14.4566 12.2809C13.9656 12.4776 13.5197 12.7718 13.1457 13.1458C12.7718 13.5197 12.4776 13.9656 12.2809 14.4566C12.0842 14.9475 11.9891 15.4732 12.0014 16.0019C11.9891 16.5307 12.0842 17.0564 12.2809 17.5473C12.4776 18.0382 12.7718 18.4842 13.1457 18.8581C13.5197 19.2321 13.9656 19.5263 14.4566 19.723C14.9475 19.9197 15.4732 20.0147 16.0019 20.0024C16.5306 20.0147 17.0564 19.9197 17.5473 19.723C18.0382 19.5263 18.4842 19.2321 18.8581 18.8581C19.2321 18.4842 19.5263 18.0382 19.723 17.5473C19.9197 17.0564 20.0147 16.5307 20.0024 16.0019C20.0147 15.4732 19.9197 14.9475 19.723 14.4566C19.5263 13.9656 19.2321 13.5197 18.8581 13.1458C18.4842 12.7718 18.0382 12.4776 17.5473 12.2809C17.0564 12.0842 16.5306 11.9891 16.0019 12.0015Z" />
            </svg>
          </button>
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
              {/* Three verbs, per the workflow PDFs: "in" for days, "on" for a
                  single date, "from" for a range. Month name in the accent. */}
              <p className="ask">
                Find me snow {mode === "days" ? "in" : wb > wa ? "from" : "on"}{" "}
                {mode === "calendar" && dates[wa] && <em>{monthName(fromIso(dates[wa]))}</em>}
              </p>

              {/* Fixed-height slot. The wheel and the calendar are different
                  heights, and without this the mode pill jumped down 33px the
                  moment you switched to the calendar. */}
              <div className="slot">
                {mode === "days" ? (
                  <DaysWheel value={days} onChange={(n) => { setDays(n); setShown(false); }} />
                ) : (
                  <MonthGrid dates={dates} a={wa} b={wb} onPick={(i) => { pick(i); setShown(false); }} />
                )}
              </div>

              <div className="go">
                <div className="pill">
                  <button className={mode === "days" ? "on" : ""} onClick={() => setMode("days")} aria-label="Count of days">
                    {mode === "days" ? "days" : (
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12.75 1.5H11.25V5.25H12.75V1.5Z" />
                        <path d="M18.8943 4.04518L16.265 6.67456L17.3255 7.73511L19.9549 5.10574L18.8943 4.04518Z" />
                        <path d="M22.5 11.25H18.75V12.75H22.5V11.25Z" />
                        <path d="M17.3254 16.2649L16.2649 17.3254L18.8943 19.9548L19.9548 18.8943L17.3254 16.2649Z" />
                        <path d="M12.75 18.75H11.25V22.5H12.75V18.75Z" />
                        <path d="M6.67454 16.2649L4.04517 18.8943L5.10572 19.9548L7.7351 17.3255L6.67454 16.2649Z" />
                        <path d="M5.25 11.25H1.5V12.75H5.25V11.25Z" />
                        <path d="M5.10572 4.04516L4.04517 5.10571L6.67454 7.73509L7.7351 6.67454L5.10572 4.04516Z" />
                        <path d="M12 9C12.5933 9 13.1734 9.17595 13.6667 9.50559C14.1601 9.83524 14.5446 10.3038 14.7716 10.8519C14.9987 11.4001 15.0581 12.0033 14.9424 12.5853C14.8266 13.1672 14.5409 13.7018 14.1213 14.1213C13.7018 14.5409 13.1672 14.8266 12.5853 14.9424C12.0033 15.0581 11.4001 14.9987 10.852 14.7716C10.3038 14.5446 9.83524 14.1601 9.50559 13.6667C9.17595 13.1734 9 12.5933 9 12C9.0009 11.2046 9.31725 10.4421 9.87967 9.87967C10.4421 9.31725 11.2046 9.00089 12 9ZM12 7.5C11.11 7.5 10.24 7.76392 9.49994 8.25839C8.75991 8.75285 8.18314 9.45566 7.84254 10.2779C7.50195 11.1002 7.41283 12.005 7.58647 12.8779C7.7601 13.7508 8.18869 14.5526 8.81802 15.182C9.44736 15.8113 10.2492 16.2399 11.1221 16.4135C11.995 16.5872 12.8998 16.4981 13.7221 16.1575C14.5443 15.8169 15.2471 15.2401 15.7416 14.5001C16.2361 13.76 16.5 12.89 16.5 12C16.5 10.8065 16.0259 9.66193 15.182 8.81802C14.3381 7.97411 13.1935 7.5 12 7.5Z" />
                      </svg>
                    )}
                  </button>
                  <button className={mode === "calendar" ? "on" : ""} onClick={() => setMode("calendar")}>
                    {mode === "calendar" ? label : (
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M19.5024 3.00042H16.502V1.50024H15.0018V3.00042H9.00112V1.50024H7.50094V3.00042H4.50058C3.67548 3.00042 3.0004 3.67551 3.0004 4.5006V19.5024C3.0004 20.3275 3.67548 21.0026 4.50058 21.0026H19.5024C20.3275 21.0026 21.0026 20.3275 21.0026 19.5024V4.5006C21.0026 3.67551 20.3275 3.00042 19.5024 3.00042ZM19.5024 19.5024H4.50058V9.00114H19.5024V19.5024ZM19.5024 7.50096H4.50058V4.5006H7.50094V6.00078H9.00112V4.5006H15.0018V6.00078H16.502V4.5006H19.5024V7.50096Z" />
                        <path d="M12.0015 11.0012L10.9288 12.0461L12.614 13.7516H8.00099V15.2517H12.614L10.9288 16.9317L12.0015 18.0021L15.5019 14.5016L12.0015 11.0012Z" />
                      </svg>
                    )}
                  </button>
                </div>
                <button className="arrow" onClick={() => setShown(true)} aria-label="Show results">→</button>
              </div>

              {shown && (
                <>
                  <div className="viewtoggle" role="group" aria-label="Results view">
                    <button className={page === 0 ? "on" : ""} onClick={() => setPage(0)} aria-label="Table">
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14.5017 2.50036C14.5017 2.23512 14.3964 1.98073 14.2088 1.79317C14.0213 1.60561 13.7669 1.50024 13.5016 1.50024H2.5003C2.23505 1.50024 1.98067 1.60561 1.79311 1.79317C1.60555 1.98073 1.50018 2.23512 1.50018 2.50036V13.5017C1.50018 13.7669 1.60555 14.0213 1.79311 14.2089C1.98067 14.3964 2.23505 14.5018 2.5003 14.5018H13.5016C13.7669 14.5018 14.0213 14.3964 14.2088 14.2089C14.3964 14.0213 14.5017 13.7669 14.5017 13.5017V2.50036ZM13.5016 2.50036V4.5006H2.5003V2.50036H13.5016ZM13.5016 13.5017H2.5003V11.5014H13.5016V13.5017ZM13.5016 10.5013H2.5003V8.50108H13.5016V10.5013ZM13.5016 7.50096H2.5003V5.50072H13.5016V7.50096Z" /></svg>
                    </button>
                    <button className={page === 1 ? "on" : ""} onClick={() => setPage(1)} aria-label="Chart">
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.00036 8.00084C4.48689 8.00084 5.11682 6.8752 5.67303 5.88194C6.2378 4.87251 6.72581 4.00036 8.00096 4.00036C9.27611 4.00036 9.76412 4.87251 10.3289 5.88194C10.8851 6.8752 11.515 8.00084 13.0016 8.00084H15.0018V7.00072H13.0016C12.145 7.00072 11.7597 6.3903 11.2018 5.39333C10.605 4.32755 9.86273 3.00024 8.00096 3.00024C6.13919 3.00024 5.3969 4.32755 4.80013 5.39333C4.24221 6.3903 3.85691 7.00072 3.00036 7.00072H2.00024V1H1.00012V14.0016C1.00012 14.2668 1.10549 14.5212 1.29305 14.7088C1.48061 14.8963 1.73499 15.0017 2.00024 15.0017H15.0018V14.0016H14.0017V11.0012H13.0016V14.0016H11.0009L11.0013 10.0011H10.0012V14.0016H8.00096V8.00084H7.00084V14.0016H5.0002L5.0006 10.0011H4.00048V14.0016H2.00024V8.00084H3.00036Z" /></svg>
                    </button>
                  </div>

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
          {TABS.map((k) => (
            <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              <span className="tg">
                <svg viewBox="0 0 32 32" aria-hidden="true"><path d={ICON[k]} /></svg>
              </span>
              <span className="tl">{k}</span>
            </button>
          ))}
        </nav>
      </div>

      <Detail
        r={open}
        metric={metric}
        onClose={() => setOpen(null)}
        fav={!!open && favs.includes(open.name)}
        onFav={() => open && toggleFav(open.name)}
        trips={trips}
        onAddToTrip={(id) => open && addToTrip(id, { name: open.name, total: open.total })}
        onNewTrip={() => open && newTrip({ name: open.name, total: open.total })}
      />
    </div>
  );
}

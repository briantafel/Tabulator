/* A reconstruction of a Snow-Forecast 6-day page, built from the structure
 * survey in claude/snow-forecast-parsing-contract.md — the real table
 * classes, the real `data-row` names, the real cell counts, and the real
 * value formats (em-dash for no snow, "15NNW" for wind, "max °C" labels).
 *
 * It is NOT a saved copy of the live page. The sandbox cannot reach
 * snow-forecast.com, so this pins the contract we observed rather than the
 * bytes they served. First real Action run is the true test — which is why
 * the scraper validates its own output loudly. */

const PERIODS = ["AM", "PM", "night"];

export function buildPage({
  elev = [3831, 3245, 2659],
  headers = ["Thursday20", "Friday21", "Saturday22", "Sunday23", "Monday24", "Tuesday25"],
  snow = null,
  tmax = null,
  tmin = null,
  wind = null,
  freeze = null,
  phrases = null,
  omitRows = [],
  lastSnowfall = "18 May 2026",
} = {}) {
  const n = headers.length * 3;
  const fill = (v) => Array.from({ length: n }, (_, i) => (typeof v === "function" ? v(i) : v));

  snow = snow ?? fill("—");
  tmax = tmax ?? fill((i) => 12 + (i % 9));
  tmin = tmin ?? fill((i) => 1 + (i % 5));
  wind = wind ?? fill((i) => `${(i % 4) * 5}${["NW", "NNW", "E", "S"][i % 4]}`);
  freeze = freeze ?? fill((i) => 5100 + (i % 7) * 50);
  phrases = phrases ?? fill((i) => ["some clouds", "rain shwrs", "mod. rain"][i % 3]);

  const times = fill((i) => PERIODS[i % 3]);
  const cells = (arr) => arr.map((v) => `<td>${v}</td>`).join("");
  const rowIf = (name, html) => (omitRows.includes(name) ? "" : `<tr data-row="${name}">${html}</tr>`);

  return `<!doctype html><html><head><title>Test Resort Snow Forecast (mid mountain)</title></head><body>
<table class="forecast-table__table forecast-table__table--content">
  ${rowIf("summary", `<td></td><td>Next 3 days weather summary:Heavy rain (total 24.0mm), heaviest during Fri.</td><td>Days 4-6 weather summary:Light rain (total 4.0mm).</td>`)}
  ${rowIf("days", `<th>Elevation ${elev[0]} m${elev[1]} m${elev[2]} m</th>${headers.map((h) => `<td>${h}</td>`).join("")}`)}
  ${rowIf("time", cells(times))}
  ${rowIf("phrases", `<th></th>${cells(phrases)}`)}
  ${rowIf("wind", `<th>km/h</th>${cells(wind)}`)}
  ${rowIf("snow", `<th>cm</th>${cells(snow)}`)}
  ${rowIf("rain", `<th>mm</th>${cells(fill("—"))}`)}
  ${rowIf("temperature-max", `<th>max °C</th>${cells(tmax)}`)}
  ${rowIf("temperature-min", `<th>min °C</th>${cells(tmin)}`)}
  ${rowIf("freezing-level", `<th>Freeze m</th>${cells(freeze)}`)}
</table>
<table class="snow-depths-table__table">
  <tr><td>Top snow depth:</td><td>0 cm</td></tr>
  <tr><td>Bottom snow depth:</td><td>0 cm</td></tr>
  <tr><td>Fresh snowfall depth:</td><td>—</td></tr>
  <tr><td>Last snowfall:</td><td>${lastSnowfall}</td></tr>
</table>
<table class="snow-history-table__table">
  <tr><td>0.0</td><td>Bluebird Powder days</td></tr>
</table>
</body></html>`;
}

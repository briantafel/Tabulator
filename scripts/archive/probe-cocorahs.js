/* Temporary probe (2026-11-11): does the CoCoRaHS export take a date range? Delete after use. */
const B = "https://data.cocorahs.org/export/exportreports.aspx?ReportType=Daily&dtf=1&Format=CSV&State=UT&TimesInGMT=True";
export async function collect({ log }) {
  for (const q of ["&ReportDateType=reportdate&StartDate=1/1/2025&EndDate=1/31/2025",
                   "&ReportDateType=timestamp&StartDate=1/1/2025&EndDate=1/31/2025",
                   "&ReportDateType=reportdate&Date=1/15/2025"]) {
    const r = await fetch(B + q); const t = await r.text();
    const lines = t.trim().split("\n");
    const dates = new Set(lines.slice(1).map((l) => l.split(",")[0]));
    log(`${r.status} ${t.length}B ${lines.length - 1} rows, ${dates.size} dates (${[...dates].sort()[0]} .. ${[...dates].sort().pop()}) ${q}`);
  }
  const st = await (await fetch("https://data.cocorahs.org/export/exportstations.aspx?State=UT&Format=CSV")).text();
  const status = {};
  for (const l of st.trim().split("\n").slice(1)) { const s = l.split(",")[9]?.trim(); status[s] = (status[s] || 0) + 1; }
  log(`station statuses: ${JSON.stringify(status)}`);
  return { ok: true };
}

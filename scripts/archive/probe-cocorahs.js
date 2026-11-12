/* Temporary probe (2026-11-12): find a Canada filter for the CoCoRaHS export. Delete after use. */
const B = "https://data.cocorahs.org/export/exportreports.aspx?ReportType=Daily&dtf=1&Format=CSV&ReportDateType=reportdate&StartDate=1/1/2025&EndDate=1/1/2025&TimesInGMT=True";
export async function collect({ log }) {
  for (const q of ["&Country=CAN", "&Country=CAN&State=BC", "&State=CAN-BC", "&Country=Canada", "&State=BC&Country=CAN", ""]) {
    const r = await fetch(B + q, { signal: AbortSignal.timeout(120e3) }); const t = await r.text();
    const lines = t.trim().split("\n").slice(1);
    const can = lines.filter((l) => /,\s*CAN-/.test(l)).length;
    const bc = lines.filter((l) => /,\s*CAN-BC/.test(l)).length;
    log(`q="${q}": HTTP ${r.status} ${lines.length} rows, ${can} CAN, ${bc} CAN-BC`);
  }
  const s = await (await fetch("https://data.cocorahs.org/export/exportstations.aspx?State=BC&Format=CSV")).text();
  const sl = s.trim().split("\n").slice(1);
  log(`stations State=BC: ${sl.length} rows, ${sl.filter((l) => l.includes("CAN-BC")).length} CAN-BC`);
  return { ok: true };
}

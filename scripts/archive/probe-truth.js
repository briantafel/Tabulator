/* Temporary probe (2026-11-11): prints what candidate CoCoRaHS / SNODAS
 * endpoints return, so the collectors are built against real formats.
 * Run with: try-source.yml module=probe-truth. Delete once the collectors exist. */
const URLS = [
  "https://data.cocorahs.org/export/exportreports.aspx?ReportType=Daily&dtf=1&Format=CSV&State=UT&ReportDateType=reportdate&Date=11/10/2026&TimesInGMT=False",
  "https://data.cocorahs.org/export/exportstations.aspx?State=UT&Format=CSV",
  "https://mesonet.agron.iastate.edu/geojson/network/UT_COCORAHS.geojson",
  "https://mesonet.agron.iastate.edu/geojson/network/UTCOCORAHS.geojson",
  "https://mesonet.agron.iastate.edu/api/1/daily.json?network=UT_COCORAHS&date=2026-11-10",
  "https://mesonet.agron.iastate.edu/api/1/daily.json?network=UTCOCORAHS&date=2026-11-10",
  "https://mesonet.agron.iastate.edu/cocorahs/obs.phtml",
  "https://mesonet.agron.iastate.edu/api/1/network/UT_COCORAHS.json",
  "https://noaadata.apps.nsidc.org/NOAA/G02158/unmasked/2026/11_Nov/",
  "https://noaadata.apps.nsidc.org/NOAA/G02158/masked/2026/11_Nov/",
  "https://www.nohrsc.noaa.gov/pub/data/snodas/",
];
export async function collect({ log }) {
  for (const u of URLS) {
    try {
      const r = await fetch(u, { headers: { "user-agent": "Tabulator archive (github.com/briantafel/Tabulator)" }, signal: AbortSignal.timeout(30000) });
      const t = await r.text();
      log(`\n=== ${r.status} ${r.headers.get("content-type")} ${t.length}B ${u}\n${t.slice(0, 1500)}`);
      const links = [...t.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => /\.(tar|gz|zip|nc|dat)/.test(h));
      if (links.length) log(`  files: ${links.slice(-6).join(" ")}`);
    } catch (e) { log(`\n=== ERROR ${u}: ${e.message}`); }
  }
  return { ok: true };
}

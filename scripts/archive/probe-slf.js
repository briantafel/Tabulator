/* Temporary probe (2026-11-11): SLF IMIS station types and measurement field names. Delete after use. */
const API = "https://measurement-api.slf.ch/public/api";
export async function collect({ log }) {
  const st = await (await fetch(`${API}/imis/stations`)).json();
  const types = {};
  for (const s of st) types[s.type] = (types[s.type] || 0) + 1;
  log(`types: ${JSON.stringify(types)}`);
  log(`station keys: ${JSON.stringify(st[0])}`);
  for (const type of Object.keys(types)) {
    const s = st.find((x) => x.type === type);
    const r = await fetch(`${API}/imis/station/${s.code}/measurements?period_in_days=1`);
    const t = await r.text();
    log(`\n${type} ${s.code} ${s.label} ${s.elevation} m: HTTP ${r.status}\n${t.slice(0, 900)}`);
  }
  return { ok: true };
}

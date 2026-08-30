/* Shape the SAMPLE forecast so the demo shows the ranking doing its job.
   Metric in the file: cm, C, km/h. Authored here in ", F, mph. */
import { readFile, writeFile } from "node:fs/promises";
import { score } from "/root/tabulator/src/lib/scoring.js";
import { bestOf, byRank, vetoOf, rankParts } from "/root/tabulator/src/lib/rank.js";
const IN=i=>i*2.54, F=f=>((f-32)*5)/9, MPH=m=>m*1.60934;
const f=JSON.parse(await readFile("public/forecast.json","utf8"));
const h=JSON.parse(await readFile("public/history.json","utf8"));

const set = (id, {total, hi, lo, wind}) => {
  const r=f.resorts.find(x=>x.id===id);
  const per=IN(total)/4;
  r.days.forEach((d,i)=>{ if(i<4){ d.snow=+per.toFixed(2); d.tempMax=+F(hi).toFixed(2);
    d.tempMin=+F(lo).toFixed(2); d.windMax=+MPH(wind).toFixed(2); } });
  return r;
};
// The pick: less snow than Alta AND less than Heavenly, but nothing wrong with it.
set("telluride",     { total: 26, hi: 25, lo: 12, wind: 10 });
// More snow than anyone, and a deal breaker: frigid and howling.
set("alta",          { total: 40, hi:  5, lo: -18, wind: 38 });
// Nearly the same snow as Telluride, a shade MORE, but far too warm.
set("heavenly",      { total: 28, hi: 38, lo: 30, wind: 12 });

/* Everything else has to sit below the pick or the point is lost. Their
   conditions are left alone; only the first four days of snow are damped, so
   the table still reads like a real spread rather than a flat line. */
for (const r of f.resorts) {
  if (["telluride","alta","heavenly"].includes(r.id)) continue;
  const tot=r.days.slice(0,4).reduce((s,d)=>s+(d.snow??0),0);
  const cap=IN(19);
  if (tot>cap){ const k=cap/tot; r.days.forEach((d,i)=>{ if(i<4) d.snow=+((d.snow??0)*k).toFixed(2); }); }
}
/* A good three-day base under the pick — it is one of the four things the
   ranking weighs, and the demo should show it mattering. */
const start=f.resorts[0].days[0].date;
for (let i=1;i<=3;i++){
  const d=new Date(start+"T12:00:00Z"); d.setUTCDate(d.getUTCDate()-i);
  const k=d.toISOString().slice(0,10);
  h.days[k]=h.days[k]||{};
  h.days[k].telluride=+(IN(10)/3).toFixed(2);
  h.days[k].heavenly=+(IN(3)/3).toFixed(2);
}
await writeFile("public/forecast.json", JSON.stringify(f,null,1));
await writeFile("public/history.json", JSON.stringify(h,null,1));

const rows=f.resorts.map(r=>score(r,0,3,h)).sort(byRank);
const pick=bestOf(rows);
console.log("PICK:", pick.name, "\n");
console.log("  resort            snow   -3d    hi     wind    rank  veto");
for (const r of rows.slice(0,8)){
  const p=rankParts(r);
  console.log(`  ${r.name.padEnd(17)}${(r.total/2.54).toFixed(1).padStart(5)}" ${(r.before==null?'  —':(r.before/2.54).toFixed(1)).padStart(5)} ${(r.hi*9/5+32).toFixed(0).padStart(4)}F ${(r.wind/1.60934).toFixed(0).padStart(4)}mph ${String(r.rank).padStart(7)}  ${vetoOf(r)??''}`);
}

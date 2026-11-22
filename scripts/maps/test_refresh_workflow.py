#!/usr/bin/env python3
"""The two-wave refresh: the workflow's ordering rules and the publish behaviour they rely on.
    python3 scripts/maps/test_refresh_workflow.py"""
import json
import sys
import tempfile
from pathlib import Path

import yaml

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import refresh_publish as rpub  # noqa: E402

WF = HERE.parents[1] / ".github/workflows"
y = lambda n: yaml.safe_load((WF / n).read_text())  # noqa: E731
# PyYAML reads the key `on` as True
trig = lambda d: d.get("on", d.get(True))  # noqa: E731

# ---- workflow wiring
main, rnd, pub = y("terrain-refresh.yml"), y("terrain-render.yml"), y("terrain-publish.yml")
assert "workflow_call" in trig(rnd) and "workflow_call" in trig(pub)
J = main["jobs"]
assert set(J) == {"plan", "render-first", "render-rest", "publish-first", "publish-rest"}, set(J)
need = lambda j: [J[j]["needs"]] if isinstance(J[j]["needs"], str) else J[j]["needs"]  # noqa: E731
assert "publish-first" in need("publish-rest"), "the second publish must wait for the first (both force-push terrain-live)"
assert "render-first" in need("publish-first") and "render-rest" in need("publish-rest")
assert "render-rest" not in need("publish-first"), "the anchored publish must NOT wait for the slow wave"
assert "render-first" not in need("render-rest"), "the waves render in parallel"
for j in ("publish-first", "publish-rest"):
    assert "always()" in J[j]["if"], "a failed wave must not stop the other from publishing what is good"
assert J["render-first"]["with"]["prefix"] == J["publish-first"]["with"]["prefix"] == "stage-first"
assert J["render-rest"]["with"]["prefix"] == J["publish-rest"]["with"]["prefix"] == "stage-rest"
outs = set(J["plan"]["outputs"])
for k in ("matrix_first", "count_first", "matrix_rest", "count_rest", "cycle", "anchor"):
    assert k in outs, k
text = (WF / "terrain-refresh.yml").read_text()
assert "needs.render." not in text and "needs.plan.outputs.matrix}" not in text, "old single-wave references left"
assert "ANCHOR_RESORTS: jackson-hole" in text

# ---- publish: the second wave builds on the first and never undoes it
def stage(root, rid, run):
    d = Path(root) / f"art-{rid}" / rid
    d.mkdir(parents=True)
    for n in rpub.FILES:
        (d / n.format(id=rid)).write_bytes(b"x")
    j = {"snow": {"run": run}, "caption_source": "NOAA NBM", "nosnow": False, "base": [2000, 1.0], "top": [3000, 3.0],
         "inside_range_in": [1.0, 3.0], "app": {"sheet": {"labels": []}, "full": {"px": 1, "ref": 1, "focus": 1, "labels": []}}}
    (d / f"{rid}.json").write_text(json.dumps(j))


with tempfile.TemporaryDirectory() as t:
    t = Path(t)
    live = t / "live"
    live.mkdir()
    (live / "index.json").write_text(json.dumps({"_note": "x", "old": {"run": "2026-11-21T12:00:00+00:00"}}))
    stage(t / "s1", "jackson-hole", "2026-11-22T12:00:00+00:00")                     # wave 1
    done, bad = rpub.publish(live, t / "s1")
    assert done == ["jackson-hole"] and not bad
    stage(t / "s2", "alta", "2026-11-22T12:00:00+00:00")                             # wave 2 on top of wave 1's live
    stage(t / "s2b", "old", "2026-11-20T00:00:00+00:00")                             # older than what is live: refused
    done, bad = rpub.publish(live, t / "s2")
    idx = json.loads((live / "index.json").read_text())
    assert done == ["alta"] and {"jackson-hole", "alta", "old"} <= set(idx), idx.keys()
    assert (live / "jackson-hole-full.webp").exists(), "wave 1's files survive wave 2"
    done, bad = rpub.publish(live, t / "s2b")
    assert bad == ["old"] and idx["old"]["run"] == "2026-11-21T12:00:00+00:00", "an older map never replaces a newer one"
print("refresh workflow tests passed")

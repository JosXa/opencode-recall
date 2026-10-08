"""Aggregate step metrics across all recall-agent sessions: speed, fan-out width, truncation, sync cost."""

import statistics

import _db

p = _db.parser(__doc__)
p.add_argument("--agent", default="recall")
p.add_argument("--since", help="YYYY-MM-DD")
a = p.parse_args()
db = _db.connect(a.db)

runs = []
for sid, *_ in _db.sessions(db, a.agent, a.since):
    steps = list(_db.steps(db, sid))
    if steps:
        runs.append((sid, steps))
rows = [s for _, steps in runs for s in steps]
first = [steps[0] for _, steps in runs]
later = [s for _, steps in runs for s in steps[1:]]
q = _db.q

print(f"sessions={len(runs)} steps={len(rows)}")
print("steps per session      ", q([len(s) for _, s in runs]))
print("session wall seconds   ", q([_db.wall(db, sid) for sid, _ in runs]))
print("tool s, first, no sync ", q([s["tool"] for s in first if not s["sync"]]))
print("tool s, first, synced  ", q([s["tool"] for s in first if s["sync"]]))
print("tool s, later steps    ", q([s["tool"] for s in later]))
print("model s per step       ", q([s["model"] for s in rows]))
print("sync s when shown      ", q([s["sync"] for s in rows if s["sync"]]))
for w in (1, 2, 3, 5, 8):
    pick = [s["tool"] for s in later if (s["width"] == w if w < 8 else s["width"] >= 8)]
    print(f"tool s, width {'8+' if w == 8 else w:<3}     ", q(pick))
tool = sum(s["tool"] or 0 for s in rows)
model = sum(s["model"] or 0 for s in rows)
print(f"time split: model {model / (tool + model):.0%}, tool {tool / (tool + model):.0%}")
print(f"width-1 steps {sum(s['width'] == 1 for s in rows) / len(rows):.0%}; "
      f"sessions opening with width 1: {sum(s['width'] == 1 for s in first)}/{len(first)}; "
      f"mean width {statistics.mean(s['width'] for s in rows):.1f}")
print(f"truncated results {sum(s['truncated'] for s in rows) / len(rows):.0%}")
modes = {}
for s in rows:
    for c in s["calls"]:
        if c.get("tool") == "history_read":
            mode = (c.get("input") or {}).get("mode", "around")
            modes[mode] = modes.get(mode, 0) + 1
print("history_read modes", modes)

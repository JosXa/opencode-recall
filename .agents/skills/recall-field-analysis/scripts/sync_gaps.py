"""Relate history_search step time and index sync cost to the idle gap since the previous search (any agent)."""

import statistics

import _db

p = _db.parser(__doc__)
a = p.parse_args()
db = _db.connect(a.db)

events = []
for (sid,) in db.execute(
    "SELECT DISTINCT session_id FROM session_message WHERE type='assistant' AND data LIKE '%history_search%'"
):
    for s in _db.steps(db, sid):
        if "history_search" in s["kinds"] and s["ran"] and s["tool"] is not None:
            events.append(s)
events.sort(key=lambda s: s["ran"])
gaps = [(b["ran"] - a_["ran"]) / 60000 for a_, b in zip(events, events[1:])]
pairs = list(zip(gaps, events[1:]))

print(f"history_search steps={len(pairs)}  (sync is shown only when it took >= the notice threshold)")
print("gap min      steps  tool p50  shown-sync share  sync p50  rows p50")
for lo, hi in ((0, 2), (2, 10), (10, 30), (30, 120), (120, 480), (480, float("inf"))):
    group = [s for g, s in pairs if lo <= g < hi]
    if not group:
        continue
    synced = [s for s in group if s["sync"]]
    sync = statistics.median(s["sync"] for s in synced) if synced else 0
    rows = statistics.median(s["rows"] for s in synced) if synced else 0
    label = f"{lo}-{'inf' if hi == float('inf') else int(hi)}"
    print(f"{label:<12} {len(group):>5}  {statistics.median(s['tool'] for s in group):7.1f}s  "
          f"{len(synced) / len(group):15.0%}  {sync:7.1f}s  {rows:8.0f}")

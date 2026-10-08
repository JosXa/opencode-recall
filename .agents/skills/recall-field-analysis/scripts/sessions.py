"""List recall-agent sessions with their prompt, step count, first-turn width, and wall time."""

import _db

p = _db.parser(__doc__)
p.add_argument("--agent", default="recall")
p.add_argument("--since", help="YYYY-MM-DD")
p.add_argument("--grep", help="only sessions whose prompt contains this text (case-insensitive)")
p.add_argument("--slow", type=float, default=0, help="only sessions with at least this many wall seconds")
a = p.parse_args()
db = _db.connect(a.db)

for sid, parent, title, _ in _db.sessions(db, a.agent, a.since):
    text = _db.prompt(db, sid)
    if a.grep and a.grep.lower() not in text.lower():
        continue
    steps = list(_db.steps(db, sid))
    seconds = _db.wall(db, sid)
    if not steps or seconds < a.slow:
        continue
    first = steps[0]["width"]
    print(f"{sid} parent={parent} steps={len(steps)} first_width={first} wall={seconds:.0f}s  {title}")
    print("   ", " ".join(text.split())[:200])

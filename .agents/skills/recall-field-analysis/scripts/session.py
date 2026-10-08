"""Print every tool step of one or more sessions: width, tool and model seconds, size, truncation, sync."""

import _db

p = _db.parser(__doc__)
p.add_argument("sid", nargs="+")
p.add_argument("--calls", action="store_true", help="print each inner tool call input")
p.add_argument("--code", action="store_true", help="print the execute code of each step")
p.add_argument("--prompt", action="store_true", help="print the prompt the session received")
a = p.parse_args()
db = _db.connect(a.db)

for sid in a.sid:
    steps = list(_db.steps(db, sid))
    print(f"{sid} steps={len(steps)} wall={_db.wall(db, sid):.0f}s")
    if a.prompt:
        print(_db.prompt(db, sid))
    for i, s in enumerate(steps):
        sync = f" sync={s['sync']:.1f}s/{s['rows']}rows" if s["sync"] else ""
        print(
            f"  {i:>2} w={s['width']:<2} tool={s['tool'] or 0:5.1f}s model={s['model'] or 0:5.1f}s "
            f"kb={s['bytes'] // 1024:<3} trunc={int(s['truncated'])}{sync}  {','.join(sorted(set(s['kinds'])))}"
        )
        if a.calls:
            for c in s["calls"]:
                print(f"       {c.get('tool')} {c.get('input')}")
        if a.code and s["code"]:
            print("\n".join("       | " + line for line in s["code"].splitlines()))

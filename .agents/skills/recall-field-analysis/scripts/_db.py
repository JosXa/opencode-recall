"""Shared helpers for reading recall-agent sessions from an OpenCode V2 database."""

import argparse
import json
import os
import re
import sqlite3
import statistics

SYNC = re.compile(r'sync indexed_rows=\\?"(\d+)\\?" seconds=\\?"([\d.]+)')


def parser(description):
    p = argparse.ArgumentParser(description=description)
    p.add_argument(
        "--db",
        default=os.environ.get("OPENCODE_DB", os.path.expanduser("~/.local/share/opencode/opencode-v2.db")),
        help="OpenCode V2 database (default: $OPENCODE_DB or the standard data dir)",
    )
    return p


def connect(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def text(content):
    return "".join(x.get("text", "") for x in (content or []) if isinstance(x, dict))


def steps(db, sid):
    """Yield one dict per tool step of a session, in order."""
    for (data,) in db.execute(
        "SELECT data FROM session_message WHERE session_id=? AND type='assistant' ORDER BY seq", (sid,)
    ):
        msg = json.loads(data)
        mt = msg.get("time") or {}
        for part in msg.get("content", []):
            if part.get("type") != "tool":
                continue
            pt = part.get("time") or {}
            state = part.get("state") or {}
            meta = state.get("metadata") or {}
            calls = meta.get("toolCalls") or [{"tool": part.get("name"), "input": state.get("input")}]
            result = text(state.get("content"))
            syncs = SYNC.findall(result)
            yield {
                "sid": sid,
                "calls": calls,
                "width": len(calls),
                "kinds": [c.get("tool") for c in calls],
                "code": (state.get("input") or {}).get("code"),
                "ran": pt.get("ran"),
                "tool": (pt["completed"] - pt["ran"]) / 1000 if pt.get("ran") and pt.get("completed") else None,
                "model": (pt["ran"] - mt["created"]) / 1000 if pt.get("ran") and mt.get("created") else None,
                "bytes": len(result),
                "truncated": bool(meta.get("truncated")) or "bytes truncated" in result,
                "sync": sum(float(s) for _, s in syncs),
                "rows": sum(int(r) for r, _ in syncs),
                "result": result,
            }


def sessions(db, agent, since=None):
    sql = "SELECT id, parent_id, title, time_created FROM session_v2 WHERE agent=?"
    args = [agent]
    if since:
        sql += " AND time_created >= strftime('%s', ?) * 1000"
        args.append(since)
    return db.execute(sql + " ORDER BY time_created", args).fetchall()


def prompt(db, sid):
    row = db.execute(
        "SELECT data FROM session_message WHERE session_id=? AND type='user' ORDER BY seq LIMIT 1", (sid,)
    ).fetchone()
    return json.loads(row[0]).get("text", "") if row else ""


def wall(db, sid):
    row = db.execute(
        "SELECT min(time_created), max(time_created) FROM session_message WHERE session_id=?", (sid,)
    ).fetchone()
    return (row[1] - row[0]) / 1000 if row and row[0] else 0


def q(values):
    v = sorted(x for x in values if x is not None)
    if not v:
        return "n=0"
    return f"n={len(v)} p50={statistics.median(v):.1f} p90={v[int(len(v) * 0.9)]:.1f} max={v[-1]:.1f}"

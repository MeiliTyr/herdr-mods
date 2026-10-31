#!/usr/bin/env python3
"""Resolve a recorded agent run to its own resumable session, without modifying stores."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
from urllib.parse import quote

# Keep in step with RESUMABLE in model.js.
ALIASES = {'claude': 'claude', 'claude-code': 'claude', 'codex': 'codex',
           'grok': 'grok', 'grok-build': 'grok', 'cmd': 'cmd', 'command-code': 'cmd'}


def first_json(path, limit=1):
    try:
        with path.open(encoding='utf-8') as f:
            for _ in range(limit):
                line = f.readline()
                if not line:
                    break
                try:
                    yield json.loads(line)
                except (ValueError, UnicodeError):
                    continue
    except (OSError, UnicodeError):
        return


def millis(value):
    try:
        return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000
    except (ValueError, TypeError, AttributeError):
        return None


def fresh(paths, created):
    """Session files written at or after the run started: an older file can't be its session."""
    for path in paths:
        try:
            if path.stat().st_mtime * 1000 >= created:
                yield path
        except OSError:
            continue


def codex_sessions(home, cwd, created):
    day = dt.datetime.fromtimestamp(created / 1000, dt.timezone.utc).date()
    for offset in (-1, 0, 1):
        folder = home / '.codex/sessions' / (day + dt.timedelta(days=offset)).strftime('%Y/%m/%d')
        for path in fresh(folder.glob('*.jsonl'), created):
            for row in first_json(path):
                p = row.get('payload', {})
                if row.get('type') == 'session_meta' and not p.get('parent_thread_id'):
                    yield p.get('id'), p.get('cwd'), millis(p.get('timestamp'))


def claude_sessions(home, cwd, created):
    folder = home / '.claude/projects' / re.sub(r'[^a-zA-Z0-9]', '-', cwd)
    for path in fresh(folder.glob('*.jsonl'), created):
        for row in first_json(path, 30):
            if row.get('cwd') and row.get('timestamp'):
                yield row.get('sessionId'), row.get('cwd'), millis(row.get('timestamp'))
                break


def cmd_sessions(home, cwd, created):
    folder = home / '.commandcode/projects' / re.sub(r'[^a-zA-Z0-9]+', '-', cwd).strip('-').lower()
    for path in fresh(folder.glob('*.jsonl'), created):
        if path.name.endswith('.checkpoints.jsonl'):
            continue
        for row in first_json(path):
            if row.get('type') == 'session':
                yield row.get('id'), row.get('cwd'), millis(row.get('timestamp'))


def grok_sessions(home, cwd, created):
    folder = home / '.grok/sessions' / quote(cwd, safe='')
    for path in folder.glob('*/summary.json'):
        try:
            row = json.loads(path.read_text(encoding='utf-8'))
            yield row.get('info', {}).get('id'), row.get('info', {}).get('cwd'), millis(row.get('created_at'))
        except (OSError, ValueError, UnicodeError):
            continue


# Per agent: where its sessions are, and the argument that resumes one (alone it opens a picker).
READERS = {'codex': codex_sessions, 'claude': claude_sessions, 'cmd': cmd_sessions, 'grok': grok_sessions}
RESUME = {'codex': 'resume', 'claude': '--resume', 'cmd': '--resume', 'grok': '--resume'}


def kind(rec):
    """The agent (an ALIASES value, or None) and the command's first word."""
    command = (rec.get('command') or '').strip().split()
    word = command[0] if command else ''
    return ALIASES.get(rec.get('agent') or os.path.basename(word)), word


def resolve(rec, records, home):
    agent, word = kind(rec)
    if not agent:
        return {'error': 'Unsupported agent'}
    cwd, created = rec.get('cwd'), rec.get('created_ms')
    if not isinstance(cwd, str) or not cwd or not isinstance(created, (int, float)):
        return {'error': 'The recorded working directory or start time is missing'}
    ends = [x for x in (rec.get('finished_ms'), rec.get('removed_ms')) if isinstance(x, (int, float))]
    ends.extend(r['created_ms'] for r in records if r.get('id') != rec.get('id') and kind(r)[0] == agent
                and r.get('cwd') == cwd and isinstance(r.get('created_ms'), (int, float))
                and r['created_ms'] > created)
    end = min(ends, default=float('inf'))
    starts = {}
    for sid, session_cwd, start in READERS[agent](home, cwd, created):
        if isinstance(sid, str) and sid and session_cwd == cwd and start is not None and created <= start < end:
            starts[sid] = min(start, starts.get(sid, start))
    # The earliest session in the window, unless two different sessions share that start.
    first = min(starts.values(), default=None)
    earliest = [sid for sid, start in starts.items() if start == first]
    session = earliest[0] if len(earliest) == 1 else None
    if agent == 'grok' and session is None:
        return {'error': 'Exact Grok session not found; this Grok version has no documented interactive resume picker. Use grok sessions list to inspect sessions.'}
    argv = [word if os.path.isabs(word) else agent, RESUME[agent]]
    if session:
        argv.append(session)
    return {'argv': argv, 'cwd': cwd, 'session': session}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--home', type=Path, default=Path.home())
    parser.add_argument('--history', required=True, type=Path)
    parser.add_argument('record_id')
    args = parser.parse_args()
    try:
        records = json.loads(args.history.read_text(encoding='utf-8'))['records']
        rec = next((r for r in records if r.get('id') == args.record_id), None)
        result = resolve(rec, records, args.home) if rec else {'error': 'Record not found'}
    except (ValueError, TypeError, OSError, OverflowError, KeyError, AttributeError) as e:
        result = {'error': str(e)}
    print(json.dumps(result))


if __name__ == '__main__':
    main()

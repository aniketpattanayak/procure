#!/usr/bin/env python3
"""Groups slow statements from the Postgres log (log_min_duration_statement) by statement text.
   python3 load/phase-8/slowlog.py <pg log> [since 'YYYY-MM-DD HH:MM'] [dump-dir]"""
import re, sys, os, collections
log = open(sys.argv[1], errors='replace').read().split('\n')
since = sys.argv[2] if len(sys.argv) > 2 else ''
out = sys.argv[3] if len(sys.argv) > 3 else None
entries, cur = [], None
head = re.compile(r'^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\.\d+ \S+ \[\d+\] (\w+):  (.*)$')
for line in log:
    m = head.match(line)
    if m:
        if cur: entries.append(cur)
        cur = None
        if m.group(2) == 'LOG' and m.group(3).startswith('duration:') and m.group(1) >= since:
            d = re.match(r'duration: ([\d.]+) ms  (?:execute [^:]*|statement): ?(.*)', m.group(3))
            if d: cur = {'ms': float(d.group(1)), 'sql': d.group(2), 'params': ''}
        elif m.group(2) == 'DETAIL' and entries and m.group(3).startswith('parameters:') and not cur:
            entries[-1]['params'] = m.group(3)
    elif cur is not None and line.startswith('\t'):
        cur['sql'] += '\n' + line[1:]
if cur: entries.append(cur)
groups = collections.defaultdict(list)
for e in entries: groups[re.sub(r'\s+', ' ', e['sql'])[:160]].append(e)
for i, (k, v) in enumerate(sorted(groups.items(), key=lambda kv: -max(e['ms'] for e in kv[1]))):
    print(f"#{i} n={len(v)} max={max(e['ms'] for e in v):.0f} ms  avg={sum(e['ms'] for e in v)/len(v):.0f}  {k}")
    if out:
        os.makedirs(out, exist_ok=True)
        worst = max(v, key=lambda e: e['ms'])
        open(f"{out}/q{i}.sql", 'w').write(worst['sql'] + '\n-- ' + worst['params'] + '\n')

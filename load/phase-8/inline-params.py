#!/usr/bin/env python3
"""Inlines '-- parameters: $1 = '...', …' (as dumped by slowlog.py) into the SQL, for EXPLAIN with explain.mjs."""
import re, sys
src = open(sys.argv[1]).read()
sql, _, tail = src.rpartition('\n-- ')
params = dict(re.findall(r"\$(\d+) = ('(?:[^']|'')*'|NULL)", tail))
print(re.sub(r'\$(\d+)\b', lambda m: params.get(m.group(1), m.group(0)), sql))

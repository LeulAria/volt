#!/usr/bin/env python3
# Rows and per-arm medians of b1run.mjs JSONL files: summarize.py <file.jsonl> [--rows]
import json, sys, statistics as st
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
def arm(tag): return tag.split('-')[-2] if tag.count('-') >= 2 else tag
def first_prompts(r): return [t['promptTokens'] for t in r['tasks'] if t['promptTokens']]
def cost(r): return r['costUsd']['parent'] + r['costUsd']['children']
def disp(r): return [t['runStart'] - t['started'] for t in r['tasks'] if t['runStart'] is not None and t['started'] is not None]
def wake(r): return [w['afterLastEndMs'] for w in r['wakes'] if w['afterLastEndMs'] is not None]
if '--rows' in sys.argv:
	for r in rows:
		print(r['tag'], 'load', r['load'].split()[0], 'e2e', r['e2eMs'], 'crit', r['criticalPathMs'], 'callStart', r['delegateCallStart'], 'accepted', r['delegateAccepted'], 'refused', len(r['refusedCalls']),
			'prompt', first_prompts(r), 'ready', [t['agentReadyMs'] for t in r['tasks']], 'src', [t['agentSource'] for t in r['tasks']], 'disp->run', disp(r), 'firstEvent-runStart', [ (t['firstEvent'] or 0) - (t['runStart'] or 0) for t in r['tasks']],
			'cost', round(cost(r), 3), r['costUsd'], 'parentRuns', r['parentRuns'], 'wakes', wake(r), 'den', r['sandboxDenials'], 'fail', r['failures'], 'states', [t['state'] for t in r['tasks']], 'timedOut', r['timedOut'])
by = {}
for r in rows: by.setdefault(arm(r['tag']), []).append(r)
def med(xs):
	xs = [x for x in xs if x is not None]
	return (round(st.median(xs)), min(xs), max(xs)) if xs else None
for a, rs in by.items():
	print(f"== {a} n={len(rs)} load1={[r['load'].split()[0] for r in rs]}")
	print('  e2e ms', med([r['e2eMs'] for r in rs]), ' critical path ms', med([r['criticalPathMs'] for r in rs]))
	print('  subagent first-request prompt', med([p for r in rs for p in first_prompts(r)]))
	print('  delegate accepted ms', med([r['delegateAccepted'] for r in rs]), ' dispatch->send ms', med([d for r in rs for d in disp(r)]))
	print('  cold agent ready ms', med([t['agentReadyMs'] for r in rs for t in r['tasks'] if t['agentSource'] == 'cold']), ' pool ready ms', med([t['agentReadyMs'] for r in rs for t in r['tasks'] if t['agentSource'] == 'pool']))
	print('  cost $', [round(cost(r), 3) for r in rs], ' children $', [r['costUsd']['children'] for r in rs])
	print('  parent runs', [r['parentRuns'] for r in rs], ' wake after last child ms', [wake(r) for r in rs], ' denials', [r['sandboxDenials'] for r in rs], ' failures', [r['failures'] for r in rs], ' refused calls', [len(r['refusedCalls']) for r in rs])

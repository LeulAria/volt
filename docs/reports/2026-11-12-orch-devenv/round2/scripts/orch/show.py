#!/usr/bin/env python3
# One block per run of b1run.mjs JSONL files, with every task: show.py <file.jsonl>...
import json, sys
for f in sys.argv[1:]:
	for l in open(f):
		if not l.strip():
			continue
		r = json.loads(l)
		print(f.split('/')[-1], r['tag'], 'load', r['load'].split()[0], '| title:', r.get('title'), '| e2e', r['e2eMs'], 'accepted', r['delegateAccepted'], 'crit', r['criticalPathMs'], 'parentRuns', r['parentRuns'],
			'wakes', [(w['afterLastEndMs'], w['ms']) for w in r['wakes']], 'fail', r['failures'], 'den', r['sandboxDenials'], 'cost', r['costUsd'], 'timedOut', r['timedOut'])
		for t in r['tasks']:
			print('   ', t['title'][:34].ljust(34), (t.get('model') or '')[:34].ljust(34), (t.get('role') or '')[:14].ljust(14), t['state'].ljust(10), 'prompt', t.get('promptTokens'), 'ready', t.get('agentReadyMs'), t.get('agentSource'),
				'start', t.get('started'), 'run', t.get('runStart'), 'end', t.get('ended'), 'req', t.get('requests'), '$', t.get('costUsd'), (t.get('error') or '')[:90])

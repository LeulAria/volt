#!/usr/bin/env python3
"""A4 First Word for the Bare CLI control on this Mac (ADEMark method, unofficial).

ADEMark runs `claude --model claude-opus-5-5 --effort high --dangerously-skip-permissions` in a new Ghostty tab and reads
the first word off the screen (ScreenCaptureKit + OCR). This Mac has no Ghostty and no process here holds the Screen
Recording grant, so this runs the same command in a pseudo-terminal of the same size and takes the first word when the
TUI writes it to the terminal (ANSI stripped): a lower bound for the pixel time, like Volt's DOM time is for Volt.
Per run, as TESTS.md A4 / ADEMark's runRep: a new CLI (a new tab), 1.5 s, type `replay:hi`, 0.4 s, t0, Enter; the
replay server's log gives the request time on the same clock (CLOCK_UPTIME_RAW).

  python3 barecli.py <label> <runs>        rows -> ../../data/firstword/a4-bare.jsonl
Env: LOAD_MAX (14: a run starts only at or below it), REPLAY_LOG, REPLAY_URL.
"""
import json, os, pty, re, select, signal, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
R5 = os.path.expanduser('~/.volt-r5/firstword')
HOME = os.path.join(R5, 'h', 'bare')
ARENA = os.path.join(R5, 'arena-bare')
REPLAY_URL = os.environ.get('REPLAY_URL', 'http://127.0.0.1:18972')
REPLAY_LOG = os.environ.get('REPLAY_LOG', os.path.join(R5, 'replay.jsonl'))
OUT = os.path.join(HERE, '../../data/firstword/a4-bare.jsonl')
COLS, ROWS = 200, 55
ANSI = re.compile(rb'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]')


def now_ns():
	return time.clock_gettime_ns(time.CLOCK_UPTIME_RAW)


def load1():
	return float(subprocess.check_output(['sysctl', '-n', 'vm.loadavg']).decode().split()[1])


def setup():
	os.makedirs(os.path.join(HOME, '.claude'), exist_ok=True)
	key = os.path.join(HOME, '.claude', 'key.sh')
	with open(key, 'w') as f:
		f.write('#!/bin/sh\necho sk-ant-replay-0000\n')
	os.chmod(key, 0o755)
	with open(os.path.join(HOME, '.claude', 'settings.json'), 'w') as f:
		json.dump({'apiKeyHelper': key, 'skipDangerousModePermissionPrompt': True,
			'env': {'ANTHROPIC_BASE_URL': REPLAY_URL, 'DISABLE_AUTOUPDATER': '1'}}, f)
	if not os.path.isdir(os.path.join(ARENA, '.git')):
		subprocess.check_call(['rm', '-rf', ARENA])
		subprocess.check_call(['cp', '-R', os.path.expanduser('~/.volt-r4/ademark/arena'), ARENA])
		subprocess.check_call(['git', '-C', ARENA, 'init', '-q', '-b', 'main'])
		subprocess.check_call(['git', '-C', ARENA, 'add', '-A'])
		subprocess.check_call(['git', '-C', ARENA, '-c', 'user.name=bench', '-c', 'user.email=bench@localhost', 'commit', '-q', '-m', 'arena'])
	cfg = os.path.join(HOME, '.claude.json')
	data = json.load(open(cfg)) if os.path.exists(cfg) else {}
	data.update({'hasCompletedOnboarding': True, 'theme': 'dark', 'bypassPermissionsModeAccepted': True})
	data.setdefault('projects', {}).setdefault(ARENA, {})['hasTrustDialogAccepted'] = True
	json.dump(data, open(cfg, 'w'))


def env():
	e = {k: v for k, v in os.environ.items() if not re.match(r'^(CLAUDE|ANTHROPIC_|VSCODE_|ELECTRON_RUN_AS_NODE$)', k)}
	e.update({'HOME': HOME, 'TERM': 'xterm-256color', 'COLORTERM': 'truecolor', 'ANTHROPIC_BASE_URL': REPLAY_URL,
		'DISABLE_AUTOUPDATER': '1', 'PATH': os.path.expanduser('~/.local/bin') + ':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'})
	return e


class Tui:
	def __init__(self):
		self.pid, self.fd = pty.fork()
		if self.pid == 0:
			os.chdir(ARENA)
			import fcntl, struct, termios
			fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
			os.execvpe('claude', ['claude', '--model', 'claude-opus-5-5', '--effort', 'high', '--dangerously-skip-permissions'], env())
		self.text = b''

	def read(self, timeout):
		r, _, _ = select.select([self.fd], [], [], timeout)
		if not r:
			return b''
		try:
			chunk = os.read(self.fd, 65536)
		except OSError:
			return b''
		self.text += chunk
		return chunk

	def wait_for(self, needle, timeout_s):
		end = time.time() + timeout_s
		while time.time() < end:
			if self.read(0.05) and needle in ANSI.sub(b'', self.text):
				return now_ns()
		return None

	def write(self, data):
		os.write(self.fd, data)

	def close(self):
		# Like closing the tab: the CLI and what it started go. Never a blocking wait (a pty close can hang on macOS).
		for sig in (signal.SIGTERM, signal.SIGKILL):
			try:
				os.killpg(self.pid, sig)
			except OSError:
				pass
			for _ in range(20):
				self.read(0)
				try:
					if os.waitpid(self.pid, os.WNOHANG)[0] == self.pid:
						return
				except OSError:
					return
				time.sleep(0.05)


def replay_after(t0):
	rows = []
	if os.path.exists(REPLAY_LOG):
		for line in open(REPLAY_LOG):
			try:
				r = json.loads(line)
			except ValueError:
				continue
			if r.get('t_ns', 0) >= t0:
				rows.append(r)
	return rows


def once(label, rep):
	load_max = float(os.environ.get('LOAD_MAX', '14'))
	while load1() > load_max:
		time.sleep(15)
	load = subprocess.check_output(['uptime']).decode().split('averages:')[-1].strip()
	tui = Tui()
	t_spawn = now_ns()
	ready = tui.wait_for(b'bypass', 30)
	if ready is None:
		tui.close()
		raise RuntimeError('the CLI never showed its footer: ' + ANSI.sub(b'', tui.text)[-400:].decode(errors='replace'))
	time.sleep(1.5)
	for ch in 'replay:hi':
		tui.write(ch.encode())
		time.sleep(0.05)
	time.sleep(0.4)
	before_enter = len(tui.text)
	t0 = now_ns()
	tui.write(b'\r')
	seen = None
	end = time.time() + 30
	while time.time() < end and seen is None:
		if tui.read(0.02) and b'LEDGERMARK' in ANSI.sub(b'', tui.text[before_enter:]):
			seen = now_ns()
	time.sleep(1.0)
	reqs = [r for r in replay_after(t0) if r.get('path', '').startswith('/v1/messages')]
	main = next((r for r in reqs if r.get('session') == 'hi'), None)
	tui.close()
	row = {'label': label, 'rep': rep, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'load': load, 'method': 'pty bytes',
		'cliReadyMs': (ready - t_spawn) / 1e6,
		'totalMs': (seen - t0) / 1e6 if seen else None,
		'beforeRequestMs': (main['t_ns'] - t0) / 1e6 if main else None,
		'onScreenMs': (seen - main['t_ns']) / 1e6 if seen and main else None,
		'requests': [{'session': r.get('session'), 'atMs': (r['t_ns'] - t0) / 1e6, 'bytes': r.get('bytes')} for r in reqs]}
	with open(OUT, 'a') as f:
		f.write(json.dumps(row) + '\n')
	print(json.dumps({k: row[k] for k in ('rep', 'load', 'totalMs', 'beforeRequestMs', 'onScreenMs', 'cliReadyMs')}), flush=True)
	return row


if __name__ == '__main__':
	label = sys.argv[1] if len(sys.argv) > 1 else 'bare'
	runs = int(sys.argv[2]) if len(sys.argv) > 2 else 6
	setup()
	rows = []
	for i in range(runs):
		try:
			rows.append(once(label, i))
		except Exception as err:
			print('run failed', err, flush=True)
		time.sleep(1)
	vals = sorted(r['totalMs'] for r in rows if r['totalMs'] is not None)
	if vals:
		mid = len(vals) // 2
		print(json.dumps({'label': label, 'n': len(vals), 'totalMs': vals[mid] if len(vals) % 2 else (vals[mid - 1] + vals[mid]) / 2}))

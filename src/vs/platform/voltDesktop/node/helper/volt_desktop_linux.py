#!/usr/bin/env python3
#---------------------------------------------------------------------------------------------
#  Copyright (c) Volt ADK. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#---------------------------------------------------------------------------------------------

# Volt's desktop helper for Linux: the same protocol as VoltDesktop.swift (one JSON request per
# line on stdin, one JSON reply per line on stdout), over AT-SPI for reading apps and acting on
# their controls, and XTest (python-xlib), xdotool or ydotool (Wayland) for pointer and keys.
#
# Nodes use the macOS role names (AXButton, AXTextField, ...), so Volt reads every OS the same way.

import base64
import json
import os
import shutil
import subprocess
import sys
import time
import warnings

try:
	import gi
	gi.require_version('Atspi', '2.0')
	from gi.repository import Atspi, GLib
except (ImportError, ValueError) as missing:
	# Volt shows the last lines of stderr when the helper exits before it is up.
	print('Desktop control on Linux needs AT-SPI for Python: install python3-gi and gir1.2-atspi-2.0 (Debian/Ubuntu) or python3-gobject and at-spi2-core (Fedora). (%s)' % missing, file=sys.stderr, flush=True)
	sys.exit(1)

try:
	from Xlib import X, XK, display as xdisplay
	from Xlib.ext import xtest
except ImportError:
	xdisplay = None


class Failure(Exception):
	pass


# Accessibles implement AT-SPI's interfaces directly; the old get_*_iface getters only warn.
warnings.filterwarnings('ignore', category=DeprecationWarning)


def supports(acc, interface):
	return interface in (safe(acc.get_interfaces, []) or [])


#region Roles

ROLE_NAMES = {
	'PUSH_BUTTON': 'AXButton', 'BUTTON': 'AXButton', 'TOGGLE_BUTTON': ('AXCheckBox', 'AXToggle'), 'SWITCH': ('AXCheckBox', 'AXSwitch'),
	'CHECK_BOX': 'AXCheckBox', 'RADIO_BUTTON': 'AXRadioButton', 'COMBO_BOX': 'AXPopUpButton',
	'TEXT': 'AXTextField', 'ENTRY': 'AXTextField', 'PASSWORD_TEXT': ('AXTextField', 'AXSecureTextField'), 'SPIN_BUTTON': 'AXIncrementor',
	'LABEL': 'AXStaticText', 'STATIC': 'AXStaticText', 'CAPTION': 'AXStaticText', 'PARAGRAPH': 'AXStaticText', 'HEADING': 'AXHeading', 'LINK': 'AXLink',
	'IMAGE': 'AXImage', 'ICON': 'AXImage', 'CANVAS': 'AXImage', 'DRAWING_AREA': 'AXImage', 'SLIDER': 'AXSlider', 'SCROLL_BAR': 'AXScrollBar', 'SCROLL_PANE': 'AXScrollArea',
	'PAGE_TAB_LIST': 'AXTabGroup', 'PAGE_TAB': ('AXRadioButton', 'AXTabButton'), 'TABLE': 'AXTable', 'TREE_TABLE': 'AXOutline', 'TREE': 'AXOutline',
	'TABLE_ROW': 'AXRow', 'TABLE_CELL': 'AXCell', 'TREE_ITEM': ('AXRow', 'AXOutlineRow'), 'LIST': 'AXList', 'LIST_BOX': 'AXList', 'LIST_ITEM': 'AXCell',
	'MENU_BAR': 'AXMenuBar', 'MENU': 'AXMenu', 'MENU_ITEM': 'AXMenuItem', 'CHECK_MENU_ITEM': 'AXMenuItem', 'RADIO_MENU_ITEM': 'AXMenuItem', 'TEAROFF_MENU_ITEM': 'AXMenuItem',
	'TOOL_BAR': 'AXToolbar', 'DIALOG': ('AXWindow', 'AXDialog'), 'ALERT': ('AXWindow', 'AXDialog'), 'FILE_CHOOSER': ('AXWindow', 'AXDialog'),
	'FRAME': 'AXWindow', 'WINDOW': 'AXWindow', 'DOCUMENT_WEB': 'AXWebArea', 'DOCUMENT_FRAME': 'AXWebArea', 'PROGRESS_BAR': 'AXProgressIndicator',
	'LEVEL_BAR': 'AXLevelIndicator', 'SEPARATOR': 'AXSplitter', 'SPLIT_PANE': 'AXSplitGroup', 'PANEL': 'AXGroup', 'FILLER': 'AXGroup', 'SECTION': 'AXGroup',
}
# Older AT-SPI versions lack some roles: map the ones this one has.
ROLES = {getattr(Atspi.Role, name): ax for name, ax in ROLE_NAMES.items() if hasattr(Atspi.Role, name)}

SKIPPED = {'AXScrollBar', 'AXSplitter', 'AXMenuBar'}
TEXTUAL = {'AXStaticText', 'AXHeading'}


def ax_role(acc):
	try:
		mapped = ROLES.get(acc.get_role(), 'AXGroup')
	except GLib.Error:
		return 'AXUnknown', None
	return mapped if isinstance(mapped, tuple) else (mapped, None)

#endregion

#region Reading

handles = {}
handle_count = 0
volt_pid = os.getppid()


def handle_for(acc):
	global handle_count
	handle_count += 1
	key = 'h%d' % handle_count
	handles[key] = acc
	return key


def element(request):
	acc = handles.get(request.get('h'))
	if acc is None:
		raise Failure('That element is gone: read the screen again.')
	return acc


def safe(fn, default=None):
	try:
		return fn()
	except Exception:
		return default


def extents(acc):
	box = safe(lambda: acc.get_extents(Atspi.CoordType.SCREEN))
	return (box.x, box.y, box.width, box.height) if box else None


def text_of(acc):
	if not supports(acc, 'Text'):
		return None
	count = safe(acc.get_character_count, 0)
	return safe(lambda: Atspi.Text.get_text(acc, 0, min(count, 500)))


def value_of(acc):
	return safe(acc.get_current_value) if supports(acc, 'Value') else None


def desktop_apps():
	desktop = Atspi.get_desktop(0)
	return [app for app in (safe(lambda i=i: desktop.get_child_at_index(i)) for i in range(safe(desktop.get_child_count, 0))) if app is not None]


def windows_of(app):
	return [w for w in (safe(lambda i=i: app.get_child_at_index(i)) for i in range(safe(app.get_child_count, 0))) if w is not None and ax_role(w)[0] == 'AXWindow']


def states(acc):
	state = safe(lambda: acc.get_state_set())
	return (lambda s: safe(lambda: state.contains(s), False)) if state else (lambda s: False)


def is_active(app):
	return any(states(w)(Atspi.StateType.ACTIVE) for w in windows_of(app))


def find_app(request):
	apps = [a for a in desktop_apps() if safe(a.get_process_id) not in (None, volt_pid, os.getpid())]
	pid = request.get('pid')
	if pid:
		for app in apps:
			if safe(app.get_process_id) == pid:
				return app
	query = (request.get('app') or '').lower()
	if query:
		named = [a for a in apps if (safe(a.get_name, '') or '').lower() == query or process_name(safe(a.get_process_id, 0)) == query]
		named = named or [a for a in apps if query in (safe(a.get_name, '') or '').lower() or query in process_name(safe(a.get_process_id, 0))]
		if named:
			return named[0]
		raise Failure('%s is not running. Open it with an open step first.' % request.get('app'))
	front = [a for a in apps if is_active(a)]
	if front:
		return front[0]
	with_windows = [a for a in apps if windows_of(a)]
	if with_windows:
		return with_windows[0]
	raise Failure('No app is in front.')


def process_name(pid):
	"""The program's file name (/proc/<pid>/comm cuts names at 15 characters)."""
	try:
		return os.path.basename(os.readlink('/proc/%d/exe' % pid)).lower()
	except OSError:
		try:
			with open('/proc/%d/comm' % pid) as comm:
				return comm.read().strip().lower()
		except OSError:
			return ''


def read(acc, depth, budget, clip):
	"""One element and its subtree; elements scrolled out of `clip` or not showing are not read."""
	if budget[0] <= 0:
		return None
	role, sub = ax_role(acc)
	if role in SKIPPED:
		return None
	has = states(acc)
	if depth > 0 and not has(Atspi.StateType.SHOWING) and role != 'AXMenu':
		return None
	frame = extents(acc)
	if frame and depth > 0:
		x, y, w, h = frame
		if w <= 0 or h <= 0:
			return None
		if clip and (x + w < clip[0] or y + h < clip[1] or x > clip[0] + clip[2] or y > clip[1] + clip[3]):
			return None
	budget[0] -= 1
	node = {'h': handle_for(acc), 'role': role}
	if sub:
		node['sub'] = sub
	name = safe(acc.get_name, '') or ''
	desc = safe(acc.get_description, '') or ''
	text = text_of(acc) if role in TEXTUAL or role == 'AXTextField' else None
	if role in TEXTUAL:
		if text or name:
			node['value'] = (text or name)[:500]
	else:
		if name:
			node['title'] = name
		if role == 'AXTextField' and text:
			node['value'] = text[:500]
	if desc and desc != name:
		node['desc'] = desc
	if role in ('AXCheckBox', 'AXRadioButton'):
		node['value'] = '1' if has(Atspi.StateType.CHECKED) or has(Atspi.StateType.PRESSED) else '0'
	elif role in ('AXSlider', 'AXIncrementor', 'AXProgressIndicator', 'AXLevelIndicator'):
		number = value_of(acc)
		if number is not None:
			node['value'] = ('%g' % number)
	if not has(Atspi.StateType.ENABLED) and not has(Atspi.StateType.SENSITIVE):
		node['disabled'] = True
	if has(Atspi.StateType.FOCUSED):
		node['focused'] = True
	if has(Atspi.StateType.SELECTED) and role not in ('AXWindow',):
		node['selected'] = True
	if has(Atspi.StateType.EXPANDABLE):
		node['expanded'] = bool(has(Atspi.StateType.EXPANDED))
	attributes = safe(acc.get_attributes, {}) or {}
	if attributes.get('placeholder-text'):
		node['ph'] = attributes['placeholder-text']
	identifier = safe(acc.get_accessible_id, '') or attributes.get('id', '')
	if identifier:
		node['id'] = identifier
	if frame:
		node['f'] = [int(v) for v in frame]
	inner = clip
	if role == 'AXScrollArea' and frame:
		inner = frame if clip is None else intersect(clip, frame)
	count = safe(acc.get_child_count, 0)
	# Huge tables and lists (a spreadsheet) are read as far as the rows on screen go.
	if depth < 40 and count:
		kids = []
		for i in range(min(count, 2048)):
			if budget[0] <= 0:
				break
			child = safe(lambda i=i: acc.get_child_at_index(i))
			if child is None:
				continue
			kid = read(child, depth + 1, budget, inner)
			if kid:
				kids.append(kid)
		if kids:
			node['c'] = kids
	return node


def intersect(a, b):
	x1, y1 = max(a[0], b[0]), max(a[1], b[1])
	x2, y2 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
	return (x1, y1, max(0, x2 - x1), max(0, y2 - y1))


def tree(request):
	app = find_app(request)
	handles.clear()
	windows = windows_of(app)
	titles = [safe(w.get_name, '') or '' for w in windows]
	window = None
	wanted = (request.get('window') or '').lower()
	if wanted:
		window = next((w for w, t in zip(windows, titles) if wanted in t.lower()), None)
	window = window or next((w for w in windows if states(w)(Atspi.StateType.ACTIVE)), None) or (windows[0] if windows else None)
	budget = [max(50, min(5000, request.get('max') or 2000))]
	result = {'app': safe(app.get_name, '') or '', 'bundle': process_name(safe(app.get_process_id, 0)), 'pid': safe(app.get_process_id, 0), 'windows': [t for t in titles if t]}
	if window is not None:
		result['window'] = safe(window.get_name, '') or ''
		root = read(window, 0, budget, None)
		if root:
			# Open popup menus are windows of their own: read them with the window.
			for other in windows:
				if other is not window and find_role(other, 'AXMenu', 4) is not None and states(other)(Atspi.StateType.SHOWING):
					menu = read(other, 1, budget, None)
					if menu:
						root.setdefault('c', []).append(menu)
			result['root'] = root
	minimized = [t for w, t in zip(windows, titles) if t and states(w)(Atspi.StateType.ICONIFIED)]
	if minimized:
		result['minimized'] = minimized
	result['truncated'] = budget[0] <= 0
	return result

#endregion

#region Acting

ACTION_NAMES = ('click', 'press', 'activate', 'toggle', 'jump', 'open', 'select')


def perform(request):
	acc = element(request)
	count = safe(acc.get_n_actions, 0) if supports(acc, 'Action') else 0
	if not count:
		raise Failure('The app offers no action on that element.')
	wanted = (request.get('action') or '').lower().replace('ax', '')
	names = [(safe(lambda i=i: acc.get_action_name(i), '') or '').lower() for i in range(count)]
	index = next((i for i, n in enumerate(names) if wanted and n == wanted), None)
	if index is None:
		index = next((i for i, n in enumerate(names) if n in ACTION_NAMES), 0)
	if not acc.do_action(index):
		raise Failure('The app refused %s.' % (names[index] or 'the action'))


def set_value(request):
	acc = element(request)
	safe(acc.grab_focus)
	if not supports(acc, 'EditableText') or not safe(lambda: acc.set_text_contents(request.get('value') or ''), False):
		raise Failure('The field does not take a value directly.')


def focus(request):
	acc = element(request)
	if not supports(acc, 'Component') or not safe(acc.grab_focus, False):
		raise Failure('The element cannot take focus.')

#endregion

#region Pointer and keys

WAYLAND = bool(os.environ.get('WAYLAND_DISPLAY')) and not os.environ.get('DISPLAY')
_display = None


def x():
	"""The X display for XTest, when python-xlib is there (one event costs no process start)."""
	global _display
	if _display is None and xdisplay is not None and not WAYLAND:
		try:
			_display = xdisplay.Display()
			if not _display.has_extension('XTEST'):
				_display = False
		except Exception:
			_display = False
	return _display or None


def tool(name):
	if shutil.which(name) is None:
		raise Failure('Desktop control on Linux needs %s for the pointer and keys: install it (apt install %s / dnf install %s).' % (name, name, name))
	return name


def run(*args):
	subprocess.run(list(args), check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=60)


KEYSYMS = {
	'enter': 'Return', 'return': 'Return', 'tab': 'Tab', 'space': 'space', 'backspace': 'BackSpace', 'delete': 'BackSpace',
	'escape': 'Escape', 'esc': 'Escape', 'forwarddelete': 'Delete', 'home': 'Home', 'end': 'End', 'pageup': 'Prior', 'pagedown': 'Next',
	'left': 'Left', 'arrowleft': 'Left', 'right': 'Right', 'arrowright': 'Right', 'up': 'Up', 'arrowup': 'Up', 'down': 'Down', 'arrowdown': 'Down',
	'-': 'minus', '=': 'equal', '[': 'bracketleft', ']': 'bracketright', ';': 'semicolon', "'": 'apostrophe', ',': 'comma', '.': 'period',
	'/': 'slash', '\\': 'backslash', '`': 'grave',
}
MODIFIERS = {'cmd': 'Super_L', 'command': 'Super_L', 'meta': 'Super_L', 'super': 'Super_L', 'win': 'Super_L', 'ctrl': 'Control_L', 'control': 'Control_L', 'alt': 'Alt_L', 'option': 'Alt_L', 'opt': 'Alt_L', 'shift': 'Shift_L'}


def keysym(name):
	name = name.strip().lower()
	if name in KEYSYMS:
		return KEYSYMS[name]
	if len(name) == 1 and (name.isalnum()):
		return name
	if name.startswith('f') and name[1:].isdigit() and 1 <= int(name[1:]) <= 12:
		return name.upper()
	raise Failure('Unknown key %s. Use a letter, digit, enter, tab, space, escape, delete, arrows, home, end, pageup, pagedown or f1-f12, with cmd/ctrl/alt/shift.' % name)


def modifiers(combo):
	parts = [p.strip().lower() for p in (combo or '').split('+') if p.strip()]
	for part in parts:
		if part not in MODIFIERS:
			raise Failure('Unknown modifier %s.' % part)
	return [MODIFIERS[p] for p in parts]


def x_key(d, name, down):
	code = d.keysym_to_keycode(XK.string_to_keysym(name))
	if not code:
		raise Failure('This keyboard has no %s key.' % name)
	xtest.fake_input(d, X.KeyPress if down else X.KeyRelease, code)


def key(request):
	parts = [p.strip() for p in (request.get('combo') or '').split('+')]
	if not parts or not parts[-1]:
		raise Failure('key needs a combo, e.g. ctrl+s.')
	mods = modifiers('+'.join(parts[:-1]))
	last = keysym(parts[-1])
	d = x()
	if d:
		for m in mods:
			x_key(d, m, True)
		x_key(d, last, True)
		x_key(d, last, False)
		for m in reversed(mods):
			x_key(d, m, False)
		d.sync()
	elif WAYLAND:
		run(tool('ydotool'), 'key', *['%s' % c for c in ydotool_codes(mods + [last])])
	else:
		run(tool('xdotool'), 'key', '--clearmodifiers', '+'.join(mods + [last]))


def ydotool_codes(names):
	# ydotool takes Linux input event codes: KEY_x:1 presses, KEY_x:0 releases.
	codes = {'Super_L': 125, 'Control_L': 29, 'Alt_L': 56, 'Shift_L': 42, 'Return': 28, 'Tab': 15, 'space': 57, 'BackSpace': 14, 'Escape': 1, 'Delete': 111,
		'Home': 102, 'End': 107, 'Prior': 104, 'Next': 109, 'Left': 105, 'Right': 106, 'Up': 103, 'Down': 108}
	letters = 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'
	for row, start in zip(letters, (16, 30, 44)):
		for i, ch in enumerate(row):
			codes[ch] = start + i
	for i, ch in enumerate('1234567890'):
		codes[ch] = 2 + i
	pressed = [codes.get(n) for n in names]
	if None in pressed:
		raise Failure('ydotool cannot send %s.' % names[pressed.index(None)])
	return ['%d:1' % c for c in pressed] + ['%d:0' % c for c in reversed(pressed)]


def pointer_to(d, px, py):
	xtest.fake_input(d, X.MotionNotify, x=int(round(px)), y=int(round(py)))


def click(request):
	px, py = request.get('x', 0), request.get('y', 0)
	button = 3 if request.get('button') == 'right' else 1
	count = max(1, int(request.get('count') or 1))
	mods = modifiers(request.get('modifiers'))
	d = x()
	if d:
		pointer_to(d, px, py)
		for m in mods:
			x_key(d, m, True)
		for _ in range(count):
			xtest.fake_input(d, X.ButtonPress, button)
			xtest.fake_input(d, X.ButtonRelease, button)
			d.sync()
			time.sleep(0.01)
		for m in reversed(mods):
			x_key(d, m, False)
		d.sync()
	elif WAYLAND:
		ydo = tool('ydotool')
		run(ydo, 'mousemove', '--absolute', '-x', str(int(px)), '-y', str(int(py)))
		run(ydo, 'click', '--repeat', str(count), '0xC0' if button == 1 else '0xC1')
	else:
		args = [tool('xdotool'), 'mousemove', '--sync', str(int(px)), str(int(py))]
		for m in mods:
			args += ['keydown', m]
		args += ['click', '--repeat', str(count), str(button)]
		for m in reversed(mods):
			args += ['keyup', m]
		run(*args)


def move(request):
	d = x()
	if d:
		pointer_to(d, request.get('x', 0), request.get('y', 0))
		d.sync()
	elif WAYLAND:
		run(tool('ydotool'), 'mousemove', '--absolute', '-x', str(int(request.get('x', 0))), '-y', str(int(request.get('y', 0))))
	else:
		run(tool('xdotool'), 'mousemove', str(int(request.get('x', 0))), str(int(request.get('y', 0))))


def interpolate(points):
	"""The stroke's points with gaps filled in, no more than 3 px apart: apps draw what the pointer passes."""
	out = [points[0]]
	for (x1, y1), (x2, y2) in zip(points, points[1:]):
		steps = max(1, int(((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5 / 3 + 0.999))
		for i in range(1, steps + 1):
			out.append((x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps))
	return out


def drag(request):
	strokes = [[(float(p[0]), float(p[1])) for p in stroke if len(p) >= 2] for stroke in request.get('strokes') or []]
	strokes = [s for s in strokes if s]
	if not strokes:
		raise Failure('drag needs strokes: [[[x, y], [x, y], ...], ...].')
	button = 3 if request.get('button') == 'right' else 1
	mods = modifiers(request.get('modifiers'))
	step = max(0.0, min(20.0, float(request.get('stepMs', 0.5)))) / 1000
	d = x()
	if d:
		for m in mods:
			x_key(d, m, True)
		for stroke in strokes:
			pointer_to(d, *stroke[0])
			d.sync()
			time.sleep(0.008)
			xtest.fake_input(d, X.ButtonPress, button)
			d.sync()
			time.sleep(0.03)
			due = time.monotonic()
			for point in interpolate(stroke)[1:]:
				pointer_to(d, *point)
				d.sync()
				due += step
				pause = due - time.monotonic()
				if pause > 0:
					time.sleep(pause)
			time.sleep(0.012)
			xtest.fake_input(d, X.ButtonRelease, button)
			d.sync()
			time.sleep(0.016)
		for m in reversed(mods):
			x_key(d, m, False)
		d.sync()
	elif WAYLAND:
		ydo = tool('ydotool')
		for stroke in strokes:
			run(ydo, 'mousemove', '--absolute', '-x', str(int(stroke[0][0])), '-y', str(int(stroke[0][1])))
			run(ydo, 'click', '0x40' if button == 1 else '0x41')
			for px, py in interpolate(stroke)[1::4]:
				run(ydo, 'mousemove', '--absolute', '-x', str(int(px)), '-y', str(int(py)))
			run(ydo, 'click', '0x80' if button == 1 else '0x81')
	else:
		# One xdotool run per stroke: a process per event would take seconds.
		args = [tool('xdotool')]
		for m in mods:
			args += ['keydown', m]
		for stroke in strokes:
			args += ['mousemove', str(int(stroke[0][0])), str(int(stroke[0][1])), 'sleep', '0.01', 'mousedown', str(button), 'sleep', '0.03']
			for px, py in interpolate(stroke)[1:]:
				args += ['mousemove', str(int(round(px))), str(int(round(py)))]
			args += ['sleep', '0.012', 'mouseup', str(button), 'sleep', '0.016']
		for m in reversed(mods):
			args += ['keyup', m]
		run(*args)


def type_text(request):
	text = request.get('text') or ''
	if not text:
		return
	if WAYLAND:
		run(tool('ydotool'), 'type', '--', text)
	else:
		run(tool('xdotool'), 'type', '--delay', '4', '--', text)


def clipboard_tools():
	if WAYLAND and shutil.which('wl-copy') and shutil.which('wl-paste'):
		return ['wl-paste', '--no-newline'], ['wl-copy']
	if shutil.which('xclip'):
		return ['xclip', '-selection', 'clipboard', '-o'], ['xclip', '-selection', 'clipboard']
	if shutil.which('xsel'):
		return ['xsel', '--clipboard', '--output'], ['xsel', '--clipboard', '--input']
	return None, None


def paste(request):
	"""Pastes through the clipboard (one keystroke), then puts back the text it held."""
	read_cmd, write_cmd = clipboard_tools()
	if not read_cmd:
		type_text(request)
		return
	saved = safe(lambda: subprocess.run(read_cmd, capture_output=True, timeout=2).stdout)
	subprocess.run(write_cmd, input=(request.get('text') or '').encode('utf-8'), timeout=5)
	key({'combo': 'ctrl+v'})
	time.sleep(0.25)
	if saved is not None:
		subprocess.run(write_cmd, input=saved, timeout=5)


def scroll(request):
	px, py = request.get('x', 0), request.get('y', 0)
	dx, dy = float(request.get('dx') or 0), float(request.get('dy') or 0)
	move({'x': px, 'y': py})
	# About 40 px per wheel notch: X11 buttons 4/5 scroll up/down, 6/7 left/right.
	for amount, back, forward in ((dy, 4, 5), (dx, 6, 7)):
		notches = int(round(abs(amount) / 40))
		if not notches:
			continue
		button = forward if amount > 0 else back
		d = x()
		if d:
			for _ in range(notches):
				xtest.fake_input(d, X.ButtonPress, button)
				xtest.fake_input(d, X.ButtonRelease, button)
			d.sync()
		elif WAYLAND:
			sign = 1 if button in (5, 7) else -1
			run(tool('ydotool'), 'mousemove', '--wheel', '-x', str(sign * notches if button > 5 else 0), '-y', str(-sign * notches if button < 6 else 0))
		else:
			run(tool('xdotool'), 'click', '--repeat', str(notches), str(button))

#endregion

#region Apps and windows


def pump(seconds):
	"""Lets AT-SPI deliver its events for a while."""
	context = GLib.MainContext.default()
	end = time.monotonic() + seconds
	while True:
		while context.pending():
			context.iteration(False)
		left = end - time.monotonic()
		if left <= 0:
			return
		time.sleep(min(0.01, left))


def raise_window(app, title=None):
	pid = safe(app.get_process_id, 0)
	if shutil.which('xdotool') and not WAYLAND:
		found = subprocess.run(['xdotool', 'search', '--onlyvisible', '--pid', str(pid)] + (['--name', title] if title else []), capture_output=True, text=True).stdout.split()
		if found:
			subprocess.run(['xdotool', 'windowactivate', found[-1]], capture_output=True)
			return True
	if shutil.which('wmctrl'):
		name = title or (windows_of(app) and safe(windows_of(app)[0].get_name, ''))
		if name:
			return subprocess.run(['wmctrl', '-a', name], capture_output=True).returncode == 0
	return False


def wait_until_ready(query, timeout):
	end = time.monotonic() + timeout
	while time.monotonic() < end:
		try:
			app = find_app({'app': query})
			if windows_of(app):
				return app
		except Failure:
			pass
		pump(0.1)
	return None


def activate(request):
	target = request.get('app') or ''
	wait = max(0.0, min(30.0, float(request.get('wait', 10))))
	if '://' in target or target.startswith('/') or target.startswith('~'):
		path = os.path.expanduser(target)
		if '://' not in target and not os.path.exists(path):
			raise Failure('There is no file at %s.' % target)
		subprocess.Popen([tool('xdg-open'), path if '://' not in target else target], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
		pump(0.5)
		return {'ready': True}
	try:
		app = find_app({'app': target})
		if windows_of(app):
			raise_window(app)
			return {'app': safe(app.get_name, '') or target, 'ready': True}
	except Failure:
		pass
	# Not running: a desktop entry by that name, else a program on the PATH.
	if shutil.which('gtk-launch') and subprocess.run(['gtk-launch', target], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
		pass
	elif shutil.which(target) or shutil.which(target.lower()):
		subprocess.Popen([shutil.which(target) or shutil.which(target.lower())], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
	else:
		raise Failure('Could not open %s: no app or program by that name.' % target)
	app = wait_until_ready(target, wait)
	return {'app': safe(app.get_name, '') if app else target, 'ready': app is not None}


def normalized(title):
	return (title or '').lower().replace('…', '').replace('...', '').strip()


def window_action(request):
	app = find_app(request)
	windows = windows_of(app)
	titles = [safe(w.get_name, '') or '' for w in windows]
	wanted = normalized(request.get('title'))
	index = (0 if windows else None) if not wanted else next((i for i, t in enumerate(titles) if normalized(t) == wanted), next((i for i, t in enumerate(titles) if wanted in normalized(t)), None))
	if index is None:
		raise Failure('%s has no open window.' % (safe(app.get_name, '') or 'The app') if not windows else 'No window titled "%s". Windows: %s.' % (request.get('title'), ', '.join('"%s"' % t for t in titles if t)))
	op = (request.get('op') or 'raise').lower()
	title = titles[index]
	if op in ('raise', 'focus', 'front', 'show', 'restore', 'unminimize'):
		if not raise_window(app, title):
			raise Failure('Raising windows needs xdotool or wmctrl.')
	elif op in ('minimize', 'min'):
		run(tool('xdotool'), 'search', '--name', title, 'windowminimize')
	elif op == 'close':
		run(tool('wmctrl'), '-c', title)
	elif op in ('zoom', 'maximize'):
		run(tool('wmctrl'), '-r', title, '-b', 'toggle,maximized_vert,maximized_horz')
	elif op == 'fullscreen':
		run(tool('wmctrl'), '-r', title, '-b', 'toggle,fullscreen')
	else:
		raise Failure('Unknown window action %s: use raise, minimize, restore, close, zoom or fullscreen.' % op)
	pump(0.15)
	return {'window': title}


def find_role(acc, role, limit=6, depth=0):
	if acc is None or depth > limit:
		return None
	if ax_role(acc)[0] == role:
		return acc
	for i in range(safe(acc.get_child_count, 0)):
		found = find_role(safe(lambda i=i: acc.get_child_at_index(i)), role, limit, depth + 1)
		if found:
			return found
	return None


def items_of(acc):
	"""A menu bar item or a menu item holds its menu, whose children are the items."""
	kids = [safe(lambda i=i: acc.get_child_at_index(i)) for i in range(safe(acc.get_child_count, 0))]
	if len(kids) == 1 and ax_role(kids[0])[0] == 'AXMenu':
		kids = [safe(lambda i=i: kids[0].get_child_at_index(i)) for i in range(safe(kids[0].get_child_count, 0))]
	return [k for k in kids if k is not None]


def menu(request):
	app = find_app(request)
	path = [normalized(p) for p in request.get('path') or []]
	if not path:
		raise Failure('menu needs a path, e.g. File > Save.')
	bar = next((b for b in (find_role(w, 'AXMenuBar') for w in windows_of(app)) if b), None)
	if bar is None:
		raise Failure('%s has no menu bar.' % (safe(app.get_name, '') or 'The app'))
	level = bar
	for i, wanted in enumerate(path):
		items = items_of(level) if level is not bar else [safe(lambda j=j: bar.get_child_at_index(j)) for j in range(safe(bar.get_child_count, 0))]
		titles = [normalized(safe(it.get_name, '')) for it in items]
		index = titles.index(wanted) if wanted in titles else next((j for j, t in enumerate(titles) if t.startswith(wanted)), None)
		if index is None:
			raise Failure('No menu item "%s". Items: %s.' % (wanted, ', '.join(t for t in titles if t)))
		item = items[index]
		if not states(item)(Atspi.StateType.ENABLED):
			raise Failure('The menu item "%s" is disabled.' % wanted)
		handles['menu'] = item
		perform({'h': 'menu'})
		if i < len(path) - 1:
			pump(0.12)
		level = item

#endregion

#region Settling

change_events = 0
last_change = 0.0
acted_at = time.monotonic()
events_at_action = 0
watched_pid = None
listener = None


def on_event(event):
	global change_events, last_change
	if watched_pid is None or safe(lambda: event.source.get_process_id()) == watched_pid:
		change_events += 1
		last_change = time.monotonic()


def listen():
	global listener
	if listener is not None:
		return listener is not False
	try:
		listener = Atspi.EventListener.new(on_event)
		for kind in ('object:children-changed', 'object:property-change', 'object:state-changed', 'object:text-changed', 'object:visible-data-changed', 'object:selection-changed', 'window:create', 'window:activate', 'focus:'):
			listener.register(kind)
		return True
	except Exception:
		listener = False
		return False


def mark_action():
	global acted_at, events_at_action
	pump(0)
	acted_at = time.monotonic()
	events_at_action = change_events


def settle(request):
	"""Returns once the app has gone quiet after the last action (see VoltDesktop.swift)."""
	global watched_pid
	if not listen():
		return {'supported': False, 'changed': False, 'events': 0, 'ms': 0}
	app = find_app(request)
	watched_pid = safe(app.get_process_id)
	quiet = float(request.get('quietMs', 60)) / 1000
	start = float(request.get('startMs', 250)) / 1000
	limit = float(request.get('maxMs', 2000)) / 1000
	began = time.monotonic()
	while True:
		pump(0.01)
		now = time.monotonic()
		events = change_events - events_at_action
		if events == 0 and now - acted_at >= start:
			break
		if events > 0 and now - last_change >= quiet:
			break
		if now - began >= limit:
			break
	return {'supported': True, 'changed': change_events > events_at_action, 'events': change_events - events_at_action, 'ms': int((time.monotonic() - began) * 1000)}

#endregion

#region Screen


def capture(request):
	x0, y0 = int(request.get('x', 0)), int(request.get('y', 0))
	w, h = max(1, int(request.get('w', 1))), max(1, int(request.get('h', 1)))
	png = None
	if WAYLAND and shutil.which('grim'):
		png = subprocess.run(['grim', '-g', '%d,%d %dx%d' % (x0, y0, w, h), '-'], capture_output=True, timeout=15).stdout
	elif shutil.which('import'):
		png = subprocess.run(['import', '-silent', '-window', 'root', '-crop', '%dx%d+%d+%d' % (w, h, x0, y0), 'png:-'], capture_output=True, timeout=15).stdout
	else:
		try:
			from PIL import ImageGrab
			import io
			buffer = io.BytesIO()
			ImageGrab.grab(bbox=(x0, y0, x0 + w, y0 + h)).save(buffer, 'PNG')
			png = buffer.getvalue()
		except Exception:
			png = None
	if not png or png[:8] != b'\x89PNG\r\n\x1a\n':
		raise Failure('Could not capture the screen: install grim (Wayland) or ImageMagick (X11).')
	width, height = int.from_bytes(png[16:20], 'big'), int.from_bytes(png[20:24], 'big')
	return {'png': base64.b64encode(png).decode('ascii'), 'width': width, 'height': height}


def screen_tool():
	return bool((WAYLAND and shutil.which('grim')) or shutil.which('import'))

#endregion


def apps():
	result = []
	for app in desktop_apps():
		pid = safe(app.get_process_id, 0)
		if pid in (os.getpid(),) or not windows_of(app):
			continue
		result.append({'name': safe(app.get_name, '') or process_name(pid), 'bundle': process_name(pid), 'pid': pid, 'active': is_active(app), 'hidden': all(states(w)(Atspi.StateType.ICONIFIED) for w in windows_of(app))})
	return result


def status(request):
	reachable = safe(lambda: Atspi.get_desktop(0).get_child_count() >= 0, False)
	if request.get('prompt') and shutil.which('gsettings'):
		# GNOME only exposes apps' trees with toolkit accessibility on.
		subprocess.run(['gsettings', 'set', 'org.gnome.desktop.interface', 'toolkit-accessibility', 'true'], capture_output=True)
	return {'trusted': bool(reachable), 'screen': screen_tool(), 'events': listen()}


ACTING = {'press', 'setValue', 'focus', 'click', 'move', 'drag', 'type', 'paste', 'key', 'scroll', 'activate', 'window', 'menu'}
COMMANDS = {
	'status': status, 'apps': lambda r: apps(), 'tree': tree, 'settle': settle, 'capture': capture,
	'press': perform, 'setValue': set_value, 'focus': focus, 'click': click, 'move': move, 'drag': drag,
	'type': type_text, 'paste': paste, 'key': key, 'scroll': scroll, 'activate': activate, 'window': window_action, 'menu': menu,
}


def respond(reply):
	sys.stdout.write(json.dumps(reply, ensure_ascii=False) + '\n')
	sys.stdout.flush()


def main():
	Atspi.init()
	listen()
	respond({'id': 0, 'ok': True, 'result': {'hello': 'volt-desktop 1', 'backend': 'linux'}})
	for line in sys.stdin:
		line = line.strip()
		if not line:
			continue
		try:
			request = json.loads(line)
		except ValueError:
			respond({'id': 0, 'ok': False, 'error': 'bad request'})
			continue
		rid = request.get('id', 0)
		cmd = request.get('cmd', '')
		try:
			handler = COMMANDS.get(cmd)
			if handler is None:
				raise Failure('unknown command')
			if cmd in ACTING:
				mark_action()
			result = handler(request)
			respond({'id': rid, 'ok': True, 'result': True if result is None else result})
		except Failure as failure:
			respond({'id': rid, 'ok': False, 'error': str(failure)})
		except subprocess.CalledProcessError as failure:
			respond({'id': rid, 'ok': False, 'error': '%s failed: %s' % (failure.cmd[0], (failure.stderr or b'').decode('utf-8', 'replace').strip()[:300])})
		except Exception as failure:
			respond({'id': rid, 'ok': False, 'error': '%s: %s' % (type(failure).__name__, failure)})


if __name__ == '__main__':
	main()

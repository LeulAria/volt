/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt's desktop helper for macOS: reads apps' accessibility trees and acts on them for the
// agent's desktop_* tools. Volt compiles it on first use and talks to it with one JSON request
// per line on stdin and one JSON reply per line on stdout:
//
//   {"id":1,"cmd":"tree","app":"Notes"}  ->  {"id":1,"ok":true,"result":{...}}
//
// Acting prefers accessibility actions (press, set value, focus): they reach the right control
// even in a window behind others and leave the user's mouse alone. Mouse and keyboard events are
// there for what has no accessibility action. Everything needs the Accessibility permission for
// Volt (System Settings > Privacy & Security > Accessibility).

import Cocoa
import ApplicationServices

setvbuf(stdout, nil, _IOLBF, 0)

struct Failure: Error {
	let message: String
	init(_ message: String) { self.message = message }
}

/// Elements from the last tree read, by the handle the reply gave them.
var handles: [String: AXUIElement] = [:]
var handleCount = 0

func handle(for element: AXUIElement) -> String {
	handleCount += 1
	let id = "h\(handleCount)"
	handles[id] = element
	return id
}

func element(_ request: [String: Any]) throws -> AXUIElement {
	guard let id = request["h"] as? String, let found = handles[id] else {
		throw Failure("That element is gone: read the screen again.")
	}
	return found
}

func trusted(prompt: Bool) -> Bool {
	let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
	return AXIsProcessTrustedWithOptions(options)
}

func requireTrust() throws {
	if !trusted(prompt: false) {
		throw Failure("Volt does not have the Accessibility permission. Turn Volt on in System Settings > Privacy & Security > Accessibility, then try again.")
	}
}

//#region Reading

let attributeNames: [String] = [
	kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
	kAXHelpAttribute, "AXPlaceholderValue", "AXIdentifier", kAXEnabledAttribute, kAXFocusedAttribute,
	kAXSelectedAttribute, kAXExpandedAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute,
	"AXVisibleRows",
]

func string(_ value: AnyObject?) -> String? {
	guard let value = value else { return nil }
	if CFGetTypeID(value) == AXValueGetTypeID() { return nil }
	if let text = value as? String { return text.isEmpty ? nil : text }
	if CFGetTypeID(value) == CFBooleanGetTypeID() { return (value as! Bool) ? "1" : "0" }
	if let number = value as? NSNumber { return number.stringValue }
	return nil
}

func bool(_ value: AnyObject?) -> Bool? {
	guard let value = value, CFGetTypeID(value) == CFBooleanGetTypeID() || value is NSNumber else { return nil }
	return (value as? NSNumber)?.boolValue
}

func point(_ value: AnyObject?) -> CGPoint? {
	guard let value = value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
	var result = CGPoint.zero
	return AXValueGetValue(value as! AXValue, .cgPoint, &result) ? result : nil
}

func size(_ value: AnyObject?) -> CGSize? {
	guard let value = value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
	var result = CGSize.zero
	return AXValueGetValue(value as! AXValue, .cgSize, &result) ? result : nil
}

func elements(_ value: AnyObject?) -> [AXUIElement] {
	guard let value = value, CFGetTypeID(value) == CFArrayGetTypeID() else { return [] }
	return (value as! [AnyObject]).compactMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
}

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
	var value: AnyObject?
	return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

/// One element and its subtree, with every attribute fetched in one round trip to the app.
func read(_ element: AXUIElement, depth: Int, budget: inout Int) -> [String: Any]? {
	if budget <= 0 { return nil }
	budget -= 1
	var raw: CFArray?
	guard AXUIElementCopyMultipleAttributeValues(element, attributeNames as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &raw) == .success, let values = raw as [AnyObject]? else {
		return nil
	}
	func value(_ name: String) -> AnyObject? {
		guard let i = attributeNames.firstIndex(of: name), i < values.count else { return nil }
		let v = values[i]
		if CFGetTypeID(v) == AXValueGetTypeID() && AXValueGetType(v as! AXValue) == .axError { return nil }
		return v
	}
	var node: [String: Any] = ["h": handle(for: element)]
	let role = string(value(kAXRoleAttribute)) ?? "AXUnknown"
	node["role"] = role
	if let v = string(value(kAXSubroleAttribute)) { node["sub"] = v }
	if let v = string(value(kAXTitleAttribute)) { node["title"] = v }
	if let v = string(value(kAXDescriptionAttribute)) { node["desc"] = v }
	if let v = string(value(kAXValueAttribute)) { node["value"] = String(v.prefix(500)) }
	if let v = string(value(kAXHelpAttribute)) { node["help"] = v }
	if let v = string(value("AXPlaceholderValue")) { node["ph"] = v }
	if let v = string(value("AXIdentifier")) { node["id"] = v }
	if bool(value(kAXEnabledAttribute)) == false { node["disabled"] = true }
	if bool(value(kAXFocusedAttribute)) == true { node["focused"] = true }
	if bool(value(kAXSelectedAttribute)) == true { node["selected"] = true }
	if let expanded = bool(value(kAXExpandedAttribute)) { node["expanded"] = expanded }
	if let p = point(value(kAXPositionAttribute)), let s = size(value(kAXSizeAttribute)) {
		node["f"] = [Int(p.x.rounded()), Int(p.y.rounded()), Int(s.width.rounded()), Int(s.height.rounded())]
	}
	// Long tables and outlines: only the rows on screen (and the header), not thousands of rows.
	let visibleRows = elements(value("AXVisibleRows"))
	var children = elements(value(kAXChildrenAttribute))
	if !visibleRows.isEmpty {
		children = visibleRows
		if let header = attribute(element, kAXHeaderAttribute), CFGetTypeID(header) == AXUIElementGetTypeID() {
			children.insert(header as! AXUIElement, at: 0)
		}
	}
	if depth < 40 && !children.isEmpty {
		var kids: [[String: Any]] = []
		for child in children {
			if budget <= 0 { break }
			if let kid = read(child, depth: depth + 1, budget: &budget) { kids.append(kid) }
		}
		if !kids.isEmpty { node["c"] = kids }
	}
	return node
}

func runningApp(_ request: [String: Any]) throws -> NSRunningApplication {
	let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
	if let pid = request["pid"] as? Int, let app = apps.first(where: { Int($0.processIdentifier) == pid }) {
		return app
	}
	if let query = (request["app"] as? String)?.lowercased(), !query.isEmpty {
		if let app = apps.first(where: { $0.bundleIdentifier?.lowercased() == query || $0.localizedName?.lowercased() == query })
			?? apps.first(where: { ($0.localizedName?.lowercased() ?? "").contains(query) }) {
			return app
		}
		throw Failure("\(request["app"] as! String) is not running. Open it with an open step first.")
	}
	if let front = frontApp() { return front }
	throw Failure("No app is in front.")
}

/**
 * The app in front of Volt: while the user talks to Volt, Volt itself is frontmost, so take the
 * app owning the frontmost normal window that is not Volt's (window order needs no permission).
 */
func frontApp() -> NSRunningApplication? {
	let volt = getppid()
	if let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != volt {
		return front
	}
	let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
	for window in windows {
		guard (window[kCGWindowLayer as String] as? Int) == 0, let owner = window[kCGWindowOwnerPID as String] as? Int32, owner != volt else { continue }
		if let app = NSRunningApplication(processIdentifier: owner), app.activationPolicy == .regular {
			return app
		}
	}
	return NSWorkspace.shared.frontmostApplication
}

func tree(_ request: [String: Any]) throws -> [String: Any] {
	try requireTrust()
	let app = try runningApp(request)
	let appElement = AXUIElementCreateApplication(app.processIdentifier)
	AXUIElementSetMessagingTimeout(appElement, 1.5)
	handles.removeAll(keepingCapacity: true)
	let windows = elements(attribute(appElement, kAXWindowsAttribute))
	var window: AXUIElement? = attribute(appElement, kAXFocusedWindowAttribute).flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
	if let wanted = (request["window"] as? String)?.lowercased(), !wanted.isEmpty {
		window = windows.first(where: { (string(attribute($0, kAXTitleAttribute)) ?? "").lowercased().contains(wanted) }) ?? window
	}
	window = window ?? windows.first
	var budget = max(50, min(5000, request["max"] as? Int ?? 2000))
	var result: [String: Any] = [
		"app": app.localizedName ?? "",
		"bundle": app.bundleIdentifier ?? "",
		"pid": Int(app.processIdentifier),
		"windows": windows.compactMap { string(attribute($0, kAXTitleAttribute)) },
	]
	if let window = window {
		result["window"] = string(attribute(window, kAXTitleAttribute)) ?? ""
		if var root = read(window, depth: 0, budget: &budget) {
			// A context menu or a popup opens as the app's own child, not the window's: read it too.
			let menus = elements(attribute(appElement, kAXChildrenAttribute)).filter { string(attribute($0, kAXRoleAttribute)) == kAXMenuRole }
			let opened = menus.compactMap { read($0, depth: 1, budget: &budget) }
			if !opened.isEmpty {
				root["c"] = ((root["c"] as? [[String: Any]]) ?? []) + opened
			}
			result["root"] = root
		}
	}
	let minimized = windows.filter { bool(attribute($0, kAXMinimizedAttribute)) == true }.compactMap { string(attribute($0, kAXTitleAttribute)) }
	if !minimized.isEmpty { result["minimized"] = minimized }
	result["truncated"] = budget <= 0
	return result
}

//#endregion

//#region Acting

func perform(_ request: [String: Any]) throws {
	try requireTrust()
	let target = try element(request)
	let action = request["action"] as? String ?? kAXPressAction
	let error = AXUIElementPerformAction(target, action as CFString)
	if error != .success {
		throw Failure("The app refused \(action) (\(error.rawValue)).")
	}
}

func setValue(_ request: [String: Any]) throws {
	try requireTrust()
	let target = try element(request)
	AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
	let error = AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, (request["value"] as? String ?? "") as CFString)
	if error != .success {
		throw Failure("The field does not take a value directly (\(error.rawValue)).")
	}
}

func focus(_ request: [String: Any]) throws {
	try requireTrust()
	let target = try element(request)
	if string(attribute(target, kAXRoleAttribute)) == kAXWindowRole {
		AXUIElementPerformAction(target, kAXRaiseAction as CFString)
		return
	}
	let error = AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
	if error != .success {
		throw Failure("The element cannot take focus (\(error.rawValue)).")
	}
}

func post(_ event: CGEvent?) {
	event?.post(tap: .cghidEventTap)
}

func click(_ request: [String: Any]) throws {
	try requireTrust()
	let at = CGPoint(x: request["x"] as? Double ?? 0, y: request["y"] as? Double ?? 0)
	let right = request["button"] as? String == "right"
	let count = max(1, request["count"] as? Int ?? 1)
	let (down, up, button): (CGEventType, CGEventType, CGMouseButton) = right ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
	post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: at, mouseButton: button))
	for n in 1...count {
		for type in [down, up] {
			let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: at, mouseButton: button)
			event?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
			post(event)
		}
	}
}

func typeText(_ request: [String: Any]) throws {
	try requireTrust()
	let units = Array((request["text"] as? String ?? "").utf16)
	var i = 0
	while i < units.count {
		let chunk = Array(units[i..<min(units.count, i + 16)])
		for down in [true, false] {
			let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
			event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
			post(event)
		}
		i += 16
		usleep(4000)
	}
}

let keyCodes: [String: CGKeyCode] = [
	"a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
	"y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
	"]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
	"n": 45, "m": 46, ".": 47, "`": 50,
	"enter": 36, "return": 36, "tab": 48, "space": 49, "backspace": 51, "delete": 51, "escape": 53, "esc": 53,
	"forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
	"left": 123, "arrowleft": 123, "right": 124, "arrowright": 124, "down": 125, "arrowdown": 125, "up": 126, "arrowup": 126,
	"f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

func key(_ request: [String: Any]) throws {
	try requireTrust()
	let parts = (request["combo"] as? String ?? "").lowercased().split(separator: "+").map { String($0).trimmingCharacters(in: .whitespaces) }
	var flags: CGEventFlags = []
	for part in parts.dropLast() {
		switch part {
		case "cmd", "command", "meta", "super": flags.insert(.maskCommand)
		case "ctrl", "control": flags.insert(.maskControl)
		case "alt", "option", "opt": flags.insert(.maskAlternate)
		case "shift": flags.insert(.maskShift)
		case "fn": flags.insert(.maskSecondaryFn)
		default: throw Failure("Unknown modifier \(part).")
		}
	}
	guard let name = parts.last, let code = keyCodes[name] else {
		throw Failure("Unknown key \(parts.last ?? ""). Use a letter, digit, enter, tab, space, escape, delete, arrows, home, end, pageup, pagedown or f1-f12, with cmd/ctrl/alt/shift.")
	}
	for down in [true, false] {
		let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
		event?.flags = flags
		post(event)
	}
}

func scroll(_ request: [String: Any]) throws {
	try requireTrust()
	let at = CGPoint(x: request["x"] as? Double ?? 0, y: request["y"] as? Double ?? 0)
	post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: at, mouseButton: .left))
	let dy = Int32(-(request["dy"] as? Double ?? 0))
	let dx = Int32(-(request["dx"] as? Double ?? 0))
	let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
	event?.location = at
	post(event)
}

/// The app's windows (focused first), for an app that answers accessibility in time.
func windowsOf(_ app: NSRunningApplication, timeout: Float = 1.5) -> (AXUIElement, [AXUIElement]) {
	let appElement = AXUIElementCreateApplication(app.processIdentifier)
	AXUIElementSetMessagingTimeout(appElement, timeout)
	return (appElement, elements(attribute(appElement, kAXWindowsAttribute)))
}

/// Lets the run loop deliver workspace changes (launches, activations) while waiting for them.
func pump(_ seconds: Double) {
	RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(seconds))
}

/**
 * Waits until the app is running, done launching, in front and has a window, so the next read
 * sees it, instead of sleeping a fixed time. Returns the app, or nil if it is not ready in time.
 */
func waitUntilReady(_ query: String, timeout: Double) -> NSRunningApplication? {
	let started = Date()
	var asked = Date.distantPast
	var reopened = false
	while Date().timeIntervalSince(started) < timeout {
		if let app = try? runningApp(["app": query]), app.isFinishedLaunching {
			if app.isActive && !windowsOf(app, timeout: 0.5).1.isEmpty {
				return app
			}
			if !app.isActive && Date().timeIntervalSince(asked) > 0.3 {
				asked = Date()
				app.activate(options: [])
				// macOS may refuse an activation a background helper asks for; `open` always brings the app.
				if !reopened && Date().timeIntervalSince(started) > 0.8, let bundle = app.bundleIdentifier {
					reopened = true
					_ = try? openWith(["-b", bundle])
				}
			}
		}
		pump(0.05)
	}
	return nil
}

/// Runs `/usr/bin/open` with these arguments; true when it succeeded.
func openWith(_ arguments: [String]) throws -> Bool {
	let process = Process()
	process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
	process.arguments = arguments
	try process.run()
	process.waitUntilExit()
	return process.terminationStatus == 0
}

/// Brings a running app to the front (opening a window if it has none), or opens it (by name or bundle id), or opens a URL.
func activate(_ request: [String: Any]) throws -> [String: Any] {
	let target = request["app"] as? String ?? ""
	let wait = min(30, max(0, request["wait"] as? Double ?? 10))
	if !target.isEmpty, !target.contains("://"), let app = try? runningApp(["app": target]), !windowsOf(app).1.isEmpty {
		app.activate(options: [])
		let ready = waitUntilReady(target, timeout: min(wait, 2)) != nil
		return ["app": app.localizedName ?? target, "ready": ready]
	}
	let arguments = target.contains("://") ? [target] : target.contains(".") && !target.contains(" ") && !target.hasSuffix(".app") ? ["-b", target] : ["-a", target]
	if !(try openWith(arguments)) {
		throw Failure("Could not open \(target).")
	}
	if target.contains("://") {
		// The URL's app comes to the front on its own; the next read takes whichever is in front.
		pump(0.3)
		return ["ready": true]
	}
	let app = waitUntilReady(target, timeout: wait)
	return ["app": app?.localizedName ?? target, "ready": app != nil]
}

/// Acts on one of an app's windows by (part of) its title: raise, minimize, restore, close, zoom or fullscreen.
func windowAction(_ request: [String: Any]) throws -> [String: Any] {
	try requireTrust()
	let app = try runningApp(request)
	let (appElement, windows) = windowsOf(app)
	let wanted = normalized(request["title"] as? String ?? "")
	let titles = windows.map { string(attribute($0, kAXTitleAttribute)) ?? "" }
	let index = wanted.isEmpty ? (windows.isEmpty ? nil : 0) : titles.firstIndex(where: { normalized($0) == wanted }) ?? titles.firstIndex(where: { normalized($0).contains(wanted) })
	guard let found = index else {
		let listed = titles.filter { !$0.isEmpty }.map { "\"\($0)\"" }.joined(separator: ", ")
		throw Failure(windows.isEmpty ? "\(app.localizedName ?? "The app") has no open window." : "No window titled \"\(request["title"] as? String ?? "")\". Windows: \(listed).")
	}
	let window = windows[found]
	let op = (request["op"] as? String ?? "raise").lowercased()
	func set(_ name: String, _ value: Bool) throws {
		let error = AXUIElementSetAttributeValue(window, name as CFString, value ? kCFBooleanTrue : kCFBooleanFalse)
		if error != .success { throw Failure("The window does not allow \(op) (\(error.rawValue)).") }
	}
	func pressButton(_ name: String) throws {
		guard let button = attribute(window, name), CFGetTypeID(button) == AXUIElementGetTypeID() else {
			throw Failure("The window has no \(op) button.")
		}
		AXUIElementPerformAction(button as! AXUIElement, kAXPressAction as CFString)
	}
	switch op {
	case "raise", "focus", "front", "show":
		if bool(attribute(window, kAXMinimizedAttribute)) == true { try set(kAXMinimizedAttribute, false) }
		app.activate(options: [])
		AXUIElementPerformAction(window, kAXRaiseAction as CFString)
		AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
		AXUIElementSetAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, window)
	case "minimize", "min": try set(kAXMinimizedAttribute, true)
	case "restore", "unminimize": try set(kAXMinimizedAttribute, false)
	case "close": try pressButton(kAXCloseButtonAttribute)
	case "zoom", "maximize": try pressButton(kAXZoomButtonAttribute)
	case "fullscreen": try set("AXFullScreen", !(bool(attribute(window, "AXFullScreen")) ?? false))
	default: throw Failure("Unknown window action \(op): use raise, minimize, restore, close, zoom or fullscreen.")
	}
	pump(0.15)
	return ["window": titles[found]]
}

func normalized(_ title: String) -> String {
	return title.lowercased().replacingOccurrences(of: "…", with: "").replacingOccurrences(of: "...", with: "").trimmingCharacters(in: .whitespaces)
}

/// Picks a menu bar path, e.g. ["File", "Export", "PDF…"]: opens each menu, presses the last item.
func menu(_ request: [String: Any]) throws {
	try requireTrust()
	let app = try runningApp(request)
	let path = (request["path"] as? [String] ?? []).map(normalized)
	guard !path.isEmpty else { throw Failure("menu needs a path, e.g. File > Save.") }
	let appElement = AXUIElementCreateApplication(app.processIdentifier)
	guard let bar = attribute(appElement, kAXMenuBarAttribute), CFGetTypeID(bar) == AXUIElementGetTypeID() else {
		throw Failure("\(app.localizedName ?? "The app") has no menu bar.")
	}
	var level = bar as! AXUIElement
	// The menu bar item opened for this path: closed again when the path turns out wrong.
	var opened: AXUIElement?
	func closeOpenedMenu() {
		if let opened = opened {
			AXUIElementPerformAction(opened, kAXCancelAction as CFString)
			for down in [true, false] {
				post(CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: down))
			}
		}
	}
	for (i, wanted) in path.enumerated() {
		var items = elements(attribute(level, kAXChildrenAttribute))
		// A menu bar item or a submenu item holds its menu as its only child.
		if items.count == 1, string(attribute(items[0], kAXRoleAttribute)) == kAXMenuRole {
			items = elements(attribute(items[0], kAXChildrenAttribute))
		}
		let titles = items.map { normalized(string(attribute($0, kAXTitleAttribute)) ?? "") }
		guard let index = titles.firstIndex(of: wanted) ?? titles.firstIndex(where: { $0.hasPrefix(wanted) }) else {
			closeOpenedMenu()
			throw Failure("No menu item \"\(wanted)\". Items: \(titles.filter { !$0.isEmpty }.joined(separator: ", ")).")
		}
		let item = items[index]
		if bool(attribute(item, kAXEnabledAttribute)) == false {
			closeOpenedMenu()
			throw Failure("The menu item \"\(wanted)\" is disabled.")
		}
		if i == path.count - 1 {
			AXUIElementPerformAction(item, kAXPressAction as CFString)
		} else {
			if string(attribute(item, kAXRoleAttribute)) == kAXMenuBarItemRole {
				AXUIElementPerformAction(item, kAXPressAction as CFString)
				opened = item
				usleep(120_000)
			}
			level = item
		}
	}
}

//#endregion

func apps() -> [[String: Any]] {
	let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
	return NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map { app in
		["name": app.localizedName ?? "", "bundle": app.bundleIdentifier ?? "", "pid": Int(app.processIdentifier), "active": app.processIdentifier == front, "hidden": app.isHidden]
	}
}

func respond(_ id: Any, _ body: [String: Any]) {
	var reply = body
	reply["id"] = id
	if let data = try? JSONSerialization.data(withJSONObject: reply), let line = String(data: data, encoding: .utf8) {
		print(line)
	} else {
		print("{\"id\":\(id),\"ok\":false,\"error\":\"could not encode the reply\"}")
	}
}

func handleLine(_ line: String) {
	guard let data = line.data(using: .utf8), let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
		respond(0, ["ok": false, "error": "bad request"])
		return
	}
	let id = request["id"] ?? 0
	do {
		var result: Any = true
		switch request["cmd"] as? String ?? "" {
		case "status":
			result = ["trusted": trusted(prompt: request["prompt"] as? Bool ?? false), "screen": CGPreflightScreenCaptureAccess()]
		case "apps": result = apps()
		case "tree": result = try tree(request)
		case "press": try perform(request)
		case "setValue": try setValue(request)
		case "focus": try focus(request)
		case "click": try click(request)
		case "type": try typeText(request)
		case "key": try key(request)
		case "scroll": try scroll(request)
		case "activate": result = try activate(request)
		case "window": result = try windowAction(request)
		case "menu": try menu(request)
		default: throw Failure("unknown command")
		}
		respond(id, ["ok": true, "result": result])
	} catch let failure as Failure {
		respond(id, ["ok": false, "error": failure.message])
	} catch {
		respond(id, ["ok": false, "error": "\(error)"])
	}
}

// Requests are read on a background thread and handled on the main one, whose run loop keeps
// the running-app list current.
Thread.detachNewThread {
	while let line = readLine() {
		let trimmed = line.trimmingCharacters(in: .whitespaces)
		if trimmed.isEmpty { continue }
		let done = DispatchSemaphore(value: 0)
		DispatchQueue.main.async {
			handleLine(trimmed)
			done.signal()
		}
		done.wait()
	}
	exit(0)
}
print("{\"id\":0,\"ok\":true,\"result\":{\"hello\":\"volt-desktop 1\"}}")
RunLoop.main.run()

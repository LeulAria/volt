/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt's desktop helper for Windows: the same protocol as VoltDesktop.swift (one JSON request per
// line on stdin, one JSON reply per line on stdout), over UI Automation for reading apps and acting
// on their controls, and SendInput for the pointer and keys. VoltDesktop.windows.ps1 compiles it
// with Windows PowerShell's C# 5 compiler, so it sticks to C# 5.
//
// Nodes use the macOS role names (AXButton, AXTextField, ...), so Volt reads every OS the same way.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;

public class VoltFailure : Exception
{
	public VoltFailure(string message) : base(message) { }
}

public static class VoltDesktopHelper
{
	static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 200 };
	static readonly Dictionary<string, AutomationElement> Handles = new Dictionary<string, AutomationElement>();
	static int handleCount;
	static int voltPid;
	static TextWriter output;

	public static void Run(int parentPid)
	{
		voltPid = parentPid;
		// Frames from UI Automation and SendInput coordinates must be in the same (physical) pixels.
		try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { try { SetProcessDPIAware(); } catch (Exception) { } }
		// UI Automation events arrive on their own threads; a free-threaded loop never blocks them.
		var loop = new Thread(Loop);
		loop.SetApartmentState(ApartmentState.MTA);
		loop.Start();
		loop.Join();
	}

	static void Loop()
	{
		var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
		output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
		Respond(0, true, new Dictionary<string, object> { { "hello", "volt-desktop 1" }, { "backend", "windows" } }, null);
		string line;
		while ((line = input.ReadLine()) != null)
		{
			line = line.Trim();
			if (line.Length == 0) { continue; }
			Dictionary<string, object> request;
			try { request = Json.DeserializeObject(line) as Dictionary<string, object>; }
			catch (Exception) { request = null; }
			if (request == null) { Respond(0, false, null, "bad request"); continue; }
			object id = request.ContainsKey("id") ? request["id"] : 0;
			try
			{
				string cmd = Str(request, "cmd") ?? "";
				if (Acting.Contains(cmd)) { MarkAction(); }
				object result = Handle(cmd, request);
				Respond(id, true, result ?? true, null);
			}
			catch (VoltFailure failure) { Respond(id, false, null, failure.Message); }
			catch (ElementNotAvailableException) { Respond(id, false, null, "That element is gone: read the screen again."); }
			catch (Exception error) { Respond(id, false, null, error.GetType().Name + ": " + error.Message); }
		}
	}

	static readonly HashSet<string> Acting = new HashSet<string> { "press", "setValue", "focus", "click", "move", "drag", "type", "paste", "key", "scroll", "activate", "window", "menu" };

	static object Handle(string cmd, Dictionary<string, object> r)
	{
		switch (cmd)
		{
			case "status": return new Dictionary<string, object> { { "trusted", true }, { "screen", true }, { "events", true } };
			case "apps": return Apps();
			case "tree": return Tree(r);
			case "settle": return Settle(r);
			case "capture": return Capture(r);
			case "press": Press(r); return null;
			case "setValue": SetValue(r); return null;
			case "focus": Element(r).SetFocus(); return null;
			case "click": Click(r); return null;
			case "move": MoveTo(Num(r, "x", 0), Num(r, "y", 0)); return null;
			case "drag": Drag(r); return null;
			case "type": TypeText(Str(r, "text") ?? ""); return null;
			case "paste": Paste(Str(r, "text") ?? ""); return null;
			case "key": Key(Str(r, "combo") ?? ""); return null;
			case "scroll": Scroll(r); return null;
			case "activate": return Activate(r);
			case "window": return WindowAction(r);
			case "menu": Menu(r); return null;
		}
		throw new VoltFailure("unknown command");
	}

	static void Respond(object id, bool ok, object result, string error)
	{
		var reply = new Dictionary<string, object> { { "id", id }, { "ok", ok } };
		if (ok) { reply["result"] = result; } else { reply["error"] = error; }
		string text;
		try { text = Json.Serialize(reply); }
		catch (Exception) { text = "{\"id\":" + Json.Serialize(id) + ",\"ok\":false,\"error\":\"could not encode the reply\"}"; }
		lock (output) { output.WriteLine(text); }
	}

	static string Str(Dictionary<string, object> r, string key)
	{
		object value;
		return r.TryGetValue(key, out value) && value != null ? Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture) : null;
	}

	static double Num(Dictionary<string, object> r, string key, double fallback)
	{
		object value;
		if (!r.TryGetValue(key, out value) || value == null) { return fallback; }
		try { return Convert.ToDouble(value, System.Globalization.CultureInfo.InvariantCulture); } catch (Exception) { return fallback; }
	}

	//#region Reading

	static AutomationElement Element(Dictionary<string, object> r)
	{
		AutomationElement found;
		string h = Str(r, "h");
		if (h == null || !Handles.TryGetValue(h, out found)) { throw new VoltFailure("That element is gone: read the screen again."); }
		return found;
	}

	static readonly AutomationProperty[] CachedProperties = {
		AutomationElement.NameProperty, AutomationElement.ControlTypeProperty, AutomationElement.AutomationIdProperty,
		AutomationElement.BoundingRectangleProperty, AutomationElement.IsEnabledProperty, AutomationElement.HasKeyboardFocusProperty,
		AutomationElement.HelpTextProperty, AutomationElement.IsPasswordProperty, AutomationElement.ProcessIdProperty,
		ValuePattern.ValueProperty, TogglePattern.ToggleStateProperty, SelectionItemPattern.IsSelectedProperty,
		ExpandCollapsePattern.ExpandCollapseStateProperty, RangeValuePattern.ValueProperty, WindowPattern.IsModalProperty,
		AutomationElement.IsValuePatternAvailableProperty, AutomationElement.IsTogglePatternAvailableProperty,
		AutomationElement.IsSelectionItemPatternAvailableProperty, AutomationElement.IsExpandCollapsePatternAvailableProperty,
		AutomationElement.IsRangeValuePatternAvailableProperty,
	};

	/// One cross-process call for the whole window: the subtree with every property it needs, cached.
	static CacheRequest SubtreeRequest()
	{
		var request = new CacheRequest { TreeScope = TreeScope.Element | TreeScope.Descendants, AutomationElementMode = AutomationElementMode.Full };
		request.TreeFilter = new AndCondition(Automation.ControlViewCondition, new PropertyCondition(AutomationElement.IsOffscreenProperty, false));
		foreach (var property in CachedProperties) { request.Add(property); }
		return request;
	}

	static object Cached(AutomationElement element, AutomationProperty property)
	{
		try
		{
			object value = element.GetCachedPropertyValue(property, true);
			return value == AutomationElement.NotSupported ? null : value;
		}
		catch (Exception) { return null; }
	}

	static readonly Dictionary<ControlType, string[]> Roles = new Dictionary<ControlType, string[]> {
		{ ControlType.Button, new[] { "AXButton" } }, { ControlType.SplitButton, new[] { "AXMenuButton" } }, { ControlType.CheckBox, new[] { "AXCheckBox" } },
		{ ControlType.RadioButton, new[] { "AXRadioButton" } }, { ControlType.ComboBox, new[] { "AXPopUpButton" } }, { ControlType.Edit, new[] { "AXTextField" } },
		{ ControlType.Document, new[] { "AXTextArea" } }, { ControlType.Text, new[] { "AXStaticText" } }, { ControlType.Hyperlink, new[] { "AXLink" } },
		{ ControlType.Image, new[] { "AXImage" } }, { ControlType.Slider, new[] { "AXSlider" } }, { ControlType.Spinner, new[] { "AXIncrementor" } },
		{ ControlType.Tab, new[] { "AXTabGroup" } }, { ControlType.TabItem, new[] { "AXRadioButton", "AXTabButton" } }, { ControlType.List, new[] { "AXList" } },
		{ ControlType.ListItem, new[] { "AXCell" } }, { ControlType.DataGrid, new[] { "AXTable" } }, { ControlType.Table, new[] { "AXTable" } },
		{ ControlType.DataItem, new[] { "AXRow" } }, { ControlType.Tree, new[] { "AXOutline" } }, { ControlType.TreeItem, new[] { "AXRow", "AXOutlineRow" } },
		{ ControlType.Menu, new[] { "AXMenu" } }, { ControlType.MenuBar, new[] { "AXMenuBar" } }, { ControlType.MenuItem, new[] { "AXMenuItem" } },
		{ ControlType.ToolBar, new[] { "AXToolbar" } }, { ControlType.Window, new[] { "AXWindow" } }, { ControlType.ProgressBar, new[] { "AXProgressIndicator" } },
		{ ControlType.ScrollBar, new[] { "AXScrollBar" } }, { ControlType.Thumb, new[] { "AXValueIndicator" } }, { ControlType.Separator, new[] { "AXSplitter" } },
		{ ControlType.Header, new[] { "AXGroup" } }, { ControlType.HeaderItem, new[] { "AXButton" } }, { ControlType.TitleBar, new[] { "AXGroup" } },
	};

	static readonly HashSet<string> Skipped = new HashSet<string> { "AXScrollBar", "AXValueIndicator", "AXSplitter", "AXMenuBar" };
	static readonly HashSet<string> Textual = new HashSet<string> { "AXStaticText" };

	static Dictionary<string, object> Read(AutomationElement element, int depth, ref int budget)
	{
		if (budget <= 0) { return null; }
		var type = Cached(element, AutomationElement.ControlTypeProperty) as ControlType;
		string[] mapped;
		string role = type != null && Roles.TryGetValue(type, out mapped) ? mapped[0] : "AXGroup";
		string sub = type != null && Roles.TryGetValue(type, out mapped) && mapped.Length > 1 ? mapped[1] : null;
		if (Skipped.Contains(role)) { return null; }
		var frame = Cached(element, AutomationElement.BoundingRectangleProperty);
		Rect rect = frame is Rect ? (Rect)frame : Rect.Empty;
		if (depth > 0 && (rect.IsEmpty || rect.Width <= 0 || rect.Height <= 0)) { return null; }
		budget--;
		string handle = "h" + (++handleCount);
		Handles[handle] = element;
		var node = new Dictionary<string, object> { { "h", handle } };
		string name = Cached(element, AutomationElement.NameProperty) as string;
		if (role == "AXWindow" && Equals(Cached(element, WindowPattern.IsModalProperty), true)) { sub = "AXDialog"; }
		if (role == "AXTextField" && Equals(Cached(element, AutomationElement.IsPasswordProperty), true)) { sub = "AXSecureTextField"; }
		node["role"] = role;
		if (sub != null) { node["sub"] = sub; }
		if (Textual.Contains(role)) { if (!string.IsNullOrEmpty(name)) { node["value"] = Clip(name); } }
		else if (!string.IsNullOrEmpty(name)) { node["title"] = name; }
		string help = Cached(element, AutomationElement.HelpTextProperty) as string;
		if (!string.IsNullOrEmpty(help) && help != name) { node["help"] = help; }
		string id = Cached(element, AutomationElement.AutomationIdProperty) as string;
		// Numeric ids are made up by the framework (window handles, list indexes).
		if (!string.IsNullOrEmpty(id) && !id.All(char.IsDigit)) { node["id"] = id; }
		if (Equals(Cached(element, AutomationElement.IsEnabledProperty), false)) { node["disabled"] = true; }
		if (Equals(Cached(element, AutomationElement.HasKeyboardFocusProperty), true)) { node["focused"] = true; }
		if (Equals(Cached(element, AutomationElement.IsTogglePatternAvailableProperty), true))
		{
			var toggle = Cached(element, TogglePattern.ToggleStateProperty);
			node["value"] = toggle is ToggleState && (ToggleState)toggle == ToggleState.On ? "1" : "0";
			if (role == "AXButton") { node["role"] = "AXCheckBox"; node["sub"] = "AXToggle"; }
		}
		else if (Equals(Cached(element, AutomationElement.IsValuePatternAvailableProperty), true) && !Textual.Contains(role))
		{
			string value = Cached(element, ValuePattern.ValueProperty) as string;
			if (!string.IsNullOrEmpty(value) && value != name) { node["value"] = Clip(value); }
		}
		else if (Equals(Cached(element, AutomationElement.IsRangeValuePatternAvailableProperty), true))
		{
			var value = Cached(element, RangeValuePattern.ValueProperty);
			if (value is double) { node["value"] = ((double)value).ToString("0.##", System.Globalization.CultureInfo.InvariantCulture); }
		}
		if (Equals(Cached(element, AutomationElement.IsSelectionItemPatternAvailableProperty), true) && Equals(Cached(element, SelectionItemPattern.IsSelectedProperty), true))
		{
			node["selected"] = true;
			if (sub == "AXTabButton") { node["value"] = "1"; }
		}
		if (Equals(Cached(element, AutomationElement.IsExpandCollapsePatternAvailableProperty), true))
		{
			var state = Cached(element, ExpandCollapsePattern.ExpandCollapseStateProperty);
			if (state is ExpandCollapseState && (ExpandCollapseState)state != ExpandCollapseState.LeafNode) { node["expanded"] = (ExpandCollapseState)state != ExpandCollapseState.Collapsed; }
		}
		if (!rect.IsEmpty) { node["f"] = new[] { (int)Math.Round(rect.X), (int)Math.Round(rect.Y), (int)Math.Round(rect.Width), (int)Math.Round(rect.Height) }; }
		if (depth < 40)
		{
			var kids = new List<object>();
			AutomationElementCollection children;
			try { children = element.CachedChildren; } catch (Exception) { children = null; }
			if (children != null)
			{
				foreach (AutomationElement child in children)
				{
					if (budget <= 0) { break; }
					var kid = Read(child, depth + 1, ref budget);
					if (kid != null) { kids.Add(kid); }
				}
			}
			if (kids.Count > 0) { node["c"] = kids; }
		}
		return node;
	}

	static string Clip(string text)
	{
		return text.Length > 500 ? text.Substring(0, 500) : text;
	}

	/// The app's visible top-level windows, front to back.
	static List<IntPtr> WindowsOf(int pid)
	{
		var found = new List<IntPtr>();
		EnumWindows((hwnd, _) =>
		{
			uint owner;
			GetWindowThreadProcessId(hwnd, out owner);
			if ((int)owner == pid && IsWindowVisible(hwnd) && WindowTitle(hwnd).Length > 0) { found.Add(hwnd); }
			return true;
		}, IntPtr.Zero);
		return found;
	}

	static string WindowTitle(IntPtr hwnd)
	{
		var text = new StringBuilder(512);
		GetWindowText(hwnd, text, text.Capacity);
		return text.ToString();
	}

	static Process FindApp(Dictionary<string, object> r)
	{
		double pid = Num(r, "pid", 0);
		if (pid > 0)
		{
			try { return Process.GetProcessById((int)pid); } catch (Exception) { }
		}
		string query = (Str(r, "app") ?? "").Trim().ToLowerInvariant();
		var candidates = Process.GetProcesses().Where(p => p.Id != voltPid && p.Id != Process.GetCurrentProcess().Id && SafeWindow(p) != IntPtr.Zero).ToList();
		if (query.Length > 0)
		{
			string bare = query.EndsWith(".exe") ? query.Substring(0, query.Length - 4) : query;
			var exact = candidates.FirstOrDefault(p => p.ProcessName.ToLowerInvariant() == bare || Describe(p).ToLowerInvariant() == query);
			var loose = exact ?? candidates.FirstOrDefault(p => p.ProcessName.ToLowerInvariant().Contains(bare) || Describe(p).ToLowerInvariant().Contains(query) || WindowTitle(SafeWindow(p)).ToLowerInvariant().Contains(query));
			if (loose != null) { return loose; }
			throw new VoltFailure(Str(r, "app") + " is not running. Open it with an open step first.");
		}
		// The app in front of Volt: while the user talks to Volt, Volt itself is in front.
		IntPtr front = GetForegroundWindow();
		for (IntPtr hwnd = front; hwnd != IntPtr.Zero; hwnd = GetWindow(hwnd, 2 /* GW_HWNDNEXT */))
		{
			uint owner;
			GetWindowThreadProcessId(hwnd, out owner);
			if ((int)owner != voltPid && IsWindowVisible(hwnd) && WindowTitle(hwnd).Length > 0 && !IsIconic(hwnd))
			{
				try { return Process.GetProcessById((int)owner); } catch (Exception) { }
			}
		}
		throw new VoltFailure("No app is in front.");
	}

	static IntPtr SafeWindow(Process p)
	{
		try { return p.MainWindowHandle; } catch (Exception) { return IntPtr.Zero; }
	}

	static string Describe(Process p)
	{
		try { return p.MainModule.FileVersionInfo.FileDescription ?? p.ProcessName; } catch (Exception) { return p.ProcessName; }
	}

	static object Tree(Dictionary<string, object> r)
	{
		var app = FindApp(r);
		var windows = WindowsOf(app.Id);
		Handles.Clear();
		string wanted = (Str(r, "window") ?? "").ToLowerInvariant();
		IntPtr window = windows.FirstOrDefault(w => wanted.Length > 0 && WindowTitle(w).ToLowerInvariant().Contains(wanted));
		if (window == IntPtr.Zero) { window = windows.FirstOrDefault(w => !IsIconic(w)); }
		if (window == IntPtr.Zero && windows.Count > 0) { window = windows[0]; }
		var result = new Dictionary<string, object> {
			{ "app", Describe(app) }, { "bundle", app.ProcessName + ".exe" }, { "pid", app.Id },
			{ "windows", windows.Select(WindowTitle).ToArray() },
		};
		var minimized = windows.Where(IsIconic).Select(WindowTitle).ToArray();
		if (minimized.Length > 0) { result["minimized"] = minimized; }
		int budget = (int)Math.Max(50, Math.Min(5000, Num(r, "max", 2000)));
		if (window != IntPtr.Zero)
		{
			result["window"] = WindowTitle(window);
			var element = AutomationElement.FromHandle(window);
			Observe(app.Id, element);
			var cached = element.GetUpdatedCache(SubtreeRequest());
			var root = Read(cached, 0, ref budget);
			// A context menu or a dropdown opens as a window of its own: read it with the window.
			foreach (var popup in PopupMenus(app.Id))
			{
				var menu = Read(popup.GetUpdatedCache(SubtreeRequest()), 1, ref budget);
				if (menu != null && root != null)
				{
					object kids;
					var list = root.TryGetValue("c", out kids) ? (List<object>)kids : new List<object>();
					list.Add(menu);
					root["c"] = list;
				}
			}
			if (root != null) { result["root"] = root; }
		}
		result["truncated"] = budget <= 0;
		return result;
	}

	static IEnumerable<AutomationElement> PopupMenus(int pid)
	{
		var condition = new AndCondition(new PropertyCondition(AutomationElement.ProcessIdProperty, pid), new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Menu));
		try { return AutomationElement.RootElement.FindAll(TreeScope.Children, condition).Cast<AutomationElement>().ToList(); }
		catch (Exception) { return new AutomationElement[0]; }
	}

	//#endregion

	//#region Acting

	static void Press(Dictionary<string, object> r)
	{
		var element = Element(r);
		object pattern;
		if (element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) { ((InvokePattern)pattern).Invoke(); return; }
		if (element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) { ((TogglePattern)pattern).Toggle(); return; }
		if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) { ((SelectionItemPattern)pattern).Select(); return; }
		if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern))
		{
			var expand = (ExpandCollapsePattern)pattern;
			if (expand.Current.ExpandCollapseState == ExpandCollapseState.Collapsed) { expand.Expand(); } else { expand.Collapse(); }
			return;
		}
		// No action to take: Volt clicks the element's center instead.
		throw new VoltFailure("The app refused the press (the element has no invoke action).");
	}

	static void SetValue(Dictionary<string, object> r)
	{
		var element = Element(r);
		object pattern;
		if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) || ((ValuePattern)pattern).Current.IsReadOnly)
		{
			throw new VoltFailure("The field does not take a value directly.");
		}
		try { element.SetFocus(); } catch (Exception) { }
		((ValuePattern)pattern).SetValue(Str(r, "value") ?? "");
	}

	//#endregion

	//#region Pointer and keys

	[StructLayout(LayoutKind.Sequential)]
	struct MouseInput { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

	[StructLayout(LayoutKind.Sequential)]
	struct KeyboardInput { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

	[StructLayout(LayoutKind.Explicit)]
	struct InputUnion { [FieldOffset(0)] public MouseInput mi; [FieldOffset(0)] public KeyboardInput ki; }

	[StructLayout(LayoutKind.Sequential)]
	struct Input { public uint type; public InputUnion u; }

	const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
	const uint MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010, WHEEL = 0x0800, HWHEEL = 0x01000, VIRTUALDESK = 0x4000, ABSOLUTE = 0x8000;
	const uint KEYUP = 0x0002, UNICODE = 0x0004, EXTENDED = 0x0001;

	static void Send(params Input[] inputs)
	{
		if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) != inputs.Length)
		{
			throw new VoltFailure("Windows blocked the input (an elevated app is in front, or the screen is locked).");
		}
	}

	static Input Mouse(uint flags, double x, double y, uint data)
	{
		var input = new Input { type = INPUT_MOUSE };
		input.u.mi.dwFlags = flags;
		input.u.mi.mouseData = data;
		if ((flags & ABSOLUTE) != 0)
		{
			// Absolute coordinates run 0-65535 across the whole virtual desktop (every monitor).
			int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
			input.u.mi.dx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1));
			input.u.mi.dy = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
		}
		return input;
	}

	static void MoveTo(double x, double y)
	{
		Send(Mouse(MOVE | ABSOLUTE | VIRTUALDESK, x, y, 0));
	}

	static Input KeyInput(ushort vk, bool up)
	{
		var input = new Input { type = INPUT_KEYBOARD };
		input.u.ki.wVk = vk;
		input.u.ki.dwFlags = (up ? KEYUP : 0) | (ExtendedKeys.Contains(vk) ? EXTENDED : 0);
		return input;
	}

	static readonly HashSet<ushort> ExtendedKeys = new HashSet<ushort> { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B };

	static readonly Dictionary<string, ushort> Keys = new Dictionary<string, ushort> {
		{ "enter", 0x0D }, { "return", 0x0D }, { "tab", 0x09 }, { "space", 0x20 }, { "backspace", 0x08 }, { "delete", 0x08 }, { "escape", 0x1B }, { "esc", 0x1B },
		{ "forwarddelete", 0x2E }, { "home", 0x24 }, { "end", 0x23 }, { "pageup", 0x21 }, { "pagedown", 0x22 },
		{ "left", 0x25 }, { "arrowleft", 0x25 }, { "up", 0x26 }, { "arrowup", 0x26 }, { "right", 0x27 }, { "arrowright", 0x27 }, { "down", 0x28 }, { "arrowdown", 0x28 },
		{ "-", 0xBD }, { "=", 0xBB }, { "[", 0xDB }, { "]", 0xDD }, { ";", 0xBA }, { "'", 0xDE }, { ",", 0xBC }, { ".", 0xBE }, { "/", 0xBF }, { "\\", 0xDC }, { "`", 0xC0 },
	};

	static readonly Dictionary<string, ushort> ModifierKeys = new Dictionary<string, ushort> {
		{ "cmd", 0x5B }, { "command", 0x5B }, { "meta", 0x5B }, { "super", 0x5B }, { "win", 0x5B }, { "ctrl", 0x11 }, { "control", 0x11 },
		{ "alt", 0x12 }, { "option", 0x12 }, { "opt", 0x12 }, { "shift", 0x10 },
	};

	static List<ushort> Modifiers(string combo)
	{
		var keys = new List<ushort>();
		foreach (var part in (combo ?? "").ToLowerInvariant().Split('+').Select(p => p.Trim()).Where(p => p.Length > 0))
		{
			ushort vk;
			if (!ModifierKeys.TryGetValue(part, out vk)) { throw new VoltFailure("Unknown modifier " + part + "."); }
			keys.Add(vk);
		}
		return keys;
	}

	static ushort VirtualKey(string name)
	{
		name = name.Trim().ToLowerInvariant();
		ushort vk;
		if (Keys.TryGetValue(name, out vk)) { return vk; }
		if (name.Length == 1 && char.IsLetterOrDigit(name[0]) && name[0] < 128) { return (ushort)char.ToUpperInvariant(name[0]); }
		int f;
		if (name.StartsWith("f") && int.TryParse(name.Substring(1), out f) && f >= 1 && f <= 12) { return (ushort)(0x6F + f); }
		throw new VoltFailure("Unknown key " + name + ". Use a letter, digit, enter, tab, space, escape, delete, arrows, home, end, pageup, pagedown or f1-f12, with cmd/ctrl/alt/shift.");
	}

	static void Key(string combo)
	{
		var parts = combo.Split('+');
		var mods = Modifiers(string.Join("+", parts.Take(parts.Length - 1)));
		ushort key = VirtualKey(parts[parts.Length - 1]);
		var inputs = new List<Input>();
		foreach (var m in mods) { inputs.Add(KeyInput(m, false)); }
		inputs.Add(KeyInput(key, false));
		inputs.Add(KeyInput(key, true));
		for (int i = mods.Count - 1; i >= 0; i--) { inputs.Add(KeyInput(mods[i], true)); }
		Send(inputs.ToArray());
	}

	static void TypeText(string text)
	{
		// Each UTF-16 unit as a Unicode key event: any language, no keyboard layout involved.
		for (int i = 0; i < text.Length; i += 16)
		{
			var inputs = new List<Input>();
			foreach (char c in text.Substring(i, Math.Min(16, text.Length - i)))
			{
				foreach (bool up in new[] { false, true })
				{
					var input = new Input { type = INPUT_KEYBOARD };
					input.u.ki.wScan = c;
					input.u.ki.dwFlags = UNICODE | (up ? KEYUP : 0);
					inputs.Add(input);
				}
			}
			Send(inputs.ToArray());
			Thread.Sleep(4);
		}
	}

	/// Pastes through the clipboard (one keystroke), then puts back the text it held. The clipboard wants a single-threaded apartment.
	static void Paste(string text)
	{
		string saved = null;
		Exception failed = null;
		var set = new Thread(() =>
		{
			try
			{
				if (System.Windows.Forms.Clipboard.ContainsText()) { saved = System.Windows.Forms.Clipboard.GetText(); }
				System.Windows.Forms.Clipboard.SetText(text.Length > 0 ? text : " ");
			}
			catch (Exception error) { failed = error; }
		});
		set.SetApartmentState(ApartmentState.STA);
		set.Start();
		set.Join();
		if (failed != null) { TypeText(text); return; }
		Key("ctrl+v");
		Thread.Sleep(250);
		var restore = new Thread(() =>
		{
			try { if (saved != null) { System.Windows.Forms.Clipboard.SetText(saved); } else { System.Windows.Forms.Clipboard.Clear(); } }
			catch (Exception) { }
		});
		restore.SetApartmentState(ApartmentState.STA);
		restore.Start();
		restore.Join();
	}

	static void Click(Dictionary<string, object> r)
	{
		double x = Num(r, "x", 0), y = Num(r, "y", 0);
		bool right = Str(r, "button") == "right";
		int count = Math.Max(1, (int)Num(r, "count", 1));
		var mods = Modifiers(Str(r, "modifiers"));
		MoveTo(x, y);
		foreach (var m in mods) { Send(KeyInput(m, false)); }
		for (int i = 0; i < count; i++)
		{
			Send(Mouse((right ? RIGHTDOWN : LEFTDOWN) | ABSOLUTE | VIRTUALDESK | MOVE, x, y, 0), Mouse((right ? RIGHTUP : LEFTUP) | ABSOLUTE | VIRTUALDESK | MOVE, x, y, 0));
			if (i < count - 1) { Thread.Sleep(30); }
		}
		for (int i = mods.Count - 1; i >= 0; i--) { Send(KeyInput(mods[i], true)); }
	}

	/// Draws or drags through each stroke (see VoltDesktop.swift): moves no more than 3 px apart, on one schedule, with a pause at sharp turns.
	static void Drag(Dictionary<string, object> r)
	{
		var strokes = new List<List<System.Windows.Point>>();
		object raw;
		if (r.TryGetValue("strokes", out raw) && raw is object[])
		{
			foreach (var stroke in (object[])raw)
			{
				var points = new List<System.Windows.Point>();
				if (stroke is object[])
				{
					foreach (var pair in (object[])stroke)
					{
						var xy = pair as object[];
						if (xy != null && xy.Length >= 2) { points.Add(new System.Windows.Point(Convert.ToDouble(xy[0], System.Globalization.CultureInfo.InvariantCulture), Convert.ToDouble(xy[1], System.Globalization.CultureInfo.InvariantCulture))); }
					}
				}
				if (points.Count > 0) { strokes.Add(points); }
			}
		}
		if (strokes.Count == 0) { throw new VoltFailure("drag needs strokes: [[[x, y], [x, y], ...], ...]."); }
		bool right = Str(r, "button") == "right";
		var mods = Modifiers(Str(r, "modifiers"));
		double stepMs = Math.Max(0, Math.Min(20, Num(r, "stepMs", 0.5)));
		var clock = Stopwatch.StartNew();
		double due = 0;
		Action<double> wait = ms =>
		{
			due += ms;
			double left = due - clock.Elapsed.TotalMilliseconds;
			if (left > 2) { Thread.Sleep((int)(left - 1.5)); }
			while (clock.Elapsed.TotalMilliseconds < due) { }
		};
		Action<double> pause = ms => { due = clock.Elapsed.TotalMilliseconds; wait(ms); };
		foreach (var m in mods) { Send(KeyInput(m, false)); }
		foreach (var points in strokes)
		{
			MoveTo(points[0].X, points[0].Y);
			pause(8);
			Send(Mouse((right ? RIGHTDOWN : LEFTDOWN) | ABSOLUTE | VIRTUALDESK | MOVE, points[0].X, points[0].Y, 0));
			pause(30);
			var last = points[0];
			double? heading = null;
			foreach (var next in points.Skip(1))
			{
				double distance = Math.Sqrt((next.X - last.X) * (next.X - last.X) + (next.Y - last.Y) * (next.Y - last.Y));
				double direction = Math.Atan2(next.Y - last.Y, next.X - last.X);
				if (heading.HasValue && distance > 0)
				{
					double turn = Math.Abs(direction - heading.Value);
					if (turn > Math.PI) { turn = 2 * Math.PI - turn; }
					if (turn > 0.45) { pause(12); }
				}
				if (distance > 0) { heading = direction; }
				int steps = Math.Max(1, (int)Math.Ceiling(distance / 3));
				for (int i = 1; i <= steps; i++)
				{
					double t = (double)i / steps;
					MoveTo(last.X + (next.X - last.X) * t, last.Y + (next.Y - last.Y) * t);
					wait(stepMs);
				}
				last = next;
			}
			pause(12);
			Send(Mouse((right ? RIGHTUP : LEFTUP) | ABSOLUTE | VIRTUALDESK | MOVE, last.X, last.Y, 0));
			pause(16);
		}
		for (int i = mods.Count - 1; i >= 0; i--) { Send(KeyInput(mods[i], true)); }
	}

	static void Scroll(Dictionary<string, object> r)
	{
		double x = Num(r, "x", 0), y = Num(r, "y", 0), dx = Num(r, "dx", 0), dy = Num(r, "dy", 0);
		MoveTo(x, y);
		// One wheel notch (120) scrolls about 100 px; content moves up for a positive dy.
		if (dy != 0) { Send(Mouse(WHEEL, 0, 0, unchecked((uint)(int)Math.Round(-dy * 1.2)))); }
		if (dx != 0) { Send(Mouse(HWHEEL, 0, 0, unchecked((uint)(int)Math.Round(dx * 1.2)))); }
	}

	//#endregion

	//#region Apps and windows

	static bool Raise(IntPtr hwnd)
	{
		if (IsIconic(hwnd)) { ShowWindow(hwnd, 9 /* SW_RESTORE */); }
		// UI Automation may bring a window forward where SetForegroundWindow alone is refused.
		try { AutomationElement.FromHandle(hwnd).SetFocus(); } catch (Exception) { }
		SetForegroundWindow(hwnd);
		return GetForegroundWindow() == hwnd;
	}

	static object Activate(Dictionary<string, object> r)
	{
		string target = Str(r, "app") ?? "";
		double wait = Math.Max(0, Math.Min(30, Num(r, "wait", 10)));
		bool file = target.Contains("://") || File.Exists(Environment.ExpandEnvironmentVariables(target)) || Directory.Exists(Environment.ExpandEnvironmentVariables(target));
		if (!file)
		{
			try
			{
				var running = FindApp(new Dictionary<string, object> { { "app", target } });
				var windows = WindowsOf(running.Id);
				if (windows.Count > 0)
				{
					Raise(windows[0]);
					return new Dictionary<string, object> { { "app", Describe(running) }, { "ready", true } };
				}
			}
			catch (VoltFailure) { }
		}
		IntPtr before = GetForegroundWindow();
		try { Process.Start(new ProcessStartInfo(file ? Environment.ExpandEnvironmentVariables(target) : target) { UseShellExecute = true }); }
		catch (Exception) { throw new VoltFailure("Could not open " + target + ": use the program's name (notepad, mspaint, calc), its .exe path, a file or a URL."); }
		var clock = Stopwatch.StartNew();
		while (clock.Elapsed.TotalSeconds < wait)
		{
			Thread.Sleep(100);
			IntPtr front = GetForegroundWindow();
			uint owner;
			GetWindowThreadProcessId(front, out owner);
			if (front != IntPtr.Zero && (int)owner != voltPid && (front != before || file) && WindowTitle(front).Length > 0)
			{
				try { return new Dictionary<string, object> { { "app", Describe(Process.GetProcessById((int)owner)) }, { "ready", true } }; } catch (Exception) { }
			}
		}
		return new Dictionary<string, object> { { "app", target }, { "ready", false } };
	}

	static string Normalized(string title)
	{
		return (title ?? "").ToLowerInvariant().Replace("…", "").Replace("...", "").Replace("&", "").Trim();
	}

	static object WindowAction(Dictionary<string, object> r)
	{
		var app = FindApp(r);
		var windows = WindowsOf(app.Id);
		var titles = windows.Select(WindowTitle).ToList();
		string wanted = Normalized(Str(r, "title"));
		int index = wanted.Length == 0 ? (windows.Count > 0 ? 0 : -1) : titles.FindIndex(t => Normalized(t) == wanted);
		if (index < 0 && wanted.Length > 0) { index = titles.FindIndex(t => Normalized(t).Contains(wanted)); }
		if (index < 0)
		{
			throw new VoltFailure(windows.Count == 0 ? Describe(app) + " has no open window." : "No window titled \"" + Str(r, "title") + "\". Windows: " + string.Join(", ", titles.Select(t => "\"" + t + "\"")) + ".");
		}
		IntPtr hwnd = windows[index];
		string op = (Str(r, "op") ?? "raise").ToLowerInvariant();
		switch (op)
		{
			case "raise": case "focus": case "front": case "show": Raise(hwnd); break;
			case "minimize": case "min": ShowWindow(hwnd, 6 /* SW_MINIMIZE */); break;
			case "restore": case "unminimize": ShowWindow(hwnd, 9 /* SW_RESTORE */); break;
			case "close": PostMessage(hwnd, 0x0010 /* WM_CLOSE */, IntPtr.Zero, IntPtr.Zero); break;
			case "zoom": case "maximize": case "fullscreen": ShowWindow(hwnd, IsZoomed(hwnd) ? 9 : 3 /* SW_MAXIMIZE */); break;
			default: throw new VoltFailure("Unknown window action " + op + ": use raise, minimize, restore, close, zoom or fullscreen.");
		}
		Thread.Sleep(150);
		return new Dictionary<string, object> { { "window", titles[index] } };
	}

	static List<AutomationElement> MenuItems(AutomationElement container, int pid)
	{
		var items = container.FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem)).Cast<AutomationElement>().ToList();
		if (items.Count == 0)
		{
			// An opened submenu is often a popup window of its own, not the item's child.
			foreach (var popup in PopupMenus(pid))
			{
				items.AddRange(popup.FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem)).Cast<AutomationElement>());
			}
		}
		return items;
	}

	/// Picks a menu bar path, e.g. ["File", "Save As…"]: opens each menu, invokes the last item.
	static void Menu(Dictionary<string, object> r)
	{
		var app = FindApp(r);
		object raw;
		var path = (r.TryGetValue("path", out raw) && raw is object[] ? ((object[])raw).Select(p => Normalized(Convert.ToString(p))) : new string[0]).ToList();
		if (path.Count == 0) { throw new VoltFailure("menu needs a path, e.g. File > Save."); }
		var windows = WindowsOf(app.Id);
		if (windows.Count == 0) { throw new VoltFailure(Describe(app) + " has no open window."); }
		var window = AutomationElement.FromHandle(windows[0]);
		var bar = window.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuBar));
		if (bar == null) { throw new VoltFailure(Describe(app) + " has no menu bar."); }
		AutomationElement level = bar;
		for (int i = 0; i < path.Count; i++)
		{
			var items = MenuItems(level, app.Id);
			var titles = items.Select(candidate => Normalized(candidate.Current.Name)).ToList();
			int index = titles.IndexOf(path[i]);
			if (index < 0) { index = titles.FindIndex(t => t.StartsWith(path[i])); }
			if (index < 0)
			{
				Key("escape");
				throw new VoltFailure("No menu item \"" + path[i] + "\". Items: " + string.Join(", ", titles.Where(t => t.Length > 0)) + ".");
			}
			var item = items[index];
			if (!item.Current.IsEnabled) { Key("escape"); throw new VoltFailure("The menu item \"" + path[i] + "\" is disabled."); }
			object pattern;
			if (i == path.Count - 1)
			{
				if (item.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) { ((InvokePattern)pattern).Invoke(); }
				else if (item.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) { ((TogglePattern)pattern).Toggle(); }
				else { throw new VoltFailure("The menu item \"" + path[i] + "\" cannot be picked."); }
			}
			else
			{
				if (item.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) { ((ExpandCollapsePattern)pattern).Expand(); }
				else if (item.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) { ((InvokePattern)pattern).Invoke(); }
				Thread.Sleep(150);
				level = item;
			}
		}
	}

	static object Apps()
	{
		IntPtr front = GetForegroundWindow();
		uint frontPid;
		GetWindowThreadProcessId(front, out frontPid);
		var apps = new List<object>();
		foreach (var p in Process.GetProcesses())
		{
			IntPtr window = SafeWindow(p);
			if (window == IntPtr.Zero || p.Id == Process.GetCurrentProcess().Id || WindowTitle(window).Length == 0) { continue; }
			apps.Add(new Dictionary<string, object> { { "name", Describe(p) }, { "bundle", p.ProcessName + ".exe" }, { "pid", p.Id }, { "active", p.Id == (int)frontPid }, { "hidden", IsIconic(window) } });
		}
		return apps;
	}

	//#endregion

	//#region Settling

	/// Change events per window, kept registered: the events an action causes are counted until `settle` reads them.
	static readonly Dictionary<int, AutomationElement> Observed = new Dictionary<int, AutomationElement>();
	static int changeEvents;
	static long lastChangeTicks;
	static long actedAtTicks = Stopwatch.GetTimestamp();
	static int eventsAtAction;

	static void Changed()
	{
		Interlocked.Increment(ref changeEvents);
		Interlocked.Exchange(ref lastChangeTicks, Stopwatch.GetTimestamp());
	}

	static void Observe(int pid, AutomationElement window)
	{
		AutomationElement existing;
		if (Observed.TryGetValue(pid, out existing) && existing.Equals(window)) { return; }
		try
		{
			if (existing != null)
			{
				Automation.RemoveStructureChangedEventHandler(existing, OnStructure);
				Automation.RemoveAutomationPropertyChangedEventHandler(existing, OnProperty);
			}
			Automation.AddStructureChangedEventHandler(window, TreeScope.Subtree, OnStructure);
			Automation.AddAutomationPropertyChangedEventHandler(window, TreeScope.Subtree, OnProperty,
				AutomationElement.NameProperty, ValuePattern.ValueProperty, TogglePattern.ToggleStateProperty, SelectionItemPattern.IsSelectedProperty,
				ExpandCollapsePattern.ExpandCollapseStateProperty, AutomationElement.IsEnabledProperty, AutomationElement.BoundingRectangleProperty);
			if (Observed.Count == 0) { Automation.AddAutomationFocusChangedEventHandler(OnFocus); }
			Observed[pid] = window;
		}
		catch (Exception) { }
	}

	static void OnStructure(object sender, StructureChangedEventArgs e) { Changed(); }
	static void OnProperty(object sender, AutomationPropertyChangedEventArgs e) { Changed(); }
	static void OnFocus(object sender, AutomationFocusChangedEventArgs e) { Changed(); }

	static void MarkAction()
	{
		Interlocked.Exchange(ref actedAtTicks, Stopwatch.GetTimestamp());
		eventsAtAction = Interlocked.CompareExchange(ref changeEvents, 0, 0);
	}

	static double SecondsSince(long ticks)
	{
		return (Stopwatch.GetTimestamp() - ticks) / (double)Stopwatch.Frequency;
	}

	/// Returns once the app has gone quiet after the last action (see VoltDesktop.swift).
	static object Settle(Dictionary<string, object> r)
	{
		var app = FindApp(r);
		if (!Observed.ContainsKey(app.Id))
		{
			var windows = WindowsOf(app.Id);
			if (windows.Count > 0) { Observe(app.Id, AutomationElement.FromHandle(windows[0])); }
		}
		if (!Observed.ContainsKey(app.Id))
		{
			return new Dictionary<string, object> { { "supported", false }, { "changed", false }, { "events", 0 }, { "ms", 0 } };
		}
		double quiet = Num(r, "quietMs", 60) / 1000, start = Num(r, "startMs", 250) / 1000, limit = Num(r, "maxMs", 2000) / 1000;
		var clock = Stopwatch.StartNew();
		while (true)
		{
			Thread.Sleep(10);
			int events = Interlocked.CompareExchange(ref changeEvents, 0, 0) - eventsAtAction;
			if (events == 0 && SecondsSince(Interlocked.Read(ref actedAtTicks)) >= start) { break; }
			if (events > 0 && SecondsSince(Interlocked.Read(ref lastChangeTicks)) >= quiet) { break; }
			if (clock.Elapsed.TotalSeconds >= limit) { break; }
		}
		int seen = Interlocked.CompareExchange(ref changeEvents, 0, 0) - eventsAtAction;
		return new Dictionary<string, object> { { "supported", true }, { "changed", seen > 0 }, { "events", seen }, { "ms", (int)clock.ElapsedMilliseconds } };
	}

	//#endregion

	static object Capture(Dictionary<string, object> r)
	{
		int x = (int)Num(r, "x", 0), y = (int)Num(r, "y", 0), w = Math.Max(1, (int)Num(r, "w", 1)), h = Math.Max(1, (int)Num(r, "h", 1));
		using (var bitmap = new Bitmap(w, h))
		{
			using (var graphics = Graphics.FromImage(bitmap)) { graphics.CopyFromScreen(x, y, 0, 0, new System.Drawing.Size(w, h)); }
			using (var png = new MemoryStream())
			{
				bitmap.Save(png, ImageFormat.Png);
				return new Dictionary<string, object> { { "png", Convert.ToBase64String(png.ToArray()) }, { "width", w }, { "height", h } };
			}
		}
	}

	//#region Win32

	delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

	[DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
	[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
	[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
	[DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
	[DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
	[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
	[DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
	[DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
	[DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
	[DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
	[DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
	[DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);
	[DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
	[DllImport("user32.dll")] static extern bool SetProcessDPIAware();

	//#endregion
}

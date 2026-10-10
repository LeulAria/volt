/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

package volt;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.Build;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * Volt's UI reader for Android. It runs on the device as the shell user
 * (`CLASSPATH=volt-ui.jar app_process / volt.UiServer`), keeps one UiAutomation connection
 * open, and answers one command per line on stdin with one line on stdout:
 *
 *   dump                    the active window's accessibility tree, in uiautomator's XML
 *   tap X Y                 a touch
 *   swipe X1 Y1 X2 Y2 MS    a drag
 *   key CODE                a key press (KeyEvent keycode)
 *   keys CODE CODE …        several key presses, in order
 *   text BASE64             typing (UTF-8 text); ERR when the keyboard map cannot type it
 *   ping
 *
 * `uiautomator dump` starts a new process and connects for every read (about two seconds);
 * staying connected makes a read take tens of milliseconds, and input skips `input`'s own start-up.
 */
public final class UiServer {

	static final String VERSION = "1";

	private static UiAutomation automation;

	public static void main(String[] args) throws Exception {
		// The accessibility client posts to the main looper, which app_process does not create.
		Looper.prepareMainLooper();
		HandlerThread thread = new HandlerThread("VoltUi");
		thread.start();
		automation = connect(thread.getLooper());
		PrintStream out = new PrintStream(System.out, false, "UTF-8");
		out.println("VOLT-UI " + VERSION + " " + Build.VERSION.SDK_INT);
		out.flush();
		BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
		String line;
		while ((line = in.readLine()) != null) {
			String reply;
			try {
				reply = handle(line.trim());
			} catch (Throwable t) {
				reply = "ERR " + String.valueOf(t).replace('\n', ' ');
			}
			out.println(reply);
			out.flush();
		}
		System.exit(0);
	}

	/** The same connection `uiautomator` makes, through the hidden constructor it uses. */
	private static UiAutomation connect(Looper looper) throws Exception {
		Class<?> connectionClass = Class.forName("android.app.UiAutomationConnection");
		Constructor<?> connectionCtor = connectionClass.getDeclaredConstructor();
		connectionCtor.setAccessible(true);
		Object connection = connectionCtor.newInstance();
		Class<?> connectionInterface = Class.forName("android.app.IUiAutomationConnection");
		Constructor<UiAutomation> ctor = UiAutomation.class.getDeclaredConstructor(Looper.class, connectionInterface);
		ctor.setAccessible(true);
		UiAutomation ua = ctor.newInstance(looper, connection);
		Method connect;
		try {
			connect = UiAutomation.class.getDeclaredMethod("connect", int.class);
			connect.setAccessible(true);
			connect.invoke(ua, 0);
		} catch (NoSuchMethodException e) {
			connect = UiAutomation.class.getDeclaredMethod("connect");
			connect.setAccessible(true);
			connect.invoke(ua);
		}
		AccessibilityServiceInfo info = ua.getServiceInfo();
		if (info != null) {
			info.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
			ua.setServiceInfo(info);
		}
		return ua;
	}

	private static String handle(String line) throws Exception {
		String[] parts = line.split(" ");
		switch (parts[0]) {
			case "ping":
				return "PONG";
			case "dump":
				return dump();
			case "tap":
				tap(Integer.parseInt(parts[1]), Integer.parseInt(parts[2]));
				return "OK";
			case "swipe":
				swipe(Integer.parseInt(parts[1]), Integer.parseInt(parts[2]), Integer.parseInt(parts[3]), Integer.parseInt(parts[4]), Integer.parseInt(parts[5]));
				return "OK";
			case "key":
				key(Integer.parseInt(parts[1]));
				return "OK";
			case "keys":
				for (int i = 1; i < parts.length; i++) {
					key(Integer.parseInt(parts[i]));
				}
				return "OK";
			case "text":
				return type(new String(Base64.getDecoder().decode(parts.length > 1 ? parts[1] : ""), StandardCharsets.UTF_8)) ? "OK" : "ERR cannot type that text with the keyboard map";
			default:
				return "ERR unknown command " + parts[0];
		}
	}

	private static String dump() {
		try {
			automation.waitForIdle(40, 600);
		} catch (Exception e) {
			// Busy screens (animations) are read as they are.
		}
		AccessibilityNodeInfo root = automation.getRootInActiveWindow();
		if (root == null) {
			SystemClock.sleep(80);
			root = automation.getRootInActiveWindow();
		}
		StringBuilder sb = new StringBuilder(32768);
		sb.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">");
		if (root != null) {
			node(sb, root, 0, 0);
		}
		sb.append("</hierarchy>");
		return sb.toString();
	}

	@SuppressWarnings("deprecation")
	private static void node(StringBuilder sb, AccessibilityNodeInfo n, int index, int depth) {
		Rect r = new Rect();
		n.getBoundsInScreen(r);
		sb.append("<node index=\"").append(index).append('"');
		attr(sb, "text", n.getText());
		attr(sb, "resource-id", n.getViewIdResourceName());
		attr(sb, "class", n.getClassName());
		attr(sb, "package", n.getPackageName());
		attr(sb, "content-desc", n.getContentDescription());
		flag(sb, "checkable", n.isCheckable());
		flag(sb, "checked", n.isChecked());
		flag(sb, "clickable", n.isClickable());
		flag(sb, "enabled", n.isEnabled());
		flag(sb, "focusable", n.isFocusable());
		flag(sb, "focused", n.isFocused());
		flag(sb, "scrollable", n.isScrollable());
		flag(sb, "long-clickable", n.isLongClickable());
		flag(sb, "password", n.isPassword());
		flag(sb, "selected", n.isSelected());
		sb.append(" bounds=\"[").append(r.left).append(',').append(r.top).append("][").append(r.right).append(',').append(r.bottom).append("]\"");
		if (Build.VERSION.SDK_INT >= 26) {
			attr(sb, "hint", n.getHintText());
		}
		int count = depth < 80 ? n.getChildCount() : 0;
		if (count == 0) {
			sb.append("/>");
			return;
		}
		sb.append('>');
		for (int i = 0; i < count; i++) {
			AccessibilityNodeInfo child = n.getChild(i);
			if (child != null) {
				node(sb, child, i, depth + 1);
			}
		}
		sb.append("</node>");
	}

	private static void flag(StringBuilder sb, String name, boolean value) {
		sb.append(' ').append(name).append("=\"").append(value ? "true" : "false").append('"');
	}

	private static void attr(StringBuilder sb, String name, CharSequence value) {
		sb.append(' ').append(name).append("=\"");
		if (value != null) {
			for (int i = 0; i < value.length(); i++) {
				char c = value.charAt(i);
				switch (c) {
					case '&': sb.append("&amp;"); break;
					case '<': sb.append("&lt;"); break;
					case '>': sb.append("&gt;"); break;
					case '"': sb.append("&quot;"); break;
					case '\n': sb.append("&#10;"); break;
					case '\r': sb.append("&#13;"); break;
					default: sb.append(c);
				}
			}
		}
		sb.append('"');
	}

	private static void touch(long down, long at, int action, float x, float y) {
		MotionEvent event = MotionEvent.obtain(down, at, action, x, y, 0);
		event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
		automation.injectInputEvent(event, true);
		event.recycle();
	}

	private static void tap(int x, int y) {
		long down = SystemClock.uptimeMillis();
		touch(down, down, MotionEvent.ACTION_DOWN, x, y);
		touch(down, down + 40, MotionEvent.ACTION_UP, x, y);
	}

	private static void swipe(int x1, int y1, int x2, int y2, int ms) {
		long down = SystemClock.uptimeMillis();
		touch(down, down, MotionEvent.ACTION_DOWN, x1, y1);
		int steps = Math.max(2, Math.min(60, ms / 16));
		for (int i = 1; i <= steps; i++) {
			float t = (float) i / steps;
			long at = down + (long) (ms * t);
			long wait = at - SystemClock.uptimeMillis();
			if (wait > 0) {
				SystemClock.sleep(wait);
			}
			touch(down, at, MotionEvent.ACTION_MOVE, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
		}
		touch(down, down + ms, MotionEvent.ACTION_UP, x2, y2);
	}

	private static void key(int code) {
		long now = SystemClock.uptimeMillis();
		automation.injectInputEvent(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD), true);
		automation.injectInputEvent(new KeyEvent(now, now, KeyEvent.ACTION_UP, code, 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD), true);
	}

	private static boolean type(String text) {
		KeyEvent[] events = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(text.toCharArray());
		if (events == null) {
			return false;
		}
		for (KeyEvent event : events) {
			automation.injectInputEvent(event, true);
		}
		return true;
	}
}

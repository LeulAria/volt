// Copyright (c) Volt ADK. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

import SwiftUI
import WidgetKit

/// The agent window's colors (apps/mobile src/lib/theme.ts, agentHomePane.css badges).
enum VoltColor {
	static let background = Color(red: 0x14 / 255, green: 0x14 / 255, blue: 0x14 / 255)
	static let card = Color(red: 0x1c / 255, green: 0x1c / 255, blue: 0x1c / 255)
	static let text = Color(red: 0xf0 / 255, green: 0xf0 / 255, blue: 0xf0 / 255)
	static let secondary = text.opacity(0.7)
	static let tertiary = text.opacity(0.5)
	static let quaternary = text.opacity(0.35)
	static let track = text.opacity(0.12)
	static let blue = Color(red: 0x37 / 255, green: 0x94 / 255, blue: 0xff / 255)
	static let green = Color(red: 0x3f / 255, green: 0xa2 / 255, blue: 0x66 / 255)
	static let red = Color(red: 0xe3 / 255, green: 0x46 / 255, blue: 0x71 / 255)
	static let warning = Color(red: 0xf0 / 255, green: 0xa0 / 255, blue: 0x20 / 255)
	static let input = Color(red: 0x7c / 255, green: 0x8c / 255, blue: 0xf0 / 255)
	static let claude = Color(red: 0xd9 / 255, green: 0x77 / 255, blue: 0x57 / 255)

	static func phase(_ phase: String) -> Color {
		switch phase {
		case "input": return input
		case "done": return green
		case "failed": return red
		case "limited", "stopping", "stopped": return warning
		default: return blue
		}
	}

	/// Meter fill by share used: calm, then amber past 75%, red past 90%.
	static func meter(_ used: Double) -> Color {
		used >= 90 ? red : used >= 75 ? warning : text.opacity(0.85)
	}

	static func brand(_ provider: String) -> Color {
		provider == "claude" ? claude : text
	}
}

/// A provider's mark from the asset catalog (generated from the agent window's path data).
struct BrandGlyph: View {
	let provider: String
	var size: CGFloat = 16
	/// Lock Screen accessories are drawn in one tint; keep the mark's shape, drop its color.
	var monochrome = false

	private static let known: Set<String> = ["claude", "codex", "cursor", "grok", "opencode", "kimi", "muse", "local", "openrouter"]

	var body: some View {
		let name = Self.known.contains(provider) ? provider : "generic"
		Image("brand-\(name)")
			.resizable()
			.renderingMode(name == "kimi" && !monochrome ? .original : .template)
			.aspectRatio(contentMode: .fit)
			.frame(width: size, height: size)
			.foregroundStyle(monochrome ? Color.primary : VoltColor.brand(provider))
	}
}

/// Volt's mark for headers: the app icon (copied into the extension by the config plugin).
struct VoltMark: View {
	var size: CGFloat = 14
	var body: some View {
		if UIImage(named: "volt-icon") != nil {
			Image("volt-icon")
				.resizable()
				.aspectRatio(contentMode: .fit)
				.frame(width: size, height: size)
				.clipShape(RoundedRectangle(cornerRadius: size * 0.2237, style: .continuous))
		} else {
			Image(systemName: "bolt.fill")
				.font(.system(size: size * 0.85, weight: .semibold))
				.frame(width: size, height: size)
				.foregroundStyle(VoltColor.text)
		}
	}
}

/// A thin capsule meter.
struct Meter: View {
	let used: Double
	var height: CGFloat = 5
	var tint: Color? = nil

	var body: some View {
		GeometryReader { geo in
			ZStack(alignment: .leading) {
				Capsule().fill(VoltColor.track)
				Capsule()
					.fill(tint ?? VoltColor.meter(used))
					.frame(width: max(used > 0 ? height : 0, geo.size.width * min(1, max(0, used / 100))))
			}
		}
		.frame(height: height)
	}
}

enum VoltFormat {
	/// "42%".
	static func percent(_ value: Double) -> String {
		"\(Int(value.rounded()))%"
	}

	/// "4:10 PM" today, "Thu 4:10 PM" this week, else "Oct 12".
	static func resetTime(_ date: Date, now: Date) -> String {
		let calendar = Calendar.current
		let formatter = DateFormatter()
		if calendar.isDate(date, inSameDayAs: now) {
			formatter.timeStyle = .short
			formatter.dateStyle = .none
		} else if date.timeIntervalSince(now) < 6 * 86_400 {
			formatter.setLocalizedDateFormatFromTemplate("EEE j:mm")
		} else {
			formatter.setLocalizedDateFormatFromTemplate("MMM d")
		}
		return formatter.string(from: date)
	}

	/// "2h 10m", "3d 4h", "12m".
	static func duration(_ seconds: Double) -> String {
		let s = max(0, Int(seconds))
		let days = s / 86_400, hours = (s % 86_400) / 3_600, minutes = (s % 3_600) / 60
		if days > 0 { return hours > 0 ? "\(days)d \(hours)h" : "\(days)d" }
		if hours > 0 { return minutes > 0 ? "\(hours)h \(minutes)m" : "\(hours)h" }
		return "\(max(1, minutes))m"
	}

	/// "4:10 PM".
	static func clock(_ date: Date) -> String {
		let formatter = DateFormatter()
		formatter.timeStyle = .short
		formatter.dateStyle = .none
		return formatter.string(from: date)
	}

	/// "2:05", "1:02:05": a finished turn's length, in the live timer's own format.
	static func elapsed(_ seconds: Double) -> String {
		let s = max(0, Int(seconds.rounded()))
		let hours = s / 3_600, minutes = (s % 3_600) / 60, rest = s % 60
		return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, rest) : String(format: "%d:%02d", minutes, rest)
	}

	static func count(_ n: Int, _ one: String, _ many: String) -> String {
		n == 1 ? "1 \(one)" : "\(n) \(many)"
	}
}

extension View {
	/// The widget's background: `containerBackground` on iOS 17+, a plain background before.
	@ViewBuilder
	func voltWidgetBackground(_ color: Color = VoltColor.background) -> some View {
		if #available(iOSApplicationExtension 17.0, iOS 17.0, *) {
			containerBackground(for: .widget) { color }
		} else {
			background(color)
		}
	}
}

// Copyright (c) Volt ADK. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

// Usage limits per provider, as the Usage page reads them: every 5-hour / weekly window with what
// is used, when it resets and, when the pace says so, when it runs out first.

import SwiftUI
import WidgetKit

typealias ProviderUsage = WidgetSnapshot.ProviderUsage
typealias LimitWindow = WidgetSnapshot.LimitWindow

/// Colors that hold up when the home screen tints widgets (iOS 18 accented / clear modes).
struct Palette {
	let fullColor: Bool

	init(_ mode: WidgetRenderingMode) {
		fullColor = mode == .fullColor
	}

	init(fullColor: Bool) {
		self.fullColor = fullColor
	}

	var text: Color { fullColor ? VoltColor.text : .primary }
	var secondary: Color { fullColor ? VoltColor.secondary : .secondary }
	var tertiary: Color { fullColor ? VoltColor.tertiary : .secondary }
	func meter(_ used: Double) -> Color? { fullColor ? VoltColor.meter(used) : nil }
	func phase(_ phase: String) -> Color { fullColor ? VoltColor.phase(phase) : .primary }
	var input: Color { fullColor ? VoltColor.input : .primary }
	var warning: Color { fullColor ? VoltColor.warning : .primary }
}

/// "Resets 4:10 PM" or, ahead of pace, "Runs out ~3:20 PM".
func windowFootnote(_ window: LimitWindow, now: Date, short: Bool = false) -> (text: String, warn: Bool)? {
	if let runsOut = window.runsOutDate, runsOut > now {
		return ("\(short ? "Out" : "Runs out") ~\(VoltFormat.resetTime(runsOut, now: now))", true)
	}
	if let reset = window.resetDate {
		return ("\(short ? "" : "Resets ")\(VoltFormat.resetTime(reset, now: now))", false)
	}
	return nil
}

struct ProviderHeader: View {
	let usage: ProviderUsage
	let palette: Palette
	var size: CGFloat = 13
	var showPlan = true

	var body: some View {
		HStack(spacing: 5) {
			BrandGlyph(provider: usage.provider, size: size + 1, monochrome: !palette.fullColor)
			Text(usage.label)
				.font(.system(size: size, weight: .semibold))
				.foregroundStyle(palette.text)
				.lineLimit(1)
			if showPlan, let plan = usage.plan {
				Text(plan)
					.font(.system(size: size - 2, weight: .medium))
					.foregroundStyle(palette.tertiary)
					.lineLimit(1)
			}
		}
	}
}

/// One window on one line: `5h ▬▬▬░░ 42%`.
struct WindowLine: View {
	let window: LimitWindow
	let palette: Palette
	var labelWidth: CGFloat = 30
	var font: CGFloat = 12

	var body: some View {
		HStack(spacing: 6) {
			Text(window.short)
				.font(.system(size: font, weight: .medium))
				.foregroundStyle(palette.secondary)
				.frame(width: labelWidth, alignment: .leading)
				.lineLimit(1)
			Meter(used: window.usedPercent, height: 5, tint: palette.meter(window.usedPercent))
				.widgetAccentable()
			Text(VoltFormat.percent(window.usedPercent))
				.font(.system(size: font, weight: .semibold).monospacedDigit())
				.foregroundStyle(palette.text)
				.frame(width: 34, alignment: .trailing)
		}
	}
}

struct UsageEmptyView: View {
	let entry: VoltEntry
	let palette: Palette

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			HStack(spacing: 6) {
				VoltMark(size: 16)
				Text("Usage").font(.system(size: 13, weight: .semibold)).foregroundStyle(palette.text)
			}
			Spacer(minLength: 0)
			Text(entry.snapshot == nil ? "Open Volt to pair with your Mac." : "No subscription limits yet.")
				.font(.system(size: 13))
				.foregroundStyle(palette.secondary)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
	}
}

/// "Updated 4m ago" once the reading is old enough to matter.
struct UpdatedFootnote: View {
	let entry: VoltEntry
	let palette: Palette

	var body: some View {
		if let checked = entry.snapshot?.usage?.checkedAt, entry.date.timeIntervalSince1970 - checked > 15 * 60 {
			Text("Updated \(VoltFormat.duration(entry.date.timeIntervalSince1970 - checked)) ago")
				.font(.system(size: 11))
				.foregroundStyle(palette.tertiary)
		}
	}
}

struct UsageSmallView: View {
	let entry: VoltEntry
	let palette: Palette

	var body: some View {
		let providers = entry.providers
		if providers.isEmpty {
			UsageEmptyView(entry: entry, palette: palette)
		} else if providers.count == 1, let usage = providers.first {
			single(usage)
		} else {
			VStack(alignment: .leading, spacing: 9) {
				ForEach(providers.prefix(2), id: \.provider) { usage in
					VStack(alignment: .leading, spacing: 5) {
						ProviderHeader(usage: usage, palette: palette, size: 12, showPlan: false)
						ForEach(usage.windows.prefix(2), id: \.id) { window in
							WindowLine(window: window, palette: palette, labelWidth: 34, font: 11)
						}
					}
				}
				Spacer(minLength: 0)
			}
			.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		}
	}

	private func single(_ usage: ProviderUsage) -> some View {
		let lead = usage.windows.first
		return VStack(alignment: .leading, spacing: 0) {
			ProviderHeader(usage: usage, palette: palette, size: 13)
			Spacer(minLength: 4)
			if let lead {
				Text(VoltFormat.percent(lead.usedPercent))
					.font(.system(size: 34, weight: .semibold).monospacedDigit())
					.foregroundStyle(palette.text)
					.minimumScaleFactor(0.7)
				Text(lead.label)
					.font(.system(size: 12, weight: .medium))
					.foregroundStyle(palette.secondary)
					.lineLimit(1)
				Meter(used: lead.usedPercent, height: 6, tint: palette.meter(lead.usedPercent))
					.widgetAccentable()
					.padding(.top, 6)
				if let note = windowFootnote(lead, now: entry.date) {
					Text(note.text)
						.font(.system(size: 11, weight: note.warn ? .semibold : .regular))
						.foregroundStyle(note.warn ? palette.warning : palette.tertiary)
						.lineLimit(1)
						.padding(.top, 4)
				}
				if usage.windows.count > 1 {
					WindowLine(window: usage.windows[1], palette: palette, labelWidth: 34, font: 11)
						.padding(.top, 8)
				}
			} else if let error = usage.error {
				Text(error).font(.system(size: 12)).foregroundStyle(palette.secondary).lineLimit(3)
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
	}
}

/// One window as a column: label and share, meter, reset.
struct WindowColumn: View {
	let window: LimitWindow
	let now: Date
	let palette: Palette

	var body: some View {
		VStack(alignment: .leading, spacing: 4) {
			HStack(spacing: 4) {
				Text(window.short)
					.font(.system(size: 11, weight: .medium))
					.foregroundStyle(palette.secondary)
					.lineLimit(1)
				Spacer(minLength: 2)
				Text(VoltFormat.percent(window.usedPercent))
					.font(.system(size: 12, weight: .semibold).monospacedDigit())
					.foregroundStyle(palette.text)
			}
			Meter(used: window.usedPercent, height: 5, tint: palette.meter(window.usedPercent))
				.widgetAccentable()
			if let note = windowFootnote(window, now: now, short: true) {
				Text(note.text)
					.font(.system(size: 10, weight: note.warn ? .semibold : .regular))
					.foregroundStyle(note.warn ? palette.warning : palette.tertiary)
					.lineLimit(1)
			} else {
				Text(" ").font(.system(size: 10))
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}
}

struct UsageMediumView: View {
	let entry: VoltEntry
	let palette: Palette

	var body: some View {
		let providers = Array(entry.providers.prefix(3))
		if providers.isEmpty {
			UsageEmptyView(entry: entry, palette: palette)
		} else {
			VStack(alignment: .leading, spacing: providers.count == 3 ? 7 : 12) {
				if providers.count < 3 {
					HStack {
						HStack(spacing: 6) {
							VoltMark(size: 15)
							Text("Usage").font(.system(size: 13, weight: .semibold)).foregroundStyle(palette.text)
						}
						Spacer()
						UpdatedFootnote(entry: entry, palette: palette)
					}
				}
				ForEach(providers, id: \.provider) { usage in
					HStack(alignment: .top, spacing: 12) {
						ProviderHeader(usage: usage, palette: palette, size: 12, showPlan: false)
							.frame(width: 84, alignment: .leading)
							.padding(.top, 1)
						if usage.windows.isEmpty {
							Text(usage.error ?? "No reading")
								.font(.system(size: 11))
								.foregroundStyle(palette.tertiary)
								.lineLimit(2)
								.frame(maxWidth: .infinity, alignment: .leading)
						} else {
							ForEach(usage.windows.prefix(2), id: \.id) { window in
								WindowColumn(window: window, now: entry.date, palette: palette)
							}
							if usage.windows.count == 1 {
								Color.clear.frame(maxWidth: .infinity, maxHeight: 1)
							}
						}
					}
				}
				Spacer(minLength: 0)
			}
			.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		}
	}
}

struct UsageLargeView: View {
	let entry: VoltEntry
	let palette: Palette

	var body: some View {
		let providers = Array(entry.providers.prefix(4))
		VStack(alignment: .leading, spacing: 12) {
			HStack {
				HStack(spacing: 6) {
					VoltMark(size: 16)
					Text("Usage").font(.system(size: 15, weight: .semibold)).foregroundStyle(palette.text)
				}
				Spacer()
				UpdatedFootnote(entry: entry, palette: palette)
			}
			if providers.isEmpty {
				UsageEmptyView(entry: entry, palette: palette)
			}
			ForEach(providers, id: \.provider) { usage in
				VStack(alignment: .leading, spacing: 7) {
					HStack {
						ProviderHeader(usage: usage, palette: palette, size: 13)
						Spacer()
						if let credits = usage.resetCredits, credits > 0 {
							Text(VoltFormat.count(credits, "reset", "resets"))
								.font(.system(size: 11, weight: .medium))
								.foregroundStyle(palette.tertiary)
						}
					}
					if usage.windows.isEmpty, let error = usage.error {
						Text(error).font(.system(size: 12)).foregroundStyle(palette.tertiary).lineLimit(2)
					}
					ForEach(usage.windows.prefix(providers.count > 2 ? 2 : 3), id: \.id) { window in
						VStack(alignment: .leading, spacing: 3) {
							HStack(spacing: 6) {
								Text(window.title)
									.font(.system(size: 12))
									.foregroundStyle(palette.secondary)
									.lineLimit(1)
								Spacer(minLength: 4)
								if let note = windowFootnote(window, now: entry.date) {
									Text(note.text)
										.font(.system(size: 11, weight: note.warn ? .semibold : .regular))
										.foregroundStyle(note.warn ? palette.warning : palette.tertiary)
										.lineLimit(1)
								}
								Text(VoltFormat.percent(window.usedPercent))
									.font(.system(size: 12, weight: .semibold).monospacedDigit())
									.foregroundStyle(palette.text)
									.frame(width: 36, alignment: .trailing)
							}
							Meter(used: window.usedPercent, height: 5, tint: palette.meter(window.usedPercent))
								.widgetAccentable()
						}
					}
				}
			}
			Spacer(minLength: 0)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
	}
}

// MARK: Lock Screen accessories

/// The provider an accessory shows: the chosen one, else the one closest to a limit.
func accessoryUsage(_ entry: VoltEntry) -> ProviderUsage? {
	entry.providers.max { ($0.tightest?.usedPercent ?? -1) < ($1.tightest?.usedPercent ?? -1) }
}

struct UsageCircularView: View {
	let entry: VoltEntry

	var body: some View {
		if let usage = accessoryUsage(entry), let window = usage.windows.first {
			Gauge(value: min(100, window.usedPercent), in: 0...100) {
				BrandGlyph(provider: usage.provider, size: 12, monochrome: true)
			} currentValueLabel: {
				Text("\(Int(window.usedPercent.rounded()))")
					.font(.system(size: 15, weight: .semibold).monospacedDigit())
			}
			.gaugeStyle(.accessoryCircularCapacity)
			.widgetAccentable()
		} else {
			ZStack {
				AccessoryWidgetBackground()
				Image(systemName: "bolt.fill").font(.system(size: 18, weight: .semibold))
			}
		}
	}
}

struct UsageRectangularView: View {
	let entry: VoltEntry

	var body: some View {
		if let usage = accessoryUsage(entry) {
			VStack(alignment: .leading, spacing: 3) {
				HStack(spacing: 4) {
					BrandGlyph(provider: usage.provider, size: 12, monochrome: true)
					Text(usage.label).font(.system(size: 13, weight: .semibold))
					if let lead = usage.windows.first, let reset = lead.resetDate {
						Text(VoltFormat.resetTime(reset, now: entry.date))
							.font(.system(size: 12))
							.foregroundStyle(.secondary)
							.lineLimit(1)
					}
				}
				ForEach(usage.windows.prefix(2), id: \.id) { window in
					WindowLine(window: window, palette: Palette(fullColor: false), labelWidth: 34, font: 12)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		} else {
			Text("Volt usage").font(.system(size: 13, weight: .semibold))
		}
	}
}

struct UsageInlineView: View {
	let entry: VoltEntry

	var body: some View {
		if let usage = accessoryUsage(entry), let window = usage.windows.first {
			if let reset = window.resetDate {
				Text("\(usage.label) \(VoltFormat.percent(window.usedPercent)) · \(VoltFormat.resetTime(reset, now: entry.date))")
			} else {
				Text("\(usage.label) \(VoltFormat.percent(window.usedPercent))")
			}
		} else {
			Text("Volt usage")
		}
	}
}

struct UsageWidgetView: View {
	let entry: VoltEntry
	@Environment(\.widgetFamily) private var family
	@Environment(\.widgetRenderingMode) private var mode

	var body: some View {
		let palette = Palette(mode)
		Group {
			switch family {
			case .systemSmall: UsageSmallView(entry: entry, palette: palette)
			case .systemMedium: UsageMediumView(entry: entry, palette: palette)
			case .accessoryCircular: UsageCircularView(entry: entry)
			case .accessoryRectangular: UsageRectangularView(entry: entry)
			case .accessoryInline: UsageInlineView(entry: entry)
			default: UsageLargeView(entry: entry, palette: palette)
			}
		}
		.widgetURL(entry.snapshot?.usageURL ?? VoltLinks.home)
		.voltWidgetBackground(family.isAccessory ? .clear : VoltColor.background)
	}
}

extension WidgetFamily {
	var isAccessory: Bool {
		switch self {
		case .accessoryCircular, .accessoryRectangular, .accessoryInline: return true
		default: return false
		}
	}
}

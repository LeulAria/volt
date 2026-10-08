// Copyright (c) Volt ADK. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

// The running turn on the Lock Screen and in the Dynamic Island. Every view takes plain values
// (attributes, content state, stale) rather than an ActivityViewContext, so the snapshot renderer
// (snapshot/) draws exactly what the system draws.

import AppIntents
import SwiftUI
import WidgetKit

typealias VoltState = VoltActivityAttributes.ContentState

/// What one presentation needs to know about the turn.
struct ActivityModel {
	let attributes: VoltActivityAttributes
	let state: VoltState
	/// Past the stale date: the system no longer vouches for the content.
	let isStale: Bool

	var phase: String { state.phase }
	var isActive: Bool { state.isActive }
	var needsInput: Bool { phase == "input" }
	var tint: Color { VoltColor.phase(phase) }
	var chatURL: URL { VoltLinks.chat(attributes.chatId) }

	/// "volt · Opus 5.5": where and with what the agent works.
	var subtitle: String? {
		let parts = [attributes.workspace, state.model].compactMap { $0 }.filter { !$0.isEmpty }
		return parts.isEmpty ? nil : parts.joined(separator: " · ")
	}

	/// The line under the title.
	var stepLine: String {
		if isStale && isActive {
			return "Not updated since \(VoltFormat.clock(Date(timeIntervalSince1970: state.updatedAt)))"
		}
		switch phase {
		case "input": return state.inputPrompt ?? state.step
		case "limited":
			if let reset = state.limitResetAt {
				return "Usage limit · resets \(VoltFormat.resetTime(Date(timeIntervalSince1970: reset), now: Date()))"
			}
			return state.step
		default: return state.step
		}
	}

	var phaseLabel: String {
		switch phase {
		case "input": return state.inputKind == "question" ? "Question" : "Approval"
		case "stopping": return "Stopping"
		case "limited": return "Limit"
		case "done": return "Done"
		case "failed": return "Failed"
		case "stopped": return "Stopped"
		default: return isStale ? "Out of date" : "Working"
		}
	}

	var phaseSymbol: String {
		switch phase {
		case "input": return state.inputKind == "question" ? "questionmark.bubble.fill" : "hand.raised.fill"
		case "stopping", "stopped": return "stop.circle.fill"
		case "limited": return "gauge.with.dots.needle.100percent"
		case "done": return "checkmark.circle.fill"
		case "failed": return "xmark.octagon.fill"
		default: return "circle.fill"
		}
	}

	/// "3 files", "2 queued", "1 subagent", "+2 more": the counters worth a glance.
	var chips: [String] {
		var chips: [String] = []
		if state.filesChanged > 0 { chips.append(VoltFormat.count(state.filesChanged, "file", "files")) }
		if state.queued > 0 { chips.append("\(state.queued) queued") }
		if state.subagents > 0 { chips.append(VoltFormat.count(state.subagents, "subagent", "subagents")) }
		if state.others > 0 { chips.append("+\(state.others) more") }
		return chips
	}
}

/// Elapsed time: a live counter while the turn runs, the final duration once it ended.
struct ElapsedText: View {
	let state: VoltState
	var font: Font = .system(size: 15, weight: .semibold).monospacedDigit()

	var body: some View {
		if let end = state.endDate {
			Text(VoltFormat.elapsed(end.timeIntervalSince(state.startDate)))
				.font(font)
		} else {
			Text(state.startDate, style: .timer)
				.font(font)
				.multilineTextAlignment(.trailing)
		}
	}
}

struct PhaseBadge: View {
	let model: ActivityModel

	var body: some View {
		HStack(spacing: 4) {
			Image(systemName: model.phaseSymbol)
				.font(.system(size: model.phase == "working" ? 6 : 11, weight: .semibold))
			Text(model.phaseLabel)
				.font(.system(size: 12, weight: .semibold))
		}
		.foregroundStyle(model.isStale && model.isActive ? VoltColor.tertiary : model.tint)
	}
}

/// Stop for a running turn (an App Intent that runs in the app's process), Open for anything else.
struct ActivityActionButton: View {
	let model: ActivityModel
	var compact = false

	var body: some View {
		if model.needsInput {
			Link(destination: model.chatURL) {
				label(model.state.inputKind == "question" ? "Answer" : "Review", symbol: "arrow.up.forward", fill: VoltColor.input, text: .white)
			}
		} else if model.phase == "working" {
			if #available(iOS 17.0, *) {
				Button(intent: VoltStopTurnIntent(chatId: model.attributes.chatId)) {
					label("Stop", symbol: "stop.fill", fill: VoltColor.text.opacity(0.14), text: VoltColor.text)
				}
				.buttonStyle(.plain)
			} else {
				Link(destination: VoltLinks.chat(model.attributes.chatId, action: "stop")) {
					label("Stop", symbol: "stop.fill", fill: VoltColor.text.opacity(0.14), text: VoltColor.text)
				}
			}
		}
	}

	private func label(_ title: String, symbol: String, fill: Color, text: Color) -> some View {
		HStack(spacing: 5) {
			Image(systemName: symbol).font(.system(size: compact ? 10 : 11, weight: .bold))
			Text(title).font(.system(size: compact ? 13 : 14, weight: .semibold))
		}
		.foregroundStyle(text)
		.padding(.horizontal, compact ? 12 : 14)
		.frame(height: compact ? 30 : 32)
		.background(Capsule().fill(fill))
	}
}

struct ChipRow: View {
	let chips: [String]

	var body: some View {
		HStack(spacing: 6) {
			ForEach(chips, id: \.self) { chip in
				Text(chip)
					.font(.system(size: 12, weight: .medium).monospacedDigit())
					.foregroundStyle(VoltColor.secondary)
					.padding(.horizontal, 7)
					.frame(height: 20)
					.background(Capsule().fill(VoltColor.text.opacity(0.08)))
					.lineLimit(1)
					.fixedSize()
			}
		}
	}
}

/// The Lock Screen (and notification banner) presentation.
struct LockScreenActivityView: View {
	let model: ActivityModel

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			HStack(alignment: .top, spacing: 10) {
				ProviderTile(provider: model.attributes.provider, size: 36)
				VStack(alignment: .leading, spacing: 2) {
					Text(model.state.title)
						.font(.system(size: 16, weight: .semibold))
						.foregroundStyle(VoltColor.text)
						.lineLimit(1)
					if let subtitle = model.subtitle {
						Text(subtitle)
							.font(.system(size: 13))
							.foregroundStyle(VoltColor.tertiary)
							.lineLimit(1)
					}
				}
				Spacer(minLength: 8)
				VStack(alignment: .trailing, spacing: 3) {
					ElapsedText(state: model.state)
						.foregroundStyle(model.isActive && !model.isStale ? VoltColor.text : VoltColor.secondary)
						.frame(maxWidth: 80, alignment: .trailing)
					PhaseBadge(model: model)
				}
			}
			HStack(alignment: .firstTextBaseline, spacing: 6) {
				if model.needsInput {
					Text(model.stepLine)
						.font(.system(size: 14, weight: .medium))
						.foregroundStyle(VoltColor.text)
						.lineLimit(2)
				} else {
					Text(model.stepLine)
						.font(.system(size: 14))
						.foregroundStyle(model.phase == "failed" ? VoltColor.red : VoltColor.secondary)
						.lineLimit(1)
				}
			}
			if !model.chips.isEmpty || model.needsInput || model.phase == "working" {
				HStack(alignment: .center, spacing: 8) {
					ChipRow(chips: model.chips)
					Spacer(minLength: 0)
					ActivityActionButton(model: model, compact: true)
				}
			}
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 14)
	}
}

/// The provider's mark on a rounded tile, as the agent window's chat rows draw it.
struct ProviderTile: View {
	let provider: String
	var size: CGFloat = 32

	var body: some View {
		BrandGlyph(provider: provider, size: size * 0.56)
			.frame(width: size, height: size)
			.background(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous).fill(VoltColor.text.opacity(0.08)))
	}
}

// MARK: Dynamic Island

struct IslandCompactLeading: View {
	let model: ActivityModel

	var body: some View {
		BrandGlyph(provider: model.attributes.provider, size: 18)
			.padding(.leading, 2)
	}
}

struct IslandCompactTrailing: View {
	let model: ActivityModel

	var body: some View {
		if model.needsInput {
			Image(systemName: model.phaseSymbol)
				.font(.system(size: 14, weight: .semibold))
				.foregroundStyle(VoltColor.input)
		} else if model.isActive {
			ElapsedText(state: model.state, font: .system(size: 14, weight: .semibold).monospacedDigit())
				.foregroundStyle(model.phase == "stopping" ? VoltColor.warning : VoltColor.text)
				.frame(maxWidth: 44, alignment: .trailing)
		} else {
			Image(systemName: model.phaseSymbol)
				.font(.system(size: 14, weight: .semibold))
				.foregroundStyle(model.tint)
		}
	}
}

struct IslandMinimal: View {
	let model: ActivityModel

	var body: some View {
		if model.needsInput {
			Image(systemName: model.phaseSymbol)
				.font(.system(size: 13, weight: .semibold))
				.foregroundStyle(VoltColor.input)
		} else {
			BrandGlyph(provider: model.attributes.provider, size: 16)
		}
	}
}

struct IslandExpandedLeading: View {
	let model: ActivityModel

	var body: some View {
		HStack(spacing: 6) {
			BrandGlyph(provider: model.attributes.provider, size: 18)
			if let model = model.state.model {
				Text(model)
					.font(.system(size: 13, weight: .medium))
					.foregroundStyle(VoltColor.secondary)
					.lineLimit(1)
			}
		}
		.padding(.leading, 4)
	}
}

struct IslandExpandedTrailing: View {
	let model: ActivityModel

	var body: some View {
		Group {
			if model.isActive && !model.needsInput {
				ElapsedText(state: model.state, font: .system(size: 15, weight: .semibold).monospacedDigit())
					.foregroundStyle(VoltColor.text)
			} else {
				PhaseBadge(model: model)
			}
		}
		.frame(maxWidth: 90, alignment: .trailing)
		.padding(.trailing, 4)
	}
}

struct IslandExpandedBottom: View {
	let model: ActivityModel

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			Text(model.state.title)
				.font(.system(size: 16, weight: .semibold))
				.foregroundStyle(VoltColor.text)
				.lineLimit(1)
			Text(model.stepLine)
				.font(.system(size: 14, weight: model.needsInput ? .medium : .regular))
				.foregroundStyle(model.needsInput ? VoltColor.text : VoltColor.secondary)
				.lineLimit(model.needsInput ? 2 : 1)
			HStack(spacing: 8) {
				ChipRow(chips: model.chips)
				Spacer(minLength: 0)
				ActivityActionButton(model: model, compact: true)
			}
		}
		.padding(.horizontal, 4)
		.frame(maxWidth: .infinity, alignment: .leading)
	}
}

// MARK: Configuration

@available(iOS 16.2, *)
struct VoltAgentLiveActivity: Widget {
	var body: some WidgetConfiguration {
		ActivityConfiguration(for: VoltActivityAttributes.self) { context in
			let model = ActivityModel(attributes: context.attributes, state: context.state, isStale: context.isStale)
			LockScreenActivityView(model: model)
				.activityBackgroundTint(VoltColor.background.opacity(0.92))
				.activitySystemActionForegroundColor(VoltColor.text)
				.widgetURL(model.chatURL)
		} dynamicIsland: { context in
			let model = ActivityModel(attributes: context.attributes, state: context.state, isStale: context.isStale)
			return DynamicIsland {
				DynamicIslandExpandedRegion(.leading) { IslandExpandedLeading(model: model) }
				DynamicIslandExpandedRegion(.trailing) { IslandExpandedTrailing(model: model) }
				DynamicIslandExpandedRegion(.bottom) { IslandExpandedBottom(model: model) }
			} compactLeading: {
				IslandCompactLeading(model: model)
			} compactTrailing: {
				IslandCompactTrailing(model: model)
			} minimal: {
				IslandMinimal(model: model)
			}
			.widgetURL(model.chatURL)
			.keylineTint(model.tint)
		}
	}
}

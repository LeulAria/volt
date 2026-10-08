// Copyright (c) Volt ADK. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

// The chats that need the user, then the ones working, then the ones that just finished: the
// agent window's Needs Attention and Working groups, one tap from the chat.

import SwiftUI
import WidgetKit

typealias WidgetAgent = WidgetSnapshot.Agent

extension WidgetAgent {
	var needsInput: Bool { phase == "input" }

	var badge: String {
		switch phase {
		case "input": return inputKind == "question" ? "Question" : "Approval"
		case "stopping": return "Stopping"
		case "limited": return "Limit"
		case "done": return "Done"
		case "failed": return "Failed"
		case "stopped": return "Stopped"
		default: return "Working"
		}
	}

	var symbol: String {
		switch phase {
		case "input": return inputKind == "question" ? "questionmark.bubble.fill" : "hand.raised.fill"
		case "done": return "checkmark.circle.fill"
		case "failed": return "xmark.octagon.fill"
		case "limited": return "gauge.with.dots.needle.100percent"
		case "stopping", "stopped": return "stop.circle.fill"
		default: return "circle.fill"
		}
	}
}

/// "2 working · 1 needs you".
func agentsSummary(_ agents: WidgetSnapshot.Agents?) -> String {
	guard let agents, agents.working + agents.needsInput > 0 else { return "No agents running" }
	var parts: [String] = []
	if agents.needsInput > 0 { parts.append(agents.needsInput == 1 ? "1 needs you" : "\(agents.needsInput) need you") }
	if agents.working > 0 { parts.append("\(agents.working) working") }
	return parts.joined(separator: " · ")
}

/// The right side of a row: a live timer while working, the state otherwise.
struct AgentTrailing: View {
	let agent: WidgetAgent
	let palette: Palette

	var body: some View {
		if agent.isActive && !agent.needsInput, let start = agent.startDate {
			Text(start, style: .timer)
				.font(.system(size: 12, weight: .medium).monospacedDigit())
				.foregroundStyle(palette.secondary)
				.multilineTextAlignment(.trailing)
				.frame(width: 48, alignment: .trailing)
		} else {
			HStack(spacing: 3) {
				Image(systemName: agent.symbol).font(.system(size: agent.phase == "working" ? 6 : 10, weight: .semibold))
				Text(agent.badge).font(.system(size: 11, weight: .semibold))
			}
			.foregroundStyle(palette.phase(agent.phase))
			.fixedSize()
		}
	}
}

struct AgentRow: View {
	let agent: WidgetAgent
	let palette: Palette
	var tile: CGFloat = 28

	var body: some View {
		Link(destination: agent.link) {
			HStack(spacing: 9) {
				ZStack(alignment: .bottomTrailing) {
					ProviderTile(provider: agent.provider, size: tile)
					if agent.isActive {
						Circle()
							.fill(palette.phase(agent.phase))
							.frame(width: 8, height: 8)
							.overlay(Circle().stroke(VoltColor.background, lineWidth: 1.5))
							.offset(x: 2, y: 2)
					}
				}
				VStack(alignment: .leading, spacing: 1) {
					Text(agent.title)
						.font(.system(size: 13, weight: .semibold))
						.foregroundStyle(palette.text)
						.lineLimit(1)
					if let step = agent.step {
						Text(step)
							.font(.system(size: 12))
							.foregroundStyle(agent.needsInput ? palette.input : palette.tertiary)
							.lineLimit(1)
					}
				}
				Spacer(minLength: 4)
				AgentTrailing(agent: agent, palette: palette)
			}
		}
	}
}

struct AgentsHeader: View {
	let entry: VoltEntry
	let palette: Palette
	var newChat = true

	var body: some View {
		HStack(spacing: 6) {
			VoltMark(size: 16)
			Text("Agents").font(.system(size: 13, weight: .semibold)).foregroundStyle(palette.text)
			Text(agentsSummary(entry.snapshot?.agents))
				.font(.system(size: 12))
				.foregroundStyle((entry.snapshot?.agents.needsInput ?? 0) > 0 ? palette.input : palette.tertiary)
				.lineLimit(1)
			Spacer(minLength: 4)
			if entry.snapshot?.server?.connected == false || entry.isStale {
				Text(entry.snapshot == nil ? "Not paired" : entry.snapshot?.server?.connected == false ? "Offline" : "Updated \(VoltFormat.duration(entry.date.timeIntervalSince((entry.snapshot?.generatedDate) ?? entry.date))) ago")
					.font(.system(size: 11))
					.foregroundStyle(palette.tertiary)
					.lineLimit(1)
			} else if newChat, let url = entry.snapshot?.newChatURL {
				Link(destination: url) {
					Image(systemName: "square.and.pencil")
						.font(.system(size: 13, weight: .semibold))
						.foregroundStyle(palette.secondary)
						.frame(width: 26, height: 22)
				}
			}
		}
	}
}

struct AgentsEmptyView: View {
	let entry: VoltEntry
	let palette: Palette

	var body: some View {
		VStack(spacing: 6) {
			Image(systemName: "checkmark.circle")
				.font(.system(size: 20, weight: .regular))
				.foregroundStyle(palette.tertiary)
			Text(entry.snapshot == nil ? "Open Volt to pair with your Mac" : "Nothing running")
				.font(.system(size: 12))
				.foregroundStyle(palette.tertiary)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
	}
}

struct AgentsSmallView: View {
	let entry: VoltEntry
	let palette: Palette

	var body: some View {
		let agents = entry.snapshot?.agents
		let lead = agents?.items.first
		VStack(alignment: .leading, spacing: 0) {
			HStack(spacing: 6) {
				VoltMark(size: 16)
				Text("Agents").font(.system(size: 13, weight: .semibold)).foregroundStyle(palette.text)
			}
			Spacer(minLength: 2)
			if let agents, agents.working + agents.needsInput > 0 {
				HStack(alignment: .firstTextBaseline, spacing: 5) {
					Text("\(agents.working + agents.needsInput)")
						.font(.system(size: 34, weight: .semibold).monospacedDigit())
						.foregroundStyle(palette.text)
					Text(agents.working + agents.needsInput == 1 ? "active" : "active")
						.font(.system(size: 13, weight: .medium))
						.foregroundStyle(palette.secondary)
				}
				if agents.needsInput > 0 {
					Label(agents.needsInput == 1 ? "1 needs you" : "\(agents.needsInput) need you", systemImage: "hand.raised.fill")
						.font(.system(size: 12, weight: .semibold))
						.foregroundStyle(palette.input)
						.labelStyle(TightLabel())
				}
			} else {
				Text("Nothing running")
					.font(.system(size: 14, weight: .medium))
					.foregroundStyle(palette.secondary)
			}
			Spacer(minLength: 6)
			if let lead {
				HStack(spacing: 6) {
					BrandGlyph(provider: lead.provider, size: 13, monochrome: !palette.fullColor)
					Text(lead.title)
						.font(.system(size: 12, weight: .semibold))
						.foregroundStyle(palette.text)
						.lineLimit(1)
				}
				if let step = lead.step {
					Text(step)
						.font(.system(size: 11))
						.foregroundStyle(lead.needsInput ? palette.input : palette.tertiary)
						.lineLimit(1)
						.padding(.top, 1)
				}
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.widgetURL(lead?.link ?? entry.snapshot?.homeURL ?? VoltLinks.home)
	}
}

struct TightLabel: LabelStyle {
	func makeBody(configuration: Configuration) -> some View {
		HStack(spacing: 4) {
			configuration.icon.font(.system(size: 10, weight: .semibold))
			configuration.title
		}
	}
}

struct AgentsListView: View {
	let entry: VoltEntry
	let palette: Palette
	let rows: Int

	var body: some View {
		let items = Array((entry.snapshot?.agents.items ?? []).prefix(rows))
		VStack(alignment: .leading, spacing: rows > 3 ? 11 : 9) {
			AgentsHeader(entry: entry, palette: palette)
			if items.isEmpty {
				AgentsEmptyView(entry: entry, palette: palette)
			} else {
				ForEach(items) { agent in
					AgentRow(agent: agent, palette: palette, tile: rows > 3 ? 30 : 26)
				}
				Spacer(minLength: 0)
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.widgetURL(entry.snapshot?.homeURL ?? VoltLinks.home)
	}
}

// MARK: Lock Screen accessories

struct AgentsCircularView: View {
	let entry: VoltEntry

	var body: some View {
		let agents = entry.snapshot?.agents
		let active = (agents?.working ?? 0) + (agents?.needsInput ?? 0)
		ZStack {
			AccessoryWidgetBackground()
			VStack(spacing: 0) {
				Image(systemName: (agents?.needsInput ?? 0) > 0 ? "hand.raised.fill" : "bolt.fill")
					.font(.system(size: 12, weight: .semibold))
				Text("\(active)")
					.font(.system(size: 20, weight: .semibold).monospacedDigit())
			}
		}
		.widgetAccentable()
		.widgetURL(entry.snapshot?.agents.items.first?.link ?? VoltLinks.home)
	}
}

struct AgentsRectangularView: View {
	let entry: VoltEntry

	var body: some View {
		let agents = entry.snapshot?.agents
		let lead = agents?.items.first { $0.isActive }
		VStack(alignment: .leading, spacing: 1) {
			HStack(spacing: 4) {
				Image(systemName: (agents?.needsInput ?? 0) > 0 ? "hand.raised.fill" : "bolt.fill")
					.font(.system(size: 11, weight: .semibold))
				Text(agentsSummary(agents))
					.font(.system(size: 13, weight: .semibold))
					.lineLimit(1)
			}
			.widgetAccentable()
			if let lead {
				Text(lead.title).font(.system(size: 13)).lineLimit(1)
				HStack(spacing: 4) {
					Text(lead.step ?? lead.badge).lineLimit(1)
					if !lead.needsInput, let start = lead.startDate {
						Spacer(minLength: 2)
						Text(start, style: .timer).monospacedDigit().multilineTextAlignment(.trailing).frame(maxWidth: 46, alignment: .trailing)
					}
				}
				.font(.system(size: 12))
				.foregroundStyle(.secondary)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.widgetURL(lead?.link ?? VoltLinks.home)
	}
}

struct AgentsInlineView: View {
	let entry: VoltEntry

	var body: some View {
		Label(agentsSummary(entry.snapshot?.agents), systemImage: (entry.snapshot?.agents.needsInput ?? 0) > 0 ? "hand.raised.fill" : "bolt.fill")
	}
}

struct AgentsWidgetView: View {
	let entry: VoltEntry
	@Environment(\.widgetFamily) private var family
	@Environment(\.widgetRenderingMode) private var mode

	var body: some View {
		let palette = Palette(mode)
		Group {
			switch family {
			case .systemSmall: AgentsSmallView(entry: entry, palette: palette)
			case .systemMedium: AgentsListView(entry: entry, palette: palette, rows: 3)
			case .accessoryCircular: AgentsCircularView(entry: entry)
			case .accessoryRectangular: AgentsRectangularView(entry: entry)
			case .accessoryInline: AgentsInlineView(entry: entry)
			default: AgentsListView(entry: entry, palette: palette, rows: 7)
			}
		}
		.voltWidgetBackground(family.isAccessory ? .clear : VoltColor.background)
	}
}

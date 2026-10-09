// Copyright (c) Volt ADK. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

// The snapshot the app writes to the App Group (src/model.ts IWidgetSnapshot) and the timeline
// built from it. Times are Unix seconds.

import Foundation
import WidgetKit

struct WidgetSnapshot: Codable {
	struct Server: Codable {
		var name: String?
		var connected: Bool
	}

	struct LimitWindow: Codable, Hashable {
		var id: String
		var label: String
		var short: String
		var scope: String?
		var usedPercent: Double
		var resetsAt: Double?
		var windowSeconds: Double?
		var runsOutAt: Double?
		var ahead: Bool?

		/// As of `date`: a window whose reset passed is back to zero.
		func at(_ date: Date) -> LimitWindow {
			guard let resetsAt, resetsAt <= date.timeIntervalSince1970 else { return self }
			var copy = self
			copy.usedPercent = 0
			copy.resetsAt = nil
			copy.runsOutAt = nil
			copy.ahead = nil
			return copy
		}

		var resetDate: Date? { resetsAt.map { Date(timeIntervalSince1970: $0) } }
		var runsOutDate: Date? { runsOutAt.map { Date(timeIntervalSince1970: $0) } }
		var title: String { scope.map { "\(label) · \($0)" } ?? label }
		var shortTitle: String { scope.map { "\(short) · \($0)" } ?? short }
	}

	struct ProviderUsage: Codable, Hashable {
		var provider: String
		var label: String
		var plan: String?
		var windows: [LimitWindow]
		var resetCredits: Int?
		var error: String?
		var checkedAt: Double

		func at(_ date: Date) -> ProviderUsage {
			var copy = self
			copy.windows = windows.map { $0.at(date) }
			return copy
		}

		/// The window closest to its limit: what a one-number widget shows.
		var tightest: LimitWindow? { windows.max { $0.usedPercent < $1.usedPercent } }
	}

	struct Usage: Codable {
		var checkedAt: Double
		var providers: [ProviderUsage]
	}

	struct Agent: Codable, Hashable, Identifiable {
		var chatId: String
		var title: String
		var provider: String
		var phase: String
		var step: String?
		var startedAt: Double?
		var inputKind: String?
		var workspace: String?
		var model: String?
		var url: String

		var id: String { chatId }
		var isActive: Bool { phase == "working" || phase == "input" || phase == "stopping" }
		var startDate: Date? { startedAt.map { Date(timeIntervalSince1970: $0) } }
		var link: URL { URL(string: url) ?? VoltLinks.home }
	}

	struct Agents: Codable {
		var working: Int
		var needsInput: Int
		var items: [Agent]
	}

	struct Links: Codable {
		var home: String
		var usage: String
		var newChat: String
	}

	var version: Int
	var generatedAt: Double
	var server: Server?
	var usage: Usage?
	var agents: Agents
	var links: Links

	var generatedDate: Date { Date(timeIntervalSince1970: generatedAt) }
	var usageURL: URL { URL(string: links.usage) ?? VoltLinks.home }
	var homeURL: URL { URL(string: links.home) ?? VoltLinks.home }
	var newChatURL: URL { URL(string: links.newChat) ?? VoltLinks.home }

	static func load() -> WidgetSnapshot? {
		guard
			let group = Bundle.main.object(forInfoDictionaryKey: "VoltWidgetsAppGroup") as? String,
			let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?.appendingPathComponent("widget-snapshot.json"),
			let data = try? Data(contentsOf: url)
		else { return nil }
		return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
	}
}

struct VoltEntry: TimelineEntry {
	let date: Date
	let snapshot: WidgetSnapshot?

	var providers: [WidgetSnapshot.ProviderUsage] {
		(snapshot?.usage?.providers ?? []).map { $0.at(date) }
	}

	/// Data older than this is labelled with its age.
	var isStale: Bool {
		guard let snapshot else { return true }
		return date.timeIntervalSince(snapshot.generatedDate) > 20 * 60
	}
}

/// One entry now and one at every reset in the next day (the meter drops to zero then), refreshed
/// after the last of them or within the hour. The app reloads timelines whenever its data changes.
struct VoltTimelineProvider: TimelineProvider {
	let preview: WidgetSnapshot?

	func placeholder(in context: Context) -> VoltEntry {
		VoltEntry(date: Date(), snapshot: preview)
	}

	func getSnapshot(in context: Context, completion: @escaping (VoltEntry) -> Void) {
		completion(VoltEntry(date: Date(), snapshot: WidgetSnapshot.load() ?? preview))
	}

	func getTimeline(in context: Context, completion: @escaping (Timeline<VoltEntry>) -> Void) {
		let now = Date()
		let snapshot = WidgetSnapshot.load()
		let horizon = now.addingTimeInterval(24 * 3_600)
		let resets = Set((snapshot?.usage?.providers ?? []).flatMap { $0.windows.compactMap(\.resetDate) }.filter { $0 > now && $0 < horizon })
		// Agents data goes stale; re-render then so the age label appears.
		let staleAt = snapshot.map { $0.generatedDate.addingTimeInterval(20 * 60 + 1) }.flatMap { $0 > now ? $0 : nil }
		let dates = ([now] + resets.sorted() + (staleAt.map { [$0] } ?? [])).sorted()
		let entries = dates.map { VoltEntry(date: $0, snapshot: snapshot) }
		completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(3_600))))
	}
}

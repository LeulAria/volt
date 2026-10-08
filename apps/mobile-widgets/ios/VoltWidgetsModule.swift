// Copyright (c) Volt ADK. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

import ActivityKit
import ExpoModulesCore
import Foundation
import WidgetKit

/// Live Activities and widget data for the Volt app (TS API: src/native.ts).
public class VoltWidgetsModule: Module {

	private var observers: [String: Task<Void, Never>] = [:]
	private var globalObservers: [Task<Void, Never>] = []
	private var stopObserver: NSObjectProtocol?

	public func definition() -> ModuleDefinition {
		Name("VoltWidgets")

		Events("onPushToken", "onPushToStartToken", "onActivityState", "onStopRequested")

		Function("getInfo") { () -> [String: Any] in
			var info: [String: Any] = [
				"appGroup": VoltWidgetStore.appGroup ?? NSNull(),
				"supported": false,
				"enabled": false,
				"frequentPushesEnabled": false,
				"pushToStartSupported": false,
			]
			if #available(iOS 16.2, *) {
				let auth = ActivityAuthorizationInfo()
				info["supported"] = true
				info["enabled"] = auth.areActivitiesEnabled
				info["frequentPushesEnabled"] = auth.frequentPushesEnabled
			}
			if #available(iOS 17.2, *) {
				info["pushToStartSupported"] = true
			}
			return info
		}

		AsyncFunction("startActivity") { (attributesJson: String, stateJson: String, options: [String: Any]?) -> [String: Any] in
			guard #available(iOS 16.2, *) else {
				throw Exception(name: "Unsupported", description: "Live Activities need iOS 16.2.")
			}
			let attributes = try JSONDecoder().decode(VoltActivityAttributes.self, from: Data(attributesJson.utf8))
			let state = try JSONDecoder().decode(VoltActivityAttributes.ContentState.self, from: Data(stateJson.utf8))
			let content = ActivityContent(state: state, staleDate: Self.date(options?["staleAt"]), relevanceScore: Self.double(options?["relevance"]) ?? 50)
			let wantsPush = (options?["push"] as? Bool) ?? true
			var activity: Activity<VoltActivityAttributes>
			var pushEnabled = wantsPush
			do {
				activity = try Activity.request(attributes: attributes, content: content, pushType: wantsPush ? .token : nil)
			} catch where wantsPush {
				// No push entitlement (or simulator without APNs): run it locally.
				activity = try Activity.request(attributes: attributes, content: content, pushType: nil)
				pushEnabled = false
			}
			if pushEnabled {
				self.observe(activity)
			}
			return ["activityId": activity.id, "pushEnabled": pushEnabled, "pushToken": activity.pushToken.map(Self.hex) ?? NSNull()]
		}

		AsyncFunction("updateActivity") { (activityId: String, stateJson: String, options: [String: Any]?) -> Bool in
			guard #available(iOS 16.2, *), let activity = Self.find(activityId) else { return false }
			let state = try JSONDecoder().decode(VoltActivityAttributes.ContentState.self, from: Data(stateJson.utf8))
			let content = ActivityContent(state: state, staleDate: Self.date(options?["staleAt"]), relevanceScore: Self.double(options?["relevance"]) ?? 50)
			if let alert = options?["alert"] as? [String: Any], let title = alert["title"] as? String, let body = alert["body"] as? String {
				await activity.update(content, alertConfiguration: AlertConfiguration(title: LocalizedStringResource(stringLiteral: title), body: LocalizedStringResource(stringLiteral: body), sound: .default))
			} else {
				await activity.update(content)
			}
			return true
		}

		AsyncFunction("endActivity") { (activityId: String, stateJson: String?, options: [String: Any]?) -> Bool in
			guard #available(iOS 16.2, *), let activity = Self.find(activityId) else { return false }
			let state = try stateJson.map { try JSONDecoder().decode(VoltActivityAttributes.ContentState.self, from: Data($0.utf8)) }
			let dismissAt = Self.double(options?["dismissAt"])
			let policy: ActivityUIDismissalPolicy = dismissAt == nil ? .default : dismissAt! <= Date().timeIntervalSince1970 ? .immediate : .after(Date(timeIntervalSince1970: dismissAt!))
			await activity.end(state.map { ActivityContent(state: $0, staleDate: nil) }, dismissalPolicy: policy)
			self.observers.removeValue(forKey: activityId)?.cancel()
			return true
		}

		AsyncFunction("endAllActivities") { () -> Int in
			guard #available(iOS 16.2, *) else { return 0 }
			let all = Activity<VoltActivityAttributes>.activities
			for activity in all {
				await activity.end(nil, dismissalPolicy: .immediate)
			}
			return all.count
		}

		AsyncFunction("listActivities") { () -> [[String: Any]] in
			guard #available(iOS 16.2, *) else { return [] }
			return Activity<VoltActivityAttributes>.activities.map { activity in
				[
					"activityId": activity.id,
					"chatId": activity.attributes.chatId,
					"provider": activity.attributes.provider,
					"activityState": Self.name(activity.activityState),
					"state": (try? String(decoding: JSONEncoder().encode(activity.content.state), as: UTF8.self)) ?? NSNull(),
					"pushToken": activity.pushToken.map(Self.hex) ?? NSNull(),
				]
			}
		}

		AsyncFunction("getPushToken") { (activityId: String) -> String? in
			guard #available(iOS 16.2, *) else { return nil }
			return Self.find(activityId)?.pushToken.map(Self.hex)
		}

		AsyncFunction("getPushToStartToken") { () -> String? in
			guard #available(iOS 17.2, *) else { return nil }
			return Activity<VoltActivityAttributes>.pushToStartToken.map(Self.hex)
		}

		AsyncFunction("setWidgetData") { (json: String) -> Bool in
			try VoltWidgetStore.write(json: json)
		}

		AsyncFunction("readWidgetData") { () -> String? in
			guard let url = VoltWidgetStore.fileURL, let data = try? Data(contentsOf: url) else { return nil }
			return String(decoding: data, as: UTF8.self)
		}

		Function("reloadWidgets") {
			WidgetCenter.shared.reloadAllTimelines()
		}

		Function("setConnection") { (server: String?, token: String?) in
			VoltConnectionStore.save(server: server, token: token)
		}

		OnStartObserving {
			self.startObserving()
		}

		OnStopObserving {
			self.stopObserving()
		}

		OnDestroy {
			self.stopObserving()
		}
	}

	// MARK: Observation

	private func startObserving() {
		stopObserver = NotificationCenter.default.addObserver(forName: .voltWidgetsStopRequested, object: nil, queue: .main) { [weak self] note in
			self?.sendEvent("onStopRequested", [
				"chatId": note.userInfo?["chatId"] as? String ?? "",
				"handled": note.userInfo?["handled"] as? Bool ?? false,
			])
		}
		guard #available(iOS 16.2, *) else { return }
		for activity in Activity<VoltActivityAttributes>.activities {
			observe(activity)
		}
		// Activities started by a push-to-start arrive here; their tokens must reach the server.
		globalObservers.append(Task { [weak self] in
			for await activity in Activity<VoltActivityAttributes>.activityUpdates {
				self?.observe(activity)
				self?.sendEvent("onActivityState", ["activityId": activity.id, "chatId": activity.attributes.chatId, "state": Self.name(activity.activityState)])
			}
		})
		if #available(iOS 17.2, *) {
			globalObservers.append(Task { [weak self] in
				for await data in Activity<VoltActivityAttributes>.pushToStartTokenUpdates {
					self?.sendEvent("onPushToStartToken", ["token": Self.hex(data)])
				}
			})
		}
	}

	private func stopObserving() {
		if let stopObserver {
			NotificationCenter.default.removeObserver(stopObserver)
		}
		stopObserver = nil
		observers.values.forEach { $0.cancel() }
		observers.removeAll()
		globalObservers.forEach { $0.cancel() }
		globalObservers.removeAll()
	}

	@available(iOS 16.2, *)
	private func observe(_ activity: Activity<VoltActivityAttributes>) {
		guard observers[activity.id] == nil else { return }
		let id = activity.id
		let chatId = activity.attributes.chatId
		observers[id] = Task { [weak self] in
			await withTaskGroup(of: Void.self) { group in
				group.addTask {
					for await data in activity.pushTokenUpdates {
						self?.sendEvent("onPushToken", ["activityId": id, "chatId": chatId, "token": Self.hex(data)])
					}
				}
				group.addTask {
					for await state in activity.activityStateUpdates {
						self?.sendEvent("onActivityState", ["activityId": id, "chatId": chatId, "state": Self.name(state)])
					}
				}
			}
		}
	}

	// MARK: Helpers

	@available(iOS 16.2, *)
	private static func find(_ id: String) -> Activity<VoltActivityAttributes>? {
		Activity<VoltActivityAttributes>.activities.first { $0.id == id }
	}

	private static func hex(_ data: Data) -> String {
		data.map { String(format: "%02x", $0) }.joined()
	}

	private static func double(_ value: Any?) -> Double? {
		(value as? NSNumber)?.doubleValue
	}

	private static func date(_ value: Any?) -> Date? {
		double(value).map { Date(timeIntervalSince1970: $0) }
	}

	@available(iOS 16.1, *)
	private static func name(_ state: ActivityState) -> String {
		switch state {
		case .active: return "active"
		case .ended: return "ended"
		case .dismissed: return "dismissed"
		case .stale: return "stale"
		@unknown default: return "unknown"
		}
	}
}

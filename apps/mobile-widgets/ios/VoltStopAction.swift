// Copyright (c) Volt ADK. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

import ActivityKit
import Foundation

public extension Notification.Name {
	/// Posted in the app process when a Live Activity's Stop button ran (userInfo: chatId, handled).
	static let voltWidgetsStopRequested = Notification.Name("VoltWidgetsStopRequested")
}

/// What the Lock Screen's Stop button does, in the app's process (the LiveActivityIntent runs
/// there): shows "Stopping" at once, then cancels the turn on the agent server over its own
/// socket, the same `orchestrator.cancel(chatId, { cascade: 'turn' })` call every client makes.
public enum VoltStopAction {

	public static func run(chatId: String) async {
		await markStopping(chatId: chatId)
		var handled = false
		if let connection = VoltConnectionStore.load() {
			do {
				try await AgentServerCall.call(connection: connection, method: "orchestrator.cancel", params: [chatId, ["cascade": "turn"]])
				handled = true
			} catch {
				NSLog("[VoltWidgets] stop over the socket failed: \(error.localizedDescription)")
			}
		}
		await MainActor.run {
			NotificationCenter.default.post(name: .voltWidgetsStopRequested, object: nil, userInfo: ["chatId": chatId, "handled": handled])
		}
	}

	private static func markStopping(chatId: String) async {
		guard #available(iOS 16.2, *) else { return }
		for activity in Activity<VoltActivityAttributes>.activities where activity.attributes.chatId == chatId {
			var state = activity.content.state
			guard state.isActive else { continue }
			state.phase = "stopping"
			state.step = "Stopping"
			state.updatedAt = Date().timeIntervalSince1970
			await activity.update(ActivityContent(state: state, staleDate: activity.content.staleDate, relevanceScore: 75))
		}
	}
}

/// One call on the agent server's WebSocket protocol (src/vs/platform/voltAgentServer/common/protocol.ts):
/// `hello` → `welcome` → `call` → `ret`, then close.
enum AgentServerCall {

	struct Failure: LocalizedError {
		let message: String
		var errorDescription: String? { message }
	}

	static func call(connection: VoltConnectionStore.Connection, method: String, params: [Any], timeout: TimeInterval = 12) async throws {
		guard var components = URLComponents(string: connection.server) else {
			throw Failure(message: "Bad server address")
		}
		components.scheme = components.scheme == "https" ? "wss" : "ws"
		components.path = "/ws"
		components.fragment = nil
		guard let url = components.url else {
			throw Failure(message: "Bad server address")
		}
		let session = URLSession(configuration: .ephemeral)
		let task = session.webSocketTask(with: url)
		// The welcome carries a snapshot of every collection; it can be large.
		task.maximumMessageSize = 256 * 1024 * 1024
		task.resume()
		defer {
			task.cancel(with: .normalClosure, reason: nil)
			session.invalidateAndCancel()
		}
		try await withThrowingTaskGroup(of: Void.self) { group in
			group.addTask {
				let hello: [String: Any] = [
					"t": "hello",
					"protocol": 1,
					"token": connection.token,
					"client": ["kind": "mobile", "id": "volt-widgets-\(UUID().uuidString)", "topics": ["server"]],
				]
				try await task.send(.string(try json(hello)))
				try await waitFor(task) { $0["t"] as? String == "welcome" }
				try await task.send(.string(try json(["t": "call", "id": 1, "method": method, "params": params])))
				let ret = try await waitFor(task) { $0["t"] as? String == "ret" && ($0["id"] as? Int) == 1 }
				if (ret["ok"] as? Bool) != true {
					let error = ret["error"] as? [String: Any]
					throw Failure(message: (error?["message"] as? String) ?? "The server refused \(method)")
				}
			}
			group.addTask {
				try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
				throw Failure(message: "Timed out")
			}
			try await group.next()
			group.cancelAll()
		}
	}

	private static func json(_ object: [String: Any]) throws -> String {
		String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
	}

	@discardableResult
	private static func waitFor(_ task: URLSessionWebSocketTask, _ match: ([String: Any]) -> Bool) async throws -> [String: Any] {
		while true {
			let message = try await task.receive()
			let data: Data
			switch message {
			case .string(let text): data = Data(text.utf8)
			case .data(let bytes): data = bytes
			@unknown default: continue
			}
			if let frame = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], match(frame) {
				return frame
			}
		}
	}
}

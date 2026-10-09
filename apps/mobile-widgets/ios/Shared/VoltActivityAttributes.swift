// Copyright (c) Volt ADK. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

// The Live Activity's attributes and content state. Compiled twice: into the app's native module
// (which starts and updates activities) and into the widget extension (which draws them). ActivityKit
// matches the two by type name, and APNs push-to-start names it in `attributes-type`, so the name
// and the JSON keys must not change without changing src/model.ts and src/apns.ts.
//
// Decoding is lenient: a push from an older or newer server with a missing field still applies.

import ActivityKit
import Foundation

public struct VoltActivityAttributes: ActivityAttributes {

	public struct ContentState: Codable, Hashable {
		/// working | input | stopping | limited | done | failed | stopped
		public var phase: String
		public var title: String
		public var step: String
		/// Unix seconds.
		public var startedAt: Double
		public var endedAt: Double?
		public var filesChanged: Int
		public var queued: Int
		public var subagents: Int
		/// approval | question
		public var inputKind: String?
		public var inputPrompt: String?
		public var model: String?
		public var others: Int
		public var limitResetAt: Double?
		public var updatedAt: Double

		public init(phase: String, title: String, step: String, startedAt: Double, endedAt: Double? = nil, filesChanged: Int = 0, queued: Int = 0, subagents: Int = 0, inputKind: String? = nil, inputPrompt: String? = nil, model: String? = nil, others: Int = 0, limitResetAt: Double? = nil, updatedAt: Double) {
			self.phase = phase
			self.title = title
			self.step = step
			self.startedAt = startedAt
			self.endedAt = endedAt
			self.filesChanged = filesChanged
			self.queued = queued
			self.subagents = subagents
			self.inputKind = inputKind
			self.inputPrompt = inputPrompt
			self.model = model
			self.others = others
			self.limitResetAt = limitResetAt
			self.updatedAt = updatedAt
		}

		enum CodingKeys: String, CodingKey {
			case phase, title, step, startedAt, endedAt, filesChanged, queued, subagents, inputKind, inputPrompt, model, others, limitResetAt, updatedAt
		}

		public init(from decoder: Decoder) throws {
			let c = try decoder.container(keyedBy: CodingKeys.self)
			let now = Date().timeIntervalSince1970
			phase = try c.decodeIfPresent(String.self, forKey: .phase) ?? "working"
			title = try c.decodeIfPresent(String.self, forKey: .title) ?? "Volt"
			step = try c.decodeIfPresent(String.self, forKey: .step) ?? ""
			startedAt = try c.decodeIfPresent(Double.self, forKey: .startedAt) ?? now
			endedAt = try c.decodeIfPresent(Double.self, forKey: .endedAt)
			filesChanged = try c.decodeIfPresent(Int.self, forKey: .filesChanged) ?? 0
			queued = try c.decodeIfPresent(Int.self, forKey: .queued) ?? 0
			subagents = try c.decodeIfPresent(Int.self, forKey: .subagents) ?? 0
			inputKind = try c.decodeIfPresent(String.self, forKey: .inputKind)
			inputPrompt = try c.decodeIfPresent(String.self, forKey: .inputPrompt)
			model = try c.decodeIfPresent(String.self, forKey: .model)
			others = try c.decodeIfPresent(Int.self, forKey: .others) ?? 0
			limitResetAt = try c.decodeIfPresent(Double.self, forKey: .limitResetAt)
			updatedAt = try c.decodeIfPresent(Double.self, forKey: .updatedAt) ?? now
		}

		public var isActive: Bool { phase == "working" || phase == "input" || phase == "stopping" }
		public var startDate: Date { Date(timeIntervalSince1970: startedAt) }
		public var endDate: Date? { endedAt.map { Date(timeIntervalSince1970: $0) } }
	}

	public var chatId: String
	public var provider: String
	public var workspace: String?
	public var server: String?

	public init(chatId: String, provider: String, workspace: String? = nil, server: String? = nil) {
		self.chatId = chatId
		self.provider = provider
		self.workspace = workspace
		self.server = server
	}

	enum CodingKeys: String, CodingKey {
		case chatId, provider, workspace, server
	}

	public init(from decoder: Decoder) throws {
		let c = try decoder.container(keyedBy: CodingKeys.self)
		chatId = try c.decode(String.self, forKey: .chatId)
		provider = try c.decodeIfPresent(String.self, forKey: .provider) ?? "generic"
		workspace = try c.decodeIfPresent(String.self, forKey: .workspace)
		server = try c.decodeIfPresent(String.self, forKey: .server)
	}
}

/// Links the activity and widgets open (expo-router routes of the app).
public enum VoltLinks {
	public static var scheme: String {
		(Bundle.main.object(forInfoDictionaryKey: "VoltWidgetsURLScheme") as? String) ?? "volt"
	}

	public static func chat(_ chatId: String, action: String? = nil) -> URL {
		let id = chatId.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_.~"))) ?? chatId
		return URL(string: "\(scheme)://chat/\(id)\(action.map { "?action=\($0)" } ?? "")")!
	}

	public static var home: URL { URL(string: "\(scheme)://")! }
}

// Copyright (c) Volt ADK. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

import Foundation
import Security
import WidgetKit

/// The App Group file the widgets read, and the timeline reloads that follow a change.
enum VoltWidgetStore {

	static let fileName = "widget-snapshot.json"
	static let widgetKinds = ["VoltUsageWidget", "VoltAgentsWidget"]

	static var appGroup: String? {
		Bundle.main.object(forInfoDictionaryKey: "VoltWidgetsAppGroup") as? String
	}

	static var fileURL: URL? {
		guard let group = appGroup else { return nil }
		return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?.appendingPathComponent(fileName)
	}

	/// Writes the snapshot when it differs from what is there (ignoring `generatedAt`), then asks
	/// WidgetKit to reload. Returns whether anything changed.
	static func write(json: String) throws -> Bool {
		guard let url = fileURL else {
			throw NSError(domain: "VoltWidgets", code: 1, userInfo: [NSLocalizedDescriptionKey: "No App Group container. Is the VoltWidgetsAppGroup entitlement set?"])
		}
		guard let data = json.data(using: .utf8), (try? JSONSerialization.jsonObject(with: data)) != nil else {
			throw NSError(domain: "VoltWidgets", code: 2, userInfo: [NSLocalizedDescriptionKey: "Widget data is not JSON."])
		}
		if let existing = try? Data(contentsOf: url), fingerprint(existing) == fingerprint(data) {
			return false
		}
		try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
		WidgetCenter.shared.reloadAllTimelines()
		return true
	}

	private static func fingerprint(_ data: Data) -> Data? {
		guard var object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
		object.removeValue(forKey: "generatedAt")
		return try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
	}
}

/// The paired agent server, kept in the app's keychain so a Stop pressed on the Lock Screen can
/// reach the server even when the JavaScript side isn't running.
public enum VoltConnectionStore {

	private static let service = "dev.volt.widgets.connection"
	private static let account = "agent-server"

	public struct Connection: Codable {
		public let server: String
		public let token: String
	}

	public static func save(server: String?, token: String?) {
		let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
		SecItemDelete(query as CFDictionary)
		guard let server, let token, !server.isEmpty, !token.isEmpty, let data = try? JSONEncoder().encode(Connection(server: server, token: token)) else {
			return
		}
		var add = query
		add[kSecValueData as String] = data
		add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
		SecItemAdd(add as CFDictionary, nil)
	}

	public static func load() -> Connection? {
		let query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account,
			kSecReturnData as String: true,
			kSecMatchLimit as String: kSecMatchLimitOne,
		]
		var item: CFTypeRef?
		guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else {
			return nil
		}
		return try? JSONDecoder().decode(Connection.self, from: data)
	}
}

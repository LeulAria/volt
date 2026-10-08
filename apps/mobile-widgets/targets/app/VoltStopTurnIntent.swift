// Copyright (c) Volt ADK. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

// The Live Activity's Stop button. The config plugin compiles this file into BOTH the app target and
// the widget extension: the extension needs the type to draw `Button(intent:)`, and the system runs a
// LiveActivityIntent's `perform()` in the app's process, where the native module does the work.

import AppIntents
import Foundation
#if canImport(VoltMobileWidgets)
import VoltMobileWidgets
#endif

@available(iOS 17.0, *)
public struct VoltStopTurnIntent: LiveActivityIntent {

	public static var title: LocalizedStringResource = "Stop Agent"
	public static var description = IntentDescription("Stops the running turn of a Volt chat.")
	public static var isDiscoverable: Bool = false

	@Parameter(title: "Chat")
	public var chatId: String

	public init() {}

	public init(chatId: String) {
		self.chatId = chatId
	}

	public func perform() async throws -> some IntentResult {
		#if canImport(VoltMobileWidgets)
		await VoltStopAction.run(chatId: chatId)
		#endif
		return .result()
	}
}

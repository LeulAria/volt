// Copyright (c) Volt ADK. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

import SwiftUI
import WidgetKit

struct VoltUsageWidget: Widget {
	let kind = "VoltUsageWidget"

	var body: some WidgetConfiguration {
		StaticConfiguration(kind: kind, provider: VoltTimelineProvider(preview: nil)) { entry in
			UsageWidgetView(entry: entry)
		}
		.configurationDisplayName("Usage")
		.description("Your agents' limits, with when each one resets.")
		.supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
	}
}

struct VoltAgentsWidget: Widget {
	let kind = "VoltAgentsWidget"

	var body: some WidgetConfiguration {
		StaticConfiguration(kind: kind, provider: VoltTimelineProvider(preview: nil)) { entry in
			AgentsWidgetView(entry: entry)
		}
		.configurationDisplayName("Agents")
		.description("Chats that are working or waiting for you.")
		.supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
	}
}

@main
struct VoltWidgetBundle: WidgetBundle {
	var body: some Widget {
		VoltUsageWidget()
		VoltAgentsWidget()
		VoltAgentLiveActivity()
	}
}

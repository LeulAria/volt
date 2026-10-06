/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	VOLT_STALL_THRESHOLD_DEFAULT, VOLT_STALL_THRESHOLD_SETTING, VOLT_TRACING_DEFAULT_ENDPOINT, VOLT_TRACING_ENABLED_SETTING,
	VOLT_TRACING_ENDPOINT_SETTING, VOLT_TRACING_HEADERS_SETTING, VOLT_TRACING_SAMPLE_RATE_SETTING,
} from '../../../../platform/voltDiagnostics/common/voltDiagnostics.js';

// Application scope: the main process reads these from the user settings file, not per workspace.
Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'volt.diagnostics',
	title: localize('voltDiagnostics.configTitle', "Volt Diagnostics"),
	type: 'object',
	properties: {
		[VOLT_TRACING_ENABLED_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('voltDiagnostics.tracingEnabled', "Send OpenTelemetry traces (agent turns and their tool calls, window startup, git operations, update checks, event-loop stalls) to the OTLP/HTTP collector in `#volt.tracing.otlpEndpoint#`. Nothing is sent while this is off. Traces include tool titles and file paths, never prompts or replies."),
		},
		[VOLT_TRACING_ENDPOINT_SETTING]: {
			type: 'string',
			default: VOLT_TRACING_DEFAULT_ENDPOINT,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('voltDiagnostics.tracingEndpoint', "Base URL of the OTLP/HTTP collector. Spans are posted as JSON to `{endpoint}/v1/traces`."),
		},
		[VOLT_TRACING_HEADERS_SETTING]: {
			type: 'object',
			default: {},
			additionalProperties: { type: 'string' },
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('voltDiagnostics.tracingHeaders', "Extra HTTP headers sent with every export, for example an API key: `{ \"x-honeycomb-team\": \"...\" }`."),
		},
		[VOLT_TRACING_SAMPLE_RATE_SETTING]: {
			type: 'number',
			default: 1,
			minimum: 0,
			maximum: 1,
			scope: ConfigurationScope.APPLICATION,
			description: localize('voltDiagnostics.tracingSampleRate', "Share of traces to keep, from 0 to 1. Spans inside a kept trace (the tool calls of an agent turn) are always kept with it."),
		},
		[VOLT_STALL_THRESHOLD_SETTING]: {
			type: 'number',
			default: VOLT_STALL_THRESHOLD_DEFAULT,
			minimum: 0,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('voltDiagnostics.stallThreshold', "Log main-process and window event-loop stalls at least this many milliseconds long to the Volt Diagnostics output, with what was running when known. `0` turns it off. Values under 50 count as 50."),
		},
	},
});

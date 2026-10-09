/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, getWindow } from '../../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { VoltUsageProvider } from '../../../../../platform/voltUsage/common/voltUsage.js';
import { voltCharts, voltChartStrings } from '../visuals/agentVisuals.js';
import type { IVoltChartsHandle } from '../visuals/voltChartsRuntime.js';
import { usageChartSpec } from './agentUsageInsights.js';
import { IUsageSummary, UsageMetric } from './agentUsageModel.js';

/** Plot height of the main chart; the agents list sits beside it. */
const CHART_HEIGHT = 280;

export interface IUsageChartSeriesStyle {
	readonly label: string;
	/** CSS color, may be a `var()`. */
	readonly color: string;
}

/**
 * Usage over the range, one thin line per agent over a faint fill, drawn by Volt Charts (the
 * engine agent visuals use): a crosshair and tooltip on hover, arrow keys to read days, and the
 * busiest day marked when one agent did all the work.
 */
export class UsageChart extends Disposable {

	readonly element: HTMLElement;
	private handle: IVoltChartsHandle | undefined;

	constructor(parent: HTMLElement) {
		super();
		this.element = append(parent, $('.volt-usage-chart.engine'));
		this._register(toDisposable(() => this.handle?.dispose()));
	}

	update(summary: IUsageSummary, metric: UsageMetric, styles: ReadonlyMap<VoltUsageProvider, IUsageChartSeriesStyle>, animate: boolean): void {
		const spec = usageChartSpec(summary, metric, styles, CHART_HEIGHT);
		if (this.handle) {
			this.handle.update(spec, animate);
			return;
		}
		this.handle = voltCharts(getWindow(this.element)).render(this.element, spec, { strings: voltChartStrings(), animate });
	}

	layout(): void {
		this.handle?.layout();
	}
}

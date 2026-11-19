import { BaseRule } from './base.ts';

export class PercentOff extends BaseRule {
	private readonly percent: number;

	constructor(percent: number) {
		super('percent-off');
		this.percent = percent;
	}

	apply(total: number): number {
		return this.clamp(total * (1 - this.percent / 100));
	}
}

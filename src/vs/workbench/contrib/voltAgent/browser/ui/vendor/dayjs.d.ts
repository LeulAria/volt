/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Types for the vendored dayjs bundle (only what Volt uses).

export type DayjsUnit = 'millisecond' | 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year' | 'date';

export interface Dayjs {
	isValid(): boolean;
	valueOf(): number;
	toDate(): Date;
	year(): number;
	month(): number;
	/** Day of the month, 1-31. */
	date(): number;
	/** Day of the week, 0 (Sunday) - 6. */
	day(): number;
	hour(): number;
	minute(): number;
	daysInMonth(): number;
	year(value: number): Dayjs;
	month(value: number): Dayjs;
	date(value: number): Dayjs;
	hour(value: number): Dayjs;
	minute(value: number): Dayjs;
	second(value: number): Dayjs;
	millisecond(value: number): Dayjs;
	add(value: number, unit: DayjsUnit): Dayjs;
	subtract(value: number, unit: DayjsUnit): Dayjs;
	startOf(unit: DayjsUnit): Dayjs;
	endOf(unit: DayjsUnit): Dayjs;
	isSame(other: Dayjs | number | Date, unit?: DayjsUnit): boolean;
	isBefore(other: Dayjs | number | Date, unit?: DayjsUnit): boolean;
	isAfter(other: Dayjs | number | Date, unit?: DayjsUnit): boolean;
	diff(other: Dayjs | number | Date, unit?: DayjsUnit): number;
	format(template?: string): string;
}

declare function dayjs(input?: Dayjs | number | Date | string): Dayjs;

export default dayjs;

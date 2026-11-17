export type Region = 'eu' | 'us' | 'none';

const RATES: Record<Region, number> = {
	eu: 0.2,
	us: 0.07,
	none: 0,
};

export function roundCents(value: number): number {
	return Math.round(value * 100) / 100;
}

export function computeTax(amount: number, region: Region): number {
	return roundCents(amount * RATES[region]);
}

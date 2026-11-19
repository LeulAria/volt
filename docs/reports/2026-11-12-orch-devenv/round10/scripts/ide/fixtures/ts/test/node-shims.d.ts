declare module 'node:test' {
	export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
	const assert: { equal(actual: unknown, expected: unknown): void };
	export default assert;
}

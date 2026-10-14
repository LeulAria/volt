// The shared core is Volt's own code (src/vs), written for browsers and Node. Before it loads,
// give React Native the few globals it reads at import time.
import * as Crypto from 'expo-crypto';

const g = globalThis as Record<string, unknown>;

if (typeof g.crypto !== 'object' || g.crypto === null) {
	g.crypto = {};
}
const cryptoLike = g.crypto as { getRandomValues?: unknown; randomUUID?: unknown };
cryptoLike.getRandomValues ??= <T extends ArrayBufferView>(array: T): T => Crypto.getRandomValues(array as never) as T;
cryptoLike.randomUUID ??= () => Crypto.randomUUID();

// base/common/platform reads the user agent, language and touch points from navigator.
const nav = (g.navigator ?? (g.navigator = {})) as Record<string, unknown>;
nav.userAgent ??= 'VoltMobile (iPhone; ReactNative)';
nav.language ??= 'en-US';
nav.maxTouchPoints ??= 5;

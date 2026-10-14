// Pairing links, as T3 Code's mobile app reads them (apps/mobile/src/features/connection/pairing.ts,
// MIT, T3 Tools Inc.): `http://host:port/#token=CODE`, the URL Volt shows and the web app opens.

export interface IPairing {
	/** `http://host:port`, no trailing slash. */
	readonly server: string;
	readonly token: string;
}

function isIpLiteral(host: string): boolean {
	try {
		const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '');
		if (hostname.includes(':')) {
			return true;
		}
		const octets = hostname.split('.');
		return octets.length === 4 && octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
	} catch {
		return false;
	}
}

/** The server and token in a pairing link, a `volt://pair?url=…` deep link, or a scanned QR code. */
export function parsePairingUrl(input: string): IPairing | undefined {
	let trimmed = input.trim();
	if (!trimmed) {
		return undefined;
	}
	try {
		if (/^volt:/i.test(trimmed)) {
			const inner = new URL(trimmed).searchParams.get('url');
			if (!inner) {
				return undefined;
			}
			trimmed = inner;
		}
		const parsed = new URL(trimmed.includes('://') ? trimmed : `${isIpLiteral(trimmed.split(/[/#]/)[0]) ? 'http' : 'https'}://${trimmed}`);
		const token = new URLSearchParams(parsed.hash.slice(1)).get('token') || parsed.searchParams.get('token') || '';
		if (!token) {
			return undefined;
		}
		return { server: `${parsed.protocol}//${parsed.host}`, token };
	} catch {
		return undefined;
	}
}

export function webSocketUrl(server: string): string {
	return `${server.replace(/^http/i, 'ws')}/ws`;
}

/** The web app's thread view, alone, for the transcript web view. */
export function embedUrl(pairing: IPairing, chat: string | undefined): string {
	const hash = new URLSearchParams({ token: pairing.token, ...(chat ? { chat } : {}) });
	return `${pairing.server}/?embed=thread#${hash.toString()}`;
}

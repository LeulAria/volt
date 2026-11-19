/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * "Pretty" for response bodies: JSON re-indented, and minified HTML, XML, CSS and JavaScript put
 * back on lines with indentation, so a page that arrives as one line can be read. These are
 * readers' formatters, not compilers: they only add line breaks and indentation between tokens,
 * never inside strings, comments or regular expressions, and anything they cannot make sense of
 * comes back as it was.
 */

export type HttpPrettyLanguage = 'json' | 'xml' | 'html' | 'javascript' | 'css' | 'plaintext';

const INDENT = '  ';
/** Past this the formatters' output would be slower to show than it is useful. */
const MAX_PRETTY_CHARS = 2_000_000;

/** What a body looks like when its content type does not say (or says something generic). */
export function detectHttpBodyLanguage(contentType: string, body: string): HttpPrettyLanguage {
	const type = contentType.toLowerCase();
	const start = body.slice(0, 400).trimStart().toLowerCase();
	if (/json/.test(type)) {
		return 'json';
	}
	if (/html/.test(type) || start.startsWith('<!doctype html') || start.startsWith('<html')) {
		return 'html';
	}
	if (/xml|svg/.test(type) || start.startsWith('<?xml')) {
		return 'xml';
	}
	if (/javascript|ecmascript/.test(type)) {
		return 'javascript';
	}
	if (/css/.test(type)) {
		return 'css';
	}
	if (start.startsWith('{') || start.startsWith('[')) {
		return 'json';
	}
	return start.startsWith('<') && /<\/[a-z][\w:-]*\s*>\s*$/i.test(body.slice(-200)) ? 'xml' : 'plaintext';
}

/** `text` formatted for reading as `language`; `text` itself when it cannot be. */
export function prettyHttpBody(text: string, language: HttpPrettyLanguage): string {
	if (!text.trim() || text.length > MAX_PRETTY_CHARS) {
		return text;
	}
	try {
		switch (language) {
			case 'json': return JSON.stringify(JSON.parse(text), null, 2);
			case 'html': return prettyMarkup(text, true);
			case 'xml': return prettyMarkup(text, false);
			case 'css': return prettyCss(text);
			case 'javascript': return prettyJavaScript(text);
			default: return text;
		}
	} catch {
		return text;
	}
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** Elements whose text is kept exactly: whitespace means something in them. */
const VERBATIM_TAGS = new Set(['pre', 'textarea']);

interface IMarkupToken {
	readonly kind: 'open' | 'close' | 'self' | 'text' | 'other';
	readonly text: string;
	readonly name: string;
}

/** The end of the tag that opens at `from`: the first `>` outside a quoted attribute value. */
function tagEnd(text: string, from: number): number {
	let quote = '';
	for (let at = from; at < text.length; at++) {
		const char = text[at];
		if (quote) {
			if (char === quote) {
				quote = '';
			}
		} else if (char === '"' || char === '\'') {
			quote = char;
		} else if (char === '>') {
			return at;
		}
	}
	return -1;
}

function markupTokens(text: string, html: boolean): IMarkupToken[] {
	const tokens: IMarkupToken[] = [];
	let at = 0;
	while (at < text.length) {
		const open = text.indexOf('<', at);
		if (open < 0) {
			tokens.push({ kind: 'text', text: text.slice(at), name: '' });
			break;
		}
		if (open > at) {
			tokens.push({ kind: 'text', text: text.slice(at, open), name: '' });
		}
		if (text.startsWith('<!--', open)) {
			const end = text.indexOf('-->', open + 4);
			const stop = end < 0 ? text.length : end + 3;
			tokens.push({ kind: 'other', text: text.slice(open, stop), name: '' });
			at = stop;
			continue;
		}
		if (text.startsWith('<![CDATA[', open)) {
			const end = text.indexOf(']]>', open);
			const stop = end < 0 ? text.length : end + 3;
			tokens.push({ kind: 'other', text: text.slice(open, stop), name: '' });
			at = stop;
			continue;
		}
		const end = tagEnd(text, open + 1);
		if (end < 0 || !/[a-zA-Z/!?]/.test(text[open + 1] ?? '')) {
			// A lone `<` in text.
			tokens.push({ kind: 'text', text: text.slice(open, open + 1), name: '' });
			at = open + 1;
			continue;
		}
		const tag = text.slice(open, end + 1);
		at = end + 1;
		if (tag[1] === '!' || tag[1] === '?') {
			tokens.push({ kind: 'other', text: tag, name: '' });
			continue;
		}
		const name = (/^<\/?\s*([^\s/>]+)/.exec(tag)?.[1] ?? '');
		const lower = html ? name.toLowerCase() : name;
		if (tag[1] === '/') {
			tokens.push({ kind: 'close', text: tag, name: lower });
			continue;
		}
		const selfClosing = tag.endsWith('/>') || (html && VOID_TAGS.has(lower));
		tokens.push({ kind: selfClosing ? 'self' : 'open', text: tag, name: lower });
		// A script's or style's text is not markup: up to its closing tag it is one piece.
		if (html && !selfClosing && (lower === 'script' || lower === 'style' || VERBATIM_TAGS.has(lower))) {
			const close = new RegExp(`</${lower}\\s*>`, 'i').exec(text.slice(at));
			const stop = close ? at + close.index : text.length;
			if (stop > at) {
				tokens.push({ kind: 'text', text: text.slice(at, stop), name: lower });
			}
			at = stop;
		}
	}
	return tokens;
}

function prettyMarkup(text: string, html: boolean): string {
	const tokens = markupTokens(text, html);
	const lines: string[] = [];
	let depth = 0;
	const pad = () => INDENT.repeat(Math.max(0, depth));
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		switch (token.kind) {
			case 'open': {
				// `<title>Google</title>`: a short text between its tags stays on their line.
				const next = tokens[index + 1];
				const after = tokens[index + 2];
				if (next?.kind === 'text' && !next.name && after?.kind === 'close' && after.name === token.name) {
					const inner = next.text.trim().replace(/\s+/g, ' ');
					if (inner.length + token.text.length < 100) {
						lines.push(`${pad()}${token.text}${inner}${after.text}`);
						index += 2;
						break;
					}
				}
				if (next?.kind === 'close' && next.name === token.name) {
					lines.push(`${pad()}${token.text}${next.text}`);
					index += 1;
					break;
				}
				lines.push(`${pad()}${token.text}`);
				depth++;
				break;
			}
			case 'close':
				depth = Math.max(0, depth - 1);
				lines.push(`${pad()}${token.text}`);
				break;
			case 'self':
			case 'other':
				lines.push(`${pad()}${token.text}`);
				break;
			case 'text': {
				if (VERBATIM_TAGS.has(token.name)) {
					lines.push(token.text);
					break;
				}
				if (!token.text.trim()) {
					break;
				}
				if (token.name === 'script' || token.name === 'style') {
					const inner = token.name === 'style' ? prettyCss(token.text) : prettyScriptText(token.text);
					lines.push(...inner.split('\n').map(line => line ? `${pad()}${line}` : line));
					break;
				}
				lines.push(...token.text.trim().split(/\s*\n\s*/).map(line => `${pad()}${line}`));
				break;
			}
		}
	}
	return lines.join('\n');
}

/** A script element's text: formatted as JavaScript unless it is data (JSON, a template). */
function prettyScriptText(text: string): string {
	const trimmed = text.trim();
	if (/^[[{]/.test(trimmed)) {
		try {
			return JSON.stringify(JSON.parse(trimmed), null, 2);
		} catch { /* not JSON: code that starts with a brace */ }
	}
	return prettyJavaScript(trimmed);
}

/** The index after the string or comment that starts at `at`, or `at` when none does. */
function skipCssQuiet(text: string, at: number): number {
	const char = text[at];
	if (char === '"' || char === '\'') {
		let end = at + 1;
		while (end < text.length && text[end] !== char) {
			end += text[end] === '\\' ? 2 : 1;
		}
		return Math.min(text.length, end + 1);
	}
	if (char === '/' && text[at + 1] === '*') {
		const end = text.indexOf('*/', at + 2);
		return end < 0 ? text.length : end + 2;
	}
	return at;
}

function prettyCss(text: string): string {
	const lines: string[] = [];
	let depth = 0;
	let current = '';
	let parens = 0;
	const flush = (suffix = '') => {
		const line = `${current.trim()}${suffix}`;
		if (line) {
			lines.push(`${INDENT.repeat(Math.max(0, depth))}${line}`);
		}
		current = '';
	};
	for (let at = 0; at < text.length;) {
		const quiet = skipCssQuiet(text, at);
		if (quiet > at) {
			current += text.slice(at, quiet);
			at = quiet;
			continue;
		}
		const char = text[at++];
		if (char === '(') {
			parens++;
		} else if (char === ')') {
			parens = Math.max(0, parens - 1);
		}
		if (parens) {
			// `url(data:...;base64,...)` and `:is(a, b)` are one piece.
			current += char;
		} else if (char === '{') {
			current = `${current.trim()} {`;
			flush();
			depth++;
		} else if (char === '}') {
			flush(current.trim() && !current.trim().endsWith(';') ? ';' : '');
			depth = Math.max(0, depth - 1);
			lines.push(`${INDENT.repeat(depth)}}`);
		} else if (char === ';') {
			flush(';');
		} else if (char === '\n' || char === '\r') {
			current += ' ';
		} else {
			current += char;
		}
	}
	flush();
	return lines.join('\n');
}

const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_AFTER_WORDS = /(?:^|[^\w$.])(?:return|typeof|case|do|else|in|of|void|delete|throw|new|yield|await)$/;

/** The index after the string, template, comment or regular expression that starts at `at`, or `at`. */
function skipJsQuiet(text: string, at: number, before: string): number {
	const char = text[at];
	if (char === '"' || char === '\'') {
		let end = at + 1;
		while (end < text.length && text[end] !== char && text[end] !== '\n') {
			end += text[end] === '\\' ? 2 : 1;
		}
		return Math.min(text.length, end + 1);
	}
	if (char === '`') {
		let end = at + 1;
		let nested = 0;
		while (end < text.length) {
			if (text[end] === '\\') {
				end += 2;
				continue;
			}
			if (text[end] === '$' && text[end + 1] === '{') {
				nested++;
				end += 2;
				continue;
			}
			if (nested && text[end] === '}') {
				nested--;
			} else if (!nested && text[end] === '`') {
				break;
			}
			end++;
		}
		return Math.min(text.length, end + 1);
	}
	if (char !== '/') {
		return at;
	}
	if (text[at + 1] === '/') {
		const end = text.indexOf('\n', at);
		return end < 0 ? text.length : end;
	}
	if (text[at + 1] === '*') {
		const end = text.indexOf('*/', at + 2);
		return end < 0 ? text.length : end + 2;
	}
	// A regular expression where a value may start; a division anywhere else.
	const trimmed = before.trimEnd();
	const last = trimmed[trimmed.length - 1];
	if (last !== undefined && !REGEX_AFTER.has(last) && !REGEX_AFTER_WORDS.test(trimmed)) {
		return at;
	}
	let end = at + 1;
	let inClass = false;
	while (end < text.length && text[end] !== '\n') {
		if (text[end] === '\\') {
			end += 2;
			continue;
		}
		if (text[end] === '[') {
			inClass = true;
		} else if (text[end] === ']') {
			inClass = false;
		} else if (text[end] === '/' && !inClass) {
			end++;
			while (/[a-z]/i.test(text[end] ?? '')) {
				end++;
			}
			return end;
		}
		end++;
	}
	return at;
}

function prettyJavaScript(text: string): string {
	const lines: string[] = [];
	let depth = 0;
	let current = '';
	let parens = 0;
	const flush = () => {
		const line = current.trim();
		if (line) {
			lines.push(`${INDENT.repeat(Math.max(0, depth))}${line}`);
		}
		current = '';
	};
	for (let at = 0; at < text.length;) {
		const quiet = skipJsQuiet(text, at, current || (lines[lines.length - 1] ?? ''));
		if (quiet > at) {
			const piece = text.slice(at, quiet);
			current += piece;
			at = quiet;
			if (piece.startsWith('//')) {
				flush();
			}
			continue;
		}
		const char = text[at++];
		if (char === '(' || char === '[') {
			parens++;
			current += char;
		} else if (char === ')' || char === ']') {
			parens = Math.max(0, parens - 1);
			current += char;
		} else if (char === '{') {
			current += '{';
			if (text[at] === '}') {
				// `{}` stays as it is.
				current += '}';
				at++;
				continue;
			}
			flush();
			depth++;
			// Inside a block the brackets around it no longer hold `;` back.
			parens = 0;
		} else if (char === '}') {
			flush();
			depth = Math.max(0, depth - 1);
			current = '}';
			// `})`, `},`, `};` and `} else {` continue the closing line.
			const rest = /^\s*(?:[),;.\]]|else\b|catch\b|finally\b|while\b)/.exec(text.slice(at, at + 24));
			if (!rest) {
				flush();
			}
		} else if (char === ';' && !parens) {
			current += ';';
			flush();
		} else if (char === '\n' || char === '\r') {
			if (current.trim()) {
				flush();
			}
		} else {
			current += char;
		}
	}
	flush();
	return lines.join('\n');
}

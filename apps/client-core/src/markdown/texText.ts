/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Inline math as plain Unicode text, for views that draw native text (a phone's reply is one
 * attributed string, so a formula inside a sentence can't be a web view). Covers what replies use
 * inline: Greek letters, operators, arrows, sub/superscripts, \frac, \sqrt, \text and font
 * commands. Display math is typeset properly elsewhere.
 */

const SYMBOLS: Record<string, string> = {
	alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
	lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ',
	chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
	sum: '∑', prod: '∏', int: '∫', iint: '∬', oint: '∮', partial: '∂', nabla: '∇', infty: '∞', emptyset: '∅', varnothing: '∅',
	times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆', circ: '∘', bullet: '•', oplus: '⊕', otimes: '⊗',
	leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', cong: '≅', propto: '∝', ll: '≪', gg: '≫',
	in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', setminus: '∖',
	forall: '∀', exists: '∃', nexists: '∄', neg: '¬', lnot: '¬', land: '∧', wedge: '∧', lor: '∨', vee: '∨', top: '⊤', bot: '⊥',
	to: '→', rightarrow: '→', leftarrow: '←', gets: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', implies: '⟹', iff: '⟺', mapsto: '↦',
	uparrow: '↑', downarrow: '↓', ldots: '…', cdots: '⋯', dots: '…', vdots: '⋮', ddots: '⋱', prime: '′', degree: '°', angle: '∠', perp: '⊥', parallel: '∥',
	hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', langle: '⟨', rangle: '⟩', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋', mid: '∣',
	quad: ' ', qquad: '  ', ',': ' ', ';': ' ', ':': ' ', '!': '', ' ': ' ', '{': '{', '}': '}', '%': '%', '$': '$', '#': '#', '&': '&', '_': '_',
	lbrace: '{', rbrace: '}', vert: '|', Vert: '‖', backslash: '\\',
	N: 'ℕ', Z: 'ℤ', Q: 'ℚ', R: 'ℝ', C: 'ℂ',
};

const NAMED_FUNCTIONS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg', 'exp', 'lim', 'liminf', 'limsup', 'max', 'min', 'sup', 'inf', 'det', 'gcd', 'deg', 'dim', 'ker', 'arg', 'Pr', 'mod', 'bmod']);

const DOUBLE_STRUCK: Record<string, string> = { N: 'ℕ', Z: 'ℤ', Q: 'ℚ', R: 'ℝ', C: 'ℂ', P: 'ℙ', H: 'ℍ', E: '𝔼' };

const SUPERSCRIPT: Record<string, string> = {
	'0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
	a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ',
	u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ', T: 'ᵀ', '′': '′', '*': '*',
};

const SUBSCRIPT: Record<string, string> = {
	'0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎',
	a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
};

/** `x` as a sub/superscript when every character has one, else `^(x)` / `_(x)`. */
function script(text: string, table: Record<string, string>, mark: '^' | '_'): string {
	const chars = [...text.replace(/\s+/g, '')];
	if (chars.length && chars.every(ch => table[ch] !== undefined)) {
		return chars.map(ch => table[ch]).join('');
	}
	return chars.length === 1 ? `${mark}${text}` : `${mark}(${text})`;
}

class Reader {
	i = 0;
	readonly s: string;

	constructor(s: string) {
		this.s = s;
	}

	/** One argument: a `{group}`, a `\command` or one character. */
	argument(): string {
		this.skipSpaces();
		const ch = this.s[this.i];
		if (ch === undefined) {
			return '';
		}
		if (ch === '{') {
			return this.group();
		}
		if (ch === '\\') {
			return this.command();
		}
		this.i++;
		return ch;
	}

	/** Raw text of a `{group}` (for \text), braces dropped. */
	rawGroup(): string {
		this.skipSpaces();
		if (this.s[this.i] !== '{') {
			return this.argument();
		}
		let depth = 0;
		const start = this.i + 1;
		for (; this.i < this.s.length; this.i++) {
			if (this.s[this.i] === '{') {
				depth++;
			} else if (this.s[this.i] === '}' && --depth === 0) {
				return this.s.slice(start, this.i++);
			}
		}
		return this.s.slice(start);
	}

	group(): string {
		this.i++;
		const out = this.until('}');
		this.i++;
		return out;
	}

	skipSpaces(): void {
		while (this.s[this.i] === ' ') {
			this.i++;
		}
	}

	command(): string {
		this.i++;
		const match = /^(?:[a-zA-Z]+|.)/.exec(this.s.slice(this.i));
		const name = match?.[0] ?? '';
		this.i += name.length;
		switch (name) {
			case 'frac': case 'dfrac': case 'tfrac': {
				const top = this.argument();
				const bottom = this.argument();
				const wrap = (x: string) => /^[\w.′]+$/u.test(x) ? x : `(${x})`;
				return `${wrap(top)}⁄${wrap(bottom)}`;
			}
			case 'sqrt': {
				let degree = '';
				if (this.s[this.i] === '[') {
					const close = this.s.indexOf(']', this.i);
					degree = this.s.slice(this.i + 1, close < 0 ? undefined : close);
					this.i = close < 0 ? this.s.length : close + 1;
				}
				const body = this.argument();
				const root = degree === '3' ? '∛' : degree === '4' ? '∜' : `${degree ? script(degree, SUPERSCRIPT, '^') : ''}√`;
				return /^[\w.]+$/u.test(body) ? `${root}${body}` : `${root}(${body})`;
			}
			case 'text': case 'textrm': case 'textit': case 'textbf': case 'mathrm': case 'operatorname': case 'textsf': case 'texttt':
				return this.rawGroup();
			case 'mathbf': case 'boldsymbol': case 'mathit': case 'mathsf': case 'mathtt': case 'mathcal': case 'mathscr': case 'mathfrak': case 'bm':
				return this.argument();
			case 'mathbb': {
				const arg = this.argument();
				return [...arg].map(ch => DOUBLE_STRUCK[ch] ?? ch).join('');
			}
			case 'left': case 'right': case 'big': case 'Big': case 'bigg': case 'Bigg': case 'bigl': case 'bigr': case 'Bigl': case 'Bigr': case 'displaystyle': case 'limits': case 'nolimits':
				return '';
			case 'hat': return `${this.argument()}̂`;
			case 'bar': case 'overline': return `${this.argument()}̅`;
			case 'vec': return `${this.argument()}⃗`;
			case 'dot': return `${this.argument()}̇`;
			case 'tilde': return `${this.argument()}̃`;
			case 'not': return `${this.argument()}̸`;
		}
		if (NAMED_FUNCTIONS.has(name)) {
			return name === 'bmod' || name === 'mod' ? ' mod ' : name;
		}
		return SYMBOLS[name] ?? name;
	}

	until(stop: string | undefined): string {
		let out = '';
		while (this.i < this.s.length && this.s[this.i] !== stop) {
			const ch = this.s[this.i];
			if (ch === '\\') {
				const word = this.command();
				// A named operator runs into the next letter without a space ("\sin x" → "sin x").
				out += word && /^[a-zA-Z]+$/.test(word) && /^ *[a-zA-Z0-9]/.test(this.s.slice(this.i)) ? `${word} ` : word;
			} else if (ch === '^' || ch === '_') {
				this.i++;
				const arg = this.argument();
				out += script(arg, ch === '^' ? SUPERSCRIPT : SUBSCRIPT, ch);
			} else if (ch === '{') {
				out += this.group();
			} else if (ch === '~') {
				out += ' ';
				this.i++;
			} else if (ch === '-') {
				out += '−';
				this.i++;
			} else if (ch === '*') {
				out += '∗';
				this.i++;
			} else if (ch === "'") {
				out += '′';
				this.i++;
			} else {
				out += ch;
				this.i++;
			}
		}
		return out;
	}
}

/** `e^{i\pi} + 1 = 0` → `eⁱᵖ + 1 = 0`-style text; never throws. */
export function texToText(tex: string): string {
	try {
		return new Reader(tex.trim()).until(undefined).replace(/ {2,}/g, ' ');
	} catch {
		return tex;
	}
}

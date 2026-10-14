/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The web app bundles these (the window loads them through its own loader).
// eslint-disable-next-line local/code-amd-node-module
import * as oniguruma from 'vscode-oniguruma';
// eslint-disable-next-line local/code-amd-node-module
import * as textmate from 'vscode-textmate';
import { Color } from '../../../../base/common/color.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { EncodedTokenizationResult, IState, ITokenizationSupport, LazyTokenizationSupport, TokenizationRegistry, TokenizationResult } from '../../../../editor/common/languages.js';
import { ILanguageExtensionPoint, ILanguageService } from '../../../../editor/common/languages/language.js';
import { ModesRegistry } from '../../../../editor/common/languages/modesRegistry.js';

interface IGrammarContribution {
	readonly language?: string;
	readonly scopeName: string;
	readonly file: string;
	readonly embeddedLanguages?: Record<string, string>;
	readonly injectTo?: string[];
	readonly tokenTypes?: Record<string, string>;
}

interface ILanguagesManifest {
	readonly languages: readonly ILanguageExtensionPoint[];
	readonly grammars: readonly IGrammarContribution[];
}

interface IThemeManifest {
	readonly tokenColors: textmate.IRawTheme['settings'];
	readonly colorMap: string[];
}

/** One line's tokenizer for a TextMate grammar, in the editor's encoded format. */
/** Foreground color bits of an encoded token (the editor's and vscode-textmate's layout). */
const FOREGROUND_MASK = 0b00000000_11111111_10000000_00000000;
const FOREGROUND_OFFSET = 15;

class TextMateTokenizationSupport implements ITokenizationSupport, IDisposable {

	/** `colorIds[textmateId]` is the agent window's id for the same color. */
	constructor(private readonly grammar: textmate.IGrammar, private readonly colorIds: Uint16Array) { }

	dispose(): void { }

	getInitialState(): IState {
		return textmate.INITIAL as unknown as IState;
	}

	tokenize(): TokenizationResult {
		throw new Error('Not supported');
	}

	tokenizeEncoded(line: string, _hasEOL: boolean, state: IState): EncodedTokenizationResult {
		const result = this.grammar.tokenizeLine2(line, state as unknown as textmate.StateStack, 500);
		const tokens = result.tokens;
		for (let i = 1; i < tokens.length; i += 2) {
			const metadata = tokens[i];
			const color = this.colorIds[(metadata & FOREGROUND_MASK) >>> FOREGROUND_OFFSET] ?? 1;
			tokens[i] = ((metadata & ~FOREGROUND_MASK) | (color << FOREGROUND_OFFSET)) >>> 0;
		}
		return new EncodedTokenizationResult(tokens, result.ruleStack as unknown as IState);
	}
}

/**
 * Code cards in the web app are tokenized the way the agent window does it: the built-in
 * extensions' languages and TextMate grammars, and the desktop theme's color map, so the
 * `mtkN` classes (styled by the captured theme CSS) come out the same.
 */
export async function setUpWebTokenization(languageService: ILanguageService): Promise<IDisposable> {
	const store = new DisposableStore();
	const [manifest, theme, wasm] = await Promise.all([
		fetch('/languages.json').then(res => res.json() as Promise<ILanguagesManifest>),
		fetch('/theme.json').then(res => res.json() as Promise<IThemeManifest>),
		fetch('/onig.wasm').then(res => res.arrayBuffer()),
	]);
	await oniguruma.loadWASM(wasm);
	for (const language of manifest.languages) {
		store.add(ModesRegistry.registerLanguage(language));
	}
	const byScope = new Map(manifest.grammars.map(grammar => [grammar.scopeName, grammar]));
	const injections = new Map<string, string[]>();
	for (const grammar of manifest.grammars) {
		for (const target of grammar.injectTo ?? []) {
			injections.set(target, [...injections.get(target) ?? [], grammar.scopeName]);
		}
	}
	const registry = new textmate.Registry({
		onigLib: Promise.resolve({
			createOnigScanner: (sources: string[]) => new oniguruma.OnigScanner(sources),
			createOnigString: (text: string) => new oniguruma.OnigString(text),
		}),
		loadGrammar: async scopeName => {
			const grammar = byScope.get(scopeName);
			if (!grammar) {
				return null;
			}
			const text = await fetch(`/grammars/${grammar.file}`).then(res => res.text());
			return textmate.parseRawGrammar(text, grammar.file);
		},
		getInjections: scopeName => injections.get(scopeName),
	});
	registry.setTheme({ settings: theme.tokenColors });
	// The window's token CSS (.mtkN) is keyed by its color ids; map this registry's ids onto them.
	const desktopIds = new Map(theme.colorMap.map((hex, id) => [(hex ?? '').toUpperCase(), id]));
	const textmateColors = registry.getColorMap();
	const colorIds = new Uint16Array(textmateColors.length);
	textmateColors.forEach((hex, id) => colorIds[id] = desktopIds.get((hex ?? '').toUpperCase()) ?? 1);
	TokenizationRegistry.setColorMap(theme.colorMap.map(hex => Color.fromHex(hex || '#000000')));
	for (const grammar of manifest.grammars) {
		const languageId = grammar.language;
		if (!languageId) {
			continue;
		}
		const lazy = store.add(new LazyTokenizationSupport<ITokenizationSupport>(async () => {
			const embedded: Record<string, number> = {};
			for (const [scope, id] of Object.entries(grammar.embeddedLanguages ?? {})) {
				embedded[scope] = languageService.languageIdCodec.encodeLanguageId(id);
			}
			const loaded = await registry.loadGrammarWithConfiguration(grammar.scopeName, languageService.languageIdCodec.encodeLanguageId(languageId), { embeddedLanguages: embedded });
			return loaded ? new TextMateTokenizationSupport(loaded, colorIds) : null;
		}));
		store.add(TokenizationRegistry.registerFactory(languageId, lazy));
	}
	return store;
}

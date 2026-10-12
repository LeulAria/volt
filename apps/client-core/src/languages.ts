/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A file's language from its name: the VS Code language id (the web IDE's editor and file icons)
// and the fence id the apps' own highlighter takes.

export interface IFileLanguage {
	/** VS Code's language id (`typescript`, `typescriptreact`, `shellscript`...). */
	readonly id: string;
	/** The editor's (Monaco's) language id. */
	readonly monaco: string;
	/** The fence id for `highlight()`. */
	readonly fence: string;
	readonly label: string;
}

type Lang = readonly [id: string, monaco: string, fence: string, label: string];

const TS: Lang = ['typescript', 'typescript', 'ts', 'TypeScript'];
const TSX: Lang = ['typescriptreact', 'typescript', 'tsx', 'TypeScript JSX'];
const JS: Lang = ['javascript', 'javascript', 'js', 'JavaScript'];
const JSX: Lang = ['javascriptreact', 'javascript', 'jsx', 'JavaScript JSX'];
const JSON_: Lang = ['json', 'json', 'json', 'JSON'];
const JSONC: Lang = ['jsonc', 'json', 'json', 'JSON with Comments'];
const SH: Lang = ['shellscript', 'shell', 'bash', 'Shell Script'];
const MD: Lang = ['markdown', 'markdown', 'markdown', 'Markdown'];
const HTML: Lang = ['html', 'html', 'html', 'HTML'];
const XML: Lang = ['xml', 'xml', 'xml', 'XML'];
const YAML: Lang = ['yaml', 'yaml', 'yaml', 'YAML'];
const PY: Lang = ['python', 'python', 'python', 'Python'];
const PLAIN: Lang = ['plaintext', 'plaintext', 'plain', 'Plain Text'];

const BY_EXTENSION: Record<string, Lang> = {
	ts: TS, mts: TS, cts: TS, tsx: TSX,
	js: JS, mjs: JS, cjs: JS, jsx: JSX,
	json: JSON_, jsonc: JSONC, json5: JSONC, code_workspace: JSONC, webmanifest: JSON_, jsonl: JSON_, geojson: JSON_,
	css: ['css', 'css', 'css', 'CSS'], scss: ['scss', 'scss', 'scss', 'SCSS'], sass: ['sass', 'scss', 'scss', 'Sass'], less: ['less', 'less', 'less', 'Less'],
	html: HTML, htm: HTML, xhtml: HTML, vue: ['vue', 'html', 'html', 'Vue'], svelte: ['svelte', 'html', 'html', 'Svelte'], astro: ['astro', 'html', 'html', 'Astro'],
	xml: XML, svg: XML, plist: XML, xsd: XML, xsl: XML, csproj: XML, fsproj: XML, props: XML, targets: XML, storyboard: XML, xib: XML,
	md: MD, mdx: ['mdx', 'markdown', 'markdown', 'MDX'], markdown: MD,
	yml: YAML, yaml: YAML,
	toml: ['toml', 'ini', 'toml', 'TOML'], ini: ['ini', 'ini', 'toml', 'Ini'], cfg: ['ini', 'ini', 'toml', 'Ini'], conf: ['ini', 'ini', 'toml', 'Conf'], properties: ['properties', 'ini', 'toml', 'Properties'], env: ['dotenv', 'ini', 'toml', 'Environment'],
	py: PY, pyi: PY, pyw: PY, ipynb: JSON_,
	go: ['go', 'go', 'go', 'Go'], mod: ['go.mod', 'plaintext', 'plain', 'Go Module'],
	rs: ['rust', 'rust', 'rust', 'Rust'],
	java: ['java', 'java', 'java', 'Java'], kt: ['kotlin', 'kotlin', 'kotlin', 'Kotlin'], kts: ['kotlin', 'kotlin', 'kotlin', 'Kotlin'], scala: ['scala', 'scala', 'scala', 'Scala'], groovy: ['groovy', 'plaintext', 'java', 'Groovy'], gradle: ['groovy', 'plaintext', 'java', 'Gradle'],
	swift: ['swift', 'swift', 'swift', 'Swift'], m: ['objective-c', 'objective-c', 'c', 'Objective-C'], mm: ['objective-cpp', 'objective-c', 'cpp', 'Objective-C++'],
	c: ['c', 'c', 'c', 'C'], h: ['c', 'c', 'c', 'C'], cc: ['cpp', 'cpp', 'cpp', 'C++'], cpp: ['cpp', 'cpp', 'cpp', 'C++'], cxx: ['cpp', 'cpp', 'cpp', 'C++'], hpp: ['cpp', 'cpp', 'cpp', 'C++'], hh: ['cpp', 'cpp', 'cpp', 'C++'], ino: ['cpp', 'cpp', 'cpp', 'Arduino'],
	cs: ['csharp', 'csharp', 'csharp', 'C#'], fs: ['fsharp', 'fsharp', 'plain', 'F#'], vb: ['vb', 'vb', 'plain', 'Visual Basic'],
	php: ['php', 'php', 'php', 'PHP'], rb: ['ruby', 'ruby', 'ruby', 'Ruby'], erb: ['erb', 'html', 'html', 'ERB'], lua: ['lua', 'lua', 'lua', 'Lua'], pl: ['perl', 'perl', 'perl', 'Perl'], pm: ['perl', 'perl', 'perl', 'Perl'],
	r: ['r', 'r', 'r', 'R'], dart: ['dart', 'dart', 'dart', 'Dart'], ex: ['elixir', 'elixir', 'elixir', 'Elixir'], exs: ['elixir', 'elixir', 'elixir', 'Elixir'], erl: ['erlang', 'plaintext', 'plain', 'Erlang'],
	clj: ['clojure', 'clojure', 'clojure', 'Clojure'], hs: ['haskell', 'plaintext', 'haskell', 'Haskell'], ml: ['ocaml', 'plaintext', 'plain', 'OCaml'], jl: ['julia', 'julia', 'julia', 'Julia'],
	zig: ['zig', 'plaintext', 'zig', 'Zig'], nim: ['nim', 'plaintext', 'plain', 'Nim'], sol: ['solidity', 'sol', 'solidity', 'Solidity'],
	sh: SH, bash: SH, zsh: SH, fish: SH, ksh: SH, command: SH,
	ps1: ['powershell', 'powershell', 'powershell', 'PowerShell'], psm1: ['powershell', 'powershell', 'powershell', 'PowerShell'], bat: ['bat', 'bat', 'bat', 'Batch'], cmd: ['bat', 'bat', 'bat', 'Batch'],
	sql: ['sql', 'sql', 'sql', 'SQL'], prisma: ['prisma', 'plaintext', 'prisma', 'Prisma'], graphql: ['graphql', 'graphql', 'graphql', 'GraphQL'], gql: ['graphql', 'graphql', 'graphql', 'GraphQL'],
	proto: ['proto', 'proto', 'protobuf', 'Protocol Buffers'], tf: ['terraform', 'hcl', 'hcl', 'Terraform'], hcl: ['hcl', 'hcl', 'hcl', 'HCL'],
	dockerfile: ['dockerfile', 'dockerfile', 'docker', 'Dockerfile'], containerfile: ['dockerfile', 'dockerfile', 'docker', 'Dockerfile'],
	diff: ['diff', 'plaintext', 'diff', 'Diff'], patch: ['diff', 'plaintext', 'diff', 'Diff'],
	hbs: ['handlebars', 'handlebars', 'html', 'Handlebars'], handlebars: ['handlebars', 'handlebars', 'html', 'Handlebars'], pug: ['jade', 'pug', 'plain', 'Pug'],
	tex: ['latex', 'plaintext', 'latex', 'LaTeX'], rst: ['restructuredtext', 'restructuredtext', 'plain', 'reStructuredText'],
	txt: PLAIN, log: ['log', 'plaintext', 'plain', 'Log'], csv: ['csv', 'plaintext', 'plain', 'CSV'], tsv: ['tsv', 'plaintext', 'plain', 'TSV'],
	lock: ['plaintext', 'plaintext', 'plain', 'Lockfile'], gitignore: ['ignore', 'plaintext', 'plain', 'Ignore'],
};

const BY_NAME: Record<string, Lang> = {
	'dockerfile': BY_EXTENSION.dockerfile, 'containerfile': BY_EXTENSION.dockerfile,
	'makefile': ['makefile', 'plaintext', 'makefile', 'Makefile'], 'gnumakefile': ['makefile', 'plaintext', 'makefile', 'Makefile'],
	'.gitignore': ['ignore', 'plaintext', 'plain', 'Ignore'], '.dockerignore': ['ignore', 'plaintext', 'plain', 'Ignore'], '.npmignore': ['ignore', 'plaintext', 'plain', 'Ignore'],
	'.env': BY_EXTENSION.env, '.zshrc': SH, '.bashrc': SH, '.bash_profile': SH, '.profile': SH,
	'tsconfig.json': JSONC, 'jsconfig.json': JSONC, '.eslintrc': JSONC, '.prettierrc': JSONC, '.babelrc': JSONC,
	'cmakelists.txt': ['cmake', 'plaintext', 'plain', 'CMake'], 'gemfile': BY_EXTENSION.rb, 'rakefile': BY_EXTENSION.rb, 'podfile': BY_EXTENSION.rb, 'vagrantfile': BY_EXTENSION.rb,
	'go.mod': ['go.mod', 'plaintext', 'plain', 'Go Module'], 'go.sum': ['go.sum', 'plaintext', 'plain', 'Go Checksums'], 'cargo.lock': BY_EXTENSION.toml,
};

/** The language of a file, from its name. */
export function languageForPath(path: string): IFileLanguage {
	const name = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
	const byName = BY_NAME[name] ?? (name.startsWith('.env.') ? BY_EXTENSION.env : name.startsWith('dockerfile.') ? BY_EXTENSION.dockerfile : undefined);
	const dot = name.lastIndexOf('.');
	const lang = byName ?? (dot >= 0 ? BY_EXTENSION[name.slice(dot + 1)] : undefined) ?? PLAIN;
	return { id: lang[0], monaco: lang[1], fence: lang[2], label: lang[3] };
}

/** File extensions the apps show as pictures instead of text. */
export function isImagePath(path: string): boolean {
	return /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i.test(path);
}

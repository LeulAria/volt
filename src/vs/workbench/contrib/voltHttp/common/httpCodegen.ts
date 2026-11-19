/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A request as code to paste somewhere else (Postman's "Code snippet"): shell commands and a few
 * languages' usual HTTP calls. `{{variables}}` are left as written for the reader to fill in.
 */

import { IHttpRequestSpec } from '../../../services/voltRuntime/common/ide/httpFile.js';

export type HttpSnippetTarget = 'curl' | 'httpie' | 'wget' | 'powershell' | 'fetch' | 'axios' | 'node' | 'python' | 'go' | 'java' | 'kotlin' | 'csharp' | 'php' | 'ruby' | 'swift' | 'rust' | 'dart';

export const HTTP_SNIPPET_TARGETS: readonly { readonly id: HttpSnippetTarget; readonly label: string; readonly language: string }[] = [
	{ id: 'curl', label: 'cURL', language: 'shellscript' },
	{ id: 'httpie', label: 'HTTPie', language: 'shellscript' },
	{ id: 'wget', label: 'Wget', language: 'shellscript' },
	{ id: 'powershell', label: 'PowerShell - Invoke-RestMethod', language: 'powershell' },
	{ id: 'fetch', label: 'JavaScript - Fetch', language: 'javascript' },
	{ id: 'axios', label: 'JavaScript - Axios', language: 'javascript' },
	{ id: 'node', label: 'Node.js - https', language: 'javascript' },
	{ id: 'python', label: 'Python - Requests', language: 'python' },
	{ id: 'go', label: 'Go - net/http', language: 'go' },
	{ id: 'java', label: 'Java - HttpClient', language: 'java' },
	{ id: 'kotlin', label: 'Kotlin - OkHttp', language: 'kotlin' },
	{ id: 'csharp', label: 'C# - HttpClient', language: 'csharp' },
	{ id: 'php', label: 'PHP - cURL', language: 'php' },
	{ id: 'ruby', label: 'Ruby - Net::HTTP', language: 'ruby' },
	{ id: 'swift', label: 'Swift - URLSession', language: 'swift' },
	{ id: 'rust', label: 'Rust - reqwest', language: 'rust' },
	{ id: 'dart', label: 'Dart - http', language: 'dart' },
];

/** A POSIX shell word: single quotes, with `'` written as `'\''`. */
function shell(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A double-quoted literal JavaScript, Python and Go all read the same way. */
function quoted(value: string): string {
	return JSON.stringify(value).replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function indent(text: string, by: string): string {
	return text.split('\n').map((line, at) => at === 0 ? line : `${by}${line}`).join('\n');
}

function contentType(spec: IHttpRequestSpec): string {
	return spec.headers.find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '';
}

/** The body as a value when it is JSON (by its content type, or by its looks when none is given). */
function jsonBody(spec: IHttpRequestSpec): { readonly value: unknown } | undefined {
	const type = contentType(spec);
	if (!spec.body || !(/json/i.test(type) || (!type && /^\s*[[{]/.test(spec.body)))) {
		return undefined;
	}
	try {
		return { value: JSON.parse(spec.body) };
	} catch {
		return undefined;
	}
}

/** Headers as one value per name (repeats joined, as they go out). */
function headerRecord(spec: IHttpRequestSpec): [string, string][] {
	const out: [string, string][] = [];
	for (const [key, value] of spec.headers) {
		const known = out.find(([name]) => name.toLowerCase() === key.toLowerCase());
		if (known) {
			known[1] = `${known[1]}, ${value}`;
		} else {
			out.push([key, value]);
		}
	}
	return out;
}

function curl(spec: IHttpRequestSpec): string {
	const lines = [`curl${spec.method === 'GET' ? '' : ` -X ${spec.method}`} ${shell(spec.url)}`];
	for (const [key, value] of spec.headers) {
		lines.push(`-H ${shell(`${key}: ${value}`)}`);
	}
	if (spec.body) {
		lines.push(`--data-raw ${shell(spec.body)}`);
	}
	return lines.join(' \\\n  ');
}

function httpie(spec: IHttpRequestSpec): string {
	const lines = [`http${spec.body ? ` --raw ${shell(spec.body)}` : ''} ${spec.method} ${shell(spec.url)}`];
	for (const [key, value] of spec.headers) {
		lines.push(value === '' ? shell(`${key};`) : shell(`${key}:${value}`));
	}
	return lines.join(' \\\n  ');
}

function wget(spec: IHttpRequestSpec): string {
	const lines = [`wget --quiet --method=${spec.method}`];
	for (const [key, value] of spec.headers) {
		lines.push(`--header=${shell(`${key}: ${value}`)}`);
	}
	if (spec.body) {
		lines.push(`--body-data=${shell(spec.body)}`);
	}
	lines.push('--output-document=-', shell(spec.url));
	return lines.join(' \\\n  ');
}

function jsObject(entries: readonly [string, string][], by: string): string {
	return `{\n${entries.map(([key, value]) => `${by}  ${quoted(key)}: ${quoted(value)},`).join('\n')}\n${by}}`;
}

function fetchSnippet(spec: IHttpRequestSpec): string {
	const headers = headerRecord(spec);
	const json = jsonBody(spec);
	const options = [`  method: ${quoted(spec.method)},`];
	if (headers.length) {
		options.push(`  headers: ${jsObject(headers, '  ')},`);
	}
	if (json) {
		options.push(`  body: JSON.stringify(${indent(JSON.stringify(json.value, null, 2), '  ')}),`);
	} else if (spec.body) {
		options.push(`  body: ${quoted(spec.body)},`);
	}
	return [
		`const response = await fetch(${quoted(spec.url)}, {`,
		...options,
		'});',
		'',
		'console.log(response.status);',
		'console.log(await response.text());',
	].join('\n');
}

function axiosSnippet(spec: IHttpRequestSpec): string {
	const headers = headerRecord(spec);
	const json = jsonBody(spec);
	const options = [`  method: ${quoted(spec.method.toLowerCase())},`, `  url: ${quoted(spec.url)},`];
	if (headers.length) {
		options.push(`  headers: ${jsObject(headers, '  ')},`);
	}
	if (json) {
		options.push(`  data: ${indent(JSON.stringify(json.value, null, 2), '  ')},`);
	} else if (spec.body) {
		options.push(`  data: ${quoted(spec.body)},`);
	}
	return [
		'import axios from "axios";',
		'',
		'const response = await axios({',
		...options,
		'});',
		'',
		'console.log(response.status);',
		'console.log(response.data);',
	].join('\n');
}

/** A JSON value as a Python literal. */
function pythonLiteral(value: unknown, by: string): string {
	if (value === null || value === undefined) {
		return 'None';
	}
	if (typeof value === 'boolean') {
		return value ? 'True' : 'False';
	}
	if (typeof value === 'string') {
		return quoted(value);
	}
	if (typeof value !== 'object') {
		return String(value);
	}
	if (Array.isArray(value)) {
		return value.length ? `[\n${value.map(item => `${by}    ${pythonLiteral(item, `${by}    `)},`).join('\n')}\n${by}]` : '[]';
	}
	const entries = Object.entries(value);
	return entries.length ? `{\n${entries.map(([key, item]) => `${by}    ${quoted(key)}: ${pythonLiteral(item, `${by}    `)},`).join('\n')}\n${by}}` : '{}';
}

function pythonSnippet(spec: IHttpRequestSpec): string {
	const headers = headerRecord(spec);
	const json = jsonBody(spec);
	const lines = ['import requests', '', `url = ${quoted(spec.url)}`];
	const args = [quoted(spec.method), 'url'];
	if (headers.length) {
		lines.push(`headers = ${pythonLiteral(Object.fromEntries(headers), '')}`);
		args.push('headers=headers');
	}
	if (json) {
		lines.push(`payload = ${pythonLiteral(json.value, '')}`);
		args.push('json=payload');
	} else if (spec.body) {
		lines.push(`payload = ${quoted(spec.body)}`);
		args.push('data=payload.encode("utf-8")');
	}
	lines.push('', `response = requests.request(${args.join(', ')})`, '', 'print(response.status_code)', 'print(response.text)');
	return lines.join('\n');
}

function goSnippet(spec: IHttpRequestSpec): string {
	const body = spec.body ? (spec.body.includes('`') ? quoted(spec.body) : `\`${spec.body}\``) : undefined;
	return [
		'package main',
		'',
		'import (',
		'\t"fmt"',
		'\t"io"',
		'\t"net/http"',
		...(body ? ['\t"strings"'] : []),
		')',
		'',
		'func main() {',
		...(body ? [`\tpayload := strings.NewReader(${body})`, ''] : []),
		`\treq, err := http.NewRequest(${quoted(spec.method)}, ${quoted(spec.url)}, ${body ? 'payload' : 'nil'})`,
		'\tif err != nil {',
		'\t\tpanic(err)',
		'\t}',
		...spec.headers.map(([key, value]) => `\treq.Header.Add(${quoted(key)}, ${quoted(value)})`),
		'',
		'\tres, err := http.DefaultClient.Do(req)',
		'\tif err != nil {',
		'\t\tpanic(err)',
		'\t}',
		'\tdefer res.Body.Close()',
		'',
		'\tdata, err := io.ReadAll(res.Body)',
		'\tif err != nil {',
		'\t\tpanic(err)',
		'\t}',
		'\tfmt.Println(res.Status)',
		'\tfmt.Println(string(data))',
		'}',
	].join('\n');
}

/** The request as a snippet for `target`. */
/** PowerShell's single-quoted string: nothing inside is expanded, `'` is doubled. */
function psQuoted(value: string): string {
	return `'${value.replace(/'/g, `''`)}'`;
}

function powershellSnippet(spec: IHttpRequestSpec): string {
	const headers = headerRecord(spec).filter(([key]) => key.toLowerCase() !== 'content-type');
	const type = contentType(spec);
	const lines: string[] = [];
	if (headers.length) {
		lines.push('$headers = @{', ...headers.map(([key, value]) => `    ${psQuoted(key)} = ${psQuoted(value)}`), '}', '');
	}
	if (spec.body) {
		lines.push(`$body = @'`, spec.body, `'@`, '');
	}
	lines.push([
		`Invoke-RestMethod -Uri ${psQuoted(spec.url)} -Method ${spec.method}`,
		...(headers.length ? ['-Headers $headers'] : []),
		...(type ? [`-ContentType ${psQuoted(type)}`] : []),
		...(spec.body ? ['-Body $body'] : []),
	].join(' `\n    '));
	return lines.join('\n');
}

function nodeSnippet(spec: IHttpRequestSpec): string {
	const headers = headerRecord(spec);
	const lines = [
		`const https = require('node:https');`,
		'',
		`const request = https.request(${quoted(spec.url)}, {`,
		`  method: ${quoted(spec.method)},`,
		...(headers.length ? [`  headers: ${jsObject(headers, '  ')},`] : []),
		'}, response => {',
		`  let body = '';`,
		`  response.on('data', chunk => body += chunk);`,
		`  response.on('end', () => console.log(response.statusCode, body));`,
		'});',
		'',
		`request.on('error', console.error);`,
		...(spec.body ? [`request.write(${quoted(spec.body)});`] : []),
		'request.end();',
	];
	return lines.join('\n');
}

/** A double-quoted literal for languages that interpolate `$` (Kotlin, Dart) or `#{` (Ruby). */
function quotedNoInterpolation(value: string, escape: RegExp): string {
	return quoted(value).replace(escape, match => `\\${match}`);
}

function javaSnippet(spec: IHttpRequestSpec): string {
	const lines = [
		'HttpClient client = HttpClient.newHttpClient();',
		'HttpRequest request = HttpRequest.newBuilder()',
		`    .uri(URI.create(${quoted(spec.url)}))`,
		...headerRecord(spec).map(([key, value]) => `    .header(${quoted(key)}, ${quoted(value)})`),
		`    .method(${quoted(spec.method)}, ${spec.body ? `HttpRequest.BodyPublishers.ofString(${quoted(spec.body)})` : 'HttpRequest.BodyPublishers.noBody()'})`,
		'    .build();',
		'',
		'HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());',
		'System.out.println(response.statusCode());',
		'System.out.println(response.body());',
	];
	return lines.join('\n');
}

function kotlinSnippet(spec: IHttpRequestSpec): string {
	const q = (value: string) => quotedNoInterpolation(value, /\$/g);
	const type = contentType(spec) || 'text/plain';
	const lines = [
		'val client = OkHttpClient()',
		...(spec.body ? [`val body = ${q(spec.body)}.toRequestBody(${q(type)}.toMediaType())`] : []),
		'val request = Request.Builder()',
		`    .url(${q(spec.url)})`,
		...headerRecord(spec).map(([key, value]) => `    .addHeader(${q(key)}, ${q(value)})`),
		`    .method(${q(spec.method)}, ${spec.body ? 'body' : 'null'})`,
		'    .build()',
		'',
		'client.newCall(request).execute().use { response ->',
		'    println(response.code)',
		'    println(response.body?.string())',
		'}',
	];
	return lines.join('\n');
}

function csharpSnippet(spec: IHttpRequestSpec): string {
	const type = contentType(spec) || 'text/plain';
	const headers = headerRecord(spec).filter(([key]) => key.toLowerCase() !== 'content-type');
	const lines = [
		'using var client = new HttpClient();',
		`using var request = new HttpRequestMessage(new HttpMethod(${quoted(spec.method)}), ${quoted(spec.url)});`,
		...headers.map(([key, value]) => `request.Headers.TryAddWithoutValidation(${quoted(key)}, ${quoted(value)});`),
		...(spec.body ? [`request.Content = new StringContent(${quoted(spec.body)}, Encoding.UTF8, ${quoted(type.split(';')[0].trim())});`] : []),
		'',
		'using var response = await client.SendAsync(request);',
		'Console.WriteLine((int)response.StatusCode);',
		'Console.WriteLine(await response.Content.ReadAsStringAsync());',
	];
	return lines.join('\n');
}

/** PHP's single-quoted string: only `\\` and `'` are escaped. */
function phpQuoted(value: string): string {
	return `'${value.replace(/\\/g, '\\\\').replace(/'/g, `\\'`)}'`;
}

function phpSnippet(spec: IHttpRequestSpec): string {
	const lines = [
		'<?php',
		'',
		`$curl = curl_init(${phpQuoted(spec.url)});`,
		'curl_setopt_array($curl, [',
		'    CURLOPT_RETURNTRANSFER => true,',
		`    CURLOPT_CUSTOMREQUEST => ${phpQuoted(spec.method)},`,
		...(spec.headers.length ? ['    CURLOPT_HTTPHEADER => [', ...spec.headers.map(([key, value]) => `        ${phpQuoted(`${key}: ${value}`)},`), '    ],'] : []),
		...(spec.body ? [`    CURLOPT_POSTFIELDS => ${phpQuoted(spec.body)},`] : []),
		']);',
		'',
		'$response = curl_exec($curl);',
		'echo curl_getinfo($curl, CURLINFO_HTTP_CODE), PHP_EOL, $response;',
		'curl_close($curl);',
	];
	return lines.join('\n');
}

function rubySnippet(spec: IHttpRequestSpec): string {
	const q = (value: string) => quotedNoInterpolation(value, /#(?=[{$@])/g);
	const lines = [
		`require 'net/http'`,
		`require 'uri'`,
		'',
		`uri = URI(${q(spec.url)})`,
		`request = Net::HTTPGenericRequest.new(${q(spec.method)}, ${spec.body ? 'true' : 'false'}, true, uri)`,
		...headerRecord(spec).map(([key, value]) => `request[${q(key)}] = ${q(value)}`),
		...(spec.body ? [`request.body = ${q(spec.body)}`] : []),
		'',
		`response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == 'https') do |http|`,
		'  http.request(request)',
		'end',
		'',
		'puts response.code',
		'puts response.body',
	];
	return lines.join('\n');
}

function swiftSnippet(spec: IHttpRequestSpec): string {
	const lines = [
		'import Foundation',
		'',
		`var request = URLRequest(url: URL(string: ${quoted(spec.url)})!)`,
		`request.httpMethod = ${quoted(spec.method)}`,
		...headerRecord(spec).map(([key, value]) => `request.setValue(${quoted(value)}, forHTTPHeaderField: ${quoted(key)})`),
		...(spec.body ? [`request.httpBody = ${quoted(spec.body)}.data(using: .utf8)`] : []),
		'',
		'let (data, response) = try await URLSession.shared.data(for: request)',
		'print((response as? HTTPURLResponse)?.statusCode ?? 0)',
		'print(String(decoding: data, as: UTF8.self))',
	];
	return lines.join('\n');
}

function rustSnippet(spec: IHttpRequestSpec): string {
	const lines = [
		'let client = reqwest::Client::new();',
		'let response = client',
		`    .request(reqwest::Method::from_bytes(b${quoted(spec.method)})?, ${quoted(spec.url)})`,
		...headerRecord(spec).map(([key, value]) => `    .header(${quoted(key)}, ${quoted(value)})`),
		...(spec.body ? [`    .body(${quoted(spec.body)})`] : []),
		'    .send()',
		'    .await?;',
		'',
		'println!("{}", response.status());',
		'println!("{}", response.text().await?);',
	];
	return lines.join('\n');
}

function dartSnippet(spec: IHttpRequestSpec): string {
	const q = (value: string) => quotedNoInterpolation(value, /\$/g);
	const headers = headerRecord(spec);
	const lines = [
		`import 'package:http/http.dart' as http;`,
		'',
		'Future<void> main() async {',
		`  final request = http.Request(${q(spec.method)}, Uri.parse(${q(spec.url)}));`,
		...(headers.length ? ['  request.headers.addAll({', ...headers.map(([key, value]) => `    ${q(key)}: ${q(value)},`), '  });'] : []),
		...(spec.body ? [`  request.body = ${q(spec.body)};`] : []),
		'',
		'  final response = await http.Response.fromStream(await request.send());',
		'  print(response.statusCode);',
		'  print(response.body);',
		'}',
	];
	return lines.join('\n');
}

export function httpSnippet(target: HttpSnippetTarget, spec: IHttpRequestSpec): string {
	switch (target) {
		case 'curl': return curl(spec);
		case 'httpie': return httpie(spec);
		case 'wget': return wget(spec);
		case 'fetch': return fetchSnippet(spec);
		case 'axios': return axiosSnippet(spec);
		case 'python': return pythonSnippet(spec);
		case 'go': return goSnippet(spec);
		case 'powershell': return powershellSnippet(spec);
		case 'node': return nodeSnippet(spec);
		case 'java': return javaSnippet(spec);
		case 'kotlin': return kotlinSnippet(spec);
		case 'csharp': return csharpSnippet(spec);
		case 'php': return phpSnippet(spec);
		case 'ruby': return rubySnippet(spec);
		case 'swift': return swiftSnippet(spec);
		case 'rust': return rustSnippet(spec);
		case 'dart': return dartSnippet(spec);
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64, encodeBase64, VSBuffer } from '../../../base/common/buffer.js';

/**
 * Protocol Buffers for the Volt Client's gRPC calls, with no dependency: a `.proto` parser, a
 * registry of the types it (or a server's reflection descriptors) defines, and a codec between the
 * proto3 JSON form the user edits and the bytes that go on the wire.
 */

export type ProtoJson = null | boolean | number | string | ProtoJson[] | { [key: string]: ProtoJson };

export type ProtoScalarType = 'double' | 'float' | 'int32' | 'int64' | 'uint32' | 'uint64' | 'sint32' | 'sint64'
	| 'fixed32' | 'fixed64' | 'sfixed32' | 'sfixed64' | 'bool' | 'string' | 'bytes';

/** `unresolved` is a name from a `.proto` text that has not been looked up yet (message or enum). */
export type ProtoFieldType = ProtoScalarType | 'message' | 'enum' | 'group' | 'unresolved';

export interface IProtoField {
	readonly name: string;
	readonly jsonName: string;
	readonly number: number;
	type: ProtoFieldType;
	/** For message, enum and group fields: the type's name. Fully qualified once resolved. */
	typeName: string;
	/** Where `typeName` is looked up from: the enclosing message's full name. */
	readonly scope: string;
	readonly repeated: boolean;
	/** The `packed` option when the field states it. */
	readonly packed: boolean | undefined;
	/** The field knows whether it was set (proto2 fields, proto3 `optional`). */
	readonly presence: boolean;
	readonly oneof: string | undefined;
}

export interface IProtoMessage {
	readonly fullName: string;
	readonly fields: IProtoField[];
	readonly oneofs: string[];
	/** The entry type protobuf makes for a `map<K, V>` field (key = 1, value = 2). */
	readonly mapEntry: boolean;
	readonly syntax: 'proto2' | 'proto3';
}

export interface IProtoEnum {
	readonly fullName: string;
	readonly values: { readonly name: string; readonly number: number }[];
	readonly allowAlias: boolean;
}

export interface IProtoMethod {
	readonly name: string;
	/** As written; `ProtoRegistry.methodTypes` resolves them. */
	readonly inputType: string;
	readonly outputType: string;
	readonly clientStreaming: boolean;
	readonly serverStreaming: boolean;
}

export interface IProtoService {
	readonly fullName: string;
	/** Where the methods' type names are looked up from: the package. */
	readonly scope: string;
	readonly methods: IProtoMethod[];
}

export interface IProtoFile {
	readonly name: string;
	readonly syntax: 'proto2' | 'proto3';
	readonly package: string;
	readonly imports: string[];
	/** Every message, nested ones included. */
	readonly messages: IProtoMessage[];
	readonly enums: IProtoEnum[];
	readonly services: IProtoService[];
}

export class ProtoError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProtoError';
	}
}

//#region wire format

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_START_GROUP = 3;
const WIRE_END_GROUP = 4;
const WIRE_FIXED32 = 5;

const MAX_DEPTH = 100;

function malformed(what: string): ProtoError {
	return new ProtoError(`Malformed protobuf data: ${what}`);
}

export class ProtoReader {

	private pos = 0;
	private readonly view: DataView;

	constructor(private readonly buf: Uint8Array) {
		this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	}

	get done(): boolean {
		return this.pos >= this.buf.length;
	}

	varint(): bigint {
		let result = 0n;
		let shift = 0n;
		for (let i = 0; i < 10; i++) {
			if (this.pos >= this.buf.length) {
				throw malformed('a number is cut off');
			}
			const byte = this.buf[this.pos++];
			result |= BigInt(byte & 0x7f) << shift;
			if ((byte & 0x80) === 0) {
				return BigInt.asUintN(64, result);
			}
			shift += 7n;
		}
		throw malformed('a number is longer than 10 bytes');
	}

	/** The next field's number and wire type. */
	tag(): [number, number] {
		const tag = this.varint();
		if (tag > 0xffffffffn) {
			throw malformed('a field number is out of range');
		}
		const value = Number(tag);
		const number = Math.floor(value / 8);
		if (number === 0) {
			throw malformed('field number 0');
		}
		return [number, value % 8];
	}

	fixed32(): number {
		this.need(4);
		const value = this.view.getUint32(this.pos, true);
		this.pos += 4;
		return value;
	}

	fixed64(): bigint {
		this.need(8);
		const value = this.view.getBigUint64(this.pos, true);
		this.pos += 8;
		return value;
	}

	float(): number {
		this.need(4);
		const value = this.view.getFloat32(this.pos, true);
		this.pos += 4;
		return value;
	}

	double(): number {
		this.need(8);
		const value = this.view.getFloat64(this.pos, true);
		this.pos += 8;
		return value;
	}

	/** A length-delimited value's bytes (a view, not a copy). */
	bytes(): Uint8Array {
		const length = this.varint();
		const left = this.buf.length - this.pos;
		if (length > BigInt(left)) {
			throw malformed(`a field says it is ${length} bytes long but only ${left} are left`);
		}
		const value = this.buf.subarray(this.pos, this.pos + Number(length));
		this.pos += Number(length);
		return value;
	}

	string(): string {
		return new TextDecoder().decode(this.bytes());
	}

	skip(wireType: number, depth = 0): void {
		switch (wireType) {
			case WIRE_VARINT: this.varint(); return;
			case WIRE_FIXED64: this.need(8); this.pos += 8; return;
			case WIRE_LEN: this.bytes(); return;
			case WIRE_FIXED32: this.need(4); this.pos += 4; return;
			case WIRE_START_GROUP: {
				if (depth > MAX_DEPTH) {
					throw malformed('groups are nested too deeply');
				}
				for (; ;) {
					if (this.done) {
						throw malformed('a group is cut off');
					}
					const [, inner] = this.tag();
					if (inner === WIRE_END_GROUP) {
						return;
					}
					this.skip(inner, depth + 1);
				}
			}
			case WIRE_END_GROUP: throw malformed('a group ends that never started');
			default: throw malformed(`unknown wire type ${wireType}`);
		}
	}

	private need(count: number): void {
		if (this.buf.length - this.pos < count) {
			throw malformed('a fixed-size number is cut off');
		}
	}
}

export class ProtoWriter {

	private buf = new Uint8Array(64);
	private view = new DataView(this.buf.buffer);
	private length = 0;

	private ensure(count: number): void {
		if (this.length + count <= this.buf.length) {
			return;
		}
		const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + count));
		next.set(this.buf.subarray(0, this.length));
		this.buf = next;
		this.view = new DataView(next.buffer);
	}

	/** `value` as an unsigned 64-bit varint (negative numbers in two's complement). */
	varint(value: bigint): this {
		let rest = BigInt.asUintN(64, value);
		this.ensure(10);
		while (rest > 0x7fn) {
			this.buf[this.length++] = Number(rest & 0x7fn) | 0x80;
			rest >>= 7n;
		}
		this.buf[this.length++] = Number(rest);
		return this;
	}

	tag(number: number, wireType: number): this {
		return this.varint(BigInt(number) * 8n + BigInt(wireType));
	}

	fixed32(value: number): this {
		this.ensure(4);
		this.view.setUint32(this.length, value, true);
		this.length += 4;
		return this;
	}

	fixed64(value: bigint): this {
		this.ensure(8);
		this.view.setBigUint64(this.length, BigInt.asUintN(64, value), true);
		this.length += 8;
		return this;
	}

	float(value: number): this {
		this.ensure(4);
		this.view.setFloat32(this.length, value, true);
		this.length += 4;
		return this;
	}

	double(value: number): this {
		this.ensure(8);
		this.view.setFloat64(this.length, value, true);
		this.length += 8;
		return this;
	}

	raw(bytes: Uint8Array): this {
		this.ensure(bytes.length);
		this.buf.set(bytes, this.length);
		this.length += bytes.length;
		return this;
	}

	/** A length-delimited value: its length, then its bytes. */
	bytes(bytes: Uint8Array): this {
		return this.varint(BigInt(bytes.length)).raw(bytes);
	}

	string(text: string): this {
		return this.bytes(new TextEncoder().encode(text));
	}

	finish(): Uint8Array {
		return this.buf.slice(0, this.length);
	}
}

function eachField(bytes: Uint8Array, visit: (number: number, wireType: number, reader: ProtoReader) => boolean): void {
	const reader = new ProtoReader(bytes);
	while (!reader.done) {
		const [number, wireType] = reader.tag();
		if (!visit(number, wireType, reader)) {
			reader.skip(wireType);
		}
	}
}

//#endregion

//#region .proto parser

const SCALARS: ReadonlySet<string> = new Set<ProtoScalarType>(['double', 'float', 'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool', 'string', 'bytes']);

/** The JSON name protobuf derives from a field name: `user_id` is `userId`. */
export function protoJsonName(name: string): string {
	let out = '';
	let upper = false;
	for (const ch of name) {
		if (ch === '_') {
			upper = true;
		} else {
			out += upper ? ch.toUpperCase() : ch;
			upper = false;
		}
	}
	return out;
}

interface IToken {
	readonly kind: 'id' | 'num' | 'str' | 'sym' | 'eof';
	readonly value: string;
	readonly line: number;
}

const NUMBER_PATTERN = /0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENT_PATTERN = /\.?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/y;

function tokenize(text: string, file: string): IToken[] {
	const tokens: IToken[] = [];
	const length = text.length;
	let line = 1;
	let i = 0;
	while (i < length) {
		const ch = text[i];
		if (ch === '\n') {
			line++;
			i++;
		} else if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\uFEFF') {
			i++;
		} else if (ch === '/' && text[i + 1] === '/') {
			while (i < length && text[i] !== '\n') {
				i++;
			}
		} else if (ch === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			if (end < 0) {
				throw new ProtoError(`${file}:${line}: a /* comment never ends`);
			}
			for (let j = i; j < end; j++) {
				if (text[j] === '\n') {
					line++;
				}
			}
			i = end + 2;
		} else if (ch === '"' || ch === '\'') {
			let value = '';
			let j = i + 1;
			for (; ; j++) {
				if (j >= length || text[j] === '\n') {
					throw new ProtoError(`${file}:${line}: a string never ends`);
				}
				if (text[j] === ch) {
					break;
				}
				if (text[j] !== '\\') {
					value += text[j];
					continue;
				}
				j++;
				const escape = text[j];
				const hex = /^[xX]([0-9a-fA-F]{1,2})/.exec(text.slice(j, j + 3));
				const octal = /^[0-7]{1,3}/.exec(text.slice(j, j + 3));
				const unicode = /^u([0-9a-fA-F]{4})/.exec(text.slice(j, j + 5));
				if (hex) {
					value += String.fromCharCode(parseInt(hex[1], 16));
					j += hex[0].length - 1;
				} else if (octal) {
					value += String.fromCharCode(parseInt(octal[0], 8));
					j += octal[0].length - 1;
				} else if (unicode) {
					value += String.fromCharCode(parseInt(unicode[1], 16));
					j += 4;
				} else {
					value += escape === 'n' ? '\n' : escape === 't' ? '\t' : escape === 'r' ? '\r' : (escape ?? '');
				}
			}
			tokens.push({ kind: 'str', value, line });
			i = j + 1;
		} else {
			IDENT_PATTERN.lastIndex = i;
			NUMBER_PATTERN.lastIndex = i;
			const ident = IDENT_PATTERN.exec(text);
			const number = ident ? null : NUMBER_PATTERN.exec(text);
			if (ident) {
				tokens.push({ kind: 'id', value: ident[0], line });
				i += ident[0].length;
			} else if (number) {
				tokens.push({ kind: 'num', value: number[0], line });
				i += number[0].length;
			} else {
				tokens.push({ kind: 'sym', value: ch, line });
				i++;
			}
		}
	}
	tokens.push({ kind: 'eof', value: '', line });
	return tokens;
}

interface IFieldOptions {
	jsonName?: string;
	packed?: boolean;
}

class ProtoParser {

	private pos = 0;
	private readonly tokens: IToken[];
	private syntax: 'proto2' | 'proto3' = 'proto2';
	private package = '';
	private readonly imports: string[] = [];
	private readonly messages: IProtoMessage[] = [];
	private readonly enums: IProtoEnum[] = [];
	private readonly services: IProtoService[] = [];

	constructor(text: string, private readonly file: string) {
		this.tokens = tokenize(text, file);
	}

	parse(): IProtoFile {
		// The package applies to the whole file wherever it is written, so read it first.
		for (let i = 0; i + 2 < this.tokens.length; i++) {
			const previous = i === 0 ? undefined : this.tokens[i - 1];
			if (this.tokens[i].kind === 'id' && this.tokens[i].value === 'package' && this.tokens[i + 1].kind === 'id' && this.tokens[i + 2].value === ';'
				&& (!previous || previous.value === ';' || previous.value === '}')) {
				this.package = this.tokens[i + 1].value;
				break;
			}
		}
		for (; ;) {
			const token = this.next();
			if (token.kind === 'eof') {
				break;
			}
			if (token.kind === 'sym' && token.value === ';') {
				continue;
			}
			if (token.kind !== 'id') {
				throw this.error(token, `unexpected "${token.value}"`);
			}
			switch (token.value) {
				case 'syntax':
				case 'edition': {
					this.expectSymbol('=');
					const value = this.expect('str').value;
					this.syntax = token.value === 'edition' || value === 'proto3' ? 'proto3' : 'proto2';
					this.expectSymbol(';');
					break;
				}
				case 'package':
					this.expect('id');
					this.expectSymbol(';');
					break;
				case 'import': {
					if (this.peek().kind === 'id') {
						this.next();
					}
					this.imports.push(this.expect('str').value);
					this.expectSymbol(';');
					break;
				}
				case 'option': this.skipStatement(); break;
				case 'message': this.parseMessage(this.package); break;
				case 'enum': this.parseEnum(this.package); break;
				case 'service': this.parseService(); break;
				case 'extend': this.skipBlockStatement(); break;
				default: throw this.error(token, `unexpected "${token.value}"`);
			}
		}
		return { name: this.file, syntax: this.syntax, package: this.package, imports: this.imports, messages: this.messages, enums: this.enums, services: this.services };
	}

	private parseMessage(scope: string): string {
		const name = this.expect('id').value;
		const fullName = scope ? `${scope}.${name}` : name;
		this.expectSymbol('{');
		this.parseMessageBody(fullName);
		return fullName;
	}

	/** The fields and nested types up to the closing brace. */
	private parseMessageBody(fullName: string): void {
		const fields: IProtoField[] = [];
		const oneofs: string[] = [];
		// Registered before its nested types so a file lists a parent before its children.
		this.messages.push({ fullName, fields, oneofs, mapEntry: false, syntax: this.syntax });
		for (; ;) {
			const token = this.next();
			if (token.kind === 'sym' && token.value === '}') {
				return;
			}
			if (token.kind === 'sym' && token.value === ';') {
				continue;
			}
			if (token.kind !== 'id') {
				throw this.error(token, `unexpected "${token.value}" in message ${fullName}`);
			}
			const next = this.peek();
			const afterNext = this.peek(1);
			if (token.value === 'message' && next.kind === 'id' && afterNext.value === '{') {
				this.parseMessage(fullName);
			} else if (token.value === 'enum' && next.kind === 'id' && afterNext.value === '{') {
				this.parseEnum(fullName);
			} else if (token.value === 'oneof' && next.kind === 'id' && afterNext.value === '{') {
				const oneof = this.next().value;
				this.next();
				oneofs.push(oneof);
				for (; ;) {
					const member = this.next();
					if (member.kind === 'sym' && member.value === '}') {
						break;
					}
					if (member.kind === 'sym' && member.value === ';') {
						continue;
					}
					if (member.kind !== 'id') {
						throw this.error(member, `unexpected "${member.value}" in oneof ${oneof}`);
					}
					if (member.value === 'option') {
						this.skipStatement();
						continue;
					}
					this.parseField(member, fullName, fields, oneof);
				}
			} else if (token.value === 'option' || ((token.value === 'reserved' || token.value === 'extensions') && next.kind !== 'id')) {
				this.skipStatement();
			} else if (token.value === 'extend' && next.kind === 'id' && afterNext.value === '{') {
				this.skipBlockStatement();
			} else {
				this.parseField(token, fullName, fields, undefined);
			}
		}
	}

	/** One field, starting at its label or type (already read as `first`). */
	private parseField(first: IToken, scope: string, fields: IProtoField[], oneof: string | undefined): void {
		let label = '';
		let typeToken = first;
		if ((first.value === 'optional' || first.value === 'required' || first.value === 'repeated') && this.peek().kind === 'id') {
			label = first.value;
			typeToken = this.next();
		}
		const repeated = label === 'repeated';
		const presence = !repeated && !oneof && (this.syntax === 'proto2' || label === 'optional');

		if (typeToken.value === 'map' && this.peek().value === '<') {
			this.next();
			const keyType = this.expect('id').value;
			this.expectSymbol(',');
			const valueType = this.expect('id').value;
			this.expectSymbol('>');
			const name = this.expect('id').value;
			this.expectSymbol('=');
			const number = this.fieldNumber();
			const options = this.fieldOptions();
			this.expectSymbol(';');
			if (!SCALARS.has(keyType) || keyType === 'double' || keyType === 'float' || keyType === 'bytes') {
				throw this.error(typeToken, `${keyType} cannot be a map key (field ${name})`);
			}
			const camel = protoJsonName(name);
			const entryName = `${scope}.${camel.charAt(0).toUpperCase()}${camel.slice(1)}Entry`;
			this.messages.push({
				fullName: entryName, oneofs: [], mapEntry: true, syntax: this.syntax,
				fields: [
					this.field('key', 1, keyType, entryName, false, false, undefined, {}),
					this.field('value', 2, valueType, entryName, false, false, undefined, {}),
				],
			});
			fields.push({ name, jsonName: options.jsonName ?? camel, number, type: 'message', typeName: entryName, scope, repeated: true, packed: undefined, presence: false, oneof: undefined });
			return;
		}

		if (typeToken.value === 'group') {
			// proto2 groups: the body is a nested message; the field is named after it in lower case.
			const name = this.expect('id').value;
			this.expectSymbol('=');
			const number = this.fieldNumber();
			this.fieldOptions();
			this.expectSymbol('{');
			const groupName = `${scope}.${name}`;
			this.parseMessageBody(groupName);
			fields.push({ name: name.toLowerCase(), jsonName: protoJsonName(name.toLowerCase()), number, type: 'group', typeName: groupName, scope, repeated, packed: undefined, presence, oneof });
			return;
		}

		const nameToken = this.next();
		if (nameToken.kind !== 'id' || nameToken.value.includes('.')) {
			throw this.error(nameToken, `expected a field name after ${typeToken.value}, found "${nameToken.value}"`);
		}
		this.expectSymbol('=');
		const number = this.fieldNumber();
		const options = this.fieldOptions();
		this.expectSymbol(';');
		fields.push(this.field(nameToken.value, number, typeToken.value, scope, repeated, presence, oneof, options));
	}

	private field(name: string, number: number, type: string, scope: string, repeated: boolean, presence: boolean, oneof: string | undefined, options: IFieldOptions): IProtoField {
		const scalar = SCALARS.has(type);
		return {
			name, jsonName: options.jsonName ?? protoJsonName(name), number,
			type: scalar ? type as ProtoScalarType : 'unresolved',
			typeName: scalar ? '' : type,
			scope, repeated, packed: options.packed, presence, oneof,
		};
	}

	private fieldNumber(): number {
		const token = this.expect('num');
		const value = /^0[0-7]+$/.test(token.value) ? parseInt(token.value, 8) : Number(token.value);
		if (!Number.isInteger(value) || value < 1 || value > 536870911) {
			throw this.error(token, `${token.value} is not a field number`);
		}
		return value;
	}

	/** `[deprecated = true, json_name = "x"]` after a field or enum value, when there is one. */
	private fieldOptions(): IFieldOptions {
		const options: IFieldOptions = {};
		if (this.peek().value !== '[' || this.peek().kind !== 'sym') {
			return options;
		}
		this.next();
		let depth = 0;
		for (; ;) {
			const token = this.next();
			if (token.kind === 'eof') {
				throw this.error(token, 'field options never end');
			}
			if (token.kind === 'sym' && (token.value === '{' || token.value === '[')) {
				depth++;
			} else if (token.kind === 'sym' && token.value === '}') {
				depth--;
			} else if (token.kind === 'sym' && token.value === ']') {
				if (depth === 0) {
					return options;
				}
				depth--;
			} else if (depth === 0 && token.kind === 'id' && this.peek().value === '=') {
				const value = this.peek(1);
				if (token.value === 'json_name' && value.kind === 'str') {
					options.jsonName = value.value;
				} else if (token.value === 'packed' && value.kind === 'id') {
					options.packed = value.value === 'true';
				}
			}
		}
	}

	private parseEnum(scope: string): void {
		const name = this.expect('id').value;
		const fullName = scope ? `${scope}.${name}` : name;
		this.expectSymbol('{');
		const values: { name: string; number: number }[] = [];
		let allowAlias = false;
		for (; ;) {
			const token = this.next();
			if (token.kind === 'sym' && token.value === '}') {
				break;
			}
			if (token.kind === 'sym' && token.value === ';') {
				continue;
			}
			if (token.kind !== 'id') {
				throw this.error(token, `unexpected "${token.value}" in enum ${fullName}`);
			}
			if (token.value === 'option' && this.peek().kind === 'id') {
				if (this.peek().value === 'allow_alias' && this.peek(2).value === 'true') {
					allowAlias = true;
				}
				this.skipStatement();
				continue;
			}
			if (token.value === 'reserved' && this.peek().value !== '=') {
				this.skipStatement();
				continue;
			}
			this.expectSymbol('=');
			const negative = this.peek().kind === 'sym' && this.peek().value === '-';
			if (negative) {
				this.next();
			}
			const numberToken = this.expect('num');
			const number = (negative ? -1 : 1) * Number(numberToken.value);
			if (!Number.isInteger(number)) {
				throw this.error(numberToken, `${numberToken.value} is not an enum number`);
			}
			this.fieldOptions();
			this.expectSymbol(';');
			values.push({ name: token.value, number });
		}
		this.enums.push({ fullName, values, allowAlias });
	}

	private parseService(): void {
		const name = this.expect('id').value;
		const fullName = this.package ? `${this.package}.${name}` : name;
		this.expectSymbol('{');
		const methods: IProtoMethod[] = [];
		for (; ;) {
			const token = this.next();
			if (token.kind === 'sym' && token.value === '}') {
				break;
			}
			if (token.kind === 'sym' && token.value === ';') {
				continue;
			}
			if (token.kind === 'id' && token.value === 'option') {
				this.skipStatement();
				continue;
			}
			if (token.kind !== 'id' || token.value !== 'rpc') {
				throw this.error(token, `unexpected "${token.value}" in service ${fullName}`);
			}
			const method = this.expect('id').value;
			const [inputType, clientStreaming] = this.rpcType();
			const returns = this.expect('id');
			if (returns.value !== 'returns') {
				throw this.error(returns, `expected "returns", found "${returns.value}"`);
			}
			const [outputType, serverStreaming] = this.rpcType();
			const end = this.next();
			if (end.kind === 'sym' && end.value === '{') {
				this.skipBlock();
			} else if (end.kind !== 'sym' || end.value !== ';') {
				throw this.error(end, `expected ";" or "{" after rpc ${method}, found "${end.value}"`);
			}
			methods.push({ name: method, inputType, outputType, clientStreaming, serverStreaming });
		}
		this.services.push({ fullName, scope: this.package, methods });
	}

	private rpcType(): [string, boolean] {
		this.expectSymbol('(');
		let type = this.expect('id').value;
		let streaming = false;
		if (type === 'stream' && this.peek().kind === 'id') {
			streaming = true;
			type = this.next().value;
		}
		this.expectSymbol(')');
		return [type, streaming];
	}

	/** Skips to the `;` that ends the statement, over any braces and brackets in it. */
	private skipStatement(): void {
		let depth = 0;
		for (; ;) {
			const token = this.next();
			if (token.kind === 'eof') {
				throw this.error(token, 'a statement never ends');
			}
			if (token.kind !== 'sym') {
				continue;
			}
			if (token.value === '{' || token.value === '[') {
				depth++;
			} else if (token.value === '}' || token.value === ']') {
				depth--;
			} else if (token.value === ';' && depth <= 0) {
				return;
			}
		}
	}

	/** Skips `name { ... }`. */
	private skipBlockStatement(): void {
		for (; ;) {
			const token = this.next();
			if (token.kind === 'eof') {
				throw this.error(token, 'a block never starts');
			}
			if (token.kind === 'sym' && token.value === '{') {
				this.skipBlock();
				return;
			}
		}
	}

	/** Skips to the brace that closes the one just read. */
	private skipBlock(): void {
		let depth = 1;
		while (depth > 0) {
			const token = this.next();
			if (token.kind === 'eof') {
				throw this.error(token, 'a block never ends');
			}
			if (token.kind === 'sym' && token.value === '{') {
				depth++;
			} else if (token.kind === 'sym' && token.value === '}') {
				depth--;
			}
		}
	}

	private peek(ahead = 0): IToken {
		return this.tokens[Math.min(this.pos + ahead, this.tokens.length - 1)];
	}

	private next(): IToken {
		const token = this.peek();
		if (this.pos < this.tokens.length - 1) {
			this.pos++;
		}
		return token;
	}

	private expect(kind: 'id' | 'num' | 'str'): IToken {
		const token = this.next();
		if (token.kind !== kind) {
			const what = kind === 'id' ? 'a name' : kind === 'num' ? 'a number' : 'a quoted string';
			throw this.error(token, `expected ${what}, found "${token.value}"`);
		}
		return token;
	}

	private expectSymbol(symbol: string): void {
		const token = this.next();
		if (token.kind !== 'sym' || token.value !== symbol) {
			throw this.error(token, `expected "${symbol}", found "${token.value || 'the end of the file'}"`);
		}
	}

	private error(token: IToken, message: string): ProtoError {
		return new ProtoError(`${this.file}:${token.line}: ${message}`);
	}
}

/** Parses one `.proto` text. Type names stay as written until a registry resolves them. */
export function parseProto(text: string, fileName = 'input.proto'): IProtoFile {
	return new ProtoParser(text, fileName).parse();
}

//#endregion

//#region descriptors (server reflection)

const DESCRIPTOR_TYPES: readonly (ProtoFieldType | undefined)[] = [
	undefined, 'double', 'float', 'int64', 'uint64', 'int32', 'fixed64', 'fixed32', 'bool', 'string', 'group', 'message',
	'bytes', 'uint32', 'enum', 'sfixed32', 'sfixed64', 'sint32', 'sint64',
];

function absoluteName(name: string): string {
	return name.startsWith('.') ? name.slice(1) : name;
}

function decodeDescriptorMessage(bytes: Uint8Array, scope: string, syntax: 'proto2' | 'proto3', file: { messages: IProtoMessage[]; enums: IProtoEnum[] }, depth: number): void {
	if (depth > MAX_DEPTH) {
		throw malformed('message descriptors are nested too deeply');
	}
	let name = '';
	let mapEntry = false;
	const fieldBytes: Uint8Array[] = [];
	const nested: Uint8Array[] = [];
	const enums: Uint8Array[] = [];
	const oneofs: string[] = [];
	eachField(bytes, (number, wireType, reader) => {
		if (wireType !== WIRE_LEN) {
			return false;
		}
		switch (number) {
			case 1: name = reader.string(); return true;
			case 2: fieldBytes.push(reader.bytes()); return true;
			case 3: nested.push(reader.bytes()); return true;
			case 4: enums.push(reader.bytes()); return true;
			case 7:
				eachField(reader.bytes(), (optionNumber, optionWireType, optionReader) => {
					if (optionNumber === 7 && optionWireType === WIRE_VARINT) {
						mapEntry = optionReader.varint() !== 0n;
						return true;
					}
					return false;
				});
				return true;
			case 8:
				eachField(reader.bytes(), (oneofNumber, oneofWireType, oneofReader) => {
					if (oneofNumber === 1 && oneofWireType === WIRE_LEN) {
						oneofs.push(oneofReader.string());
						return true;
					}
					return false;
				});
				return true;
			default: return false;
		}
	});
	const fullName = scope ? `${scope}.${name}` : name;
	const fields: IProtoField[] = [];
	const realOneofs = new Set<string>();
	for (const raw of fieldBytes) {
		let fieldName = '';
		let jsonName: string | undefined;
		let fieldNumber = 0;
		let label = 1;
		let type = 0;
		let typeName = '';
		let oneofIndex = -1;
		let proto3Optional = false;
		let packed: boolean | undefined;
		eachField(raw, (number, wireType, reader) => {
			if (wireType === WIRE_LEN) {
				switch (number) {
					case 1: fieldName = reader.string(); return true;
					case 6: typeName = reader.string(); return true;
					case 10: jsonName = reader.string(); return true;
					case 8:
						eachField(reader.bytes(), (optionNumber, optionWireType, optionReader) => {
							if (optionNumber === 2 && optionWireType === WIRE_VARINT) {
								packed = optionReader.varint() !== 0n;
								return true;
							}
							return false;
						});
						return true;
					default: return false;
				}
			}
			if (wireType === WIRE_VARINT) {
				switch (number) {
					case 3: fieldNumber = Number(BigInt.asIntN(32, reader.varint())); return true;
					case 4: label = Number(reader.varint()); return true;
					case 5: type = Number(reader.varint()); return true;
					case 9: oneofIndex = Number(BigInt.asIntN(32, reader.varint())); return true;
					case 17: proto3Optional = reader.varint() !== 0n; return true;
					default: return false;
				}
			}
			return false;
		});
		const fieldType = DESCRIPTOR_TYPES[type];
		if (!fieldType) {
			throw new ProtoError(`The descriptor of ${fullName}.${fieldName} has the unknown type ${type}`);
		}
		const repeated = label === 3;
		const oneof = oneofIndex >= 0 && !proto3Optional ? oneofs[oneofIndex] : undefined;
		if (oneof !== undefined) {
			realOneofs.add(oneof);
		}
		// protoc writes type names absolute (`.a.B`). Descriptors built another way (protobuf.js, which
		// @grpc/reflection serves) write them as the .proto did, so those are looked up by scope.
		const named = fieldType === 'message' || fieldType === 'enum';
		fields.push({
			name: fieldName, jsonName: jsonName || protoJsonName(fieldName), number: fieldNumber,
			type: named && !typeName.startsWith('.') ? 'unresolved' : fieldType,
			typeName: absoluteName(typeName), scope: fullName, repeated, packed,
			presence: !repeated && oneof === undefined && (syntax === 'proto2' || proto3Optional), oneof,
		});
	}
	file.messages.push({ fullName, fields, oneofs: oneofs.filter(oneof => realOneofs.has(oneof)), mapEntry, syntax });
	for (const raw of nested) {
		decodeDescriptorMessage(raw, fullName, syntax, file, depth + 1);
	}
	for (const raw of enums) {
		file.enums.push(decodeDescriptorEnum(raw, fullName));
	}
}

function decodeDescriptorEnum(bytes: Uint8Array, scope: string): IProtoEnum {
	let name = '';
	let allowAlias = false;
	const values: { name: string; number: number }[] = [];
	eachField(bytes, (number, wireType, reader) => {
		if (wireType !== WIRE_LEN) {
			return false;
		}
		if (number === 1) {
			name = reader.string();
			return true;
		}
		if (number === 2) {
			let valueName = '';
			let valueNumber = 0;
			eachField(reader.bytes(), (valueField, valueWireType, valueReader) => {
				if (valueField === 1 && valueWireType === WIRE_LEN) {
					valueName = valueReader.string();
					return true;
				}
				if (valueField === 2 && valueWireType === WIRE_VARINT) {
					valueNumber = Number(BigInt.asIntN(32, valueReader.varint()));
					return true;
				}
				return false;
			});
			values.push({ name: valueName, number: valueNumber });
			return true;
		}
		if (number === 3) {
			eachField(reader.bytes(), (optionNumber, optionWireType, optionReader) => {
				if (optionNumber === 2 && optionWireType === WIRE_VARINT) {
					allowAlias = optionReader.varint() !== 0n;
					return true;
				}
				return false;
			});
			return true;
		}
		return false;
	});
	return { fullName: scope ? `${scope}.${name}` : name, values, allowAlias };
}

function decodeDescriptorService(bytes: Uint8Array, scope: string): IProtoService {
	let name = '';
	const methods: IProtoMethod[] = [];
	eachField(bytes, (number, wireType, reader) => {
		if (wireType !== WIRE_LEN) {
			return false;
		}
		if (number === 1) {
			name = reader.string();
			return true;
		}
		if (number === 2) {
			let methodName = '';
			let inputType = '';
			let outputType = '';
			let clientStreaming = false;
			let serverStreaming = false;
			eachField(reader.bytes(), (methodField, methodWireType, methodReader) => {
				if (methodWireType === WIRE_LEN) {
					switch (methodField) {
						case 1: methodName = methodReader.string(); return true;
						case 2: inputType = methodReader.string(); return true;
						case 3: outputType = methodReader.string(); return true;
						default: return false;
					}
				}
				if (methodWireType === WIRE_VARINT) {
					switch (methodField) {
						case 5: clientStreaming = methodReader.varint() !== 0n; return true;
						case 6: serverStreaming = methodReader.varint() !== 0n; return true;
						default: return false;
					}
				}
				return false;
			});
			methods.push({ name: methodName, inputType, outputType, clientStreaming, serverStreaming });
			return true;
		}
		return false;
	});
	return { fullName: scope ? `${scope}.${name}` : name, scope, methods };
}

/** Reads a serialized `google.protobuf.FileDescriptorProto`. */
export function decodeFileDescriptor(bytes: Uint8Array): IProtoFile {
	let name = '';
	let packageName = '';
	let syntax: 'proto2' | 'proto3' = 'proto2';
	const imports: string[] = [];
	const messageBytes: Uint8Array[] = [];
	const enumBytes: Uint8Array[] = [];
	const serviceBytes: Uint8Array[] = [];
	eachField(bytes, (number, wireType, reader) => {
		if (number === 14 && wireType === WIRE_VARINT) {
			// An edition: its defaults (packed, no required) are proto3's as far as the codec goes.
			reader.varint();
			syntax = 'proto3';
			return true;
		}
		if (wireType !== WIRE_LEN) {
			return false;
		}
		switch (number) {
			case 1: name = reader.string(); return true;
			case 2: packageName = reader.string(); return true;
			case 3: imports.push(reader.string()); return true;
			case 4: messageBytes.push(reader.bytes()); return true;
			case 5: enumBytes.push(reader.bytes()); return true;
			case 6: serviceBytes.push(reader.bytes()); return true;
			case 12: syntax = reader.string() === 'proto2' ? 'proto2' : 'proto3'; return true;
			default: return false;
		}
	});
	const file: IProtoFile = { name, syntax, package: packageName, imports, messages: [], enums: [], services: [] };
	for (const raw of messageBytes) {
		decodeDescriptorMessage(raw, packageName, syntax, file, 0);
	}
	for (const raw of enumBytes) {
		file.enums.push(decodeDescriptorEnum(raw, packageName));
	}
	for (const raw of serviceBytes) {
		file.services.push(decodeDescriptorService(raw, packageName));
	}
	return file;
}

//#endregion

//#region well-known types

/** The `google/protobuf/*.proto` files an import may name, so they resolve without files. */
export const WELL_KNOWN_PROTOS: Readonly<Record<string, string>> = {
	'google/protobuf/any.proto': `syntax = "proto3"; package google.protobuf;
message Any { string type_url = 1; bytes value = 2; }`,
	'google/protobuf/timestamp.proto': `syntax = "proto3"; package google.protobuf;
message Timestamp { int64 seconds = 1; int32 nanos = 2; }`,
	'google/protobuf/duration.proto': `syntax = "proto3"; package google.protobuf;
message Duration { int64 seconds = 1; int32 nanos = 2; }`,
	'google/protobuf/empty.proto': `syntax = "proto3"; package google.protobuf;
message Empty {}`,
	'google/protobuf/field_mask.proto': `syntax = "proto3"; package google.protobuf;
message FieldMask { repeated string paths = 1; }`,
	'google/protobuf/struct.proto': `syntax = "proto3"; package google.protobuf;
message Struct { map<string, Value> fields = 1; }
message Value {
	oneof kind {
		NullValue null_value = 1;
		double number_value = 2;
		string string_value = 3;
		bool bool_value = 4;
		Struct struct_value = 5;
		ListValue list_value = 6;
	}
}
enum NullValue { NULL_VALUE = 0; }
message ListValue { repeated Value values = 1; }`,
	'google/protobuf/wrappers.proto': `syntax = "proto3"; package google.protobuf;
message DoubleValue { double value = 1; }
message FloatValue { float value = 1; }
message Int64Value { int64 value = 1; }
message UInt64Value { uint64 value = 1; }
message Int32Value { int32 value = 1; }
message UInt32Value { uint32 value = 1; }
message BoolValue { bool value = 1; }
message StringValue { string value = 1; }
message BytesValue { bytes value = 1; }`,
	// The part of descriptor.proto that describes files, messages, fields, enums and services.
	'google/protobuf/descriptor.proto': `syntax = "proto2"; package google.protobuf;
message FileDescriptorSet { repeated FileDescriptorProto file = 1; }
message FileDescriptorProto {
	optional string name = 1;
	optional string package = 2;
	repeated string dependency = 3;
	repeated int32 public_dependency = 10;
	repeated int32 weak_dependency = 11;
	repeated DescriptorProto message_type = 4;
	repeated EnumDescriptorProto enum_type = 5;
	repeated ServiceDescriptorProto service = 6;
	repeated FieldDescriptorProto extension = 7;
	optional FileOptions options = 8;
	optional string syntax = 12;
}
message DescriptorProto {
	optional string name = 1;
	repeated FieldDescriptorProto field = 2;
	repeated FieldDescriptorProto extension = 6;
	repeated DescriptorProto nested_type = 3;
	repeated EnumDescriptorProto enum_type = 4;
	optional MessageOptions options = 7;
	repeated OneofDescriptorProto oneof_decl = 8;
}
message FieldDescriptorProto {
	enum Type {
		TYPE_DOUBLE = 1; TYPE_FLOAT = 2; TYPE_INT64 = 3; TYPE_UINT64 = 4; TYPE_INT32 = 5; TYPE_FIXED64 = 6;
		TYPE_FIXED32 = 7; TYPE_BOOL = 8; TYPE_STRING = 9; TYPE_GROUP = 10; TYPE_MESSAGE = 11; TYPE_BYTES = 12;
		TYPE_UINT32 = 13; TYPE_ENUM = 14; TYPE_SFIXED32 = 15; TYPE_SFIXED64 = 16; TYPE_SINT32 = 17; TYPE_SINT64 = 18;
	}
	enum Label { LABEL_OPTIONAL = 1; LABEL_REQUIRED = 2; LABEL_REPEATED = 3; }
	optional string name = 1;
	optional int32 number = 3;
	optional Label label = 4;
	optional Type type = 5;
	optional string type_name = 6;
	optional string extendee = 2;
	optional string default_value = 7;
	optional int32 oneof_index = 9;
	optional string json_name = 10;
	optional FieldOptions options = 8;
	optional bool proto3_optional = 17;
}
message OneofDescriptorProto { optional string name = 1; }
message EnumDescriptorProto {
	optional string name = 1;
	repeated EnumValueDescriptorProto value = 2;
	optional EnumOptions options = 3;
}
message EnumValueDescriptorProto { optional string name = 1; optional int32 number = 2; }
message ServiceDescriptorProto { optional string name = 1; repeated MethodDescriptorProto method = 2; }
message MethodDescriptorProto {
	optional string name = 1;
	optional string input_type = 2;
	optional string output_type = 3;
	optional bool client_streaming = 5;
	optional bool server_streaming = 6;
}
message FileOptions { optional string java_package = 1; optional string go_package = 11; }
message MessageOptions { optional bool deprecated = 3; optional bool map_entry = 7; }
message FieldOptions { optional bool packed = 2; optional bool deprecated = 3; }
message EnumOptions { optional bool allow_alias = 2; optional bool deprecated = 3; }`,
};

const WRAPPERS: ReadonlySet<string> = new Set(['DoubleValue', 'FloatValue', 'Int64Value', 'UInt64Value', 'Int32Value', 'UInt32Value', 'BoolValue', 'StringValue', 'BytesValue'].map(name => `google.protobuf.${name}`));

/** The well-known types whose JSON form is not the plain message. */
function hasSpecialJson(fullName: string): boolean {
	if (!fullName.startsWith('google.protobuf.')) {
		return false;
	}
	switch (fullName) {
		case 'google.protobuf.Timestamp':
		case 'google.protobuf.Duration':
		case 'google.protobuf.Struct':
		case 'google.protobuf.Value':
		case 'google.protobuf.ListValue':
		case 'google.protobuf.FieldMask':
		case 'google.protobuf.Any':
			return true;
		default:
			return WRAPPERS.has(fullName);
	}
}

const TIMESTAMP_PATTERN = /^(\d{4}-\d\d-\d\d)[Tt ](\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?([Zz]|[+-]\d\d:\d\d)$/;
const DURATION_PATTERN = /^(-)?(\d+)(?:\.(\d{1,9}))?s$/;

/** Nanoseconds as protobuf JSON writes them: nothing, or 3, 6 or 9 digits. */
function fraction(nanos: number): string {
	if (nanos === 0) {
		return '';
	}
	const digits = String(Math.abs(nanos)).padStart(9, '0');
	if (digits.endsWith('000000')) {
		return `.${digits.slice(0, 3)}`;
	}
	return digits.endsWith('000') ? `.${digits.slice(0, 6)}` : `.${digits}`;
}

let wellKnownFiles: IProtoFile[] | undefined;

//#endregion

//#region registry and codec

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function joinPath(path: string, key: string): string {
	return path ? `${path}.${key}` : key;
}

function fail(path: string, message: string): ProtoError {
	return new ProtoError(path ? `${path}: ${message}` : message);
}

function setKey(target: { [key: string]: ProtoJson }, key: string, value: ProtoJson): void {
	if (key === '__proto__') {
		Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
	} else {
		target[key] = value;
	}
}

function toBase64(bytes: Uint8Array): string {
	return encodeBase64(VSBuffer.wrap(bytes));
}

function fromBase64(text: string, path: string): Uint8Array {
	const compact = text.replace(/\s+/g, '');
	if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(compact)) {
		throw fail(path, 'expected base64 text');
	}
	return decodeBase64(compact).buffer;
}

function wireTypeOf(type: ProtoFieldType): number {
	switch (type) {
		case 'double': case 'fixed64': case 'sfixed64': return WIRE_FIXED64;
		case 'float': case 'fixed32': case 'sfixed32': return WIRE_FIXED32;
		case 'string': case 'bytes': case 'message': return WIRE_LEN;
		case 'group': return WIRE_START_GROUP;
		default: return WIRE_VARINT;
	}
}

/** Numbers and enums can be packed into one length-delimited value. */
function isPackable(type: ProtoFieldType): boolean {
	return type !== 'string' && type !== 'bytes' && type !== 'message' && type !== 'group';
}

const INT_RANGES: Readonly<Record<string, readonly [bigint, bigint]>> = {
	int32: [-(2n ** 31n), 2n ** 31n - 1n], sint32: [-(2n ** 31n), 2n ** 31n - 1n], sfixed32: [-(2n ** 31n), 2n ** 31n - 1n],
	uint32: [0n, 2n ** 32n - 1n], fixed32: [0n, 2n ** 32n - 1n],
	int64: [-(2n ** 63n), 2n ** 63n - 1n], sint64: [-(2n ** 63n), 2n ** 63n - 1n], sfixed64: [-(2n ** 63n), 2n ** 63n - 1n],
	uint64: [0n, 2n ** 64n - 1n], fixed64: [0n, 2n ** 64n - 1n],
	enum: [-(2n ** 31n), 2n ** 31n - 1n],
};

function toInteger(value: unknown, type: string, path: string): bigint {
	let result: bigint;
	if (typeof value === 'bigint') {
		result = value;
	} else if (typeof value === 'number' && Number.isInteger(value)) {
		result = BigInt(value);
	} else if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) {
		result = BigInt(value.trim());
	} else {
		throw fail(path, typeof value === 'number' ? `expected a whole number (${type})` : `expected a number (${type})`);
	}
	const [min, max] = INT_RANGES[type];
	if (result < min || result > max) {
		throw fail(path, `${result} does not fit ${type} (${min} to ${max})`);
	}
	return result;
}

function toFloat(value: unknown, type: string, path: string): number {
	if (typeof value === 'number') {
		return value;
	}
	if (typeof value === 'string') {
		const text = value.trim();
		if (text === 'NaN') {
			return NaN;
		}
		if (text === 'Infinity' || text === '-Infinity') {
			return text === 'Infinity' ? Infinity : -Infinity;
		}
		if (text !== '' && Number.isFinite(Number(text))) {
			return Number(text);
		}
	}
	throw fail(path, `expected a number (${type})`);
}

function floatToJson(value: number, single: boolean): ProtoJson {
	if (Number.isNaN(value)) {
		return 'NaN';
	}
	if (!Number.isFinite(value)) {
		return value > 0 ? 'Infinity' : '-Infinity';
	}
	if (single) {
		// The shortest decimal that still reads back as this 32-bit float (1.1, not 1.100000023841858).
		for (let precision = 1; precision <= 9; precision++) {
			const candidate = Number(value.toPrecision(precision));
			if (Math.fround(candidate) === value) {
				return candidate;
			}
		}
	}
	return value;
}

type Converted = bigint | number | boolean | string | Uint8Array;

function isDefault(value: Converted): boolean {
	if (value instanceof Uint8Array) {
		return value.length === 0;
	}
	return value === 0n || value === 0 || value === false || value === '';
}

interface IMessageIndex {
	readonly byNumber: Map<number, IProtoField>;
	readonly byName: Map<string, IProtoField>;
}

/**
 * The messages, enums and services of a set of `.proto` files (or descriptors), by full name, and
 * the codec over them. The well-known `google.protobuf` types are always there.
 */
export class ProtoRegistry {

	readonly messages = new Map<string, IProtoMessage>();
	readonly enums = new Map<string, IProtoEnum>();
	readonly services = new Map<string, IProtoService>();
	private readonly files = new Set<string>();
	private readonly indexes = new Map<IProtoMessage, IMessageIndex>();

	constructor() {
		if (!wellKnownFiles) {
			wellKnownFiles = Object.entries(WELL_KNOWN_PROTOS).map(([name, text]) => parseProto(text, name));
		}
		for (const file of wellKnownFiles) {
			this.addFile(file);
		}
	}

	/**
	 * A registry from `.proto` texts: `root` (the first entry when absent) and everything it imports.
	 * An import is found by its path, then by its file name alone; `google/protobuf/*` are built in.
	 * An import that is nowhere is left out (it only matters when one of its types is used).
	 */
	static fromProtos(files: Readonly<Record<string, string>> | ((name: string) => string | undefined), root?: string): ProtoRegistry {
		const registry = new ProtoRegistry();
		let resolve: (name: string) => string | undefined;
		if (typeof files === 'function') {
			resolve = files;
		} else {
			const names = Object.keys(files);
			root ??= names[0];
			const baseName = (name: string) => name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
			resolve = name => {
				if (Object.prototype.hasOwnProperty.call(files, name)) {
					return files[name];
				}
				const base = baseName(name);
				const match = names.find(candidate => candidate.replace(/^\.\//, '') === name.replace(/^\.\//, '')) ?? names.find(candidate => baseName(candidate) === base);
				return match === undefined ? undefined : files[match];
			};
		}
		if (root === undefined) {
			throw new ProtoError('No .proto file was given');
		}
		const pending = [root];
		const seen = new Set<string>();
		while (pending.length) {
			const name = pending.shift()!;
			if (seen.has(name) || registry.hasFile(name)) {
				continue;
			}
			seen.add(name);
			const text = resolve(name);
			if (text === undefined) {
				if (name === root) {
					throw new ProtoError(`The .proto file ${name} was not given`);
				}
				continue;
			}
			pending.push(...registry.addProto(text, name).imports);
		}
		return registry;
	}

	/** A registry from serialized `google.protobuf.FileDescriptorProto`s, in any order. */
	static fromDescriptors(descriptors: readonly Uint8Array[]): ProtoRegistry {
		const registry = new ProtoRegistry();
		for (const bytes of descriptors) {
			registry.addDescriptor(bytes);
		}
		return registry;
	}

	hasFile(name: string): boolean {
		return this.files.has(name);
	}

	addProto(text: string, fileName = 'input.proto'): IProtoFile {
		const file = parseProto(text, fileName);
		this.addFile(file);
		return file;
	}

	addDescriptor(bytes: Uint8Array): IProtoFile {
		const file = decodeFileDescriptor(bytes);
		this.addFile(file);
		return file;
	}

	addFile(file: IProtoFile): void {
		this.files.add(file.name);
		for (const message of file.messages) {
			this.messages.set(message.fullName, message);
		}
		for (const item of file.enums) {
			this.enums.set(item.fullName, item);
		}
		for (const service of file.services) {
			this.services.set(service.fullName, service);
		}
	}

	/**
	 * A type name as protobuf scopes it: `.a.B` is absolute; anything else is looked for in `scope`,
	 * then in each scope around it, outward.
	 */
	resolveTypeName(name: string, scope: string): string | undefined {
		if (name.startsWith('.')) {
			const absolute = name.slice(1);
			return this.messages.has(absolute) || this.enums.has(absolute) ? absolute : undefined;
		}
		for (let current = scope; ; current = current.slice(0, Math.max(current.lastIndexOf('.'), 0))) {
			const candidate = current ? `${current}.${name}` : name;
			if (this.messages.has(candidate) || this.enums.has(candidate)) {
				return candidate;
			}
			if (!current) {
				return undefined;
			}
		}
	}

	getMessage(name: string): IProtoMessage {
		const message = this.messages.get(absoluteName(name));
		if (!message) {
			throw new ProtoError(`Unknown message type ${absoluteName(name)}`);
		}
		return message;
	}

	/** The request and response messages of a method. */
	methodTypes(service: IProtoService, method: IProtoMethod): { readonly input: IProtoMessage; readonly output: IProtoMessage } {
		const find = (name: string) => {
			const resolved = this.resolveTypeName(name, service.scope);
			const message = resolved === undefined ? undefined : this.messages.get(resolved);
			if (!message) {
				throw new ProtoError(`Unknown message type ${absoluteName(name)} (method ${service.fullName}.${method.name})`);
			}
			return message;
		};
		return { input: find(method.inputType), output: find(method.outputType) };
	}

	/** JSON value -> bytes of the message type `typeName`. Throws a `ProtoError` naming the field that does not fit. */
	encode(typeName: string, value: unknown): Uint8Array {
		return this.encodeMessage(this.getMessage(typeName), value, '', false, 0);
	}

	/** Bytes of the message type `typeName` -> JSON value. Throws a `ProtoError` on malformed bytes. */
	decode(typeName: string, bytes: Uint8Array): ProtoJson {
		return this.decodeMessage(this.getMessage(typeName), bytes, 0);
	}

	/**
	 * A JSON value with every field of the message at its default, to start editing from: nested
	 * messages are expanded `depth` levels (and never into a type they are already inside), enums are
	 * their first name, repeated fields `[]`, maps `{}`, and a oneof shows its first member.
	 */
	templateOf(typeName: string, depth = 3): ProtoJson {
		return this.template(this.getMessage(typeName), depth, []);
	}

	//#region internals

	private index(message: IProtoMessage): IMessageIndex {
		let index = this.indexes.get(message);
		if (!index) {
			index = { byNumber: new Map(), byName: new Map() };
			for (const field of message.fields) {
				index.byNumber.set(field.number, field);
			}
			// The name as written wins over another field's JSON name.
			for (const field of message.fields) {
				for (const name of [protoJsonName(field.name), field.jsonName]) {
					if (!index.byName.has(name)) {
						index.byName.set(name, field);
					}
				}
			}
			for (const field of message.fields) {
				index.byName.set(field.name, field);
			}
			this.indexes.set(message, index);
		}
		return index;
	}

	/** Looks a field's type name up, the first time the field is used. */
	private resolve(field: IProtoField): void {
		if (field.type !== 'unresolved') {
			return;
		}
		const resolved = this.resolveTypeName(field.typeName, field.scope);
		if (resolved === undefined) {
			throw new ProtoError(`Unknown type ${field.typeName} (field ${field.scope}.${field.name})`);
		}
		field.typeName = resolved;
		field.type = this.messages.has(resolved) ? 'message' : 'enum';
	}

	private mapEntryOf(field: IProtoField): IProtoMessage | undefined {
		if (!field.repeated || field.type !== 'message') {
			return undefined;
		}
		const entry = this.messages.get(field.typeName);
		return entry?.mapEntry && entry.fields.length === 2 ? entry : undefined;
	}

	private isPacked(message: IProtoMessage, field: IProtoField): boolean {
		return isPackable(field.type) && (field.packed ?? message.syntax === 'proto3');
	}

	private enumOf(field: IProtoField): IProtoEnum {
		const found = this.enums.get(field.typeName);
		if (!found) {
			throw new ProtoError(`Unknown enum type ${field.typeName} (field ${field.scope}.${field.name})`);
		}
		return found;
	}

	private isValueType(field: IProtoField): boolean {
		return field.type === 'message' && field.typeName === 'google.protobuf.Value';
	}

	//#endregion

	//#region encode

	private encodeMessage(message: IProtoMessage, value: unknown, path: string, plain: boolean, depth: number): Uint8Array {
		if (depth > MAX_DEPTH) {
			throw fail(path, 'nested too deeply');
		}
		if (!plain && hasSpecialJson(message.fullName)) {
			const special = this.encodeWellKnown(message, value, path, depth);
			if (special) {
				return special;
			}
		}
		if (!isObject(value)) {
			throw fail(path, `expected an object (${message.fullName})`);
		}
		const index = this.index(message);
		const given = new Map<IProtoField, { key: string; value: unknown }>();
		for (const [key, item] of Object.entries(value)) {
			const field = index.byName.get(key);
			if (!field) {
				throw fail(joinPath(path, key), `${message.fullName} has no such field`);
			}
			if (item === null || item === undefined) {
				this.resolve(field);
				if (!this.isValueType(field) || field.repeated) {
					continue;
				}
			}
			const earlier = given.get(field);
			if (earlier) {
				throw fail(joinPath(path, key), `the same field is also given as ${earlier.key}`);
			}
			given.set(field, { key, value: item });
		}
		const writer = new ProtoWriter();
		const oneofs = new Map<string, string>();
		for (const field of message.fields) {
			const entry = given.get(field);
			if (!entry) {
				continue;
			}
			const fieldPath = joinPath(path, entry.key);
			if (field.oneof !== undefined) {
				const other = oneofs.get(field.oneof);
				if (other !== undefined) {
					throw fail(fieldPath, `only one of the ${field.oneof} fields can be set, and ${other} already is`);
				}
				oneofs.set(field.oneof, entry.key);
			}
			this.writeField(writer, message, field, entry.value, fieldPath, depth);
		}
		return writer.finish();
	}

	private writeField(writer: ProtoWriter, message: IProtoMessage, field: IProtoField, value: unknown, path: string, depth: number): void {
		this.resolve(field);
		const entry = this.mapEntryOf(field);
		if (entry) {
			if (!isObject(value)) {
				throw fail(path, 'expected an object (a map)');
			}
			const [keyField, valueField] = entry.fields;
			this.resolve(valueField);
			for (const [key, item] of Object.entries(value)) {
				const itemPath = joinPath(path, key);
				if ((item === null || item === undefined) && !this.isValueType(valueField)) {
					throw fail(itemPath, 'a map value cannot be null');
				}
				const entryWriter = new ProtoWriter();
				const keyValue: unknown = keyField.type === 'bool' ? (key === 'true' ? true : key === 'false' ? false : key) : key;
				this.writeValue(entryWriter, keyField, keyValue, itemPath, depth, true);
				this.writeValue(entryWriter, valueField, item, itemPath, depth, true);
				writer.tag(field.number, WIRE_LEN).bytes(entryWriter.finish());
			}
			return;
		}
		if (field.repeated) {
			if (!Array.isArray(value)) {
				throw fail(path, 'expected an array');
			}
			const items: readonly unknown[] = value;
			const check = (item: unknown, i: number) => {
				if ((item === null || item === undefined) && !this.isValueType(field)) {
					throw fail(`${path}[${i}]`, 'an array item cannot be null');
				}
			};
			if (this.isPacked(message, field)) {
				if (items.length) {
					const packed = new ProtoWriter();
					items.forEach((item, i) => {
						check(item, i);
						this.writeScalar(packed, field.type, this.convert(field, item, `${path}[${i}]`));
					});
					writer.tag(field.number, WIRE_LEN).bytes(packed.finish());
				}
				return;
			}
			items.forEach((item, i) => {
				check(item, i);
				this.writeValue(writer, field, item, `${path}[${i}]`, depth, true);
			});
			return;
		}
		// proto3 fields without presence are not written at their default.
		this.writeValue(writer, field, value, path, depth, field.presence || field.oneof !== undefined);
	}

	/** One value with its tag. `always` writes it even at its default. */
	private writeValue(writer: ProtoWriter, field: IProtoField, value: unknown, path: string, depth: number, always: boolean): void {
		if (field.type === 'message') {
			writer.tag(field.number, WIRE_LEN).bytes(this.encodeMessage(this.getMessage(field.typeName), value, path, false, depth + 1));
			return;
		}
		if (field.type === 'group') {
			throw fail(path, 'groups cannot be sent');
		}
		const converted = this.convert(field, value, path);
		if (!always && isDefault(converted)) {
			return;
		}
		writer.tag(field.number, wireTypeOf(field.type));
		this.writeScalar(writer, field.type, converted);
	}

	/** A JSON value as what the wire takes: integers and enums as bigint, bytes decoded. */
	private convert(field: IProtoField, value: unknown, path: string): Converted {
		switch (field.type) {
			case 'bool':
				if (typeof value !== 'boolean') {
					throw fail(path, 'expected true or false');
				}
				return value;
			case 'string':
				if (typeof value !== 'string') {
					throw fail(path, 'expected a string');
				}
				return value;
			case 'bytes':
				if (typeof value !== 'string') {
					throw fail(path, 'expected base64 text');
				}
				return fromBase64(value, path);
			case 'float':
			case 'double':
				return toFloat(value, field.type, path);
			case 'enum': {
				const type = this.enumOf(field);
				if (typeof value === 'string' && !/^\s*-?\d+\s*$/.test(value)) {
					const found = type.values.find(candidate => candidate.name === value);
					if (!found) {
						const names = type.values.slice(0, 12).map(candidate => candidate.name).join(', ');
						throw fail(path, `"${value}" is not a value of ${type.fullName} (${names}${type.values.length > 12 ? ', ...' : ''})`);
					}
					return BigInt(found.number);
				}
				if (value === null && type.fullName === 'google.protobuf.NullValue') {
					return 0n;
				}
				return toInteger(value, 'enum', path);
			}
			case 'message':
			case 'group':
			case 'unresolved':
				throw fail(path, 'expected a number');
			default:
				return toInteger(value, field.type, path);
		}
	}

	private writeScalar(writer: ProtoWriter, type: ProtoFieldType, value: Converted): void {
		switch (type) {
			case 'bool': writer.varint(value ? 1n : 0n); break;
			case 'string': writer.string(value as string); break;
			case 'bytes': writer.bytes(value as Uint8Array); break;
			case 'float': writer.float(value as number); break;
			case 'double': writer.double(value as number); break;
			case 'sint32':
			case 'sint64': {
				const number = value as bigint;
				writer.varint((number << 1n) ^ (number >> 63n));
				break;
			}
			case 'fixed32':
			case 'sfixed32': writer.fixed32(Number(BigInt.asUintN(32, value as bigint))); break;
			case 'fixed64':
			case 'sfixed64': writer.fixed64(value as bigint); break;
			default: writer.varint(value as bigint); break;
		}
	}

	/** The bytes of a well-known type from its JSON form, or nothing when `value` is the plain message. */
	private encodeWellKnown(message: IProtoMessage, value: unknown, path: string, depth: number): Uint8Array | undefined {
		const name = message.fullName;
		if (WRAPPERS.has(name)) {
			const writer = new ProtoWriter();
			if (value !== null && value !== undefined) {
				this.writeField(writer, message, message.fields[0], value, path, depth);
			}
			return writer.finish();
		}
		switch (name) {
			case 'google.protobuf.Timestamp': {
				if (isObject(value)) {
					return undefined;
				}
				const match = typeof value === 'string' ? TIMESTAMP_PATTERN.exec(value.trim()) : null;
				const millis = match ? Date.parse(`${match[1]}T${match[2]}${match[4].toUpperCase()}`) : NaN;
				if (!match || Number.isNaN(millis)) {
					throw fail(path, 'expected a time like "2024-01-31T12:00:00Z"');
				}
				return this.encodeMessage(message, { seconds: String(millis / 1000), nanos: Number((match[3] ?? '').padEnd(9, '0')) }, path, true, depth);
			}
			case 'google.protobuf.Duration': {
				if (isObject(value)) {
					return undefined;
				}
				const match = typeof value === 'string' ? DURATION_PATTERN.exec(value.trim()) : null;
				if (!match) {
					throw fail(path, 'expected a duration like "1.5s"');
				}
				const sign = match[1] ? -1 : 1;
				return this.encodeMessage(message, { seconds: `${match[1] ?? ''}${match[2]}`, nanos: sign * Number((match[3] ?? '').padEnd(9, '0')) }, path, true, depth);
			}
			case 'google.protobuf.FieldMask': {
				if (isObject(value)) {
					return undefined;
				}
				if (typeof value !== 'string') {
					throw fail(path, 'expected field paths as text like "name,address.city"');
				}
				const paths = value.split(',').map(item => item.trim()).filter(item => item !== '')
					.map(item => item.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`));
				return this.encodeMessage(message, { paths }, path, true, depth);
			}
			case 'google.protobuf.Struct':
				if (!isObject(value)) {
					throw fail(path, 'expected an object');
				}
				return this.encodeMessage(message, { fields: value }, path, true, depth);
			case 'google.protobuf.ListValue':
				if (!Array.isArray(value)) {
					throw fail(path, 'expected an array');
				}
				return this.encodeMessage(message, { values: value }, path, true, depth);
			case 'google.protobuf.Value': {
				let plain: Record<string, unknown>;
				if (value === null || value === undefined) {
					plain = { nullValue: 'NULL_VALUE' };
				} else if (typeof value === 'number') {
					plain = { numberValue: value };
				} else if (typeof value === 'string') {
					plain = { stringValue: value };
				} else if (typeof value === 'boolean') {
					plain = { boolValue: value };
				} else if (Array.isArray(value)) {
					plain = { listValue: value };
				} else if (isObject(value)) {
					plain = { structValue: value };
				} else {
					throw fail(path, 'expected a JSON value');
				}
				return this.encodeMessage(message, plain, path, true, depth);
			}
			case 'google.protobuf.Any': {
				if (!isObject(value)) {
					throw fail(path, 'expected an object with "@type"');
				}
				const typeUrl = value['@type'];
				if (typeUrl === undefined && (value['typeUrl'] !== undefined || value['type_url'] !== undefined)) {
					return undefined;
				}
				if (typeof typeUrl !== 'string') {
					throw fail(joinPath(path, '@type'), 'expected a string like "type.googleapis.com/package.Message"');
				}
				const typeName = typeUrl.slice(typeUrl.lastIndexOf('/') + 1);
				const target = this.messages.get(typeName);
				let bytes: Uint8Array;
				if (!target) {
					const raw = value['value'];
					if (raw === undefined || raw === null) {
						bytes = new Uint8Array(0);
					} else if (typeof raw !== 'string') {
						throw fail(joinPath(path, 'value'), `the type ${typeName || '(none)'} is not known here, so this must be its bytes as base64`);
					} else {
						bytes = fromBase64(raw, joinPath(path, 'value'));
					}
				} else if (hasSpecialJson(target.fullName)) {
					bytes = this.encodeMessage(target, value['value'], joinPath(path, 'value'), false, depth + 1);
				} else {
					const rest: Record<string, unknown> = { ...value };
					delete rest['@type'];
					bytes = this.encodeMessage(target, rest, path, false, depth + 1);
				}
				const writer = new ProtoWriter();
				if (typeUrl !== '') {
					writer.tag(1, WIRE_LEN).string(typeUrl);
				}
				if (bytes.length) {
					writer.tag(2, WIRE_LEN).bytes(bytes);
				}
				return writer.finish();
			}
			default:
				return undefined;
		}
	}

	//#endregion

	//#region decode

	private decodeMessage(message: IProtoMessage, bytes: Uint8Array, depth: number): ProtoJson {
		if (depth > MAX_DEPTH) {
			throw malformed('messages are nested too deeply');
		}
		if (message.fullName === 'google.protobuf.Any') {
			return this.decodeAny(bytes, depth);
		}
		const index = this.index(message);
		const values = new Map<IProtoField, ProtoJson>();
		const messageBytes = new Map<IProtoField, Uint8Array>();
		const set = (field: IProtoField, value: ProtoJson) => {
			if (field.oneof !== undefined) {
				// The last member on the wire is the one that is set.
				for (const other of message.fields) {
					if (other.oneof === field.oneof && other !== field) {
						values.delete(other);
						messageBytes.delete(other);
					}
				}
			}
			values.set(field, value);
		};
		const reader = new ProtoReader(bytes);
		while (!reader.done) {
			const [number, wireType] = reader.tag();
			const field = index.byNumber.get(number);
			if (!field) {
				reader.skip(wireType);
				continue;
			}
			this.resolve(field);
			const entry = this.mapEntryOf(field);
			if (field.repeated && !entry) {
				let list = values.get(field);
				if (!Array.isArray(list)) {
					list = [];
					values.set(field, list);
				}
				if (wireType === WIRE_LEN && isPackable(field.type)) {
					const packed = new ProtoReader(reader.bytes());
					while (!packed.done) {
						list.push(this.readScalar(packed, field));
					}
				} else if (wireType !== wireTypeOf(field.type) || field.type === 'group') {
					reader.skip(wireType);
				} else if (field.type === 'message') {
					list.push(this.decodeMessage(this.getMessage(field.typeName), reader.bytes(), depth + 1));
				} else {
					list.push(this.readScalar(reader, field));
				}
				continue;
			}
			if (wireType !== wireTypeOf(field.type) || field.type === 'group') {
				// Not what this field takes: an unknown field as far as this schema goes.
				reader.skip(wireType);
				continue;
			}
			if (entry) {
				let map = values.get(field);
				if (!isObject(map)) {
					map = {};
					values.set(field, map);
				}
				const [keyField, valueField] = entry.fields;
				this.resolve(valueField);
				let key = this.defaultOf(keyField);
				let value: ProtoJson | undefined;
				const entryReader = new ProtoReader(reader.bytes());
				while (!entryReader.done) {
					const [entryNumber, entryWireType] = entryReader.tag();
					if (entryNumber === 1 && entryWireType === wireTypeOf(keyField.type)) {
						key = this.readScalar(entryReader, keyField);
					} else if (entryNumber === 2 && entryWireType === wireTypeOf(valueField.type)) {
						value = valueField.type === 'message'
							? this.decodeMessage(this.getMessage(valueField.typeName), entryReader.bytes(), depth + 1)
							: this.readScalar(entryReader, valueField);
					} else {
						entryReader.skip(entryWireType);
					}
				}
				if (value === undefined) {
					value = valueField.type === 'message' ? this.decodeMessage(this.getMessage(valueField.typeName), new Uint8Array(0), depth + 1) : this.defaultOf(valueField);
				}
				setKey(map, String(key), value);
			} else if (field.type === 'message') {
				// A message field that comes twice is the two merged, which is what their bytes joined decode to.
				let raw = reader.bytes();
				const earlier = messageBytes.get(field);
				if (earlier) {
					const joined = new Uint8Array(earlier.length + raw.length);
					joined.set(earlier);
					joined.set(raw, earlier.length);
					raw = joined;
				}
				set(field, this.decodeMessage(this.getMessage(field.typeName), raw, depth + 1));
				messageBytes.set(field, raw);
			} else {
				set(field, this.readScalar(reader, field));
			}
		}
		const out: { [key: string]: ProtoJson } = {};
		for (const field of message.fields) {
			const value = values.get(field);
			if (value !== undefined) {
				setKey(out, field.jsonName, value);
				continue;
			}
			this.resolve(field);
			if (field.repeated) {
				setKey(out, field.jsonName, this.mapEntryOf(field) ? {} : []);
			} else if (field.type !== 'message' && field.type !== 'group' && field.oneof === undefined && !(field.presence && message.syntax === 'proto3')) {
				setKey(out, field.jsonName, this.defaultOf(field));
			}
		}
		return hasSpecialJson(message.fullName) ? this.fromPlain(message.fullName, out) : out;
	}

	private readScalar(reader: ProtoReader, field: IProtoField): ProtoJson {
		switch (field.type) {
			case 'bool': return reader.varint() !== 0n;
			case 'string': return reader.string();
			case 'bytes': return toBase64(reader.bytes());
			case 'float': return floatToJson(reader.float(), true);
			case 'double': return floatToJson(reader.double(), false);
			case 'int32': return Number(BigInt.asIntN(32, reader.varint()));
			case 'uint32': return Number(BigInt.asUintN(32, reader.varint()));
			case 'int64': return String(BigInt.asIntN(64, reader.varint()));
			case 'uint64': return String(reader.varint());
			case 'sint32': {
				const value = reader.varint();
				return Number(BigInt.asIntN(32, (value >> 1n) ^ -(value & 1n)));
			}
			case 'sint64': {
				const value = reader.varint();
				return String(BigInt.asIntN(64, (value >> 1n) ^ -(value & 1n)));
			}
			case 'fixed32': return reader.fixed32();
			case 'sfixed32': return reader.fixed32() | 0;
			case 'fixed64': return String(reader.fixed64());
			case 'sfixed64': return String(BigInt.asIntN(64, reader.fixed64()));
			case 'enum': {
				const number = Number(BigInt.asIntN(32, reader.varint()));
				return this.enumOf(field).values.find(candidate => candidate.number === number)?.name ?? number;
			}
			default: throw new ProtoError(`The field ${field.scope}.${field.name} is not a scalar`);
		}
	}

	private defaultOf(field: IProtoField): ProtoJson {
		this.resolve(field);
		switch (field.type) {
			case 'bool': return false;
			case 'string': case 'bytes': return '';
			case 'int64': case 'uint64': case 'sint64': case 'fixed64': case 'sfixed64': return '0';
			case 'enum': {
				const values = this.enumOf(field).values;
				return (values.find(candidate => candidate.number === 0) ?? values[0])?.name ?? 0;
			}
			case 'message': case 'group': case 'unresolved': return null;
			default: return 0;
		}
	}

	private decodeAny(bytes: Uint8Array, depth: number): ProtoJson {
		let typeUrl = '';
		let value: Uint8Array = new Uint8Array(0);
		eachField(bytes, (number, wireType, reader) => {
			if (number === 1 && wireType === WIRE_LEN) {
				typeUrl = reader.string();
				return true;
			}
			if (number === 2 && wireType === WIRE_LEN) {
				value = reader.bytes();
				return true;
			}
			return false;
		});
		const target = this.messages.get(typeUrl.slice(typeUrl.lastIndexOf('/') + 1));
		if (target) {
			try {
				const decoded = this.decodeMessage(target, value, depth + 1);
				if (hasSpecialJson(target.fullName) || !isObject(decoded)) {
					return { '@type': typeUrl, value: decoded };
				}
				return { '@type': typeUrl, ...decoded };
			} catch {
				// Not what the type says it is: show the bytes.
			}
		}
		return { '@type': typeUrl, value: toBase64(value) };
	}

	/** The JSON form of a well-known type from its plain decoded message. */
	private fromPlain(name: string, plain: { [key: string]: ProtoJson }): ProtoJson {
		if (WRAPPERS.has(name)) {
			return plain['value'] ?? null;
		}
		switch (name) {
			case 'google.protobuf.Timestamp': {
				const seconds = Number(plain['seconds']);
				const nanos = Number(plain['nanos']);
				const date = new Date(seconds * 1000);
				if (Number.isNaN(date.getTime()) || nanos < 0 || nanos > 999999999 || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) {
					return plain;
				}
				return `${date.toISOString().slice(0, 19)}${fraction(nanos)}Z`;
			}
			case 'google.protobuf.Duration': {
				const seconds = BigInt(String(plain['seconds']));
				const nanos = Number(plain['nanos']);
				if (Math.abs(nanos) > 999999999 || (seconds > 0n && nanos < 0) || (seconds < 0n && nanos > 0)) {
					return plain;
				}
				const negative = seconds < 0n || nanos < 0;
				return `${negative ? '-' : ''}${seconds < 0n ? -seconds : seconds}${fraction(nanos)}s`;
			}
			case 'google.protobuf.FieldMask': {
				const paths = plain['paths'];
				return Array.isArray(paths) ? paths.map(item => String(item).replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())).join(',') : '';
			}
			case 'google.protobuf.Struct': return plain['fields'] ?? {};
			case 'google.protobuf.ListValue': return plain['values'] ?? [];
			case 'google.protobuf.Value': {
				const keys = Object.keys(plain);
				return keys.length === 0 || keys[0] === 'nullValue' ? null : plain[keys[0]];
			}
			default: return plain;
		}
	}

	//#endregion

	//#region template

	private template(message: IProtoMessage, depth: number, inside: readonly string[]): ProtoJson {
		const name = message.fullName;
		if (WRAPPERS.has(name)) {
			return this.defaultOf(message.fields[0]);
		}
		switch (name) {
			case 'google.protobuf.Timestamp': return '1970-01-01T00:00:00Z';
			case 'google.protobuf.Duration': return '0s';
			case 'google.protobuf.FieldMask': return '';
			case 'google.protobuf.Struct': return {};
			case 'google.protobuf.ListValue': return [];
			case 'google.protobuf.Value': return null;
			case 'google.protobuf.Any': return { '@type': '' };
		}
		const out: { [key: string]: ProtoJson } = {};
		const oneofs = new Set<string>();
		for (const field of message.fields) {
			this.resolve(field);
			if (field.type === 'group') {
				continue;
			}
			if (field.oneof !== undefined) {
				if (oneofs.has(field.oneof)) {
					continue;
				}
				oneofs.add(field.oneof);
			}
			if (field.repeated) {
				setKey(out, field.jsonName, this.mapEntryOf(field) ? {} : []);
			} else if (field.type === 'message') {
				const target = this.getMessage(field.typeName);
				const expand = hasSpecialJson(target.fullName) || (depth > 0 && target !== message && !inside.includes(target.fullName));
				setKey(out, field.jsonName, expand ? this.template(target, depth - 1, [...inside, name]) : {});
			} else {
				setKey(out, field.jsonName, this.defaultOf(field));
			}
		}
		return out;
	}

	//#endregion
}

//#endregion

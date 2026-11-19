/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { parseProto, ProtoError, ProtoJson, ProtoRegistry } from '../../common/voltProto.js';

function hex(bytes: Uint8Array): string {
	return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(' ');
}

function bytesOf(text: string): Uint8Array {
	return new Uint8Array(text.split(/\s+/).filter(part => part !== '').map(part => parseInt(part, 16)));
}

function registryOf(text: string): ProtoRegistry {
	return ProtoRegistry.fromProtos({ 'test.proto': text });
}

function roundTrip(registry: ProtoRegistry, type: string, value: unknown): ProtoJson {
	return registry.decode(type, registry.encode(type, value));
}

const SCALARS_PROTO = `syntax = "proto3";
package t;
message Scalars {
	double d = 1; float f = 2; int32 i32 = 3; int64 i64 = 4; uint32 u32 = 5; uint64 u64 = 6;
	sint32 s32 = 7; sint64 s64 = 8; fixed32 f32 = 9; fixed64 f64 = 10; sfixed32 sf32 = 11; sfixed64 sf64 = 12;
	bool b = 13; string s = 14; bytes by = 15;
}`;

const SCALAR_DEFAULTS = {
	d: 0, f: 0, i32: 0, i64: '0', u32: 0, u64: '0', s32: 0, s64: '0', f32: 0, f64: '0', sf32: 0, sf64: '0', b: false, s: '', by: '',
};

suite('VoltProto', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('parser', () => {

		test('messages, nested types, oneof, map, enums, comments and what it skips', () => {
			const file = parseProto(`
				// A line comment with a "quote and a { brace
				syntax = "proto3";
				/* A block comment
				message NotReal { } */
				package demo.shop.v1;

				import "google/protobuf/timestamp.proto";
				import public "common/money.proto";

				option java_package = "com.demo";
				option (custom.file_option) = { key: "v;}" nested { a: 1 } };

				message Order {
					option deprecated = false;
					reserved 20, 30 to 40;
					reserved "old_name";
					string id = 1; // trailing comment
					repeated Line lines = 2;
					map<string, int64> stock = 3;
					Status status = 4 [deprecated = true, json_name = "state"];
					oneof payment {
						option (custom.oneof_option) = true;
						string card = 5;
						Cash cash = 6;
					}
					optional int32 discount = 7;
					google.protobuf.Timestamp placed = 8;
					repeated int32 codes = 9 [packed = false];
					message Line {
						string sku = 1;
						uint32 count = 0x02;
						enum Kind { KIND_UNSPECIFIED = 0; GIFT = 1; }
						Kind kind = 3;
					}
					message Cash { double given = 1; }
					enum Status {
						option allow_alias = true;
						STATUS_UNSPECIFIED = 0;
						OPEN = 1;
						ACTIVE = 1 [deprecated = true];
						GONE = -1;
						reserved 9;
					}
					extensions 100 to 199;
				}

				extend google.protobuf.FieldOptions { string note = 50000; }

				service Orders {
					option deprecated = false;
					rpc Get (GetRequest) returns (Order);
					rpc Watch(GetRequest) returns (stream Order) {
						option (google.api.http) = { get: "/v1/orders/{id}" };
					}
					rpc Upload (stream Order) returns (GetRequest) {}
					rpc Talk (stream .demo.shop.v1.Order) returns (stream Order);
				}

				message GetRequest { string id = 1; };
			`, 'shop.proto');

			assert.strictEqual(file.syntax, 'proto3');
			assert.strictEqual(file.package, 'demo.shop.v1');
			assert.deepStrictEqual(file.imports, ['google/protobuf/timestamp.proto', 'common/money.proto']);
			assert.deepStrictEqual(file.messages.map(message => message.fullName), [
				'demo.shop.v1.Order', 'demo.shop.v1.Order.StockEntry', 'demo.shop.v1.Order.Line', 'demo.shop.v1.Order.Cash', 'demo.shop.v1.GetRequest',
			]);
			assert.deepStrictEqual(file.enums.map(item => item.fullName), ['demo.shop.v1.Order.Line.Kind', 'demo.shop.v1.Order.Status']);

			const order = file.messages[0];
			assert.deepStrictEqual(order.fields.map(field => `${field.number}:${field.name}`), ['1:id', '2:lines', '3:stock', '4:status', '5:card', '6:cash', '7:discount', '8:placed', '9:codes']);
			assert.deepStrictEqual(order.oneofs, ['payment']);
			const byName = new Map(order.fields.map(field => [field.name, field]));
			assert.strictEqual(byName.get('status')!.jsonName, 'state');
			assert.strictEqual(byName.get('card')!.oneof, 'payment');
			assert.strictEqual(byName.get('cash')!.oneof, 'payment');
			assert.strictEqual(byName.get('discount')!.presence, true);
			assert.strictEqual(byName.get('id')!.presence, false);
			assert.strictEqual(byName.get('lines')!.repeated, true);
			assert.strictEqual(byName.get('codes')!.packed, false);
			assert.strictEqual(byName.get('stock')!.typeName, 'demo.shop.v1.Order.StockEntry');
			assert.strictEqual(file.messages[1].mapEntry, true);
			assert.deepStrictEqual(file.messages[1].fields.map(field => `${field.number}:${field.name}:${field.type}`), ['1:key:string', '2:value:int64']);
			assert.strictEqual(file.messages[2].fields[1].number, 2);

			const status = file.enums[1];
			assert.strictEqual(status.allowAlias, true);
			assert.deepStrictEqual(status.values, [
				{ name: 'STATUS_UNSPECIFIED', number: 0 }, { name: 'OPEN', number: 1 }, { name: 'ACTIVE', number: 1 }, { name: 'GONE', number: -1 },
			]);

			assert.deepStrictEqual(file.services, [{
				fullName: 'demo.shop.v1.Orders', scope: 'demo.shop.v1', methods: [
					{ name: 'Get', inputType: 'GetRequest', outputType: 'Order', clientStreaming: false, serverStreaming: false },
					{ name: 'Watch', inputType: 'GetRequest', outputType: 'Order', clientStreaming: false, serverStreaming: true },
					{ name: 'Upload', inputType: 'Order', outputType: 'GetRequest', clientStreaming: true, serverStreaming: false },
					{ name: 'Talk', inputType: '.demo.shop.v1.Order', outputType: 'Order', clientStreaming: true, serverStreaming: true },
				],
			}]);
		});

		test('proto2: labels, groups and a file without syntax', () => {
			const file = parseProto(`
				package old;
				message Legacy {
					required string id = 1;
					optional int32 count = 2 [default = 5];
					repeated int32 codes = 3;
					optional group Extra = 4 { optional string note = 1; }
				}
			`);
			assert.strictEqual(file.syntax, 'proto2');
			assert.deepStrictEqual(file.messages.map(message => message.fullName), ['old.Legacy', 'old.Legacy.Extra']);
			assert.deepStrictEqual(file.messages[0].fields.map(field => `${field.name}:${field.type}:${field.presence}`), ['id:string:true', 'count:int32:true', 'codes:int32:false', 'extra:group:true']);
		});

		test('keywords as field names and types named like keywords', () => {
			const registry = registryOf(`syntax = "proto3";
				message Odd { string message = 1; int32 option = 2; bool reserved = 3; string package = 4; string map = 5; stream stream = 6; }
				message stream { string service = 1; }`);
			const value = { message: 'm', option: 2, reserved: true, package: 'p', map: 'x', stream: { service: 's' } };
			assert.deepStrictEqual(roundTrip(registry, 'Odd', value), value);
		});

		test('errors name the file and the line', () => {
			assert.throws(() => parseProto('syntax = "proto3";\nmessage A {\n\tstring = 1;\n}', 'bad.proto'), (error: Error) => error instanceof ProtoError && error.message.startsWith('bad.proto:3: '));
			assert.throws(() => parseProto('message A {\n string a = 1;\n', 'open.proto'), /open\.proto:3: /);
			assert.throws(() => parseProto('message A { map<float, string> m = 1; }'), /float cannot be a map key/);
			assert.throws(() => parseProto('/* never closed'), /comment never ends/);
			assert.throws(() => parseProto('message A { string a = 0; }'), /not a field number/);
		});

		test('type names resolve from the innermost scope outward, and a leading dot is absolute', () => {
			const registry = registryOf(`syntax = "proto3";
				package a.b;
				message Item { string outer = 1; }
				message Box {
					message Item { string inner = 1; }
					message Deep {
						Item nearest = 1;
						.a.b.Item absolute = 2;
						b.Item partial = 3;
						Box.Item qualified = 4;
						Sibling sibling = 5;
					}
					message Sibling { int32 n = 1; }
					Item mine = 1;
					Deep deep = 2;
				}
				message User { Item item = 1; Box.Item boxed = 2; }`);
			const value = {
				mine: { inner: 'x' },
				deep: { nearest: { inner: 'n' }, absolute: { outer: 'o' }, partial: { outer: 'p' }, qualified: { inner: 'q' }, sibling: { n: 1 } },
			};
			assert.deepStrictEqual(roundTrip(registry, 'a.b.Box', value), value);
			assert.deepStrictEqual(roundTrip(registry, '.a.b.User', { item: { outer: 'o' }, boxed: { inner: 'i' } }), { item: { outer: 'o' }, boxed: { inner: 'i' } });
			assert.throws(() => registry.encode('a.b.Box', { mine: { outer: 'x' } }), /mine\.outer: a\.b\.Box\.Item has no such field/);
		});

		test('imports: from the map by path, by file name, built in, by callback; a missing one only matters when used', () => {
			const root = `syntax = "proto3";
				package app;
				import "shared/types/money.proto";
				import "google/protobuf/timestamp.proto";
				import "google/api/annotations.proto";
				import "lib/extra.proto";
				message Bill { common.Money total = 1; google.protobuf.Timestamp at = 2; extra.Tag tag = 3; }
				message Lost { nowhere.Thing thing = 1; }`;
			const money = 'syntax = "proto3"; package common; message Money { string currency = 1; int64 units = 2; }';
			const extra = 'syntax = "proto3"; package extra; message Tag { string name = 1; }';
			const value = { total: { currency: 'EUR', units: '12' }, at: '2024-01-31T12:00:00Z', tag: { name: 't' } };

			const byMap = ProtoRegistry.fromProtos({ 'bill.proto': root, 'money.proto': money, 'lib/extra.proto': extra });
			assert.deepStrictEqual(roundTrip(byMap, 'app.Bill', value), value);
			assert.strictEqual(byMap.hasFile('shared/types/money.proto'), true);
			assert.throws(() => byMap.encode('app.Lost', { thing: {} }), /Unknown type nowhere\.Thing \(field app\.Lost\.thing\)/);

			const asked: string[] = [];
			const byCallback = ProtoRegistry.fromProtos(name => {
				asked.push(name);
				return name === 'bill.proto' ? root : name.endsWith('money.proto') ? money : name.endsWith('extra.proto') ? extra : undefined;
			}, 'bill.proto');
			assert.deepStrictEqual(roundTrip(byCallback, 'app.Bill', value), value);
			assert.deepStrictEqual(asked, ['bill.proto', 'shared/types/money.proto', 'google/api/annotations.proto', 'lib/extra.proto']);

			// Not the first entry: the root is named.
			const named = ProtoRegistry.fromProtos({ 'money.proto': money, 'bill.proto': root }, 'bill.proto');
			assert.ok(named.messages.has('app.Bill'));
			assert.throws(() => ProtoRegistry.fromProtos({}), /No \.proto file/);
		});
	});

	suite('encode and decode', () => {

		test('known byte vectors', () => {
			const registry = registryOf(`syntax = "proto3";
				message Test1 { int32 a = 1; }
				message Test2 { string b = 2; }
				message Test3 { Test1 c = 3; }
				message Test4 { repeated int32 d = 4; }
				message Test5 { repeated int32 f = 6; }
				message Signed { sint32 s = 1; }
				message Fixed { fixed32 a = 1; fixed64 b = 2; double c = 3; float d = 4; }`);
			assert.strictEqual(hex(registry.encode('Test1', { a: 150 })), '08 96 01');
			assert.strictEqual(hex(registry.encode('Test2', { b: 'testing' })), '12 07 74 65 73 74 69 6e 67');
			assert.strictEqual(hex(registry.encode('Test3', { c: { a: 150 } })), '1a 03 08 96 01');
			assert.strictEqual(hex(registry.encode('Test5', { f: [3, 270, 86942] })), '32 06 03 8e 02 9e a7 05');
			assert.strictEqual(hex(registry.encode('Test1', { a: -1 })), '08 ff ff ff ff ff ff ff ff ff 01');
			assert.strictEqual(hex(registry.encode('Test1', { a: -2 })), '08 fe ff ff ff ff ff ff ff ff 01');
			assert.strictEqual(hex(registry.encode('Signed', { s: -1 })), '08 01');
			assert.strictEqual(hex(registry.encode('Signed', { s: 1 })), '08 02');
			assert.strictEqual(hex(registry.encode('Signed', { s: -2 })), '08 03');
			assert.strictEqual(hex(registry.encode('Signed', { s: 2147483647 })), '08 fe ff ff ff 0f');
			assert.strictEqual(hex(registry.encode('Signed', { s: -2147483648 })), '08 ff ff ff ff 0f');
			assert.strictEqual(hex(registry.encode('Fixed', { a: 1, b: '2', c: 1, d: 1 })), '0d 01 00 00 00 11 02 00 00 00 00 00 00 00 19 00 00 00 00 00 00 f0 3f 25 00 00 80 3f');
			assert.strictEqual(hex(registry.encode('Test1', {})), '');
			assert.strictEqual(hex(registry.encode('Test1', { a: 0 })), '');

			assert.deepStrictEqual(registry.decode('Test1', bytesOf('08 96 01')), { a: 150 });
			assert.deepStrictEqual(registry.decode('Test2', bytesOf('12 07 74 65 73 74 69 6e 67')), { b: 'testing' });
			assert.deepStrictEqual(registry.decode('Test3', bytesOf('1a 03 08 96 01')), { c: { a: 150 } });
			assert.deepStrictEqual(registry.decode('Test1', bytesOf('08 ff ff ff ff ff ff ff ff ff 01')), { a: -1 });
		});

		test('every scalar type round trips, at its edges too', () => {
			const registry = registryOf(SCALARS_PROTO);
			assert.deepStrictEqual(registry.decode('t.Scalars', new Uint8Array(0)), SCALAR_DEFAULTS);

			const typical = {
				d: 1.5e300, f: 1.1, i32: 42, i64: '1234567890123', u32: 7, u64: '18446744073709551615', s32: -3, s64: '-1234567890123',
				f32: 4000000000, f64: '9007199254740993', sf32: -5, sf64: '-9007199254740993', b: true, s: 'h\u00e9llo \u4e16\u754c \ud83d\ude00', by: 'AAEC/v8=',
			};
			assert.deepStrictEqual(roundTrip(registry, 't.Scalars', typical), typical);

			const low = {
				d: -Number.MAX_VALUE, f: -0.5, i32: -2147483648, i64: '-9223372036854775808', u32: 0, u64: '0', s32: -2147483648, s64: '-9223372036854775808',
				f32: 0, f64: '0', sf32: -2147483648, sf64: '-9223372036854775808', b: false, s: '', by: '',
			};
			assert.deepStrictEqual(roundTrip(registry, 't.Scalars', low), low);

			const high = {
				d: Number.MAX_VALUE, f: 3.4028235e38, i32: 2147483647, i64: '9223372036854775807', u32: 4294967295, u64: '18446744073709551615', s32: 2147483647, s64: '9223372036854775807',
				f32: 4294967295, f64: '18446744073709551615', sf32: 2147483647, sf64: '9223372036854775807', b: true, s: 'x', by: '/w==',
			};
			assert.deepStrictEqual(roundTrip(registry, 't.Scalars', high), high);
		});

		test('numbers come as numbers or strings; 64-bit comes back as strings; floats that are not numbers as names', () => {
			const registry = registryOf(SCALARS_PROTO);
			assert.deepStrictEqual(roundTrip(registry, 't.Scalars', { i32: '-12', i64: 12, u64: 9007199254740991, d: '2.5', f: 'NaN' }), { ...SCALAR_DEFAULTS, i32: -12, i64: '12', u64: '9007199254740991', d: 2.5, f: 'NaN' });
			assert.deepStrictEqual(roundTrip(registry, 't.Scalars', { d: 'Infinity', f: '-Infinity' }), { ...SCALAR_DEFAULTS, d: 'Infinity', f: '-Infinity' });
			assert.deepStrictEqual(roundTrip(registry, 't.Scalars', { f: 0.1, d: 0.1 }), { ...SCALAR_DEFAULTS, f: 0.1, d: 0.1 });
			// null is "not set".
			assert.deepStrictEqual(roundTrip(registry, 't.Scalars', { s: null, i32: null }), SCALAR_DEFAULTS);
		});

		test('a value that does not fit says where and why', () => {
			const registry = registryOf(`syntax = "proto3";
				package app;
				message Request { User user = 1; repeated User others = 2; map<string, User> named = 3; }
				message User { string name = 1; Address address = 2; int32 age = 3; uint32 points = 4; bool admin = 5; bytes key = 6; Role role = 7; repeated int32 codes = 8; int64 big = 9; }
				message Address { string zip = 1; }
				enum Role { ROLE_UNSPECIFIED = 0; ADMIN = 1; }`);
			const fails = (value: unknown, message: string) => assert.throws(() => registry.encode('app.Request', value), (error: Error) => {
				assert.ok(error instanceof ProtoError);
				assert.strictEqual(error.message, message);
				return true;
			});
			fails({ user: { address: { zip: 12345 } } }, 'user.address.zip: expected a string');
			fails({ user: { age: 1.5 } }, 'user.age: expected a whole number (int32)');
			fails({ user: { age: 'old' } }, 'user.age: expected a number (int32)');
			fails({ user: { age: 2147483648 } }, 'user.age: 2147483648 does not fit int32 (-2147483648 to 2147483647)');
			fails({ user: { points: -1 } }, 'user.points: -1 does not fit uint32 (0 to 4294967295)');
			fails({ user: { big: '9223372036854775808' } }, 'user.big: 9223372036854775808 does not fit int64 (-9223372036854775808 to 9223372036854775807)');
			fails({ user: { admin: 'yes' } }, 'user.admin: expected true or false');
			fails({ user: { key: 'not base64!' } }, 'user.key: expected base64 text');
			fails({ user: { role: 'BOSS' } }, 'user.role: "BOSS" is not a value of app.Role (ROLE_UNSPECIFIED, ADMIN)');
			fails({ user: { codes: 5 } }, 'user.codes: expected an array');
			fails({ user: { codes: [1, 'x'] } }, 'user.codes[1]: expected a number (int32)');
			fails({ user: 'bob' }, 'user: expected an object (app.User)');
			fails({ others: [{ name: 'a' }, { name: 7 }] }, 'others[1].name: expected a string');
			fails({ named: { bob: { address: { zip: false } } } }, 'named.bob.address.zip: expected a string');
			fails({ named: [] }, 'named: expected an object (a map)');
			fails({ usr: {} }, 'usr: app.Request has no such field');
			fails([], 'expected an object (app.Request)');
			assert.throws(() => registry.encode('app.Nope', {}), /Unknown message type app\.Nope/);
		});

		test('repeated: packed in proto3, not in proto2, either way as the field says; both read', () => {
			const proto3 = registryOf(`syntax = "proto3";
				message P { repeated int32 n = 1; repeated string s = 2; repeated int32 loose = 3 [packed = false]; repeated E e = 4; repeated double d = 5; repeated bool b = 6; repeated sint64 z = 7; repeated fixed32 x = 8; }
				enum E { A = 0; B = 1; }`);
			const proto2 = registryOf('syntax = "proto2"; message P { repeated int32 n = 1; repeated int32 tight = 3 [packed = true]; }');
			assert.strictEqual(hex(proto3.encode('P', { n: [1, 2, 300] })), '0a 04 01 02 ac 02');
			assert.strictEqual(hex(proto3.encode('P', { n: [] })), '');
			assert.strictEqual(hex(proto3.encode('P', { s: ['a', 'bc'] })), '12 01 61 12 02 62 63');
			assert.strictEqual(hex(proto3.encode('P', { loose: [1, 2] })), '18 01 18 02');
			assert.strictEqual(hex(proto3.encode('P', { e: ['B', 0, 'A'] })), '22 03 01 00 00');
			assert.strictEqual(hex(proto2.encode('P', { n: [1, 2] })), '08 01 08 02');
			assert.strictEqual(hex(proto2.encode('P', { tight: [1, 2] })), '1a 02 01 02');

			// Packed and unpacked, and both mixed, read into the same list.
			const empty = { n: [], s: [], loose: [], e: [], d: [], b: [], z: [], x: [] };
			assert.deepStrictEqual(proto3.decode('P', bytesOf('0a 02 01 02 08 03 0a 01 04')), { ...empty, n: [1, 2, 3, 4] });
			assert.deepStrictEqual(proto3.decode('P', bytesOf('1a 02 01 02 18 03')), { ...empty, loose: [1, 2, 3] });
			assert.deepStrictEqual(proto2.decode('P', bytesOf('0a 02 01 02 08 03')), { n: [1, 2, 3], tight: [] });

			const all = { n: [-1, 0, 1], s: ['', 'x'], loose: [0], e: ['B', 'A'], d: [0, -1.5], b: [true, false], z: ['-9223372036854775808', '0'], x: [0, 4294967295] };
			assert.deepStrictEqual(roundTrip(proto3, 'P', all), all);
		});

		test('maps, nested messages, bytes and enums by name or number', () => {
			const registry = registryOf(`syntax = "proto3";
				package m;
				message Holder {
					map<string, int32> counts = 1;
					map<int64, Item> items = 2;
					map<bool, string> flags = 3;
					map<uint32, Color> colors = 4;
					map<string, bytes> blobs = 5;
					Item item = 6;
					Color color = 7;
					bytes raw = 8;
				}
				message Item { string name = 1; Item child = 2; repeated Item more = 3; }
				enum Color { COLOR_UNSPECIFIED = 0; RED = 1; BLUE = 2; }`);
			assert.strictEqual(hex(registry.encode('m.Holder', { counts: { a: 1 } })), '0a 05 0a 01 61 10 01');
			// An entry keeps its key and value even at their defaults.
			assert.strictEqual(hex(registry.encode('m.Holder', { counts: { '': 0 } })), '0a 04 0a 00 10 00');

			const value = {
				counts: { a: 1, b: -2, zero: 0 },
				items: { '5': { name: 'five', more: [] }, '-9223372036854775808': { name: '', child: { name: 'c', more: [] }, more: [{ name: 'm', more: [] }] } },
				flags: { 'true': 'yes', 'false': 'no' },
				colors: { '1': 'RED', '2': 'BLUE' },
				blobs: { k: 'AQID' },
				item: { name: 'top', child: { name: 'mid', child: { name: 'leaf', more: [] }, more: [] }, more: [] },
				color: 'BLUE',
				raw: 'aGVsbG8=',
			};
			assert.deepStrictEqual(roundTrip(registry, 'm.Holder', value), value);

			// Enums: a name or a number in, the name out; a number the enum does not have stays a number.
			assert.deepStrictEqual(roundTrip(registry, 'm.Holder', { color: 2, colors: { '7': 1 } }), { counts: {}, items: {}, flags: {}, colors: { '7': 'RED' }, blobs: {}, color: 'BLUE', raw: '' });
			assert.deepStrictEqual(registry.decode('m.Holder', bytesOf('38 09')), { counts: {}, items: {}, flags: {}, colors: {}, blobs: {}, color: 9, raw: '' });
			// Unpadded and URL-safe base64 are taken too.
			assert.deepStrictEqual((roundTrip(registry, 'm.Holder', { raw: '_-8' }) as { raw: string }).raw, '/+8=');
			// A map entry with nothing in it is the default key and value.
			assert.deepStrictEqual((registry.decode('m.Holder', bytesOf('0a 00 12 00')) as { counts: unknown; items: unknown }), { counts: { '': 0 }, items: { '0': { name: '', more: [] } }, flags: {}, colors: {}, blobs: {}, color: 'COLOR_UNSPECIFIED', raw: '' });
			assert.throws(() => registry.encode('m.Holder', { items: { five: { name: 'x' } } }), /items\.five: expected a number \(int64\)/);
			assert.throws(() => registry.encode('m.Holder', { flags: { maybe: 'x' } }), /flags\.maybe: expected true or false/);
		});

		test('oneof: one member at most, zero values kept, unset members left out', () => {
			const registry = registryOf(`syntax = "proto3";
				message Pay { string id = 1; oneof method { string card = 2; int32 cash = 3; Wire wire = 4; } optional int32 tip = 5; optional string note = 6; }
				message Wire { string iban = 1; }`);
			assert.deepStrictEqual(roundTrip(registry, 'Pay', { id: 'p' }), { id: 'p' });
			assert.deepStrictEqual(roundTrip(registry, 'Pay', { card: '' }), { id: '', card: '' });
			assert.strictEqual(hex(registry.encode('Pay', { cash: 0 })), '18 00');
			assert.deepStrictEqual(roundTrip(registry, 'Pay', { cash: 0 }), { id: '', cash: 0 });
			assert.deepStrictEqual(roundTrip(registry, 'Pay', { wire: {} }), { id: '', wire: { iban: '' } });
			assert.deepStrictEqual(roundTrip(registry, 'Pay', { card: null, cash: 5 }), { id: '', cash: 5 });
			assert.throws(() => registry.encode('Pay', { card: 'x', cash: 1 }), /^ProtoError: cash: only one of the method fields can be set, and card already is$/);
			// On the wire the last member wins.
			assert.deepStrictEqual(registry.decode('Pay', bytesOf('12 01 78 18 05')), { id: '', cash: 5 });
			// proto3 optional: a zero that was set is kept, one that was not is left out.
			assert.strictEqual(hex(registry.encode('Pay', { tip: 0 })), '28 00');
			assert.deepStrictEqual(roundTrip(registry, 'Pay', { tip: 0, note: '' }), { id: '', tip: 0, note: '' });
		});

		test('field names: as written, lowerCamelCase or json_name in; json names out', () => {
			const registry = registryOf('syntax = "proto3"; message U { string user_id = 1; int32 visit_count = 2 [json_name = "visits"]; string plain = 3; }');
			const expected = { userId: 'u', visits: 3, plain: '' };
			assert.deepStrictEqual(roundTrip(registry, 'U', { user_id: 'u', visit_count: 3 }), expected);
			assert.deepStrictEqual(roundTrip(registry, 'U', { userId: 'u', visitCount: 3 }), expected);
			assert.deepStrictEqual(roundTrip(registry, 'U', { userId: 'u', visits: 3 }), expected);
			assert.throws(() => registry.encode('U', { userId: 'a', user_id: 'b' }), /user_id: the same field is also given as userId/);
		});

		test('proto2: set fields are written even at zero; all scalars show on decode', () => {
			const registry = registryOf('syntax = "proto2"; message L { required string id = 1; optional int32 n = 2; optional L next = 3; optional E e = 4; } enum E { FIRST = 1; SECOND = 2; }');
			assert.strictEqual(hex(registry.encode('L', { id: '', n: 0 })), '0a 00 10 00');
			assert.deepStrictEqual(registry.decode('L', new Uint8Array(0)), { id: '', n: 0, e: 'FIRST' });
			assert.deepStrictEqual(roundTrip(registry, 'L', { id: 'a', next: { id: 'b', e: 'SECOND' } }), { id: 'a', n: 0, next: { id: 'b', n: 0, e: 'SECOND' }, e: 'FIRST' });
		});

		test('well-known types', () => {
			const registry = registryOf(`syntax = "proto3";
				import "google/protobuf/timestamp.proto";
				import "google/protobuf/duration.proto";
				import "google/protobuf/empty.proto";
				import "google/protobuf/struct.proto";
				import "google/protobuf/wrappers.proto";
				import "google/protobuf/any.proto";
				import "google/protobuf/field_mask.proto";
				message W {
					google.protobuf.Timestamp at = 1;
					google.protobuf.Duration took = 2;
					google.protobuf.Empty nothing = 3;
					google.protobuf.Struct data = 4;
					google.protobuf.Value any_value = 5;
					google.protobuf.ListValue list = 6;
					google.protobuf.StringValue name = 7;
					google.protobuf.Int64Value big = 8;
					google.protobuf.BoolValue flag = 9;
					google.protobuf.BytesValue blob = 10;
					google.protobuf.DoubleValue ratio = 11;
					google.protobuf.Any detail = 12;
					google.protobuf.FieldMask mask = 13;
					repeated google.protobuf.Timestamp times = 14;
					map<string, google.protobuf.Value> values = 15;
					google.protobuf.UInt32Value count = 16;
				}
				message Inner { string note = 1; }`);
			const one = (value: Record<string, unknown>) => {
				const decoded = roundTrip(registry, 'W', value) as Record<string, ProtoJson>;
				delete decoded['times'];
				delete decoded['values'];
				return decoded;
			};

			// Timestamp: seconds and nanos on the wire, RFC 3339 in JSON.
			assert.strictEqual(hex(registry.encode('W', { at: '1970-01-01T00:00:01.5Z' })), '0a 08 08 01 10 80 ca b5 ee 01');
			assert.deepStrictEqual(one({ at: '2024-01-31T12:34:56Z' }), { at: '2024-01-31T12:34:56Z' });
			assert.deepStrictEqual(one({ at: '2024-01-31T12:34:56.120Z' }), { at: '2024-01-31T12:34:56.120Z' });
			assert.deepStrictEqual(one({ at: '2024-01-31T12:34:56.000001Z' }), { at: '2024-01-31T12:34:56.000001Z' });
			assert.deepStrictEqual(one({ at: '2024-01-31T12:34:56.123456789Z' }), { at: '2024-01-31T12:34:56.123456789Z' });
			assert.deepStrictEqual(one({ at: '2024-01-31T14:34:56+02:00' }), { at: '2024-01-31T12:34:56Z' });
			assert.deepStrictEqual(one({ at: '1969-12-31T23:59:59Z' }), { at: '1969-12-31T23:59:59Z' });
			assert.deepStrictEqual(one({ at: '0001-01-01T00:00:00Z' }), { at: '0001-01-01T00:00:00Z' });
			assert.deepStrictEqual(one({ at: '9999-12-31T23:59:59.999999999Z' }), { at: '9999-12-31T23:59:59.999999999Z' });
			assert.deepStrictEqual(one({ at: { seconds: 1, nanos: 0 } }), { at: '1970-01-01T00:00:01Z' });
			assert.throws(() => registry.encode('W', { at: 'yesterday' }), /^ProtoError: at: expected a time like "2024-01-31T12:00:00Z"$/);
			assert.throws(() => registry.encode('W', { at: 5 }), /at: expected a time/);
			assert.throws(() => registry.encode('W', { times: ['2024-01-31T12:00:00Z', '2024-13-01T00:00:00Z'] }), /times\[1\]: expected a time/);

			// Duration.
			assert.strictEqual(hex(registry.encode('W', { took: '1.5s' })), '12 08 08 01 10 80 ca b5 ee 01');
			assert.deepStrictEqual(one({ took: '1.5s' }), { took: '1.500s' });
			assert.deepStrictEqual(one({ took: '3s' }), { took: '3s' });
			assert.deepStrictEqual(one({ took: '-0.000001s' }), { took: '-0.000001s' });
			assert.deepStrictEqual(one({ took: '-3.25s' }), { took: '-3.250s' });
			assert.deepStrictEqual(one({ took: '0s' }), { took: '0s' });
			assert.throws(() => registry.encode('W', { took: '5 minutes' }), /took: expected a duration like "1\.5s"/);

			// Empty.
			assert.strictEqual(hex(registry.encode('W', { nothing: {} })), '1a 00');
			assert.deepStrictEqual(one({ nothing: {} }), { nothing: {} });

			// Struct, Value, ListValue: any JSON.
			const data = { text: 'x', n: 1.5, yes: true, none: null, list: [1, 'two', false, null, [3], { deep: {} }], nested: { a: { b: [] } } };
			assert.deepStrictEqual(one({ data }), { data });
			assert.deepStrictEqual(one({ data: {} }), { data: {} });
			assert.strictEqual(hex(registry.encode('W', { data: { a: 'b' } })), '22 0a 0a 08 0a 01 61 12 03 1a 01 62');
			assert.deepStrictEqual(one({ anyValue: 'text' }), { anyValue: 'text' });
			assert.deepStrictEqual(one({ anyValue: 0 }), { anyValue: 0 });
			assert.deepStrictEqual(one({ anyValue: false }), { anyValue: false });
			assert.deepStrictEqual(one({ anyValue: [1, { a: null }] }), { anyValue: [1, { a: null }] });
			assert.deepStrictEqual(one({ any_value: { k: 'v' } }), { anyValue: { k: 'v' } });
			// A null Value is a value (null), not "unset".
			assert.strictEqual(hex(registry.encode('W', { anyValue: null })), '2a 02 08 00');
			assert.deepStrictEqual(one({ anyValue: null }), { anyValue: null });
			assert.deepStrictEqual(one({ list: [1, null, 'a'] }), { list: [1, null, 'a'] });
			assert.deepStrictEqual(roundTrip(registry, 'W', { values: { a: null, b: 2, c: [] } }), { times: [], values: { a: null, b: 2, c: [] } });
			assert.throws(() => registry.encode('W', { data: [] }), /data: expected an object/);
			assert.throws(() => registry.encode('W', { list: {} }), /list: expected an array/);

			// Wrappers: the bare value.
			assert.strictEqual(hex(registry.encode('W', { name: 'hi' })), '3a 04 0a 02 68 69');
			assert.strictEqual(hex(registry.encode('W', { name: '' })), '3a 00');
			assert.deepStrictEqual(one({ name: 'hi', big: '-9007199254740993', flag: false, blob: 'AQI=', ratio: 0.25, count: 0 }), { name: 'hi', big: '-9007199254740993', flag: false, blob: 'AQI=', ratio: 0.25, count: 0 });
			assert.deepStrictEqual(one({ big: 12 }), { big: '12' });
			assert.throws(() => registry.encode('W', { name: 5 }), /^ProtoError: name: expected a string$/);
			assert.throws(() => registry.encode('W', { flag: 'no' }), /flag: expected true or false/);

			// Any: the fields beside "@type" when the type is known here, else its bytes.
			assert.strictEqual(hex(registry.encode('W', { detail: { '@type': 'type.googleapis.com/Inner', note: 'n' } })), '62 20 0a 19 74 79 70 65 2e 67 6f 6f 67 6c 65 61 70 69 73 2e 63 6f 6d 2f 49 6e 6e 65 72 12 03 0a 01 6e');
			assert.deepStrictEqual(one({ detail: { '@type': 'type.googleapis.com/Inner', note: 'n' } }), { detail: { '@type': 'type.googleapis.com/Inner', note: 'n' } });
			assert.deepStrictEqual(one({ detail: { '@type': 'type.googleapis.com/google.protobuf.Duration', value: '2s' } }), { detail: { '@type': 'type.googleapis.com/google.protobuf.Duration', value: '2s' } });
			assert.deepStrictEqual(one({ detail: { '@type': 'type.googleapis.com/other.Unknown', value: 'CAE=' } }), { detail: { '@type': 'type.googleapis.com/other.Unknown', value: 'CAE=' } });
			assert.throws(() => registry.encode('W', { detail: { '@type': 'x/Inner', note: 5 } }), /detail\.note: expected a string/);
			assert.throws(() => registry.encode('W', { detail: { note: 'x' } }), /detail\.@type: expected a string/);
			assert.throws(() => registry.encode('W', { detail: { '@type': 'x/other.Unknown', value: { a: 1 } } }), /detail\.value: the type other\.Unknown is not known here/);

			// FieldMask: comma-separated paths, lowerCamelCase in JSON, snake_case on the wire.
			assert.strictEqual(hex(registry.encode('W', { mask: 'userId,address.zipCode' })), '6a 1b 0a 07 75 73 65 72 5f 69 64 0a 10 61 64 64 72 65 73 73 2e 7a 69 70 5f 63 6f 64 65');
			assert.deepStrictEqual(one({ mask: 'userId,address.zipCode' }), { mask: 'userId,address.zipCode' });
			assert.deepStrictEqual(one({ mask: '' }), { mask: '' });

			// Nothing set: only the repeated field and the map show.
			assert.deepStrictEqual(registry.decode('W', new Uint8Array(0)), { times: [], values: {} });
			assert.deepStrictEqual(roundTrip(registry, 'W', { times: ['2024-01-31T12:00:00Z', '2024-01-31T12:00:01Z'] }), { times: ['2024-01-31T12:00:00Z', '2024-01-31T12:00:01Z'], values: {} });

			// The well-known types as the message itself.
			assert.deepStrictEqual(roundTrip(registry, 'google.protobuf.Timestamp', '2024-01-31T12:00:00Z'), '2024-01-31T12:00:00Z');
			assert.deepStrictEqual(roundTrip(registry, 'google.protobuf.Struct', { a: [1] }), { a: [1] });
			assert.deepStrictEqual(roundTrip(registry, 'google.protobuf.Empty', {}), {});
		});

		test('fields the schema does not know are skipped', () => {
			const full = registryOf(`syntax = "proto3";
				message M { int32 a = 1; string extra_text = 2; fixed64 extra_fixed = 3; Sub extra_sub = 4; fixed32 extra_small = 5; repeated int32 extra_list = 6; string z = 7; sint64 extra_big = 2000; }
				message Sub { string x = 1; }`);
			const small = registryOf('syntax = "proto3"; message M { int32 a = 1; string z = 7; }');
			const bytes = full.encode('M', { a: 5, extraText: 'skip me', extraFixed: '99', extraSub: { x: 'y' }, extraSmall: 7, extraList: [1, 2, 3], z: 'end', extraBig: '-1' });
			assert.deepStrictEqual(small.decode('M', bytes), { a: 5, z: 'end' });
			// A group (wire types 3 and 4), nested, is skipped whole.
			assert.deepStrictEqual(small.decode('M', bytesOf('08 05 13 08 01 1b 12 01 61 1c 14 3a 01 7a')), { a: 5, z: 'z' });
			// A field with another wire type than the schema says is not this field.
			assert.deepStrictEqual(small.decode('M', bytesOf('0a 01 61 3a 01 7a')), { a: 0, z: 'z' });
			assert.deepStrictEqual(small.decode('M', bytesOf('38 05 08 02')), { a: 2, z: '' });
		});

		test('a message field that comes twice is merged', () => {
			const registry = registryOf('syntax = "proto3"; message M { S s = 1; } message S { string a = 1; int32 b = 2; repeated int32 c = 3; }');
			assert.deepStrictEqual(registry.decode('M', bytesOf('0a 05 0a 01 78 18 01 0a 04 10 07 18 02')), { s: { a: 'x', b: 7, c: [1, 2] } });
		});

		test('malformed bytes throw a clear error and never loop', () => {
			const registry = registryOf('syntax = "proto3"; message M { int32 a = 1; string s = 2; M child = 3; repeated int32 list = 4; fixed64 f = 5; fixed32 g = 6; map<string, M> map = 7; }');
			const fails = (bytes: string, pattern: RegExp) => assert.throws(() => registry.decode('M', bytesOf(bytes)), (error: Error) => {
				assert.ok(error instanceof ProtoError, String(error));
				assert.ok(error.message.startsWith('Malformed protobuf data: '), error.message);
				assert.ok(pattern.test(error.message), error.message);
				return true;
			});
			fails('08', /a number is cut off/);
			fails('08 ff ff', /a number is cut off/);
			fails('08 ff ff ff ff ff ff ff ff ff ff 01', /longer than 10 bytes/);
			fails('12 05 61 62', /says it is 5 bytes long but only 2 are left/);
			fails('12 ff ff ff ff 0f 61', /says it is 4294967295 bytes long/);
			fails('00 01', /field number 0/);
			fails('0e', /unknown wire type 6/);
			fails('0f', /unknown wire type 7/);
			fails('0c', /a group ends that never started/);
			fails('0b 08 01', /a group is cut off/);
			fails('29 01 02 03', /fixed-size number is cut off/);
			fails('35 01 02', /fixed-size number is cut off/);
			fails('1a 01 08', /a number is cut off/);
			fails('22 02 01 80', /a number is cut off/);
			fails('3a 04 0a 05 61 62', /bytes long but only/);
			fails('ff ff ff ff ff 01 00', /field number is out of range/);

			// 200 levels of a message inside itself.
			let nested = new Uint8Array(0);
			for (let i = 0; i < 200; i++) {
				const next = new Uint8Array(nested.length + 3);
				next[0] = 0x1a;
				if (nested.length < 128) {
					next[1] = nested.length;
					next.set(nested, 2);
					nested = next.subarray(0, nested.length + 2);
				} else {
					next[1] = (nested.length & 0x7f) | 0x80;
					next[2] = nested.length >> 7;
					next.set(nested, 3);
					nested = next;
				}
			}
			assert.throws(() => registry.decode('M', nested), /Malformed protobuf data: messages are nested too deeply/);

			// Random bytes either decode or throw a ProtoError; they never hang or throw anything else.
			let seed = 12345;
			const random = () => {
				seed = (seed * 1103515245 + 12345) & 0x7fffffff;
				return seed;
			};
			for (let round = 0; round < 500; round++) {
				const bytes = new Uint8Array(random() % 40);
				for (let i = 0; i < bytes.length; i++) {
					bytes[i] = random() % 256;
				}
				try {
					registry.decode('M', bytes);
				} catch (error) {
					assert.ok(error instanceof ProtoError, `${hex(bytes)}: ${String(error)}`);
				}
			}
		});
	});

	suite('descriptors', () => {

		const FILE = {
			name: 'shop/orders.proto',
			package: 'shop.v1',
			dependency: ['google/protobuf/timestamp.proto', 'shop/common.proto'],
			syntax: 'proto3',
			messageType: [{
				name: 'Order',
				field: [
					{ name: 'id', number: 1, label: 'LABEL_OPTIONAL', type: 'TYPE_STRING', jsonName: 'id' },
					{ name: 'line_items', number: 2, label: 'LABEL_REPEATED', type: 'TYPE_MESSAGE', typeName: '.shop.v1.Order.Line', jsonName: 'lineItems' },
					{ name: 'labels', number: 3, label: 'LABEL_REPEATED', type: 'TYPE_MESSAGE', typeName: '.shop.v1.Order.LabelsEntry', jsonName: 'labels' },
					{ name: 'status', number: 4, label: 'LABEL_OPTIONAL', type: 'TYPE_ENUM', typeName: '.shop.v1.Status', jsonName: 'status' },
					{ name: 'card', number: 5, label: 'LABEL_OPTIONAL', type: 'TYPE_STRING', oneofIndex: 0, jsonName: 'card' },
					{ name: 'cash', number: 6, label: 'LABEL_OPTIONAL', type: 'TYPE_INT64', oneofIndex: 0, jsonName: 'cash' },
					{ name: 'tip', number: 7, label: 'LABEL_OPTIONAL', type: 'TYPE_INT32', oneofIndex: 1, jsonName: 'tip', proto3Optional: true },
					{ name: 'placed', number: 8, label: 'LABEL_OPTIONAL', type: 'TYPE_MESSAGE', typeName: '.google.protobuf.Timestamp', jsonName: 'placed' },
					{ name: 'codes', number: 9, label: 'LABEL_REPEATED', type: 'TYPE_SINT32', jsonName: 'codes' },
					{ name: 'loose', number: 10, label: 'LABEL_REPEATED', type: 'TYPE_INT32', jsonName: 'loose', options: { packed: false } },
					{ name: 'renamed_here', number: 11, label: 'LABEL_OPTIONAL', type: 'TYPE_BOOL', jsonName: 'other' },
					{ name: 'owner', number: 12, label: 'LABEL_OPTIONAL', type: 'TYPE_MESSAGE', typeName: '.shop.common.Person', jsonName: 'owner' },
				],
				nestedType: [
					{ name: 'Line', field: [{ name: 'sku', number: 1, label: 'LABEL_OPTIONAL', type: 'TYPE_STRING' }, { name: 'count', number: 2, label: 'LABEL_OPTIONAL', type: 'TYPE_UINT32' }, { name: 'kind', number: 3, label: 'LABEL_OPTIONAL', type: 'TYPE_ENUM', typeName: '.shop.v1.Order.Line.Kind' }], enumType: [{ name: 'Kind', value: [{ name: 'PLAIN', number: 0 }, { name: 'GIFT', number: 1 }] }] },
					{ name: 'LabelsEntry', field: [{ name: 'key', number: 1, label: 'LABEL_OPTIONAL', type: 'TYPE_STRING' }, { name: 'value', number: 2, label: 'LABEL_OPTIONAL', type: 'TYPE_DOUBLE' }], options: { mapEntry: true } },
				],
				oneofDecl: [{ name: 'payment' }, { name: '_tip' }],
			}, {
				name: 'GetOrder', field: [{ name: 'id', number: 1, label: 'LABEL_OPTIONAL', type: 'TYPE_STRING' }],
			}],
			enumType: [{ name: 'Status', value: [{ name: 'STATUS_UNSPECIFIED', number: 0 }, { name: 'OPEN', number: 1 }, { name: 'ACTIVE', number: 1 }, { name: 'LOST', number: -1 }], options: { allowAlias: true } }],
			service: [{
				name: 'Orders', method: [
					{ name: 'Get', inputType: '.shop.v1.GetOrder', outputType: '.shop.v1.Order' },
					{ name: 'Watch', inputType: '.shop.v1.GetOrder', outputType: '.shop.v1.Order', serverStreaming: true },
					{ name: 'Sync', inputType: '.shop.v1.Order', outputType: '.shop.v1.Order', clientStreaming: true, serverStreaming: true },
				],
			}],
		};
		const COMMON = {
			name: 'shop/common.proto', package: 'shop.common',
			messageType: [{ name: 'Person', field: [{ name: 'name', number: 1, label: 'LABEL_REQUIRED', type: 'TYPE_STRING' }, { name: 'age', number: 2, label: 'LABEL_OPTIONAL', type: 'TYPE_INT32' }, { name: 'tags', number: 3, label: 'LABEL_REPEATED', type: 'TYPE_INT32' }] }],
		};

		const TEXT = `syntax = "proto3";
			package shop.v1;
			import "google/protobuf/timestamp.proto";
			import "shop/common.proto";
			message Order {
				string id = 1;
				repeated Line line_items = 2;
				map<string, double> labels = 3;
				Status status = 4;
				oneof payment { string card = 5; int64 cash = 6; }
				optional int32 tip = 7;
				google.protobuf.Timestamp placed = 8;
				repeated sint32 codes = 9;
				repeated int32 loose = 10 [packed = false];
				bool renamed_here = 11 [json_name = "other"];
				shop.common.Person owner = 12;
				message Line { string sku = 1; uint32 count = 2; Kind kind = 3; enum Kind { PLAIN = 0; GIFT = 1; } }
			}
			message GetOrder { string id = 1; }
			enum Status { option allow_alias = true; STATUS_UNSPECIFIED = 0; OPEN = 1; ACTIVE = 1; LOST = -1; }
			service Orders {
				rpc Get (GetOrder) returns (Order);
				rpc Watch (GetOrder) returns (stream Order);
				rpc Sync (stream Order) returns (stream Order);
			}`;
		const COMMON_TEXT = 'syntax = "proto2"; package shop.common; message Person { required string name = 1; optional int32 age = 2; repeated int32 tags = 3; }';

		function descriptors(): Uint8Array[] {
			const builder = new ProtoRegistry();
			// Dependencies after the file that needs them: the order must not matter.
			return [builder.encode('google.protobuf.FileDescriptorProto', FILE), builder.encode('google.protobuf.FileDescriptorProto', COMMON)];
		}

		test('a registry from FileDescriptorProto bytes is the registry from the same .proto text', () => {
			const [fileBytes, commonBytes] = descriptors();
			const reflected = new ProtoRegistry();
			const file = reflected.addDescriptor(fileBytes);
			assert.strictEqual(file.name, 'shop/orders.proto');
			assert.deepStrictEqual(file.imports, ['google/protobuf/timestamp.proto', 'shop/common.proto']);
			assert.strictEqual(reflected.hasFile('shop/orders.proto'), true);
			assert.strictEqual(reflected.hasFile('shop/common.proto'), false);
			assert.strictEqual(reflected.hasFile('google/protobuf/timestamp.proto'), true);
			reflected.addDescriptor(commonBytes);

			const parsed = ProtoRegistry.fromProtos({ 'shop/orders.proto': TEXT, 'shop/common.proto': COMMON_TEXT });
			const names = (registry: ProtoRegistry) => [...registry.messages.keys(), ...registry.enums.keys(), ...registry.services.keys()].filter(name => !name.startsWith('google.')).sort();
			assert.deepStrictEqual(names(reflected), names(parsed));
			assert.deepStrictEqual(reflected.services.get('shop.v1.Orders')!.methods.map(method => `${method.name}:${method.clientStreaming}:${method.serverStreaming}`), ['Get:false:false', 'Watch:false:true', 'Sync:true:true']);
			const service = reflected.services.get('shop.v1.Orders')!;
			assert.strictEqual(reflected.methodTypes(service, service.methods[0]).input.fullName, 'shop.v1.GetOrder');
			assert.strictEqual(reflected.methodTypes(service, service.methods[0]).output.fullName, 'shop.v1.Order');
			assert.deepStrictEqual(reflected.enums.get('shop.v1.Status'), parsed.enums.get('shop.v1.Status'));

			const value = {
				id: 'o1',
				lineItems: [{ sku: 'a', count: 2, kind: 'GIFT' }, { sku: 'b', count: 0, kind: 'PLAIN' }],
				labels: { weight: 1.5, zero: 0 },
				status: 'LOST',
				cash: '-5',
				tip: 0,
				placed: '2024-01-31T12:00:00.250Z',
				codes: [-1, 0, 1],
				loose: [1, 2],
				other: true,
				owner: { name: 'ann', age: 0, tags: [1, 2] },
			};
			const bytes = parsed.encode('shop.v1.Order', value);
			assert.strictEqual(hex(reflected.encode('shop.v1.Order', value)), hex(bytes));
			assert.deepStrictEqual(reflected.decode('shop.v1.Order', bytes), value);
			assert.deepStrictEqual(parsed.decode('shop.v1.Order', bytes), value);
			// The same shape with nothing set: no oneof member, no optional, no message.
			const empty = { id: '', lineItems: [], labels: {}, status: 'STATUS_UNSPECIFIED', codes: [], loose: [], other: false };
			assert.deepStrictEqual(reflected.decode('shop.v1.Order', new Uint8Array(0)), empty);
			assert.deepStrictEqual(parsed.decode('shop.v1.Order', new Uint8Array(0)), empty);
			assert.deepStrictEqual(reflected.templateOf('shop.v1.Order'), parsed.templateOf('shop.v1.Order'));
			assert.throws(() => reflected.encode('shop.v1.Order', { card: 'x', cash: 1 }), /only one of the payment fields/);
		});

		test('fromDescriptors, a missing dependency and bytes that are not a descriptor', () => {
			const [fileBytes] = descriptors();
			const registry = ProtoRegistry.fromDescriptors([fileBytes]);
			assert.deepStrictEqual(registry.decode('shop.v1.GetOrder', bytesOf('0a 01 78')), { id: 'x' });
			assert.throws(() => registry.encode('shop.v1.Order', { owner: { name: 'a' } }), /Unknown message type shop\.common\.Person/);
			assert.throws(() => ProtoRegistry.fromDescriptors([bytesOf('0a ff 01')]), /Malformed protobuf data/);
		});

		test('type names without the leading dot (descriptors not made by protoc) are looked up by scope', () => {
			const builder = new ProtoRegistry();
			// What @grpc/reflection serves: names as the .proto wrote them, no dependency list.
			const registry = ProtoRegistry.fromDescriptors([builder.encode('google.protobuf.FileDescriptorProto', {
				name: 'users.proto', package: 'demo.v1', syntax: 'proto3',
				messageType: [{
					name: 'User',
					field: [
						{ name: 'role', number: 1, label: 'LABEL_OPTIONAL', type: 'TYPE_ENUM', typeName: 'Role' },
						{ name: 'home', number: 2, label: 'LABEL_OPTIONAL', type: 'TYPE_MESSAGE', typeName: 'Address' },
						{ name: 'labels', number: 3, label: 'LABEL_REPEATED', type: 'TYPE_MESSAGE', typeName: 'Labels' },
						{ name: 'at', number: 4, label: 'LABEL_OPTIONAL', type: 'TYPE_MESSAGE', typeName: 'google.protobuf.Timestamp' },
						{ name: 'work', number: 5, label: 'LABEL_OPTIONAL', type: 'TYPE_MESSAGE', typeName: 'v1.Address' },
					],
					nestedType: [
						{ name: 'Labels', field: [{ name: 'key', number: 1, type: 'TYPE_STRING' }, { name: 'value', number: 2, type: 'TYPE_ENUM', typeName: 'Role' }], options: { mapEntry: true } },
						{ name: 'Address', field: [{ name: 'inner', number: 1, type: 'TYPE_STRING' }] },
					],
				}, { name: 'Address', field: [{ name: 'outer', number: 1, type: 'TYPE_STRING' }] }],
				enumType: [{ name: 'Role', value: [{ name: 'NONE', number: 0 }, { name: 'ADMIN', number: 1 }] }],
				service: [{ name: 'Users', method: [{ name: 'Get', inputType: 'Address', outputType: 'User' }] }],
			})]);
			const value = { role: 'ADMIN', home: { inner: 'i' }, labels: { a: 'ADMIN', b: 'NONE' }, at: '2024-01-31T12:00:00Z', work: { outer: 'o' } };
			assert.deepStrictEqual(roundTrip(registry, 'demo.v1.User', value), value);
			assert.strictEqual(hex(registry.encode('demo.v1.User', { role: 'ADMIN', labels: { a: 1 } })), '08 01 1a 05 0a 01 61 10 01');
			const service = registry.services.get('demo.v1.Users')!;
			assert.strictEqual(registry.methodTypes(service, service.methods[0]).input.fullName, 'demo.v1.Address');
			assert.deepStrictEqual(registry.templateOf('demo.v1.User'), { role: 'NONE', home: { inner: '' }, labels: {}, at: '1970-01-01T00:00:00Z', work: { outer: '' } });
		});

		test('the descriptor itself decodes back to what was encoded', () => {
			const builder = new ProtoRegistry();
			const decoded = builder.decode('google.protobuf.FileDescriptorProto', builder.encode('google.protobuf.FileDescriptorProto', COMMON)) as { name: string; messageType: { name: string; field: { name: string; label: string; type: string }[] }[] };
			assert.strictEqual(decoded.name, 'shop/common.proto');
			assert.deepStrictEqual(decoded.messageType[0].field.map(field => `${field.name}:${field.label}:${field.type}`), ['name:LABEL_REQUIRED:TYPE_STRING', 'age:LABEL_OPTIONAL:TYPE_INT32', 'tags:LABEL_REPEATED:TYPE_INT32']);
		});
	});

	suite('templateOf', () => {

		test('every field at its default: nested messages expanded, recursion stopped, one member per oneof', () => {
			const registry = registryOf(`syntax = "proto3";
				package t;
				import "google/protobuf/timestamp.proto";
				import "google/protobuf/duration.proto";
				import "google/protobuf/struct.proto";
				import "google/protobuf/wrappers.proto";
				import "google/protobuf/any.proto";
				import "google/protobuf/field_mask.proto";
				import "google/protobuf/empty.proto";
				message Request {
					string user_id = 1;
					int32 count = 2;
					int64 big = 3;
					bool flag = 4;
					bytes blob = 5;
					double ratio = 6;
					Kind kind = 7;
					repeated string tags = 8;
					map<string, int32> counts = 9;
					Address address = 10;
					oneof contact { string email = 11; Phone phone = 12; }
					optional string nickname = 13;
					Node tree = 14;
					google.protobuf.Timestamp at = 15;
					google.protobuf.Duration took = 16;
					google.protobuf.Struct data = 17;
					google.protobuf.StringValue label = 18;
					google.protobuf.Int64Value total = 19;
					google.protobuf.Any detail = 20;
					google.protobuf.FieldMask mask = 21;
					google.protobuf.Empty nothing = 22;
					google.protobuf.Value anything = 23;
					google.protobuf.ListValue list = 24;
					string renamed = 25 [json_name = "other"];
				}
				enum Kind { KIND_FIRST = 0; KIND_SECOND = 1; }
				message Address { string zip = 1; Geo geo = 2; }
				message Geo { double lat = 1; double lng = 2; Planet planet = 3; }
				message Planet { string name = 1; Star star = 2; }
				message Star { string name = 1; }
				message Phone { string number = 1; }
				message Node { string name = 1; Node parent = 2; repeated Node children = 3; Leaf leaf = 4; }
				message Leaf { Node back = 1; int32 n = 2; }`);
			const template = registry.templateOf('t.Request');
			assert.deepStrictEqual(template, {
				userId: '', count: 0, big: '0', flag: false, blob: '', ratio: 0, kind: 'KIND_FIRST', tags: [], counts: {},
				address: { zip: '', geo: { lat: 0, lng: 0, planet: { name: '', star: {} } } },
				email: '',
				nickname: '',
				tree: { name: '', parent: {}, children: [], leaf: { back: {}, n: 0 } },
				at: '1970-01-01T00:00:00Z', took: '0s', data: {}, label: '', total: '0', detail: { '@type': '' }, mask: '', nothing: {}, anything: null, list: [],
				other: '',
			});
			// What the editor starts from can be sent as it is.
			assert.ok(registry.encode('t.Request', template) instanceof Uint8Array);
			assert.deepStrictEqual(registry.templateOf('t.Request', 1), { ...(template as object), address: { zip: '', geo: {} }, tree: { name: '', parent: {}, children: [], leaf: {} } });
			assert.deepStrictEqual(registry.templateOf('t.Request', 0), { ...(template as object), address: {}, tree: {} });
			assert.deepStrictEqual(registry.templateOf('google.protobuf.Empty'), {});
			assert.throws(() => registry.templateOf('t.Missing'), /Unknown message type t\.Missing/);
		});

		test('proto2 enums start at their first value', () => {
			const registry = registryOf('syntax = "proto2"; message M { optional E e = 1; required string s = 2; } enum E { ONE = 1; TWO = 2; }');
			assert.deepStrictEqual(registry.templateOf('M'), { e: 'ONE', s: '' });
		});
	});
});

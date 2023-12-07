/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'assert';
import * as os from 'os';

import { lsif, ts, assertElement } from './lsifs';
import { Edge, Element, ElementTypes, Vertex, VertexLabels } from 'lsif-protocol';

suite('Export Tests', () => {
	const compilerOptions: ts.CompilerOptions = {
		module: ts.ModuleKind.CommonJS,
		target: ts.ScriptTarget.ES5,
		esModuleInterop: true,
		rootDir: '/@test'
	};
	test('Simple export', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export function foo(): void { }',
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { foo } from "./a";',
					'foo()'
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":14,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":15,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":16,"type":"edge","label":"moniker","outV":14,"inV":15}'),
			JSON.parse('{"id":17,"type":"vertex","label":"range","start":{"line":0,"character":16},"end":{"line":0,"character":19},"tag":{"type":"definition","text":"foo","kind":12,"fullRange":{"start":{"line":0,"character":0},"end":{"line":0,"character":31}}}}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Const export', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export const x: number | string = 10;',
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { x } from "./a";',
					'x;'
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":10,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":15,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:x","unique":"workspace","kind":"export"}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Namespace export', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export namespace N { export const a: number = 10; }',
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { N } from "./a";',
					'let x = N.a;'
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":15,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:N","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":22,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:N.a","unique":"workspace","kind":"export"}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export { foo }', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'function foo() { }',
					'export { foo };'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { foo } from "./a";',
					'foo();'
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":14,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":15,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"*","unique":"document","kind":"local"}'),
			JSON.parse('{"id":16,"type":"edge","label":"moniker","outV":14,"inV":15}'),
			JSON.parse('{"id":21,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":22,"type":"edge","label":"next","outV":21,"inV":14}'),
			JSON.parse('{"id":23,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":24,"type":"edge","label":"moniker","outV":21,"inV":23}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export { foo } with children', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'namespace Foo { export const x = 10; }',
					'export { Foo };'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { Foo } from "./a";',
					'Foo.x;'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 96);
		const validate: Element[] = [
			JSON.parse('{"id":15,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"*","unique":"document","kind":"local"}'),
			JSON.parse('{"id":22,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"*","unique":"document","kind":"local"}'),
			// This needs its own result set since we have a different hover.
			JSON.parse('{"id":28,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":29,"type":"edge","label":"next","outV":28,"inV":14}'),
			JSON.parse('{"id":30,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:Foo","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":31,"type":"edge","label":"moniker","outV":28,"inV":30}'),
			// JSON.parse('{"id":35,"type":"vertex","label":"hoverResult","result":{"contents":[{"language":"typescript","value":"(alias) namespace foo\\nexport foo"}]}}'),
			JSON.parse('{"id":35,"type":"edge","label":"textDocument/hover","outV":28,"inV":34}'),
			JSON.parse('{"id":36,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:Foo.x","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":37,"type":"edge","label":"attach","outV":36,"inV":22}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export { foo } with import', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'function foo() { }',
					'export { foo };'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { foo } from "./a";',
					'foo();'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 78);
		const validate: Element[] = [
			JSON.parse('{"id":14,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":15,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"*","unique":"document","kind":"local"}'),
			JSON.parse('{"id":39,"type":"vertex","label":"referenceResult"}'),
			JSON.parse('{"id":40,"type":"edge","label":"textDocument/references","outV":14,"inV":39}'),
			JSON.parse('{"id":59,"type":"vertex","label":"range","start":{"line":0,"character":9},"end":{"line":0,"character":12},"tag":{"type":"definition","text":"foo","kind":7,"fullRange":{"start":{"line":0,"character":9},"end":{"line":0,"character":12}}}}'),
			JSON.parse('{"id":65,"type":"vertex","label":"range","start":{"line":1,"character":0},"end":{"line":1,"character":3},"tag":{"type":"reference","text":"foo"}}'),
			JSON.parse('{"id":74,"type":"edge","label":"item","outV":39,"inVs":[59,65],"shard":48,"property":"references"}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export { _foo as foo }', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'function _foo() { }',
					'export { _foo as foo };'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { foo } from "./a";',
					'foo();'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 85);
		const validate: Element[] = [
			// _foo
			JSON.parse('{"id":14,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":15,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"*","unique":"document","kind":"local"}'),
			JSON.parse('{"id":16,"type":"edge","label":"moniker","outV":14,"inV":15}'),
			JSON.parse('{"id":17,"type":"vertex","label":"range","start":{"line":0,"character":9},"end":{"line":0,"character":13},"tag":{"type":"definition","text":"_foo","kind":12,"fullRange":{"start":{"line":0,"character":0},"end":{"line":0,"character":19}}}}'),
			JSON.parse('{"id":18,"type":"edge","label":"next","outV":17,"inV":14}'),
			// Alias foo with reference result since it is a rename
			JSON.parse('{"id":23,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":24,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":25,"type":"edge","label":"moniker","outV":23,"inV":24}'),
			JSON.parse('{"id":26,"type":"vertex","label":"range","start":{"line":1,"character":17},"end":{"line":1,"character":20},"tag":{"type":"definition","text":"foo","kind":7,"fullRange":{"start":{"line":1,"character":9},"end":{"line":1,"character":20}}}}'),
			JSON.parse('{"id":27,"type":"vertex","label":"referenceResult"}'),
			JSON.parse('{"id":28,"type":"edge","label":"textDocument/references","outV":23,"inV":27}'),
			// The reference result for _foo
			JSON.parse('{"id":42,"type":"vertex","label":"referenceResult"}'),
			JSON.parse('{"id":43,"type":"edge","label":"textDocument/references","outV":14,"inV":42}'),
			JSON.parse('{"id":46,"type":"edge","label":"item","outV":42,"inVs":[27],"shard":7,"property":"referenceResults"}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export = function', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'function foo(path: string): void { }',
					'export = foo;'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import foo from "./a";',
					'foo("p");'
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":14,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":28,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":29,"type":"edge","label":"next","outV":28,"inV":14}'),
			JSON.parse('{"id":30,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:export=","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":31,"type":"edge","label":"moniker","outV":28,"inV":30}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export = Interface', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'interface I { foo(): void; }',
					'export = I;'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import I from "./a";',
					'let i: I;',
					'i.foo();'
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":21,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":22,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"*","unique":"document","kind":"local"}'),
			JSON.parse('{"id":23,"type":"edge","label":"moniker","outV":21,"inV":22}'),
			JSON.parse('{"id":24,"type":"vertex","label":"range","start":{"line":0,"character":14},"end":{"line":0,"character":17},"tag":{"type":"definition","text":"foo","kind":7,"fullRange":{"start":{"line":0,"character":14},"end":{"line":0,"character":26}}}}'),
			JSON.parse('{"id":25,"type":"edge","label":"next","outV":24,"inV":21}'),
			JSON.parse('{"id":34,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:export=.foo","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":35,"type":"edge","label":"attach","outV":34,"inV":22}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export default function', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'function foo(): void { }',
					'export default foo;'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import foo from "./a";',
					'foo();'
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":14,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":21,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":22,"type":"edge","label":"next","outV":21,"inV":14}'),
			JSON.parse('{"id":23,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:default","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":24,"type":"edge","label":"moniker","outV":21,"inV":23}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export default Interface', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'interface I { foo(): void; }',
					'export default I;'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import I from "./a";',
					'let i: I;',
					'i.foo();'
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":21,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":22,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"*","unique":"document","kind":"local"}'),
			JSON.parse('{"id":23,"type":"edge","label":"moniker","outV":21,"inV":22}'),
			JSON.parse('{"id":24,"type":"vertex","label":"range","start":{"line":0,"character":14},"end":{"line":0,"character":17},"tag":{"type":"definition","text":"foo","kind":7,"fullRange":{"start":{"line":0,"character":14},"end":{"line":0,"character":26}}}}'),
			JSON.parse('{"id":25,"type":"edge","label":"next","outV":24,"inV":21}'),
			JSON.parse('{"id":34,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:default.foo","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":35,"type":"edge","label":"attach","outV":34,"inV":22}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export variable declaration', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export let foo: { touch: boolean };'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { foo } from "./a";',
					'foo.touch;'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 85);
		const validate: Element[] = [
			JSON.parse('{"id":15,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":28,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo.touch","unique":"workspace","kind":"export"}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export variable declaration with inferred type', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export const foo = { touch: true };'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { foo } from "./a";',
					'foo.touch;'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 94);
		const validate: Element[] = [
			JSON.parse('{"id":15,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":28,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo.touch","unique":"workspace","kind":"export"}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export inferred function return type', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export function foo() { return { touch: true }; }'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { foo } from "./a";',
					'foo().touch;'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 96);
		const validate: Element[] = [
			JSON.parse('{"id":15,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":22,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"*","unique":"document","kind":"local"}'),
			JSON.parse('{"id":28,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo.__rt.touch","unique":"workspace","kind":"export"}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export inferred method return type', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export class Foo { public bar() { return { touch: true }; } }'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { Foo } from "./a";',
					'let foo: Foo;',
					'foo.bar().touch;'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 135);
		const validate: Element[] = [
			JSON.parse('{"id":22,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:Foo.bar","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":29,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"*","unique":"document","kind":"local"}'),
			JSON.parse('{"id":35,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:Foo.bar.__rt.touch","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":36,"type":"edge","label":"attach","outV":35,"inV":29}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export composite return type', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export interface Foo { bar(): { toString(): string } | { toString(): number }; }'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { Foo } from "./a";',
					'let foo: Foo;',
					'foo.bar().toString();'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 144);
		const validate: Element[] = [
			JSON.parse('{"id":42,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:Foo.bar.__rt.toString","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":43,"type":"edge","label":"attach","outV":42,"inV":29}'),
			JSON.parse('{"id":44,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:Foo.bar.__rt.toString","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":45,"type":"edge","label":"attach","outV":44,"inV":36}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export type via property', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'interface Foo { touch: boolean; }',
					'export class Bar { foo: Foo; }'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { Bar } from "./a";',
					'let bar: Bar = new Bar();',
					'bar.foo.touch;'
				].join(os.EOL)
			]
		]), compilerOptions);
		// There will not be a moniker for a:Bar.foo.touch since interface Foo is named.
		// However symbol data must survive for b.ts
		assert.strictEqual(emitter.lastId, 135);
	});
	test('Export type via property signature', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'interface Foo { touch: boolean; }',
					'export interface Bar { foo: Foo; }'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { Bar } from "./a";',
					'let bar: Bar;',
					'bar.foo.touch;'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 133);
		// There will not be a moniker for a:Bar.foo.touch since interface Foo is named.
		// However symbol data must survive for b.ts
	});
	test('Export type via variable declaration in namespace', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'interface Foo { touch: boolean; }',
					'export namespace Bar { export let foo: Foo; }'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { Bar } from "./a";',
					'Bar.foo.touch;'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 117);
		// There will not be a moniker for a:Bar.foo.touch since interface Foo is named.
		// However symbol data must survive for b.ts
	});
	test('Export type via variable declaration with anonymous class declaration', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'abstract class Foo { public abstract doIt(): boolean; }',
					'export namespace Bar { export const foo: Foo = new class extends Foo { public doIt(): boolean { return true; } } ; }'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { Bar } from "./a";',
					'Bar.foo.doIt();'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 132);
		// There will not be a moniker for a:Bar.foo.touch since interface Foo is named.
		// However symbol data must survive for b.ts
	});
	test('Export function with literal param', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export function foo(arg: { key: number; value: number }): void { }'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { foo } from "./a";',
					'foo({ key: 10, value: 20 });'
				].join(os.EOL)
			]
		]), compilerOptions);
		// Tests that the LSIF tool doesn't throw due to data recreation.
		assert.strictEqual(emitter.lastId, 140);
	});
	test('Export function with callback signature', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export function foo(callback: (entry: { key: string; value: number; }, remove: () => void) => void): void { }'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { foo } from "./a";',
					'foo((e, r) => { e.key; r.value });'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 177);
		const validate: Element[] = [
			JSON.parse('{"id":35,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo.__arg.callback.__arg.entry.key","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":36,"type":"edge","label":"attach","outV":35,"inV":22}'),
			JSON.parse('{"id":37,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo.__arg.callback.__arg.entry.value","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":38,"type":"edge","label":"attach","outV":37,"inV":29}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export function type with callback signature', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export interface Func { (callback: (entry: { key: string; value: number; }) => void); }'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { Func } from "./a";',
					'let f: Func;',
					'f(e => { e.key; e.value; });'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 167);
		const validate: Element[] = [
			JSON.parse('{"id":35,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:Func.__arg.callback.__arg.entry.key","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":36,"type":"edge","label":"attach","outV":35,"inV":22}'),
			JSON.parse('{"id":37,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:Func.__arg.callback.__arg.entry.value","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":38,"type":"edge","label":"attach","outV":37,"inV":29}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export function with callback signature as return value', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export function foo(): (entry: { key: number; value: number; }) => void { return (entry: { key: number; value: number; }) => { return; }}'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { foo } from "./a";',
					'foo()({ key: 10, value: 20});'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 179);
		const validate: Element[] = [
			JSON.parse('{"id":35,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo.__rt.__arg.entry.key","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":36,"type":"edge","label":"attach","outV":35,"inV":22}'),
			JSON.parse('{"id":37,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo.__rt.__arg.entry.value","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":38,"type":"edge","label":"attach","outV":37,"inV":29}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Extend private class', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'abstract class Foo {',
					'    run(): void { }',
					'}',
					'export class Bar extends Foo {',
					'    do(): void { }',
					'}'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { Bar } from "./a"',
					'let bar: Bar = new Bar();',
					'bar.run();'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 132);
		const validate: Element[] = [
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export computed property name', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export class Foo {',
					'	get [Symbol.toStringTag](): string {',
					'		return "Foo";',
					'	}',
					'}'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { Foo } from "./a"',
					'let foo: Foo = new Foo();'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 99);
		const validate: Element[] = [
			JSON.parse('{"id":21,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":22,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"*","unique":"document","kind":"local"}'),
			JSON.parse('{"id":23,"type":"edge","label":"moniker","outV":21,"inV":22}'),
			JSON.parse('{"id":24,"type":"vertex","label":"range","start":{"line":1,"character":5},"end":{"line":1,"character":25},"tag":{"type":"definition","text":"[Symbol.toStringTag]","kind":7,"fullRange":{"start":{"line":1,"character":1},"end":{"line":3,"character":2}}}}'),
			JSON.parse('{"id":25,"type":"edge","label":"next","outV":24,"inV":21}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Class constructor', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export class Foo {',
					'    constructor(callback: (entry: { key: string; value: number; }) => void) { }',
					'}'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { Foo } from "./a"',
					'let foo: Foo = new Foo((entry) => { entry.key; });'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 164);
		const validate: Element[] = [
			JSON.parse('{"id":35,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:Foo.__arg.callback.__arg.entry.key","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":36,"type":"edge","label":"attach","outV":35,"inV":22}'),
			JSON.parse('{"id":37,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:Foo.__arg.callback.__arg.entry.value","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":38,"type":"edge","label":"attach","outV":37,"inV":29}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export class as default', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export default class {',
					'    constructor(callback: (entry: { key: string; value: number; }) => void) { }',
					'}'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import Foo from "./a"',
					'let foo: Foo = new Foo((entry) => { entry.key; });'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 157);
		const validate: Element[] = [
			JSON.parse('{"id":31,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:default.__arg.callback.__arg.entry.key","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":32,"type":"edge","label":"attach","outV":31,"inV":18}'),
			JSON.parse('{"id":33,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:default.__arg.callback.__arg.entry.value","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":34,"type":"edge","label":"attach","outV":33,"inV":25}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export * from', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export function foo(): void {};',
					'export function bar(): { value: number; } { return { value: 10 }; };'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'export * from "./a";'
				].join(os.EOL)
			],
			[
				'/@test/c.ts',
				[
					'import { foo, bar } from "./b";',
					'foo();',
					'bar();'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 148);
		const validate: (Vertex | Edge)[] = [
			JSON.parse('{"id":14,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":15,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":16,"type":"edge","label":"moniker","outV":14,"inV":15}'),
			JSON.parse('{"id":21,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":22,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:bar","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":23,"type":"edge","label":"moniker","outV":21,"inV":22}'),
			JSON.parse('{"id":29,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"*","unique":"document","kind":"local"}'),
			JSON.parse('{"id":35,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:bar.__rt.value","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":36,"type":"edge","label":"attach","outV":35,"inV":29}'),
			JSON.parse('{"id":60,"type":"vertex","label":"referenceResult"}'),
			JSON.parse('{"id":61,"type":"edge","label":"textDocument/references","outV":14,"inV":60}'),
			JSON.parse('{"id":66,"type":"vertex","label":"referenceResult"}'),
			JSON.parse('{"id":67,"type":"edge","label":"textDocument/references","outV":21,"inV":66}'),
			JSON.parse('{"id":92,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"b:foo","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":93,"type":"edge","label":"attach","outV":92,"inV":15}'),
			JSON.parse('{"id":94,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"b:bar","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":95,"type":"edge","label":"attach","outV":94,"inV":22}'),
			JSON.parse('{"id":96,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"b:bar.__rt.value","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":97,"type":"edge","label":"attach","outV":96,"inV":29}'),
			JSON.parse('{"id":143,"type":"edge","label":"item","outV":60,"inVs":[118,132],"shard":107,"property":"references"}'),
			JSON.parse('{"id":144,"type":"edge","label":"item","outV":66,"inVs":[126,134],"shard":107,"property":"references"}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});

	test('Declare global', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'declare global {',
					'    const value: number;',
					'}',
					'export function foo() {',
					'}'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import * as a from "./a";',
					'console.log(value)'
				].join(os.EOL)
			]
		]), { });
		assert.strictEqual(emitter.lastId, 136);
		const validate: Element[] = [
			JSON.parse('{"id":22,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":value","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":29,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo","unique":"workspace","kind":"export"}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});

	test('Export as namespace', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.d.ts',
				[
					'export as namespace M;',
					'export = M;',
					'declare namespace M {',
					'    function foo(): void;',
					'}'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import * as a from "./a";',
					'console.log(a.foo)'
				].join(os.EOL)
			]
		]), { });
		assert.strictEqual(emitter.lastId, 146);
		const validate: Element[] = [
			JSON.parse('{"id":23,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":M","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":36,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":M.foo","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":37,"type":"edge","label":"attach","outV":36,"inV":30}'),
			JSON.parse('{"id":40,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:export=","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":44,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:export=.foo","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":45,"type":"edge","label":"attach","outV":44,"inV":30}'),
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
});

suite('Export use cases', () => {
	const compilerOptions: ts.CompilerOptions = {
		module: ts.ModuleKind.CommonJS,
		target: ts.ScriptTarget.ES5,
		esModuleInterop: true,
		rootDir: '/@test'
	};
	test('Export default RAL with multiple declarations', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'interface RAL { readonly y: number; }',
					'namespace RAL { export const x = 10; }',
					'function RAL() { }',
					'export default RAL;'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import RAL from "./a";',
					'RAL();'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 112);
		const validate: Element[] = [
			JSON.parse('{"id":45,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:default.x","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":46,"type":"edge","label":"attach","outV":45,"inV":33}'),
			JSON.parse('{"id":47,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:default.y","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":48,"type":"edge","label":"attach","outV":47,"inV":26}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export default RAL with nested declarations', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'interface RAL { readonly console: { warn(message?: any): void; } }',
					'export default RAL;'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import RAL from "./a";',
					'let r: RAL;',
					'r.console.warn();'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 141);
		const validate: Element[] = [
			JSON.parse('{"id":42,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":43,"type":"edge","label":"next","outV":42,"inV":14}'),
			JSON.parse('{"id":44,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:default","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":45,"type":"edge","label":"moniker","outV":42,"inV":44}'),
			JSON.parse('{"id":46,"type":"vertex","label":"range","start":{"line":1,"character":15},"end":{"line":1,"character":18},"tag":{"type":"reference","text":"RAL"}}'),
			JSON.parse('{"id":47,"type":"edge","label":"next","outV":46,"inV":14}'),
			JSON.parse('{"id":48,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:default.console","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":49,"type":"edge","label":"attach","outV":48,"inV":22}'),
			JSON.parse('{"id":50,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:default.console.warn","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":51,"type":"edge","label":"attach","outV":50,"inV":29}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export default RAL with merged nested declarations', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'interface RAL {',
					'    readonly console: {',
					'        info(message?: any, ...optionalParams: any[]): void;',
					'        log(message?: any, ...optionalParams: any[]): void;',
					'    }',
					'}',
					'',
					'let _ral: RAL | undefined;',
					'',
					'function RAL(): RAL {',
					'	return _ral;',
					'}',
					'namespace RAL {',
					'	export function install(ral: RAL): void {',
					'		_ral = ral;',
					'	}',
					'}',
					'export default RAL;'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import RAL from "./a";',
					'let r: RAL;',
					'r.console.warn();'
				].join(os.EOL)
			]
		]), Object.assign<ts.CompilerOptions, ts.CompilerOptions, ts.CompilerOptions>({}, compilerOptions, { 'lib': [ 'es2017' ] }));
		assert.strictEqual(emitter.lastId, 253);
		for (const elem of emitter.sequence) {
			if (elem.type === ElementTypes.vertex && elem.label === VertexLabels.moniker) {
				if (elem.identifier.indexOf('__arg') !== -1 || elem.identifier.indexOf('__rt') !== -1) {
					throw new Error(`Attached moniker with arg or return type detected.\n${JSON.stringify(elem, undefined, 0)}`);
				}
			}
		}
	});
	test('Export default RAL with nested public declarations', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export interface MyConsole { warn(message?: any, ...optionalParams: any[]): void; }',
					'interface RAL { readonly console: MyConsole }',
					'export default RAL;'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import RAL from "./a";',
					'let r: RAL;',
					'r.console.warn();'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 193);
		const validate: Element[] = [
			JSON.parse('{"id":15,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:MyConsole","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":22,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:MyConsole.warn","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":74,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:default","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":78,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:default.console","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":79,"type":"edge","label":"attach","outV":78,"inV":64}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export default RAL with aliased interface type', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'interface _Buffer { end(); }',
					'namespace RAL { export type Buffer = _Buffer; }',
					'export default RAL;'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import RAL from "./a";',
					'let b: RAL.Buffer;'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 136);
		// There is no a:RAL.Buffer.end since _Buffer is named.
		const validate: Element[] = [
			JSON.parse('{"id":46,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:default","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":50,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:default.Buffer","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":51,"type":"edge","label":"attach","outV":50,"inV":36}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Transient symbols', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export interface IEditorMinimapOptions {',
					'	enabled?: boolean;',
					'}',
					'export let minimapOpts: Readonly<Required<IEditorMinimapOptions>>;'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { minimapOpts } from "./a";',
					'minimapOpts.enabled;'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 149);
		// Ensure that be sees enabled.
	});
	test('Property with ReadonlyArray<string>', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export interface CodeActionProvider {',
					'	readonly providedCodeActionKinds?: ReadonlyArray<string>;',
					'}'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { CodeActionProvider } from "./a";',
					'let c: CodeActionProvider;',
					'c.providedCodeActionKinds;'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 124);
		const validate: Element[] = [
			JSON.parse('{"id":22,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:CodeActionProvider.providedCodeActionKinds","unique":"workspace","kind":"export"}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Property with ReadonlyArray<literal type>', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export interface CodeActionProvider {',
					'	readonly documentation?: ReadonlyArray<{ readonly kind: string, readonly command: number }>',
					'}'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { CodeActionProvider } from "./a";',
					'let provider: CodeActionProvider;',
					'provider?.documentation?[0].kind'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 158);
		const validate: Element[] = [
			JSON.parse('{"id":42,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:CodeActionProvider.documentation.kind","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":43,"type":"edge","label":"attach","outV":42,"inV":29}'),
			JSON.parse('{"id":44,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:CodeActionProvider.documentation.command","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":45,"type":"edge","label":"attach","outV":44,"inV":36}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test('Property with literal type[]', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export interface IModelTokensChangedEvent {',
					'	readonly ranges: {',
					'		readonly fromLineNumber: number;',
					'		readonly toLineNumber: number;',
					'	}[];',
					'}'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { IModelTokensChangedEvent } from "./a";',
					'let event: IModelTokensChangedEvent;',
					'event.ranges.fromLineNumber;'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.strictEqual(emitter.lastId, 158);
		const validate: Element[] = [
			JSON.parse('{"id":15,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:IModelTokensChangedEvent","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":22,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:IModelTokensChangedEvent.ranges","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":42,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:IModelTokensChangedEvent.ranges.fromLineNumber","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":43,"type":"edge","label":"attach","outV":42,"inV":29}'),
			JSON.parse('{"id":44,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:IModelTokensChangedEvent.ranges.toLineNumber","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":45,"type":"edge","label":"attach","outV":44,"inV":36}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
	test.skip('Type Reference', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export class FindReplaceState<T extends { update: (value: T) => void; } = { update: () => {} } {',
					'}'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { FindReplaceState } from "./a";',
					'export class FindModelBoundToEditorModel {',
					'   constructor(_state: FindReplaceState) {',
					'   }',
					'}'
				].join(os.EOL)
			]
		]), compilerOptions);
		//		assert.strictEqual(emitter.lastId, 158);
		const validate: Element[] = [
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
});
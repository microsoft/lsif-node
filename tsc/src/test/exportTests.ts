/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'assert';
import * as os from 'os';

import { lsif } from './lsifs';
import * as ts from 'typescript';
import { Element } from 'lsif-protocol';
import { emit } from 'npm';

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
			JSON.parse('{"id":15,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":16,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo","unique":"group","kind":"export"}'),
			JSON.parse('{"id":17,"type":"edge","label":"moniker","outV":15,"inV":16}'),
			JSON.parse('{"id":18,"type":"vertex","label":"range","start":{"line":0,"character":16},"end":{"line":0,"character":19},"tag":{"type":"definition","text":"foo","kind":12,"fullRange":{"start":{"line":0,"character":0},"end":{"line":0,"character":31}}}}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
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
			JSON.parse('{"id":11,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:","unique":"group","kind":"export"}'),
			JSON.parse('{"id":16,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:x","unique":"group","kind":"export"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
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
			JSON.parse('{"id":16,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:N","unique":"group","kind":"export"}'),
			JSON.parse('{"id":23,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:N.a","unique":"group","kind":"export"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
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
			JSON.parse('{"id":15,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":16,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"YMJQRLr/qZiUrOskF3looA==","unique":"document","kind":"local"}'),
			JSON.parse('{"id":17,"type":"edge","label":"moniker","outV":15,"inV":16}'),
			JSON.parse('{"id":22,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":23,"type":"edge","label":"next","outV":22,"inV":15}'),
			JSON.parse('{"id":24,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo","unique":"group","kind":"export"}'),
			JSON.parse('{"id":25,"type":"edge","label":"moniker","outV":22,"inV":24}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
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
		const validate: Element[] = [
			// _foo
			JSON.parse('{"id":15,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":16,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"YeBaOlHI3V6HYvNguYaW9Q==","unique":"document","kind":"local"}'),
			JSON.parse('{"id":17,"type":"edge","label":"moniker","outV":15,"inV":16}'),
			JSON.parse('{"id":18,"type":"vertex","label":"range","start":{"line":0,"character":9},"end":{"line":0,"character":13},"tag":{"type":"definition","text":"_foo","kind":12,"fullRange":{"start":{"line":0,"character":0},"end":{"line":0,"character":19}}}}'),
			JSON.parse('{"id":19,"type":"edge","label":"next","outV":18,"inV":15}'),
			// Alias foo with reference result since it is a rename
			JSON.parse('{"id":24,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":25,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo","unique":"group","kind":"export"}'),
			JSON.parse('{"id":26,"type":"edge","label":"moniker","outV":24,"inV":25}'),
			JSON.parse('{"id":27,"type":"vertex","label":"range","start":{"line":1,"character":17},"end":{"line":1,"character":20},"tag":{"type":"definition","text":"foo","kind":7,"fullRange":{"start":{"line":1,"character":9},"end":{"line":1,"character":20}}}}'),
			JSON.parse('{"id":28,"type":"vertex","label":"referenceResult"}'),
			JSON.parse('{"id":29,"type":"edge","label":"textDocument/references","outV":24,"inV":28}'),
			// The reference result for _foo
			JSON.parse('{"id":42,"type":"vertex","label":"referenceResult"}'),
			JSON.parse('{"id":43,"type":"edge","label":"textDocument/references","outV":15,"inV":42}'),
			JSON.parse('{"id":46,"type":"edge","label":"item","outV":42,"inVs":[28],"shard":8,"property":"referenceResults"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export = function', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'function foo(): void { }',
					'export = foo;'
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
			JSON.parse('{"id":15,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":22,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":23,"type":"edge","label":"next","outV":22,"inV":15}'),
			JSON.parse('{"id":24,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:export=","unique":"group","kind":"export"}'),
			JSON.parse('{"id":25,"type":"edge","label":"moniker","outV":22,"inV":24}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
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
			JSON.parse('{"id":22,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":23,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"WzmMfsn1pdjmwBw/mXw4bw==","unique":"document","kind":"local"}'),
			JSON.parse('{"id":24,"type":"edge","label":"moniker","outV":22,"inV":23}'),
			JSON.parse('{"id":25,"type":"vertex","label":"range","start":{"line":0,"character":14},"end":{"line":0,"character":17},"tag":{"type":"definition","text":"foo","kind":7,"fullRange":{"start":{"line":0,"character":14},"end":{"line":0,"character":26}}}}'),
			JSON.parse('{"id":26,"type":"edge","label":"next","outV":25,"inV":22}'),
			JSON.parse('{"id":35,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:export=.foo","unique":"group","kind":"export"}'),
			JSON.parse('{"id":36,"type":"edge","label":"attach","outV":35,"inV":23}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
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
			JSON.parse('{"id":15,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":22,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":23,"type":"edge","label":"next","outV":22,"inV":15}'),
			JSON.parse('{"id":24,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:default","unique":"group","kind":"export"}'),
			JSON.parse('{"id":25,"type":"edge","label":"moniker","outV":22,"inV":24}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
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
			JSON.parse('{"id":22,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":23,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"WzmMfsn1pdjmwBw/mXw4bw==","unique":"document","kind":"local"}'),
			JSON.parse('{"id":24,"type":"edge","label":"moniker","outV":22,"inV":23}'),
			JSON.parse('{"id":25,"type":"vertex","label":"range","start":{"line":0,"character":14},"end":{"line":0,"character":17},"tag":{"type":"definition","text":"foo","kind":7,"fullRange":{"start":{"line":0,"character":14},"end":{"line":0,"character":26}}}}'),
			JSON.parse('{"id":26,"type":"edge","label":"next","outV":25,"inV":22}'),
			JSON.parse('{"id":35,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:default.foo","unique":"group","kind":"export"}'),
			JSON.parse('{"id":36,"type":"edge","label":"attach","outV":35,"inV":23}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
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
	test('Export { RAL } with multiple declarations', async () => {
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
		assert.deepEqual(emitter.lastId, 113);
		const validate: Element[] = [
			JSON.parse('{"id":46,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:default.x","unique":"group","kind":"export"}'),
			JSON.parse('{"id":47,"type":"edge","label":"attach","outV":46,"inV":34}'),
			JSON.parse('{"id":48,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:default.y","unique":"group","kind":"export"}'),
			JSON.parse('{"id":49,"type":"edge","label":"attach","outV":48,"inV":27}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export { RAL } with nested declarations', async () => {
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
		assert.deepEqual(emitter.lastId, 145);
		const validate: Element[] = [
			JSON.parse('{"id":43,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":44,"type":"edge","label":"next","outV":43,"inV":15}'),
			JSON.parse('{"id":45,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:default","unique":"group","kind":"export"}'),
			JSON.parse('{"id":46,"type":"edge","label":"moniker","outV":43,"inV":45}'),
			JSON.parse('{"id":47,"type":"vertex","label":"range","start":{"line":1,"character":15},"end":{"line":1,"character":18},"tag":{"type":"reference","text":"RAL"}}'),
			JSON.parse('{"id":48,"type":"edge","label":"next","outV":47,"inV":15}'),
			JSON.parse('{"id":52,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:default.console","unique":"group","kind":"export"}'),
			JSON.parse('{"id":53,"type":"edge","label":"attach","outV":52,"inV":23}'),
			JSON.parse('{"id":54,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:default.console.warn","unique":"group","kind":"export"}'),
			JSON.parse('{"id":55,"type":"edge","label":"attach","outV":54,"inV":30}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export { RAL } with nested public declarations', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export interface MyConsole { warn(message?: any, ...optionalParams: any[]): void; }',
					'interface RAL { readonly console: MyConsole }',
					'export default RAL;'
				].join(os.EOL)
			]
		]), compilerOptions);
		console.log(emitter.toString());
		assert.deepEqual(emitter.lastId, 146);
		const validate: Element[] = [
			JSON.parse('{"id":16,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:MyConsole","unique":"group","kind":"export"}'),
			JSON.parse('{"id":23,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:MyConsole.warn","unique":"group","kind":"export"}'),
			JSON.parse('{"id":76,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:RAL","unique":"group","kind":"export"}'),
			JSON.parse('{"id":82,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:RAL.console","unique":"group","kind":"export"}'),
			JSON.parse('{"id":83,"type":"edge","label":"attach","outV":82,"inV":66}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export { RAL } aliased interface type', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'interface _Buffer { end(); }',
					'namespace RAL { export type Buffer = _Buffer; }',
					'export default RAL;'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.deepEqual(emitter.lastId, 94);
		// There is no a:RAL.Buffer.end since _Buffer is named.
		const validate: Element[] = [
			JSON.parse('{"id":47,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:RAL","unique":"group","kind":"export"}'),
			JSON.parse('{"id":53,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:RAL.Buffer","unique":"group","kind":"export"}'),
			JSON.parse('{"id":54,"type":"edge","label":"attach","outV":53,"inV":37}'),
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
});
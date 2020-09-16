/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'assert';
import * as os from 'os';

import { lsif } from './lsifs';
import * as ts from 'typescript';
import { Element } from 'lsif-protocol';

suite('Module System Tests', () => {
	const compilerOptions: ts.CompilerOptions = {
		module: ts.ModuleKind.CommonJS,
		target: ts.ScriptTarget.ES5,
		rootDir: '/@test'
	};
	test('Single export', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export const x: number | string = 10;',
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
	test('Namespace export', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export namespace N { export const a: number = 10; }',
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
	test('Default export', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'function foo() { }',
					'export default foo;'
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":15,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":16,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"z9tFVl5qLcmtAWiHkDMgtg==","unique":"document","kind":"local"}'),
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
	test('Export = foo', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'function foo() { }',
					'export = foo;'
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":15,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":16,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"z9tFVl5qLcmtAWiHkDMgtg==","unique":"document","kind":"local"}'),
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
	test('Export { foo }', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'function foo() { }',
					'export { foo };'
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":15,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":16,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"z9tFVl5qLcmtAWiHkDMgtg==","unique":"document","kind":"local"}'),
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
	test('Export { _foo as foo }', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'function _foo() { }',
					'export { _foo as foo };'
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":15,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":16,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"170NjUeOL6mfW3aDVml2Ig==","unique":"document","kind":"local"}'),
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
	test('Export { foo } with children', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'namespace foo { export const x = 10; }',
					'export { foo };'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.deepEqual(emitter.lastId, 65);
		const validate: Element[] = [
			JSON.parse('{"id":16,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"VLZrX43VmC8pcNLmu3MJDA==","unique":"document","kind":"local"}'),
			JSON.parse('{"id":23,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"W+GcqeTBebr7ph8ZDmst6w==","unique":"document","kind":"local"}'),
			// This needs its own result set since we have a different hover.
			JSON.parse('{"id":29,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":30,"type":"edge","label":"next","outV":29,"inV":15}'),
			JSON.parse('{"id":31,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo","unique":"group","kind":"export"}'),
			JSON.parse('{"id":32,"type":"edge","label":"moniker","outV":29,"inV":31}'),
			// JSON.parse('{"id":35,"type":"vertex","label":"hoverResult","result":{"contents":[{"language":"typescript","value":"(alias) namespace foo\\nexport foo"}]}}'),
			JSON.parse('{"id":36,"type":"edge","label":"textDocument/hover","outV":29,"inV":35}'),
			JSON.parse('{"id":37,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo.x","unique":"group","kind":"export"}'),
			JSON.parse('{"id":38,"type":"edge","label":"attach","outV":37,"inV":23}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export { RAL } with multiple declarations', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'interface RAL { readonly y: number; }',
					'namespace RAL { export const x = 10; }',
					'function RAL() { }',
					'export default RAL;'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.deepEqual(emitter.lastId, 86);
		const validate: Element[] = [
			JSON.parse('{"id":48,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:RAL.x","unique":"group","kind":"export"}'),
			JSON.parse('{"id":49,"type":"edge","label":"attach","outV":48,"inV":34}'),
			JSON.parse('{"id":50,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:RAL.y","unique":"group","kind":"export"}'),
			JSON.parse('{"id":51,"type":"edge","label":"attach","outV":50,"inV":27}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export { RAL } with nested declarations', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'interface RAL { readonly console: { warn(message?: any, ...optionalParams: any[]): void; } }',
					'export default RAL;'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.deepEqual(emitter.lastId, 140);
		const validate: Element[] = [
			JSON.parse('{"id":72,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:RAL","unique":"group","kind":"export"}'),
			JSON.parse('{"id":78,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:RAL.console","unique":"group","kind":"export"}'),
			JSON.parse('{"id":79,"type":"edge","label":"attach","outV":78,"inV":23}'),
			JSON.parse('{"id":80,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:RAL.console.warn","unique":"group","kind":"export"}'),
			JSON.parse('{"id":81,"type":"edge","label":"attach","outV":80,"inV":30}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export { RAL } with nested public declarations', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export interface MyConsole { warn(message?: any, ...optionalParams: any[]): void; }',
					'interface RAL { readonly console: MyConsole }',
					'export default RAL;'
				].join(os.EOL)
			]
		]), compilerOptions);
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
	test('Export { RAL } aliased interface type', () => {
		const emitter = lsif('/@test', new Map([
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
	test('Export { foo } with import', () => {
		const emitter = lsif('/@test', new Map([
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
			JSON.parse('{"id":16,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"z9tFVl5qLcmtAWiHkDMgtg==","unique":"document","kind":"local"}'),
			JSON.parse('{"id":39,"type":"vertex","label":"referenceResult"}'),
			JSON.parse('{"id":40,"type":"edge","label":"textDocument/references","outV":15,"inV":39}'),
			JSON.parse('{"id":60,"type":"vertex","label":"range","start":{"line":0,"character":9},"end":{"line":0,"character":12},"tag":{"type":"definition","text":"foo","kind":7,"fullRange":{"start":{"line":0,"character":9},"end":{"line":0,"character":12}}}}'),
			JSON.parse('{"id":66,"type":"vertex","label":"range","start":{"line":1,"character":0},"end":{"line":1,"character":3},"tag":{"type":"reference","text":"foo"}}'),
			JSON.parse('{"id":74,"type":"edge","label":"item","outV":39,"inVs":[60,66],"shard":49,"property":"references"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export variable declaration', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export let foo: { touch: boolean };'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.deepEqual(emitter.lastId, 60);
		const validate: Element[] = [
			JSON.parse('{"id":16,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo","unique":"group","kind":"export"}'),
			JSON.parse('{"id":34,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo.touch","unique":"group","kind":"export"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export variable declaration with inferred type', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export const foo = { touch: true };'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.deepEqual(emitter.lastId, 62);
		const validate: Element[] = [
			JSON.parse('{"id":16,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo","unique":"group","kind":"export"}'),
			JSON.parse('{"id":34,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo.touch","unique":"group","kind":"export"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export inferred function return type', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export function foo() { return { touch: true }; }'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.deepEqual(emitter.lastId, 64);
		const validate: Element[] = [
			JSON.parse('{"id":16,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo","unique":"group","kind":"export"}'),
			JSON.parse('{"id":30,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"6R7I4yKdXikhIJtj2BY+gg==","unique":"document","kind":"local"}'),
			JSON.parse('{"id":34,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo.touch","unique":"group","kind":"export"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export inferred method return type', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export class Foo { public bar() { return { touch: true }; } }'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.deepEqual(emitter.lastId, 77);
		const validate: Element[] = [
			JSON.parse('{"id":23,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:Foo.bar","unique":"group","kind":"export"}'),
			JSON.parse('{"id":41,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:Foo.bar.touch","unique":"group","kind":"export"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export composite return type', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export interface Foo { bar(): { toString(): string } | { toString(): number }; }'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.deepEqual(emitter.lastId, 100);
		const validate: Element[] = [
			JSON.parse('{"id":53,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:Foo.bar.toString","unique":"group","kind":"export"}'),
			JSON.parse('{"id":54,"type":"edge","label":"attach","outV":53,"inV":30}'),
			JSON.parse('{"id":55,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:Foo.bar.toString","unique":"group","kind":"export"}'),
			JSON.parse('{"id":56,"type":"edge","label":"attach","outV":55,"inV":42}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export type via property', () => {
		const emitter = lsif('/@test', new Map([
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
		assert.deepEqual(emitter.lastId, 136);
	});
	test('Export type via property signature', () => {
		const emitter = lsif('/@test', new Map([
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
		assert.deepEqual(emitter.lastId, 134);
		// There will not be a moniker for a:Bar.foo.touch since interface Foo is named.
		// However symbol data must survive for b.ts
	});
	test('Export type via variable declaration in namespace', () => {
		const emitter = lsif('/@test', new Map([
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
		assert.deepEqual(emitter.lastId, 118);
		// There will not be a moniker for a:Bar.foo.touch since interface Foo is named.
		// However symbol data must survive for b.ts
	});
	test('Export type via variable declaration with anonymous class declaration', () => {
		const emitter = lsif('/@test', new Map([
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
		assert.deepEqual(emitter.lastId, 133);
		// There will not be a moniker for a:Bar.foo.touch since interface Foo is named.
		// However symbol data must survive for b.ts
	});
	test('Export function with literal param', () => {
		const emitter = lsif('/@test', new Map([
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
		assert.deepEqual(emitter.lastId, 153);
	});
	test('Export function with callback signature', () => {
		const emitter = lsif('/@test', new Map([
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
		assert.deepEqual(emitter.lastId, 210);
		const validate: Element[] = [
			JSON.parse('{"id":72,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo.callback.entry.key","unique":"group","kind":"export"}'),
			JSON.parse('{"id":73,"type":"edge","label":"attach","outV":72,"inV":37}'),
			JSON.parse('{"id":74,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo.callback.entry.value","unique":"group","kind":"export"}'),
			JSON.parse('{"id":75,"type":"edge","label":"attach","outV":74,"inV":44}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export function with callback signature as return value', () => {
		const emitter = lsif('/@test', new Map([
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
		assert.deepEqual(emitter.lastId, 216);
		const validate: Element[] = [
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Transient symbols', () => {
		const emitter = lsif('/@test', new Map([
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
		assert.deepEqual(emitter.lastId, 158);
		const validate: Element[] = [
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Property with ReadonlyArray<string>', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export interface CodeActionProvider {',
					'	readonly providedCodeActionKinds?: ReadonlyArray<string>;',
					'}'
				].join(os.EOL)
			]
		]), compilerOptions);
		assert.deepEqual(emitter.lastId, 78);
		const validate: Element[] = [
			JSON.parse('{"id":23,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:CodeActionProvider.providedCodeActionKinds","unique":"group","kind":"export"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Property with ReadonlyArray<literal type>', () => {
		const emitter = lsif('/@test', new Map([
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
		assert.deepEqual(emitter.lastId, 168);
		const validate: Element[] = [
			JSON.parse('{"id":61,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:CodeActionProvider.documentation.kind","unique":"group","kind":"export"}'),
			JSON.parse('{"id":62,"type":"edge","label":"attach","outV":61,"inV":43}'),
			JSON.parse('{"id":63,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:CodeActionProvider.documentation.command","unique":"group","kind":"export"}'),
			JSON.parse('{"id":64,"type":"edge","label":"attach","outV":63,"inV":50}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Property with literal type[]', () => {
		const emitter = lsif('/@test', new Map([
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
			]
		]), compilerOptions);
		assert.deepEqual(emitter.lastId, 118);
		const validate: Element[] = [
			JSON.parse('{"id":16,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:IModelTokensChangedEvent","unique":"group","kind":"export"}'),
			JSON.parse('{"id":23,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:IModelTokensChangedEvent.ranges","unique":"group","kind":"export"}'),
			JSON.parse('{"id":63,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:IModelTokensChangedEvent.ranges.fromLineNumber","unique":"group","kind":"export"}'),
			JSON.parse('{"id":64,"type":"edge","label":"attach","outV":63,"inV":30}'),
			JSON.parse('{"id":65,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:IModelTokensChangedEvent.ranges.toLineNumber","unique":"group","kind":"export"}'),
			JSON.parse('{"id":66,"type":"edge","label":"attach","outV":65,"inV":37}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Extend private class', () => {
		const emitter = lsif('/@test', new Map([
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
		assert.deepEqual(emitter.lastId, 133);
		const validate: Element[] = [
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
});

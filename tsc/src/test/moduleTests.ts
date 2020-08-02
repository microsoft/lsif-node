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
	test('Export { foo } ', () => {
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
			JSON.parse('{"id":25,"type":"edge","label":"next","outV":24,"inV":15}'),
			JSON.parse('{"id":26,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:foo","unique":"group","kind":"export"}'),
			JSON.parse('{"id":27,"type":"edge","label":"moniker","outV":24,"inV":26}')
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
		console.log(emitter.toString());
		const validate: Element[] = [
			JSON.parse('{"id":16,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"VLZrX43VmC8pcNLmu3MJDA==","unique":"document","kind":"local"}'),
			
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
});
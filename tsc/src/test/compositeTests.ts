/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'assert';
import * as os from 'os';

import { lsif } from './lsifs';
import * as ts from 'typescript';
import { Element } from 'lsif-protocol';

suite('Union Types', () => {
	const compilerOptions: ts.CompilerOptions = {
		module: ts.ModuleKind.CommonJS,
		target: ts.ScriptTarget.ES5,
		rootDir: '/@test'
	};
	test('base types', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export const x: number | string = 10;',
					'x.toString();'
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":16,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:x","unique":"group","kind":"export"}'),
			JSON.parse('{"id":29,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":Number.toString","unique":"group","kind":"export"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Union type (2)', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export interface A { name: string };',
					'export interface B { name: string };',
					'export type C = A | B;',
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { C } from "./a";',
					'let c: C;',
					'c.name;'
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":128,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":129,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":[a:A.name,a:B.name]","unique":"group","kind":"export"}'),
			JSON.parse('{"id":154,"type":"vertex","label":"referenceResult"}'),
			JSON.parse('{"id":155,"type":"edge","label":"textDocument/references","outV":128,"inV":154}'),
			JSON.parse('{"id":156,"type":"edge","label":"item","outV":154,"inVs":[70,83],"shard":2,"property":"referenceResults"}'),
			JSON.parse('{"id":157,"type":"edge","label":"item","outV":154,"inVs":[23,37],"shard":2,"property":"referenceLinks"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Union type (3)', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export interface A { name: string };',
					'export interface B { name: string };',
					'export interface C { name: string };',
					'export type D = A | (A & B);',
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { D } from "./a";',
					'let d: D;',
					'd.name;'
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":23,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:A.name","unique":"group","kind":"export"}'),
			JSON.parse('{"id":37,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:B.name","unique":"group","kind":"export"}'),
			JSON.parse('{"id":156,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":157,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":[a:A.name,a:B.name]","unique":"group","kind":"export"}'),
			JSON.parse('{"id":182,"type":"vertex","label":"referenceResult"}'),
			JSON.parse('{"id":183,"type":"edge","label":"textDocument/references","outV":156,"inV":182}'),
			JSON.parse('{"id":184,"type":"edge","label":"item","outV":182,"inVs":[86,99],"shard":2,"property":"referenceResults"}'),
			JSON.parse('{"id":185,"type":"edge","label":"item","outV":182,"inVs":[23,37],"shard":2,"property":"referenceLinks"}'),
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Union types with literals', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export type D = { name: string; } | { name: number; };',
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'import { D } from "./a";',
					'let d: D;',
					'd.name;'
				].join(os.EOL)
			],
			[
				'/@test/c.ts',
				[
					'import { D } from "./a";',
					'let d: D;',
					'd.name;'
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":46,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:D.name","unique":"group","kind":"export"}'),
			JSON.parse('{"id":47,"type":"edge","label":"attach","outV":46,"inV":23}'),
			JSON.parse('{"id":48,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:D.name","unique":"group","kind":"export"}'),
			JSON.parse('{"id":49,"type":"edge","label":"attach","outV":48,"inV":35}'),
			JSON.parse('{"id":113,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":a:D.name","unique":"group","kind":"export"}')
		];
		assert.deepEqual(emitter.lastId, 191);
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
});
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
	test('base types', async () => {
		const emitter = await lsif('/@test', new Map([
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
	test('Union type (2)', async () => {
		const emitter = await lsif('/@test', new Map([
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
			JSON.parse('{"id":132,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":133,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":[a:A.name,a:B.name]","unique":"group","kind":"export"}'),
			JSON.parse('{"id":160,"type":"vertex","label":"referenceResult"}'),
			JSON.parse('{"id":161,"type":"edge","label":"textDocument/references","outV":132,"inV":160}'),
			JSON.parse('{"id":162,"type":"edge","label":"item","outV":160,"inVs":[70,83],"shard":2,"property":"referenceResults"}'),
			JSON.parse('{"id":163,"type":"edge","label":"item","outV":160,"inVs":[23,37],"shard":2,"property":"referenceLinks"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Union type (3)', async () => {
		const emitter = await lsif('/@test', new Map([
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
			JSON.parse('{"id":160,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":161,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":[a:A.name,a:B.name]","unique":"group","kind":"export"}'),
			JSON.parse('{"id":188,"type":"vertex","label":"referenceResult"}'),
			JSON.parse('{"id":189,"type":"edge","label":"textDocument/references","outV":160,"inV":188}'),
			JSON.parse('{"id":190,"type":"edge","label":"item","outV":188,"inVs":[86,99],"shard":2,"property":"referenceResults"}'),
			JSON.parse('{"id":191,"type":"edge","label":"item","outV":188,"inVs":[23,37],"shard":2,"property":"referenceLinks"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Union types with literals', async () => {
		const emitter = await lsif('/@test', new Map([
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
		assert.deepEqual(emitter.lastId, 195);
		const validate: Element[] = [
			JSON.parse('{"id":42,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:D.name","unique":"group","kind":"export"}'),
			JSON.parse('{"id":43,"type":"edge","label":"attach","outV":42,"inV":26}'),
			JSON.parse('{"id":44,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:D.name","unique":"group","kind":"export"}'),
			JSON.parse('{"id":45,"type":"edge","label":"attach","outV":44,"inV":36}'),
			JSON.parse('{"id":109,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":a:D.name","unique":"group","kind":"export"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
});
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'assert';
import * as os from 'os';

import { lsif, ts, assertElement } from './lsifs';
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
			JSON.parse('{"id":15,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:x","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":27,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":Number.toString","unique":"workspace","kind":"export"}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
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
		assert.deepEqual(emitter.lastId, 156);
		const validate: Element[] = [
			JSON.parse('{"id":126,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":127,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":[a:A.name,a:B.name]","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":128,"type":"edge","label":"moniker","outV":126,"inV":127}'),
			JSON.parse('{"id":153,"type":"edge","label":"textDocument/references","outV":126,"inV":152}'),
			JSON.parse('{"id":154,"type":"edge","label":"item","outV":152,"inVs":[70,83],"shard":3,"property":"referenceResults"}'),
			JSON.parse('{"id":155,"type":"edge","label":"item","outV":152,"inVs":[22,36],"shard":3,"property":"referenceLinks"}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
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
		assert.deepEqual(emitter.lastId, 184);
		const validate: Element[] = [
			JSON.parse('{"id":22,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:A.name","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":36,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:B.name","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":154,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":155,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":[a:A.name,a:B.name]","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":156,"type":"edge","label":"moniker","outV":154,"inV":155}'),
			JSON.parse('{"id":180,"type":"vertex","label":"referenceResult"}'),
			JSON.parse('{"id":181,"type":"edge","label":"textDocument/references","outV":154,"inV":180}'),
			JSON.parse('{"id":182,"type":"edge","label":"item","outV":180,"inVs":[86,99],"shard":3,"property":"referenceResults"}'),
			JSON.parse('{"id":183,"type":"edge","label":"item","outV":180,"inVs":[22,36],"shard":3,"property":"referenceLinks"}'),
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
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
		assert.deepEqual(emitter.lastId, 175);
		const validate: Element[] = [
			JSON.parse('{"id":35,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:D.name","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":36,"type":"edge","label":"attach","outV":35,"inV":22}'),
			JSON.parse('{"id":37,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:D.name","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":38,"type":"edge","label":"attach","outV":37,"inV":29}'),
			JSON.parse('{"id":97,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":a:D.name","unique":"workspace","kind":"export"}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
});
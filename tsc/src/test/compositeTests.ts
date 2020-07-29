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
			JSON.parse('{"id":22,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:x","unique":"group","kind":"export"}'),
			JSON.parse('{"id":33,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":Number.toString","unique":"group","kind":"export"}')
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
		console.log(emitter.toString());
		const validate: Element[] = [
			JSON.parse('{"id":132,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":133,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":[a:A.name,a:B.name]","unique":"group","kind":"export"}'),
			JSON.parse('{"id":148,"type":"vertex","label":"referenceResult"}'),
			JSON.parse('{"id":149,"type":"edge","label":"textDocument/references","outV":132,"inV":148}'),
			JSON.parse('{"id":149,"type":"edge","label":"item","outV":147,"inVs":[67,80],"shard":2,"property":"referenceResults"}')
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
			JSON.parse('{"id":20,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:A.name","unique":"group","kind":"export"}'),
			JSON.parse('{"id":34,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:B.name","unique":"group","kind":"export"}'),
			JSON.parse('{"id":151,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":152,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":[a:A.name,a:B.name]","unique":"group","kind":"export"}'),
			JSON.parse('{"id":151,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":176,"type":"edge","label":"textDocument/references","outV":151,"inV":175}'),
			JSON.parse('{"id":177,"type":"edge","label":"item","outV":175,"inVs":[83,96],"shard":2,"property":"referenceResults"}'),
			JSON.parse('{"id":178,"type":"edge","label":"item","outV":175,"inVs":[20,34],"shard":2,"property":"referenceLinks"}')
		];
		console.log(emitter.toString());
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
});
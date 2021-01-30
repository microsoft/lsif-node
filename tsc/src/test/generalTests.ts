/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'assert';
import * as os from 'os';

import * as ts from 'typescript';

import { lsif } from './lsifs';
import { Element } from 'lsif-protocol';

suite('General Tests', () => {
	const compilerOptions: ts.CompilerOptions = {
		module: ts.ModuleKind.CommonJS,
		target: ts.ScriptTarget.ES5,
		rootDir: '/@test'
	};
	test('Single export', async () => {
		const emitter = await lsif('/@test', new Map([
			['/@test/a.ts', 'export const x = 10;']
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":11,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:","unique":"group","kind":"export"}'),
			JSON.parse('{"id":16,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:x","unique":"group","kind":"export"}'),
			JSON.parse('{"id":18,"type":"vertex","label":"range","start":{"line":0,"character":13},"end":{"line":0,"character":14},"tag":{"type":"definition","text":"x","kind":7,"fullRange":{"start":{"line":0,"character":13},"end":{"line":0,"character":19}}}}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Type cyclic references', async () => {
		await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export type BaseCompressValue =  boolean | number | string | object;',
					'export type CompressValue = BaseCompressValue | undefined | CompressArray;',
					'export interface CompressArray extends Array<CompressValue> {}',
				].join(os.EOL)
			]
		]), compilerOptions);
		// No endless recursion
	});
});
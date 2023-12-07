/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as os from 'os';

import { lsif, ts, assertElement } from './lsifs';
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
			JSON.parse('{"id":10,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":15,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:x","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":17,"type":"vertex","label":"range","start":{"line":0,"character":13},"end":{"line":0,"character":14},"tag":{"type":"definition","text":"x","kind":7,"fullRange":{"start":{"line":0,"character":13},"end":{"line":0,"character":19}}}}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
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
	test('Reference Links', async() => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'interface A { func(); }',
					'interface B extends A { func1(); }',
					'interface C extends B { func2(); }',
					'class D implements C { func() {} func1() {} func2() {} }',
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":17,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":A.func","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":33,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":B.func1","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":49,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":C.func2","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":137,"type":"edge","label":"item","outV":134,"inVs":[17],"shard":7,"property":"referenceLinks"}'),
			JSON.parse('{"id":144,"type":"edge","label":"item","outV":141,"inVs":[33],"shard":7,"property":"referenceLinks"}'),
			JSON.parse('{"id":151,"type":"edge","label":"item","outV":148,"inVs":[49],"shard":7,"property":"referenceLinks"}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
});
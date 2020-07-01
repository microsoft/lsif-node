/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

// import * as assert from 'assert';
import * as os from 'os';

import { lsif } from './lsifs';
import * as ts from 'typescript';

suite('Union Types', () => {
	const compilerOptions: ts.CompilerOptions = {
		module: ts.ModuleKind.CommonJS,
		target: ts.ScriptTarget.ES5,
		rootDir: '/@test'
	};
	// test('base types', () => {
	// 	const emitter = lsif('/@test', new Map([
	// 		[
	// 			'/@test/a.ts',
	// 			[
	// 				'export const x: number | string = 10;',
	// 				'x.toString();'
	// 			].join(os.EOL)
	// 		]
	// 	]), compilerOptions);
	// 	const xm = JSON.parse('{"id":13,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:x","unique":"group","kind":"export"}');
	// 	const toString = JSON.parse('{"id":24,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":Number.toString","unique":"group","kind":"export"}');
	// 	assert.deepEqual(emitter.elements.get(13), xm);
	// 	assert.deepEqual(emitter.elements.get(24), toString);
	// });
	// test('Union type (2)', () => {
	// 	const emitter = lsif('/@test', new Map([
	// 		[
	// 			'/@test/a.ts',
	// 			[
	// 				'export interface A { name: string };',
	// 				'export interface B { name: string };',
	// 				'export type C = A | B;',
	// 			].join(os.EOL)
	// 		],
	// 		[
	// 			'/@test/b.ts',
	// 			[
	// 				'import { C } from "./a";',
	// 				'let c: C;',
	// 				'c.name;'
	// 			].join(os.EOL)
	// 		]
	// 	]), compilerOptions);
	// 	console.log(emitter.toString());
	// });
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
		console.log(emitter.toString());
	});
});
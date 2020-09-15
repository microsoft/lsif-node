/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'assert';
import * as os from 'os';

import { lsif } from './lsifs';
import * as ts from 'typescript';
import { Element } from 'lsif-protocol';

suite('Scope Tests', () => {
	const compilerOptions: ts.CompilerOptions = {
		module: ts.ModuleKind.CommonJS,
		target: ts.ScriptTarget.ES5,
		rootDir: '/@test'
	};
	test('Function parameter', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export function foo(x: number): void { };',
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":23,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"KXyaWAVvNlCv7grudI07wg==","unique":"document","kind":"local"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
});
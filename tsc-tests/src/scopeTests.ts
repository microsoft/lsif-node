/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as os from 'os';

import { lsif, ts, assertElement } from './lsifs';
import { Element } from 'lsif-protocol';

suite('Scope Tests', () => {
	const compilerOptions: ts.CompilerOptions = {
		module: ts.ModuleKind.CommonJS,
		target: ts.ScriptTarget.ES5,
		rootDir: '/@test'
	};
	test('Function parameter', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'export function foo(x: number): void { };',
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":22,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"*","unique":"document","kind":"local"}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
});
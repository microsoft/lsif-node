/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as os from 'os';

import { lsif, ts, assertElement } from './lsifs';
import { Element } from 'lsif-protocol';

suite('JavaScript Tests', () => {
	const compilerOptions: ts.CompilerOptions = {
		allowJs: true,
		module: ts.ModuleKind.CommonJS,
		target: ts.ScriptTarget.ES5,
		esModuleInterop: true,
		rootDir: '/@test'
	};

	test('module.exports', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.js',
				[
					'module.exports = Route;',
					'function Route(pppp) {',
  					'	this.path = pppp;',
					'}'
				].join(os.EOL)
			],
			[
				'/@test/b.js',
				[
					'const Route = require("./a");',
					'new Route();'
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
});
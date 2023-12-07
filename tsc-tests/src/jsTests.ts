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
			JSON.parse('{"id":23,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:export=","unique":"workspace","kind":"export"}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});

	test('module.exports with liternal', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.js',
				[
					'function _Route(pppp) {',
  					'	this.path = pppp;',
					'}',
					'module.exports = {',
					'    Route = _Route;',
					'}'
				].join(os.EOL)
			],
			[
				'/@test/b.js',
				[
					'const a = require("./a");',
					'new a.Route();'
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":58,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:exports.Route","unique":"workspace","kind":"export"}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});

	test('JavaDoc', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.js',
				[
					'/**',
 					' * The options object parsed by Optionator.',
 					' * @typedef {Object} ParsedCLIOptions',
 					' * @property {boolean} cache Only check changed files',
					' */'
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":12,"type":"vertex","label":"range","start":{"line":2,"character":21},"end":{"line":2,"character":37},"tag":{"type":"definition","text":"ParsedCLIOptions","kind":7,"fullRange":{"start":{"line":2,"character":3},"end":{"line":4,"character":1}}}}'),
			JSON.parse('{"id":19,"type":"vertex","label":"range","start":{"line":3,"character":23},"end":{"line":3,"character":28},"tag":{"type":"definition","text":"cache","kind":7,"fullRange":{"start":{"line":3,"character":3},"end":{"line":4,"character":1}}}}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});

	test('exports.paramsHaveValue', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.js',
				[
					'function paramsHaveValue() {',
					'}',
					'exports.paramsHaveValue = paramsHaveValue;'
				].join(os.EOL)
			],
			[
				'/@test/b.js',
				[
					'const a = require("./a");',
					'a.paramsHaveValue();'
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":14,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":15,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"*","unique":"document","kind":"local"}'),
			JSON.parse('{"id":16,"type":"edge","label":"moniker","outV":14,"inV":15}'),
			JSON.parse('{"id":21,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":22,"type":"edge","label":"next","outV":21,"inV":14}'),
			JSON.parse('{"id":23,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:paramsHaveValue","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":24,"type":"edge","label":"moniker","outV":21,"inV":23}'),
			JSON.parse('{"id":25,"type":"vertex","label":"range","start":{"line":2,"character":8},"end":{"line":2,"character":23},"tag":{"type":"definition","text":"paramsHaveValue","kind":7,"fullRange":{"start":{"line":2,"character":0},"end":{"line":2,"character":23}}}}'),
			JSON.parse('{"id":26,"type":"edge","label":"next","outV":25,"inV":21}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});

	test('exports.paramsHaveValue with indirect exports', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.js',
				[
					'function paramsHaveValue() {',
					'    return { value: 10 };',
					'}',
					'exports.paramsHaveValue = paramsHaveValue;'
				].join(os.EOL)
			],
			[
				'/@test/b.js',
				[
					'const a = require("./a");',
					'a.paramsHaveValue().value;'
				].join(os.EOL)
			]
		]), compilerOptions);
		const validate: Element[] = [
			JSON.parse('{"id":14,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":15,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"*","unique":"document","kind":"local"}'),
			JSON.parse('{"id":16,"type":"edge","label":"moniker","outV":14,"inV":15}'),
			JSON.parse('{"id":21,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":22,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"*","unique":"document","kind":"local"}'),
			JSON.parse('{"id":23,"type":"edge","label":"moniker","outV":21,"inV":22}'),
			JSON.parse('{"id":24,"type":"vertex","label":"range","start":{"line":1,"character":13},"end":{"line":1,"character":18},"tag":{"type":"definition","text":"value","kind":7,"fullRange":{"start":{"line":1,"character":13},"end":{"line":1,"character":22}}}}'),
			JSON.parse('{"id":25,"type":"edge","label":"next","outV":24,"inV":21}'),
			JSON.parse('{"id":28,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":29,"type":"edge","label":"next","outV":28,"inV":14}'),
			JSON.parse('{"id":30,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:paramsHaveValue","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":31,"type":"edge","label":"moniker","outV":28,"inV":30}'),
			JSON.parse('{"id":40,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:paramsHaveValue.__rt.value","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":41,"type":"edge","label":"attach","outV":40,"inV":22}')
		];
		for (const elem of validate) {
			assertElement(emitter.elements.get(elem.id), elem);
		}
	});
});
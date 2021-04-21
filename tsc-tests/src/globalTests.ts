/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'assert';
import * as os from 'os';

import { lsif } from './lsifs';
import { Element, VertexLabels, Vertex, Edge } from 'lsif-protocol';

suite('Global Module Tests', () => {
	test('Single export', async () => {
		const emitter = await lsif('/@test', new Map([
			['/@test/a.ts', 'let x = 10;']
		]), { });
		const validate: Element[] = [
			JSON.parse('{"id":10,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":x","unique":"workspace","kind":"export"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export in namespace', async () => {
		const emitter = await lsif('/@test', new Map([
			['/@test/a.ts', 'namespace N { export const a: number = 10; }']
		]), { });
		const validate: Element[] = [
			JSON.parse('{"id":10,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":N","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":17,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":N.a","unique":"workspace","kind":"export"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Private in namespace', async () => {
		const emitter = await lsif('/@test', new Map([
			['/@test/a.ts', 'namespace N { const a: number = 10; }']
		]), { });
		const validate: Element[] = [
			JSON.parse('{"id":10,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":N","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":17,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"g5yRGXDFrx4hhFmRmF/HHA==","unique":"document","kind":"local"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Same export name', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'interface A { name: string; }',
					'namespace A { export const a: number = 10; }'
				].join(os.EOL)
			]
		]), { });
		const validate: Element[] = [
			JSON.parse('{"id":10,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":A","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":19,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":A.name","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":26,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":A.a","unique":"workspace","kind":"export"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export via type literal', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'const x = { touch: false };'
				].join(os.EOL)
			]
		]), { });
		assert.deepEqual(emitter.lastId, 42);
		const validate: Element[] = [
			JSON.parse('{"id":10,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":x","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":23,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":x.touch","unique":"workspace","kind":"export"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export in declaration file', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.d.ts',
				[
					'declare const x: { touch: false };'
				].join(os.EOL)
			]
		]), { });
		const validate: Element[] = [
			JSON.parse('{"id":10,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":x","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":23,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":x.touch","unique":"workspace","kind":"export"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export function signature in declaration file', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.d.ts',
				[
					'declare const x: { (a: number): void; };'
				].join(os.EOL)
			]
		]), { });
		const validate: Element[] = [
			JSON.parse('{"id":10,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":x","unique":"workspace","kind":"export"}'),
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Interface with signature', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.d.ts',
				[
					'interface Thenable<T> {',
					'	then<TResult>(onfulfilled?: (value: T) => TResult | Thenable<TResult>, onrejected?: (reason: any) => TResult | Thenable<TResult>): Thenable<TResult>;',
					'	then<TResult>(onfulfilled?: (value: T) => TResult | Thenable<TResult>, onrejected?: (reason: any) => void): Thenable<TResult>;',
					'}'
				].join(os.EOL)
			],
			[
				'/@test/b.d.ts',
				[
					'interface Thenable<T> {',
					'	then<TResult>(onfulfilled?: (value: T) => TResult | Thenable<TResult>, onrejected?: (reason: any) => TResult | Thenable<TResult>): Thenable<TResult>;',
					'	then<TResult>(onfulfilled?: (value: T) => TResult | Thenable<TResult>, onrejected?: (reason: any) => void): Thenable<TResult>;',
					'}'
				].join(os.EOL)
			]
		]), { });
		assert.deepEqual(emitter.lastId, 383);
		const validate: Element[] = [
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Ambient module', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.d.ts',
				[
					'declare const ApplicationInsights: number;',
					'declare module \'applicationinsights\' {',
    				'    export = ApplicationInsights;',
					'}'
				].join(os.EOL)
			]
		]), { });
		assert.deepEqual(emitter.lastId, 49);
		const validate: Element[] = [
			JSON.parse('{"id":25,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":applicationinsights.export=","unique":"workspace","kind":"export"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Bug 76', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.d.ts',
				[
					'declare module chrome {',
					'	namespace _debugger {',
					'		export var onDetach: number;',
					'	}',
					'	export { _debugger as debugger }',
					'}'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'chrome.debugger.onDetach;'
				].join(os.EOL)
			]
		]), { });
		assert.deepEqual(emitter.lastId, 83);
		const validate: (Vertex | Edge)[] = [
			JSON.parse('{"id":23,"type":"vertex","label":"resultSet"}'),
			JSON.parse('{"id":24,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"*","unique":"document","kind":"local"}'),
			JSON.parse('{"id":25,"type":"edge","label":"moniker","outV":23,"inV":24}'),
			JSON.parse('{"id":26,"type":"vertex","label":"range","start":{"line":2,"character":13},"end":{"line":2,"character":21},"tag":{"type":"definition","text":"onDetach","kind":7,"fullRange":{"start":{"line":2,"character":13},"end":{"line":2,"character":29}}}}'),
			JSON.parse('{"id":27,"type":"edge","label":"next","outV":26,"inV":23}'),
			JSON.parse('{"id":41,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:debugger.onDetach","unique":"workspace","kind":"export"}'),
			JSON.parse('{"id":42,"type":"edge","label":"attach","outV":41,"inV":24}')
		];
		for (const elem of validate) {
			const actual = emitter.elements.get(elem.id);
			if (elem.label === VertexLabels.moniker && elem.identifier === '*' && actual && actual.label === VertexLabels.moniker) {
				actual.identifier = '*';
			}
			assert.deepEqual(actual, elem);
		}
	});
	test('Constructor Signature', async () => {
		const emitter = await lsif('/@test', new Map([
			[
				'/@test/a.d.ts',
				[
					'interface TestConstructor { new <K, V>(): [K, V] }'
				].join(os.EOL)
			],
			[
				'/@test/b.ts',
				[
					'let t = new TestConstructor<number, string>();'
				].join(os.EOL)
			]
		]), { });
		assert.deepEqual(emitter.lastId, 80);
		const validate: Element[] = [
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
});
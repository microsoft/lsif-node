/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'assert';
import * as os from 'os';

import { lsif } from './lsifs';
import { Element } from 'lsif-protocol';

suite('Global Module Tests', () => {
	test('Single export', () => {
		const emitter = lsif('/@test', new Map([
			['/@test/a.ts', 'let x = 10;']
		]), { });
		const validate: Element[] = [
			JSON.parse('{"id":11,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":x","unique":"group","kind":"export"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export in namespace', () => {
		const emitter = lsif('/@test', new Map([
			['/@test/a.ts', 'namespace N { export const a: number = 10; }']
		]), { });
		const validate: Element[] = [
			JSON.parse('{"id":11,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":N","unique":"group","kind":"export"}'),
			JSON.parse('{"id":18,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":N.a","unique":"group","kind":"export"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Private in namespace', () => {
		const emitter = lsif('/@test', new Map([
			['/@test/a.ts', 'namespace N { const a: number = 10; }']
		]), { });
		const validate: Element[] = [
			JSON.parse('{"id":11,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":N","unique":"group","kind":"export"}'),
			JSON.parse('{"id":18,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"X7TAD/7fCTUXK66nQL3Zcw==","unique":"document","kind":"local"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Same export name', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'interface A { name: string; }',
					'namespace A { export const a: number = 10; }'
				].join(os.EOL)
			]
		]), { });
		const validate: Element[] = [
			JSON.parse('{"id":11,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":A","unique":"group","kind":"export"}'),
			JSON.parse('{"id":20,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":A.name","unique":"group","kind":"export"}'),
			JSON.parse('{"id":27,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":A.a","unique":"group","kind":"export"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export via type literal', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.ts',
				[
					'const x = { touch: false };'
				].join(os.EOL)
			]
		]), { });
		assert.deepEqual(emitter.lastId, 51);
		const validate: Element[] = [
			JSON.parse('{"id":11,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":x","unique":"group","kind":"export"}'),
			JSON.parse('{"id":29,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":x.touch","unique":"group","kind":"export"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export in declaration file', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.d.ts',
				[
					'declare const x: { touch: false };'
				].join(os.EOL)
			]
		]), { });
		const validate: Element[] = [
			JSON.parse('{"id":11,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":x","unique":"group","kind":"export"}'),
			JSON.parse('{"id":29,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":x.touch","unique":"group","kind":"export"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Export function signature in declaration file', () => {
		const emitter = lsif('/@test', new Map([
			[
				'/@test/a.d.ts',
				[
					'declare const x: { (a: number): void; };'
				].join(os.EOL)
			]
		]), { });
		const validate: Element[] = [
			JSON.parse('{"id":11,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":x","unique":"group","kind":"export"}'),
			JSON.parse('{"id":34,"type":"vertex","label":"moniker","scheme":"tsc","identifier":":x.1I","unique":"group","kind":"export"}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
	test('Interface with signature', () => {
		const emitter = lsif('/@test', new Map([
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
		assert.deepEqual(emitter.lastId, 421);
		const validate: Element[] = [
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
});


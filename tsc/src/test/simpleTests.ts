/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'assert';

import { lsif } from './lsifs';
import { Element } from 'lsif-protocol';

suite('Simple Tests', () => {
	test('Single export', () => {
		const emitter = lsif('/@test', new Map([
			['/@test/a.ts', 'export const x = 10;']
		]), { });
		const validate: Element[] = [
			JSON.parse('{"id":17,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:","unique":"group","kind":"export"}'),
			JSON.parse('{"id":22,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:x","unique":"group","kind":"export"}'),
			JSON.parse('{"id":24,"type":"vertex","label":"range","start":{"line":0,"character":13},"end":{"line":0,"character":14},"tag":{"type":"definition","text":"x","kind":7,"fullRange":{"start":{"line":0,"character":13},"end":{"line":0,"character":19}}}}')
		];
		for (const elem of validate) {
			assert.deepEqual(emitter.elements.get(elem.id), elem);
		}
	});
});
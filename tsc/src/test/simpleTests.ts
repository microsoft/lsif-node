/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'assert';

import { lsif } from './lsifs';

suite('Simple Tests', () => {
	test('Single export', () => {
		const emitter = lsif('/test', new Map([
			['/test/a.ts', 'export const x = 10;']
		]), { });
		const moniker = JSON.parse('{"id":13,"type":"vertex","label":"moniker","scheme":"tsc","identifier":"a:x","unique":"group","kind":"export"}');
		const range = JSON.parse('{"id":15,"type":"vertex","label":"range","start":{"line":0,"character":13},"end":{"line":0,"character":14},"tag":{"type":"definition","text":"x","kind":7,"fullRange":{"start":{"line":0,"character":13},"end":{"line":0,"character":19}}}}');
		assert.deepEqual(emitter.elements.get(13), moniker);
		assert.deepEqual(emitter.elements.get(15), range);
	});
});
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

//import * as assert from 'assert';

import { lsif } from './lsifs';

suite('Simple Tests', () => {
	test('Single export', () => {
		const emitter = lsif('/@test', new Map([
			['/@test/a.ts', 'let x = 10;']
		]), { });
		console.log(emitter.toString());
	});
});
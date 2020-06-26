/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as ts from 'typescript';

import { InMemoryLanguageServiceHost } from './hosts';
import { Builder } from '../graph';

import { lsif } from '../lsif';

suite('Simple Tests', () => {
	test('xxx', () => {
		const host = new InMemoryLanguageServiceHost('/test', new Map([
			['/test/a.ts', 'export const x = 10;']
		]), { });
		const languageService = ts.createLanguageService(host);
		let counter = 1;
		const generator = (): number => {
			return counter++;
		};
		const builder = new Builder({ idGenerator: generator, emitSource: false });
	});
});
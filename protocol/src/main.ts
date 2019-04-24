/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as lsp from 'vscode-languageserver-protocol';
export { lsp };

export * from './protocol';

export const Version = function () {
	let packageJson = require('../package.json');
	return packageJson.version;
}();
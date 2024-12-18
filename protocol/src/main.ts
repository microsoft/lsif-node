/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as types from 'vscode-languageserver-types';
export { types };

export * from './protocol';

export const Version = function () {
	const packageJson = require('../package.json');
	return packageJson.version;
}();
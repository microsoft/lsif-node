#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
"use strict";

const path  = require('path');
const fs = require('fs');
const shell = require('shelljs');

const root = path.dirname(path.dirname(__dirname));
const current = process.cwd();

/**
 * @param {string} target
 * @param {string} name
 */
function mkLink(target, name) {
	if (fs.existsSync(name)) {
		shell.rm('-rf', name);
	}
	shell.ln('-s', target, name);
}

try {
	// The legacy tools still import the protocol by its former unscoped name.
	for (const folder of ['tsc', 'tooling', 'tsc-tests', 'npm', 'sqlite']) {
		const nodeModules = path.join(root, folder, 'node_modules');
		fs.mkdirSync(nodeModules, { recursive: true });
		process.chdir(nodeModules);
		mkLink(path.join('..', '..', 'protocol'), 'lsif-protocol');
	}
} finally {
	process.chdir(current);
}
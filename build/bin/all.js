#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
"use strict";
//@ts-check

const path = require('path');
const child_process = require('child_process')

const root = path.dirname(path.dirname(__dirname));
const args = process.argv.slice(2);

// When we install in a package pipeline then we don't want to call install in
// the project directories since we need to call install there to ensure proper
// dependency management.
if (args[0] === 'install' && process.env['npm_config_root_only'] === 'true') {
	return;
}


const folders = ['protocol', 'tsc', 'npm', 'sqlite', 'tooling', 'tsc-tests', 'lsif'];

for (const folder of folders) {
	console.log(`Running npm ${args.join(' ')} in ${folder}`);
	child_process.spawnSync(`npm ${args.join(' ')}`, { cwd: path.join(root, folder), shell: true, stdio: 'inherit' });
}
#!/usr/bin/env node

let path  = require('path');
let fs = require('fs');
let shell = require('shelljs');

let root = path.dirname(path.dirname(__dirname));
let current = process.cwd();

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
	// Setup symlink for tsc
	{
		const tsc = path.join(root, 'tsc', 'node_modules');
		fs.mkdirSync(tsc, { recursive: true });
		process.chdir(tsc);

		mkLink(path.join('..', '..', 'protocol'), 'lsif-protocol');
	}
	// Setup symlink for tooling
	{
		const tooling = path.join(root, 'tooling', 'node_modules');
		fs.mkdirSync(tooling, { recursive: true });
		process.chdir(tooling);
		mkLink(path.join('..', '..', 'protocol'), 'lsif-protocol');
	}
	// Setup symlink for tsc-tests
	{
		const tscTests = path.join(root, 'tsc-tests', 'node_modules');
		fs.mkdirSync(tscTests, { recursive: true });
		process.chdir(tscTests);

		mkLink(path.join('..', '..', 'protocol'), 'lsif-protocol');
		mkLink(path.join('..', '..', 'tsc'), 'lsif-tsc');
		mkLink(path.join('..', '..', 'tooling'), 'lsif-tooling');
	}

	// Setup symlink for npm
	{
		const npm = path.join(root, 'npm', 'node_modules');
		fs.mkdirSync(npm, { recursive: true });
		process.chdir(npm);
		mkLink(path.join('..', '..', 'protocol'), 'lsif-protocol');
		mkLink(path.join('..', '..', 'tsc'), 'lsif-tsc');
	}

	// Setup links for sqlite
	{
		const sqlite = path.join(root, 'sqlite', 'node_modules');
		fs.mkdirSync(sqlite, { recursive: true });
		process.chdir(sqlite);
		mkLink(path.join('..', '..', 'protocol'), 'lsif-protocol');
	}

	// Setup symlinks for util
	{
		const util = path.join(root, 'util', 'node_modules');
		fs.mkdirSync(util, { recursive: true });
		process.chdir(util);
		mkLink(path.join('..', '..', 'protocol'), 'lsif-protocol');
	}

	// Setup symlinks for lsif commands
	{
		const lsif = path.join(root, 'lsif', 'node_modules')
		fs.mkdirSync(lsif, { recursive: true });
		process.chdir(lsif);
		mkLink(path.join('..', '..', 'tsc'), 'lsif-tsc');
		mkLink(path.join('..', '..', 'npm'), 'lsif-npm');
		mkLink(path.join('..', '..', 'sqlite'), 'lsif-sqlite');
		mkLink(path.join('..', '..', 'tooling'), 'lsif-tooling');
	}
} finally {
	process.chdir(current);
}
#!/usr/bin/env node

let path  = require('path');
let fs = require('fs');
let shell = require('shelljs');

let root = path.dirname(path.dirname(__dirname));
let current = process.cwd();
try {
	process.chdir(path.join(root, 'tsc', 'node_modules'));
	if (fs.existsSync('lsif-protocol')) {
		shell.rm('-rf', 'lsif-protocol');
	}
	shell.ln('-s', path.join('..', '..', 'protocol'), 'lsif-protocol');
	if (fs.existsSync('lsif-tooling')) {
		shell.rm('-rf', 'lsif-tooling');
	}
	shell.ln('-s', path.join('..', '..', 'tooling'), 'lsif-tooling');

	process.chdir(path.join(root, 'npm', 'node_modules'));
	if (fs.existsSync('lsif-protocol')) {
		shell.rm('-rf', 'lsif-protocol');
	}
	shell.ln('-s', path.join('..', '..', 'protocol'), 'lsif-protocol');
	if (fs.existsSync('lsif-tsc')) {
		shell.rm('-rf', 'lsif-tsc');
	}
	shell.ln('-s', path.join('..', '..', 'tsc'), 'lsif-tsc');

	process.chdir(path.join(root, 'sqlite', 'node_modules'));
	if (fs.existsSync('lsif-protocol')) {
		shell.rm('-rf', 'lsif-protocol');
	}
	shell.ln('-s', path.join('..', '..', 'protocol'), 'lsif-protocol');

	process.chdir(path.join(root, 'tooling', 'node_modules'));
	if (fs.existsSync('lsif-protocol')) {
		shell.rm('-rf', 'lsif-protocol');
	}
	shell.ln('-s', path.join('..', '..', 'protocol'), 'lsif-protocol');

	process.chdir(path.join(root, 'util', 'node_modules'));
	if (fs.existsSync('lsif-protocol')) {
		shell.rm('-rf', 'lsif-protocol');
	}
	shell.ln('-s', path.join('..', '..', 'protocol'), 'lsif-protocol');

	const lsif = path.join(root, 'lsif', 'node_modules')
	fs.mkdirSync(lsif, { recursive: true });
	process.chdir(lsif);

	if (fs.existsSync('lsif-protocol')) {
		shell.rm('-rf', 'lsif-protocol');
	}
	shell.ln('-s', path.join('..', '..', 'protocol'), 'lsif-protocol');

	if (fs.existsSync('lsif-tsc')) {
		shell.rm('-rf', 'lsif-tsc');
	}
	shell.ln('-s', path.join('..', '..', 'tsc'), 'lsif-tsc');

	if (fs.existsSync('lsif-npm')) {
		shell.rm('-rf', 'lsif-npm');
	}
	shell.ln('-s', path.join('..', '..', 'npm'), 'lsif-npm');

	if (fs.existsSync('lsif-sqlite')) {
		shell.rm('-rf', 'lsif-sqlite');
	}
	shell.ln('-s', path.join('..', '..', 'sqlite'), 'lsif-sqlite');

	if (fs.existsSync('lsif-tooling')) {
		shell.rm('-rf', 'lsif-tooling');
	}
	shell.ln('-s', path.join('..', '..', 'tooling'), 'lsif-tooling');
} finally {
	process.chdir(current);
}
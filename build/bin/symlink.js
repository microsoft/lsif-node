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
	// process.chdir(path.join(root, 'npm-lsif', 'src'));
	// if (fs.existsSync('shared')) {
	// 	shell.rm('-rf', 'shared');
	// }
	// shell.ln('-s', path.join('..', '..', 'shared'), 'shared');
} finally {
	process.chdir(current);
}
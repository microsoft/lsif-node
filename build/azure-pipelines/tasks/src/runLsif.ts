/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import * as util from 'util';

import * as shelljs from 'shelljs';

const exists = util.promisify(fs.exists);
const readFile = util.promisify(fs.readFile);
const stat = util.promisify(fs.stat);
const readdir = util.promisify(fs.readdir);

const ROOT = path.join(__dirname, '..', '..', '..', '..');

interface DataFormat {
	name: string;
	repository: string;
	branch?: string;
	init?: { command: string, args?: string[] }[];
	tests: { tsconfig: string, projectRoot?: string, cwd?: string,  }[];
}

interface TestStatistics {
	passed: string[];
	failed: string[];
}

async function runCommand(command: string, args?: ReadonlyArray<string>, cwd?: string): Promise<number | undefined> {
	return new Promise((resolve, reject) => {
		const process = cp.spawn(command, args, {
			cwd,
			stdio: 'inherit',
			shell: true
		});
		let resolved: boolean = false;
		const handleEnd = (code: number | null, signal: string | null) => {
			if (resolved) {
				return;
			}
			resolved = true;
			if (signal) {
				reject(1);
			}
			if (code === null || code === 0) {
				resolve();
			} else {
				reject(code);
			}
		}
		process.on('close', handleEnd);
		process.on('exit', handleEnd);
		process.on('error', (error) => {
			console.error(error);
			reject(1);
		});
	})
}

async function runTest(filename: string): Promise<number | undefined> {
	process.stdout.write(`Running tests for: ${filename}\n`);
	if (!filename) {
		process.stderr.write(`No repository description provided.\n`);
		return 1;
	}
	if (!await exists(filename)) {
		process.stderr.write(`Repository description ${filename} not found.`);
		return 1;
	}
	const data: DataFormat = JSON.parse(await readFile(filename, { encoding: 'utf8' }));
	const tmpdir = os.tmpdir();
	let directory = path.join(tmpdir, data.name);

	if (await exists(directory)) {
		shelljs.rm('-rf', directory);
	}

	await runCommand('git', ['clone', data.repository, directory]);
	if (data.branch) {
		await runCommand('git', ['checkout', data.branch], directory);
	}
	if (data.init) {
		for (let init of data.init) {
			await runCommand(init.command, init.args, directory);
		}
	}
	if (data.tests) {
		for (let test of data.tests) {
			let cwd = test.cwd ? path.join(directory, test.cwd) : directory;
			process.stdout.write(`Running LSIF exporter for ${path.join(cwd, test.tsconfig)}\n`);
			let args: string[] = [path.join(ROOT, 'tsc', 'lib', 'main.js'),
				'-p', test.tsconfig,
				'--outputFormat', 'line'
			];
			if (test.projectRoot) {
				args.push('--projectRoot', test.projectRoot);
			}
			args.push('--out', path.join(cwd, `${data.name}.lsif`));
			await runCommand('node', args, cwd);
			process.stdout.write(`\n`);
		}
	}
	if (await exists(directory)) {
		shelljs.rm('-rf', directory);
	}
	return undefined;
}


async function main(pathname: string | undefined): Promise<number | undefined> {
	if (pathname === undefined) {
		console.error(`No test file or test directory provided`);
		return 1;
	}

	let testStats: TestStatistics = { passed: [], failed: [] };
	let stats = await stat(pathname);
	if (stats.isFile() && path.extname(pathname) === '.json') {
		try {
			await runTest(pathname);
			testStats.passed.push(pathname);
		} catch (error) {
			testStats.failed.push(pathname);
			console.log(error);
		}
	} else if (stats.isDirectory()) {
		let entries = await readdir(pathname);
		for (let entry of entries) {
			if (entry === '.' || entry === '..') {
				continue;
			}
			let candidate = path.join(pathname, entry);
			let stats = await stat(candidate);
			if (stats.isFile() && path.extname(candidate) === '.json') {
				try {
					await runTest(candidate);
					testStats.passed.push(candidate);
				} catch (error) {
					testStats.failed.push(candidate);
					console.log(error);
				}
			}
		}
	} else {
		console.error('No tests to run found');
		return 1;
	}
	process.stdout.write(`\n\nTest summary:\n`);
	process.stdout.write(`\tPassed tests: ${testStats.passed.length}\n`);
	process.stdout.write(`\tFailed tests: ${testStats.failed.length}\n`);
	if (testStats.failed.length > 0) {
		for (let failed of testStats.failed) {
			process.stdout.write(`\t\t${failed}\n`);
		}
	}
	return testStats.failed.length > 0 ? 1 : undefined;
}

main(process.argv[2]).then((error) => {
	if (error !== undefined) {
		process.exitCode = error;
	}
}, (error) => {
	process.exitCode = 1;
});
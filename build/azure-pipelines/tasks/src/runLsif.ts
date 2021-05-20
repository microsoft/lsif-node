/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as util from 'util';
import * as _fs from 'fs';
const fs = _fs.promises;
const exists = util.promisify(_fs.exists);

import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';

import * as uuid from 'uuid';
import * as shelljs from 'shelljs';

const ROOT = path.join(__dirname, '..', '..', '..', '..');


interface TestFormat {
	cwd?: string;
	config: string | object;
}

interface DataFormat {
	name: string;
	repository: string;
	branch?: string;
	init?: { command: string; args?: string[]; }[];
	tests?: TestFormat[]
}

interface TestStatistics {
	passed: string[];
	failed: string[];
}

async function runCommand(command: string, args: ReadonlyArray<string>, cwd?: string): Promise<number | undefined> {
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
				resolve(undefined);
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

async function runLsifTsc(cwd: string, configFilePath: string): Promise<string> {
	const out: string = `${uuid.v4()}.lsif`;
	const args: string[] = [path.join(ROOT, 'tsc', 'lib', 'main.js')];
	args.push('--config', configFilePath);
	args.push('--out', path.join(cwd, out));
	await runCommand('node', args, cwd);
	return out;
}

async function runValidate(cwd: string, outFile: string): Promise<void> {
	let args: string[] = [path.join(ROOT, 'tooling', 'lib', 'main.js'),
		'--in', `${outFile}`
	];
	await runCommand('node', args, cwd);
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
	const data: DataFormat = JSON.parse(await fs.readFile(filename, { encoding: 'utf8' }));
	const tmpdir = os.tmpdir();
	let directory = path.join(tmpdir, data.name);

	if (await exists(directory)) {
		shelljs.rm('-rf', directory);
	}

	await runCommand('git', ['clone', '--depth 1', data.repository, directory]);
	if (data.branch) {
		await runCommand('git', ['checkout', data.branch], directory);
	}
	if (data.init) {
		for (let init of data.init) {
			await runCommand(init.command, init.args ?? [], directory);
		}
	}
	if (Array.isArray(data.tests)) {
		for (const test of data.tests) {
			const cwd = test.cwd ? path.join(directory, test.cwd) : directory;
			let configFileName: string = path.join(directory, 'lsif.json');
			let label = `lsif.json`;
			if (!await exists(configFileName)) {
				if (typeof test.config === 'string') {
					label = test.config;
					configFileName = path.isAbsolute(test.config) ? test.config : path.join(cwd, test.config);
				} else if (test.config !== undefined) {
					configFileName = path.join(directory, uuid.v4());
					label = 'inline configuration';
					await fs.writeFile(configFileName, JSON.stringify(test.config));
				}
			}
			if (!await exists(configFileName)) {
				process.stderr.write(`Configuration files ${configFileName} doesn't exist`);
				continue;
			}
			process.stdout.write(`Running LSIF exporter for ${label}\n`);
			const outFile = await runLsifTsc(cwd, configFileName);
			process.stdout.write(`Running validation tool for ${path.join(cwd, data.name)}.lsif\n`);
			await runValidate(cwd, outFile);
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
	let stats = await fs.stat(pathname);
	if (stats.isFile() && path.extname(pathname) === '.json') {
		try {
			await runTest(pathname);
			testStats.passed.push(pathname);
		} catch (error) {
			testStats.failed.push(pathname);
			console.log(error);
		}
	} else if (stats.isDirectory()) {
		let entries = await fs.readdir(pathname);
		for (let entry of entries) {
			if (entry === '.' || entry === '..') {
				continue;
			}
			let candidate = path.join(pathname, entry);
			let stats = await fs.stat(candidate);
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
}, (_error) => {
	process.exitCode = 1;
});
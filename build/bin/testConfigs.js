#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
"use strict";

//@ts-check
const path = require('path');
const util = require('util');
const os = require('os');
const cp = require('child_process');
const _fs = require('fs');
const fs = _fs.promises;
const exists = util.promisify(_fs.exists);

const uuid = require('uuid');

const ROOT = path.join(__dirname, '..', '..');

/**
 * @param {string} command
 * @param {ReadonlyArray<string>} args
 * @param {string | undefined} cwd
 * @returns {Promise<number | undefined>}
 */
async function runCommand(command, args, cwd) {
	return new Promise((resolve, reject) => {
		const process = cp.spawn(command, args, {
			cwd,
			stdio: 'inherit',
			shell: true
		});
		let resolved = false;
		const handleEnd = (code, signal) => {
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

/**
 * @param {string} file
 * @returns { { init: { command: string; args: string[]; }[] } }
 */
async function readInitFile(initFile) {
	return JSON.parse(await fs.readFile(initFile, { encoding: 'utf8' }));
}

/**
 *
 * @param {string} cwd
 * @param {string} configFilePath
 * @returns {Promise<string>}
 */
async function runLsifTsc(cwd, configFilePath) {
	const out = `${uuid.v4()}.lsif`;
	const args = ['--max-old-space-size=4096', path.join(ROOT, 'tsc', 'lib', 'main.js')];
	args.push('--config', configFilePath);
	args.push('--out', path.join(cwd, out));
	await runCommand('node', args, cwd);
	return out;
}

/**
 *
 * @param {string} cwd
 * @param {string} outFile
 * @return {Promise<void>}
 */
async function runValidate(cwd, outFile) {
	const args = ['--max-old-space-size=4096', path.join(ROOT, 'tooling', 'lib', 'main.js'),
		'--in', `${outFile}`
	];
	await runCommand('node', args, cwd);
}


/**
 *
 * @param {string} root
 * @param {string} hub
 * @param {string} org
 * @param {string} repository
 */
async function checkRepository(root, hub, org, repository) {
	const offTag = path.join(root, hub, org, repository, 'off');
	if (await exists(offTag)) {
		return -1;
	}

	if (hub === 'github.com') {
		const url = `https://github.com/${org}/${repository}`;
		process.stdout.write(`====================== Checking repository ${url} ===========================\n\n`);
		const tmpdir = os.tmpdir();
		const directory = path.join(tmpdir, repository);
		if (await exists(directory)) {
			await fs.rmdir(directory, { recursive: true });
		}
		await runCommand('git', ['clone', '--depth 1', url, directory]);
		const setupFile = path.join(root, hub, org, repository, 'setup.json');
		if (await exists(setupFile)) {
			const content = await readInitFile(setupFile);
			if (Array.isArray(content.init)) {
				for (const command of content.init) {
					await runCommand(command.command, command.args ?? [], directory);
				}
			}
		}
		// First check if the repository has its own config file.
		const configLocations = [
			{ own: true, path: path.join(directory), name: '.lsifrc.json' },
			{ own: true, path: path.join(directory), name: 'lsif.json' },
			{ own: true, path: path.join(directory), name: path.join('.github', 'workflow-resources', '.lsifrc.json') },
			{ own: false, path: path.join(root, hub, org, repository), name: '.lsifrc.json' },
			{ own: false, path: path.join(root, hub, org, repository), name: '.lsifrc-test.json' },
			{ own: false, path: path.join(root, hub, org, repository), name: '.lsifrc-off.json' }
		];

		let config = undefined;
		for (const elem of configLocations) {
			const configFile = path.join(elem.path, elem.name);
			if (await exists(configFile)) {
				config = elem;
				break;
			}
		}
		if (config === undefined) {
			return 1;
		}
		if (config.name === '.lsifrc-off.json') {
			return -1;
		}
		let name;
		if (config.own) {
			name = config.name;
		} else {
			await fs.writeFile(path.join(directory, '.lsifrc.json'), await fs.readFile(path.join(config.path, config.name)), { encoding: 'utf8' });
			name = '.lsifrc.json';
		}

		process.stdout.write(`Run LSIF tool\n`);
		const out  = await runLsifTsc(directory, name);
		process.stdout.write(`Run Validation tool\n`);
		await runValidate(directory, out);
		await fs.rmdir(directory, { recursive: true });
		return 0;
	}
}

/**
 * @param {string} configs
 * @param {string} hub
 * @param {string} org
 * @param {string} repository
 */
async function main(configs, hub, org, repository) {
	if (configs === undefined) {
		configs = './configs';
	}
	if (!path.isAbsolute(configs)) {
		configs = path.join(process.cwd(), configs);
	}

	const testStats = { passed: [], failed: [], skipped: [] };
	if (hub !== undefined && repository !== undefined) {
		try {
			const code = await checkRepository(configs, hub, org, repository);
			if (code === undefined || code === 0) {
				testStats.passed.push(`${hub}/${org}/${repository}`);
			} else if (code === -1) {
				testStats.skipped.push(`${hub}/${org}/${repository}`);
			} else {
				testStats.failed.push(`${hub}/${org}/${repository}`);
			}
		} catch (error) {
			testStats.failed.push(`${hub}/${org}/${repository}`);
		}
	} else {
		const hubs = await fs.readdir(configs);
		for (const hub of hubs) {
			if (hub === '.' || hub === '..') {
				continue;
			}

			const organizations = await fs.readdir(path.join(configs, hub));
			for (const org of organizations) {
				if (org === '.' || org === '..') {
					continue;
				}

				const orgPath = path.join(configs, hub, org);
				const stat = await fs.stat(orgPath);
				if (!stat.isDirectory()) {
					continue;
				}

				const repositories = await fs.readdir(orgPath);

				for (const repository of repositories) {
					if (repository === '.' || repository === '..') {
						continue;
					}
					try {
						const code = await checkRepository(configs, hub, org, repository);
						if (code === undefined || code === 0) {
							testStats.passed.push(`${hub}/${org}/${repository}`);
						}	else if (code === -1) {
							testStats.skipped.push(`${hub}/${org}/${repository}`);
						}  else {
							testStats.failed.push(`${hub}/${org}/${repository}`);
						}
					} catch {
						testStats.failed.push(`${hub}/${org}/${repository}`);
					}
				}
			}
		}
	}

	process.stdout.write(`\n\nTest summary:\n`);
	process.stdout.write(`\tPassed tests: ${testStats.passed.length}\n`);
	process.stdout.write(`\tSkipped tests: ${testStats.skipped.length}\n`);
	if (testStats.skipped.length > 0) {
		for (let skipped of testStats.skipped) {
			process.stdout.write(`\t\t${skipped}\n`);
		}
	}
	process.stdout.write(`\tFailed tests: ${testStats.failed.length}\n`);
	if (testStats.failed.length > 0) {
		for (let failed of testStats.failed) {
			process.stdout.write(`\t\t${failed}\n`);
		}
	}
	return testStats.failed.length > 0 ? 1 : undefined;
}

main(process.argv[2], process.argv[3], process.argv[4], process.argv[5]).then((error) => {
	if (error !== undefined ) {
		process.exitCode = error;
	}
}, (error) => {
	console.error(error);
	process.exitCode = 1;
});
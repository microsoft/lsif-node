/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { promisify } from 'util';
import * as path from 'path';
import * as _fs from 'fs';

import * as npm from 'npm';

namespace fs {
	export const exist = promisify(_fs.exists);
	export const readFile = promisify(_fs.readFile);
}

interface Dictionary<T> {
	[key: string]: T
}

interface CommandCallback {
	(err?: Error, result?: any, result2?: any, result3?: any, result4?: any): void;
}

interface ViewSignature {
	(args: string[], callback: CommandCallback): void;
	(args: string[], silent: boolean, callback: CommandCallback): void;
}

interface PackageJson {
	devDependencies: Dictionary<string>
	dependencies: Dictionary<string>;
}

function stripComments(content: string): string {
	const regexp = /("(?:[^\\"]*(?:\\.)?)*")|('(?:[^\\']*(?:\\.)?)*')|(\/\*(?:\r?\n|.)*?\*\/)|(\/{2,}.*?(?:(?:\r?\n)|$))/g;

	return content.replace(regexp, function (match, m1, m2, m3, m4) {
		// Only one of m1, m2, m3, m4 matches
		if (m3) {
			// A block comment. Replace with nothing
			return '';
		} else if (m4) {
			// A line comment. If it ends in \r?\n then keep it.
			const length_1 = m4.length;
			if (length_1 > 2 && m4[length_1 - 1] === '\n') {
				return m4[length_1 - 2] === '\r' ? '\r\n' : '\n';
			}
			else {
				return '';
			}
		} else {
			// We match a string
			return match;
		}
	});
}

function ensureSeparator(directory: string): string {
	return directory[directory.length - 1] !== path.sep ? `${directory}${path.sep}` : directory;
}

export async function installTypings(handled: Set<string>, projectRoot: string, startDirectory: string): Promise<void> {
	if (startDirectory.length < projectRoot.length) {
		return;
	}
	projectRoot = path.normalize(projectRoot);
	startDirectory = path.normalize(startDirectory);
	if (!ensureSeparator(startDirectory).startsWith(ensureSeparator(projectRoot))) {
		return;
	}
	while (startDirectory.length >= projectRoot.length) {
		let packageFile = path.join(startDirectory, 'package.json');
		if (handled.has(packageFile)) {
			return;
		}
		if (await fs.exist(packageFile)) {
			await installTypingsForPackageFile(packageFile);
			handled.add(packageFile);
		}
		startDirectory = path.dirname(startDirectory);
	}
}

async function installTypingsForPackageFile(packageFile: string): Promise<void> {

	const prefix = path.dirname(packageFile);
	const typings: Set<string> = new Set();
	const modules: Map<string, string> = new Map();
	const packageJson: PackageJson = JSON.parse(stripComments(await fs.readFile(packageFile, 'utf8')));

	if (packageJson.devDependencies) {
		for (let pack of Object.keys(packageJson.devDependencies)) {
			if (pack.startsWith('@types/')) {
				typings.add(pack);
			}
		}
	}
	if (packageJson.dependencies !== undefined) {
		for (let pack of Object.keys(packageJson.dependencies)) {
			if (pack.startsWith('@types/')) {
				typings.add(pack);
			}
		}
		for (let pack of Object.keys(packageJson.dependencies)) {
			if (pack.startsWith('@types/')) {
				continue;
			}
			if (!typings.has(`@types/${pack}`)) {
				modules.set(pack, packageJson.dependencies[pack]);
			}
		}
	}

	if (modules.size > 0) {
		await new Promise((resolve, reject) => {
			npm.load({ json: true, save: false, 'save-dev': false, prefix: prefix }, (error, config) => {
				if (error) {
					reject(error);
				} else {
					resolve(config);
				}
			})
		});

		for (let module of modules.keys()) {
			try {
				await new Promise((resolve, reject) => {
					(npm.commands.view as ViewSignature)([`@types/${module}`], true, (error: Error | undefined | null, result: object) => {
						if (error) {
							reject(error);
						}
						resolve(result);
					});
				});
				await new Promise((resolve, reject) => {
					npm.commands.install([`@types/${module}`], (error, result) => {
						if (error) {
							reject(error);
						}
						resolve(result);
					});
				});
			} catch (error) {
				// typing doesn't exist. Ignore the error
			}
		}
	}
}
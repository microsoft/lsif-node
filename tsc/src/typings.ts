/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { promisify } from 'util';
import * as path from 'path';
import * as _fs from 'fs';

namespace fs {
	export const exist = promisify(_fs.exists);
	export const readFile = promisify(_fs.readFile);
	export const stat = promisify(_fs.stat);
	export const Stats = _fs.Stats;
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

	return content.replace(regexp, function (match, _m1, _m2, m3, m4) {
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

export class TypingsInstaller {

	private handledPackages: Set<string>;
	private handledTsConfig: Set<string>;

	constructor() {
		this.handledPackages = new Set();
		this.handledTsConfig = new Set();
	}

	private static ensureSeparator(directory: string): string {
		return directory[directory.length - 1] !== path.sep ? `${directory}${path.sep}` : directory;
	}

	public async installTypings(projectRoot: string, start: string, typings: string[]): Promise<void> {
		if (typings.length === 0) {
			return;
		}
		let stat = await fs.stat(start);
		let startDirectory: string;
		let key: string;

		if (stat.isDirectory()) {
			startDirectory = start;
			// this has a very very rare possibility of a clash
			key = path.join(start, typings.join(':'));
		} else if (stat.isFile()) {
			startDirectory = path.dirname(start);
			key = start;
		} else {
			return;
		}

		if (this.handledTsConfig.has(key)) {
			return;
		}
		if (startDirectory.length < projectRoot.length) {
			return;
		}
		projectRoot = path.normalize(projectRoot);

		typings = typings.map(typing => typing.startsWith('@types/') ? typing : `@types/${typing}`);

		while (startDirectory.length >= projectRoot.length) {
			let packageFile = path.join(startDirectory, 'package.json');
			if (await fs.exist(packageFile)) {
				typings = await this.filterTypingsToInstall(packageFile, typings);
				if (typings.length === 0) {
					return;
				}
				await this.loadNpm(packageFile);
				await this.doInstallTypingsFromNpm(await this.validateTypingsOnNpm(typings));
				this.handledTsConfig.add(key);
				return;
			}
			startDirectory = path.dirname(startDirectory);
		}
	}

	public async guessTypings(projectRoot: string, startDirectory: string): Promise<void> {
		if (startDirectory.length < projectRoot.length) {
			return;
		}
		projectRoot = path.normalize(projectRoot);
		startDirectory = path.normalize(startDirectory);

		if (!TypingsInstaller.ensureSeparator(startDirectory).startsWith(TypingsInstaller.ensureSeparator(projectRoot))) {
			return;
		}

		while (startDirectory.length >= projectRoot.length) {
			let packageFile = path.join(startDirectory, 'package.json');
			if (this.handledPackages.has(packageFile)) {
				return;
			}
			if (await fs.exist(packageFile)) {
				let typings = await this.findTypingsToInstall(packageFile);
				if (typings.length === 0) {
					continue;
				}
				await this.loadNpm(packageFile);
				await this.doInstallTypingsFromNpm(await this.validateTypingsOnNpm(typings));
				this.handledPackages.add(packageFile);
			}
			startDirectory = path.dirname(startDirectory);
		}
	}

	private async findTypingsToInstall(packageFile: string): Promise<string[]> {

		const typings: Set<string> = new Set();
		const toInstall: string[] = [];
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
				const typing = `@types/${pack}`;
				if (!typings.has(typing)) {
					toInstall.push(typing);
				}
			}
		}

		return toInstall;
	}

	private async filterTypingsToInstall(packageFile: string, toInstall: string[]): Promise<string[]> {

		const typings: Set<string> = new Set();
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
		}
		let result: string[] = [];
		for (let typing of toInstall) {
			if (!typings.has(typing)) {
				result.push(typing);
			}
		}
		return result;
	}

	private async loadNpm(packageFile: string): Promise<void> {
		const prefix = path.dirname(packageFile);
		let npm = await import('npm');
		await new Promise((resolve, reject) => {
			npm.load({ json: true, save: false, 'save-dev': false, prefix: prefix, spin: false, loglevel: 'silent', 'progress': false, 'audit': false } as any, (error, config) => {
				if (error) {
					reject(error);
				} else {
					resolve(config);
				}
			});
		});
	}

	private async validateTypingsOnNpm(typings: string[]): Promise<string[]> {
		if (typings.length === 0) {
			return typings;
		}
		const promises: Promise<string | undefined>[] = [];
		let npm = await import('npm');
		for (let typing of typings) {
			try {
				promises.push(new Promise<string | undefined>((resolve, _reject) => {
					(npm.commands.view as ViewSignature)([typing], true, (error: Error | undefined | null, _result: object) => {
						if (error) {
							resolve(undefined);
						}
						resolve(typing);
					});
				}));
			} catch (error) {
				// typing doesn't exist. Ignore the error
			}
		}
		const all = await Promise.all(promises);
		const result: string[] = [];
		for (let elem of all) {
			if (elem !== undefined) {
				result.push(elem);
			}
		}
		return result;
	}

	private async doInstallTypingsFromNpm(typings: string[]): Promise<void> {
		if (typings.length === 0) {
			return;
		}
		let npm = await import('npm');
		return new Promise((resolve, reject) => {
			// NPM can't be made really silent. So we patch console.log while we are actually
			// updating. Will not affect outputting LSIF to stdout since we wait until the installer
			// is finished.
			const save = console.log;
			console.log = () => {};
			npm.commands.install(typings, (error, result) => {
				console.log = save;
				if (error) {
					reject(error);
				}
				resolve(result);
			});
		});
	}
}
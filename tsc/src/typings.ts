/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { promisify } from 'util';
import * as path from 'path';
import * as _fs from 'fs';
import * as cp from 'child_process';

namespace fs {
	export const exist = promisify(_fs.exists);
	export const readFile = promisify(_fs.readFile);
	export const stat = promisify(_fs.stat);
	export const Stats = _fs.Stats;
}

namespace pcp {
	export const exec = promisify(cp.exec);
}

interface Dictionary<T> {
	[key: string]: T;
}

interface PackageJson {
	devDependencies: Dictionary<string>;
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
		const stat = await fs.stat(start);
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
			const packageFile = path.join(startDirectory, 'package.json');
			if (await fs.exist(packageFile)) {
				typings = await this.filterTypingsToInstall(packageFile, typings);
				if (typings.length === 0) {
					return;
				}
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
			const packageFile = path.join(startDirectory, 'package.json');
			if (this.handledPackages.has(packageFile)) {
				return;
			}
			if (await fs.exist(packageFile)) {
				const typings = await this.findTypingsToInstall(packageFile);
				if (typings.length === 0) {
					continue;
				}
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
			for (const pack of Object.keys(packageJson.devDependencies)) {
				if (pack.startsWith('@types/')) {
					typings.add(pack);
				}
			}
		}
		if (packageJson.dependencies !== undefined) {
			for (const pack of Object.keys(packageJson.dependencies)) {
				if (pack.startsWith('@types/')) {
					typings.add(pack);
				}
			}
			for (const pack of Object.keys(packageJson.dependencies)) {
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
			for (const pack of Object.keys(packageJson.devDependencies)) {
				if (pack.startsWith('@types/')) {
					typings.add(pack);
				}
			}
		}
		if (packageJson.dependencies !== undefined) {
			for (const pack of Object.keys(packageJson.dependencies)) {
				if (pack.startsWith('@types/')) {
					typings.add(pack);
				}
			}
		}
		const result: string[] = [];
		for (const typing of toInstall) {
			if (!typings.has(typing)) {
				result.push(typing);
			}
		}
		return result;
	}

	private async validateTypingsOnNpm(typings: string[]): Promise<string[]> {
		if (typings.length === 0) {
			return typings;
		}
		const latestVersion = (await import('latest-version')).default;
		const promises: Promise<string | undefined>[] = [];
		for (const typing of typings) {
			try {
				promises.push(latestVersion(typing).then(() => typing, (_error) => undefined));
			} catch (error) {
				// typing doesn't exist. Ignore the error
			}
		}
		const all = await Promise.all(promises);
		const result: string[] = [];
		for (const elem of all) {
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
		// Need to think about command length. Might be a limit.
		const command = `npm install --no-save ${typings.join(' ')}`;
		await pcp.exec(command);
	}
}
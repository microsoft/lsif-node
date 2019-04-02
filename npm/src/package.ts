/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as fs from 'fs';

import * as Is from 'lsif-tsc/lib/utils/is';
import * as paths from 'lsif-tsc/lib/utils/paths';

class PackageJson {
	static read(filename: string): PackageJson | undefined {
		try {
			if (fs.existsSync(filename)) {
				let content: PackageJson = new PackageJson(filename, JSON.parse(fs.readFileSync(filename, { encoding: 'utf8' })));
				if (Is.string(content.name)) {
					return content;
				}
			}
		} catch {
		}
		return undefined;
	}

	public $location: string;

	public name: string;
	public main: string;
	public typings: string;
	public version?: string;
	public repository?: {
		type: string;
		url: string;
	}

	private constructor(location: string, json: any) {
		this.$location = location;
		this.name = json.name;
		this.version = json.version;
		this.repository = json.repository;
		if (Is.string(json.main)) {
			this.main = paths.normalizeSeparator(paths.removeExtension(json.main));
		} else {
			this.main= 'index';
		}
		if (Is.string(json.typings)) {
			this.typings = paths.normalizeSeparator(paths.removeExtension(json.typings));
		} else {
			this.typings = 'index';
		}
	}

	public hasVersion(): this is PackageJson & { version: string } {
		return Is.string(this.version);
	}

	public hasRepository(): this is PackageJson & { repository: { type: string; url: string } } {
		return this.repository !== undefined && Is.string(this.repository.url) && Is.string(this.repository.url);
	}
}

export default PackageJson;
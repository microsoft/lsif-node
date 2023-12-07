/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as path from 'path';

import {
	Moniker, PackageInformation, MonikerKind, UniquenessLevel
} from 'lsif-protocol';

import { EmitterContext } from '../common/graph';
import { NpmMoniker } from '../common/moniker';
import{ PackageJson } from './package';

export class ImportMonikers {

	private readonly emitter: EmitterContext;
	private readonly workspaceRoot: string;
	private readonly packageData: Map<string,  { packageInfo: PackageInformation, packageJson: PackageJson } | null>;

	constructor(emitter: EmitterContext, workspaceRoot: string) {
		this.packageData = new Map();
		this.emitter = emitter;
		this.workspaceRoot = workspaceRoot;
	}

	attachMoniker(tscMoniker: Moniker, fileName: string, packageName: string, filePath: string, exportParts: string | string[]): void {
		const packagePart = `/node_modules/${packageName}`;
		const index = fileName.lastIndexOf(packagePart);
		if (index === -1) {
			return;
		}
		const fullFilePath = path.posix.join(this.workspaceRoot, filePath);
		const packageLocation = path.posix.join(fileName.substr(0, index), packagePart);
		if (!fullFilePath.startsWith(packageLocation + '/')) {
			return;
		}

		const packageFileName = path.posix.join(packageLocation, `package.json`);
		let packageData = this.packageData.get(packageFileName);
		if (packageData === null) {
			return;
		}
		if (packageData === undefined) {
			const packageJson = PackageJson.read(packageFileName);
			if (packageJson === undefined) {
				this.packageData.set(packageFileName, null);
				return;
			}
			const packageInfo = this.emitter.vertex.packageInformation(packageJson.name, 'npm');
			this.emitter.emit(packageInfo);
			packageInfo.version = packageJson.version;
			packageData = { packageInfo, packageJson };
			this.packageData.set(packageFileName, packageData);
		}
		const exportPath = typeof exportParts === 'string' ? exportParts : `[${exportParts.join('')}]`;
		let npmIdentifier: string;
		if (packageData.packageJson.$absoluteTypings === fullFilePath || packageData.packageJson.$absoluteMain === fullFilePath) {
			npmIdentifier = NpmMoniker.create(packageData.packageJson.name, undefined, exportPath);
		} else {
			const npmPath = fullFilePath.substring(packageLocation.length + 1); // +1 for '/'
			npmIdentifier = NpmMoniker.create(packageData.packageJson.name, npmPath, exportPath);
		}
		const npmMoniker = this.emitter.vertex.moniker(NpmMoniker.scheme, npmIdentifier, UniquenessLevel.scheme, MonikerKind.import);
		this.emitter.emit(npmMoniker);
		this.emitter.emit(this.emitter.edge.packageInformation(npmMoniker, packageData.packageInfo));
		this.emitter.emit(this.emitter.edge.attach(npmMoniker, tscMoniker));
	}
}
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as path from 'path';

import {
	Moniker, PackageInformation, MonikerKind, UniquenessLevel
} from 'lsif-protocol';

import { EmitterContext } from '../common/graph';
import { TscMoniker, NpmMoniker } from '../common/moniker';

import PackageJson from './package';

export class ImportLinker {

	private readonly emitter: EmitterContext;
	private readonly workspaceFolder: string;
	private readonly packageData: Map<string,  { packageInfo: PackageInformation, packageJson: PackageJson } | null>;

	constructor(emitter: EmitterContext, workspaceFolder: string) {
		this.packageData = new Map();
		this.emitter = emitter;
		this.workspaceFolder = workspaceFolder;
	}

	public handleMoniker(moniker: Moniker): void {
		if (moniker.kind !== MonikerKind.import || moniker.scheme !== TscMoniker.scheme) {
			return;
		}
		const tscMoniker = TscMoniker.parse(moniker.identifier);
		if (!TscMoniker.hasPath(tscMoniker)) {
			return;
		}

		const parts = tscMoniker.path.split('/');
		let packagePath: string | undefined;
		let monikerPath: string | undefined;
		for (let i = parts.length - 1; i >= 0; i--) {
			const part = parts[i];
			if (part === 'node_modules') {
				// End is exclusive and one for the name
				const packageIndex = i + (parts[i + 1].startsWith('@') ? 3 : 2);
				packagePath = path.join(this.workspaceFolder, ...parts.slice(0, packageIndex), `package.json`);
				monikerPath = parts.slice(packageIndex).join('/');
				break;
			}
		}
		if (packagePath === undefined || (monikerPath !== undefined && monikerPath.length === 0)) {
			return;
		}
		let packageData = this.packageData.get(packagePath);
		if (packageData === undefined) {
			const packageJson = PackageJson.read(packagePath);
			if (packageJson === undefined) {
				this.packageData.set(packagePath, null);
			} else {
				const packageInfo = this.emitter.vertex.packageInformation(packageJson.name, 'npm');
				packageInfo.version = packageJson.version;
				packageData = { packageInfo, packageJson };
				this.packageData.set(packagePath, packageData);
			}
		}
		if (packageData !== null && packageData !== undefined) {
			let npmIdentifier: string;
			if (packageData.packageJson.typings === monikerPath || packageData.packageJson.main === monikerPath) {
				npmIdentifier = NpmMoniker.create(packageData.packageJson.name, undefined, tscMoniker.name);
			} else {
				npmIdentifier = NpmMoniker.create(packageData.packageJson.name, monikerPath, tscMoniker.name);
			}
			const npmMoniker = this.emitter.vertex.moniker(NpmMoniker.scheme, npmIdentifier, UniquenessLevel.scheme, moniker.kind);
			this.emitter.emit(npmMoniker);
			this.emitter.emit(this.emitter.edge.packageInformation(npmMoniker, packageData.packageInfo));
			this.emitter.emit(this.emitter.edge.attach(npmMoniker, moniker));
		}
	}
}
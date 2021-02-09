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
import * as paths from '../common/paths';

import PackageJson from './package';

export class ExportLinker {

	private readonly emitter: EmitterContext;
	private readonly workspaceFolder: string;
	private readonly packageJson: PackageJson

	private readonly pathPrefix: string;
	private packageInformation: PackageInformation | undefined;

	constructor(emitter: EmitterContext, workspaceFolder: string, packageJson: PackageJson) {
		this.emitter = emitter;
		this.workspaceFolder = workspaceFolder;
		this.packageJson = packageJson;
		this.pathPrefix = packageJson.$location;
		if (this.pathPrefix[this.pathPrefix.length - 1] !== '/') {
			this.pathPrefix = `${this.pathPrefix}/`;
		}
	}

	public handleMoniker(moniker: Moniker): void {
		if (moniker.kind !== MonikerKind.export || moniker.scheme !== TscMoniker.scheme) {
			return;
		}
		const tscMoniker: TscMoniker = TscMoniker.parse(moniker.identifier);
		if (TscMoniker.hasPath(tscMoniker) && this.isPackaged(path.join(this.workspaceFolder, tscMoniker.path))) {
			this.ensurePackageInformation();
			const monikerPath = this.getMonikerPath(this.workspaceFolder, tscMoniker);
			let npmIdentifier: string;
			if (this.packageJson.main === monikerPath || this.packageJson.typings === monikerPath) {
				npmIdentifier = NpmMoniker.create(this.packageJson.name, undefined, tscMoniker.name);
			} else {
				npmIdentifier = NpmMoniker.create(this.packageJson.name, monikerPath, tscMoniker.name);
			}
			const npmMoniker = this.emitter.vertex.moniker(NpmMoniker.scheme, npmIdentifier, UniquenessLevel.scheme, moniker.kind);
			this.emitter.emit(npmMoniker);
			this.emitter.emit(this.emitter.edge.packageInformation(npmMoniker, this.packageInformation!));
			this.emitter.emit(this.emitter.edge.attach(npmMoniker, moniker));
		}
	}

	private isPackaged(_uri: string): boolean {
		// This needs to consult the .npmignore file and checks if the
		// document is actually published via npm. For now we return
		// true for all documents.
		return true;
	}

	private ensurePackageInformation(): void {
		if (this.packageInformation === undefined) {
			this.packageInformation = this.emitter.vertex.packageInformation(this.packageJson.name, 'npm');
			this.packageInformation.version = this.packageJson.version;
			this.emitter.emit(this.packageInformation);
		}
	}

	private getMonikerPath(projectRoot: string, tscMoniker: TscMoniker & { path: string; }): string {
		const fullPath = path.posix.join(projectRoot, tscMoniker.path);
		if (paths.isParent(this.pathPrefix, fullPath)) {
			return path.posix.relative(this.pathPrefix, fullPath);
		}
		return tscMoniker.path;
	}
}
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
import * as paths from '../common/paths';

import { PackageJson } from './package';

export class ExportMonikers {

	private readonly emitter: EmitterContext;
	private readonly workspaceFolder: string;
	private readonly packageJson: PackageJson

	private readonly pathPrefix: string;
	private _packageInformation: PackageInformation | undefined;

	constructor(emitter: EmitterContext, workspaceFolder: string, packageJson: PackageJson) {
		this.emitter = emitter;
		this.workspaceFolder = workspaceFolder;
		this.packageJson = packageJson;
		this.pathPrefix = packageJson.$location;
		if (this.pathPrefix[this.pathPrefix.length - 1] !== '/') {
			this.pathPrefix = `${this.pathPrefix}/`;
		}
	}

	public attachMoniker(tscMoniker: Moniker, filePath: string, exportParts: string | string[]): void {
		if (!this.isPackaged(path.join(this.workspaceFolder, filePath))) {
			return undefined;
		}
		const exportPath: string = typeof exportParts === 'string'
			? exportParts
			: `[${exportParts.join(',')}]`;
		const npmFilePath = this.getNpmFilePath(this.workspaceFolder, filePath);
		let npmIdentifier: string;
		if (this.packageJson.main === npmFilePath || this.packageJson.typings === npmFilePath) {
			npmIdentifier = NpmMoniker.create(this.packageJson.name, undefined, exportPath);
		} else {
			npmIdentifier = NpmMoniker.create(this.packageJson.name, npmFilePath, exportPath);
		}
		const npmMoniker = this.emitter.vertex.moniker(NpmMoniker.scheme, npmIdentifier, UniquenessLevel.scheme, MonikerKind.export);
		this.emitter.emit(npmMoniker);
		this.emitter.emit(this.emitter.edge.packageInformation(npmMoniker, this.packageInformation));
		this.emitter.emit(this.emitter.edge.attach(npmMoniker, tscMoniker));
	}

	private isPackaged(_uri: string): boolean {
		// This needs to consult the .npmignore file and checks if the
		// document is actually published via npm. For now we return
		// true for all documents.
		return true;
	}

	private get packageInformation(): PackageInformation {
		if (this._packageInformation === undefined) {
			this._packageInformation = this.emitter.vertex.packageInformation(this.packageJson.name, 'npm');
			this._packageInformation.version = this.packageJson.version;
			this.emitter.emit(this._packageInformation);
		}
		return this._packageInformation;
	}

	private getNpmFilePath(projectRoot: string, filePath: string): string {
		const fullPath = path.posix.join(projectRoot, filePath);
		if (paths.isParent(this.pathPrefix, fullPath)) {
			return path.posix.relative(this.pathPrefix, fullPath);
		}
		return filePath;
	}
}
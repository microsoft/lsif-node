/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import * as minimist from 'minimist';
import * as uuid from 'uuid';

import URI from 'vscode-uri';

import PackageJson from './package';
import {
	Edge, Vertex, Id, Moniker, PackageInformation, packageInformation, moniker, EdgeLabels, ElementTypes, VertexLabels,
	MonikerKind }
from 'lsif-protocol';

import * as Is from 'lsif-tsc/lib/utils/is';
import { TscMoniker, NpmMoniker } from 'lsif-tsc/lib/utils/moniker';

const __out = process.stdout;
const __eol = os.EOL;

interface Options extends minimist.ParsedArgs {
	file?: string;
	projectRoot?: string;
}

export namespace Options {
	export const defaults: Options = {
		_: [],
		file: undefined,
		projectRoot: undefined
	};
}

function emit(value: string | Edge | Vertex): void {
	if (Is.string(value)) {
		__out.write(value);
		__out.write(__eol);
	} else {
		__out.write(JSON.stringify(value, undefined, 0));
		__out.write(__eol);
	}
}

function normalizePath(value: string): string {
	return path.posix.normalize(value.replace(/\\/g, '/'));
}

function makeAbsolute(p: string, root?: string): string {
	if (path.isAbsolute(p)) {
		return normalizePath(p);
	}
	if (root === undefined) {
		return normalizePath(path.join(process.cwd(), p));
	} else {
		return normalizePath(path.join(root, p));
	}
}

class ExportLinker {

	private packageInformation: PackageInformation | undefined;
	private _idGenerator: (() => Id) | undefined;

	constructor(private projectRoot: string, private packageInfo: PackageJson) {
	}

	private get idGenerator(): () => Id {
		if (this._idGenerator === undefined) {
			throw new Error(`ID Generator not initialized.`);
		}
		return this._idGenerator;
	}

	public handleMoniker(moniker: Moniker): void {
		if (moniker.schema !== TscMoniker.schema) {
			emit(moniker);
			return;
		}
		let tscMoniker: TscMoniker = TscMoniker.parse(moniker.identifier);
		if (TscMoniker.hasPath(tscMoniker) && this.isPackaged(path.join(this.projectRoot, tscMoniker.path))) {
			if (this.packageInfo.main === tscMoniker.path || this.packageInfo.typings === tscMoniker.path) {
				moniker.identifier = NpmMoniker.create(this.packageInfo.name, undefined, tscMoniker.name);
			} else {
				moniker.identifier = NpmMoniker.create(this.packageInfo.name, tscMoniker.path, tscMoniker.name);
			}
			moniker.schema = NpmMoniker.schema;
			this.emitPackageInformation(moniker);
		}
		emit(moniker);
		if (this.packageInformation !== undefined) {
			emit({ type: ElementTypes.edge, label: EdgeLabels.packageInformation, id: this.idGenerator(), outV: moniker.id, inV: this.packageInformation.id });
		}
	}

	private isPackaged(uri: string): boolean {
		// This needs to consult the .npmignore file and checks if the
		// document is actually published via npm. For now we return
		// true for all documents.
		return true;
	}

	private emitPackageInformation(moniker: Moniker): void {
		if (this.packageInformation === undefined) {
			this.ensureIdGenerator(moniker.id);
			this.packageInformation = {
				type: ElementTypes.vertex,
				label: VertexLabels.packageInformation,
				id: this.idGenerator(),
				name: this.packageInfo.name,
				manager: 'npm',
				version: this.packageInfo.version
			}
			if (this.packageInfo.hasRepository()) {
				this.packageInformation.repository = this.packageInfo.repository;
			}
			emit(this.packageInformation);
		}
	}

	private ensureIdGenerator(id: Id): void {
		if (this.idGenerator !== undefined) {
			return;
		}
		if (typeof id === 'number') {
			let counter = Number.MAX_SAFE_INTEGER;
			this._idGenerator = () => {
				return counter--;
			}
		} else {
			this._idGenerator = () => {
				return uuid.v4();
			}
		}
	}
}

class ImportLinker {

	private packageJsons: Map<Id, PackageJson | null>;
	private packageInfos: Map<Id, PackageInformation>;
	private monikers: Map<Id, Moniker>;

	constructor() {
		this.packageJsons = new Map();
		this.monikers = new Map();
		this.packageInfos = new Map();
	}

	public handlePackageInformation(packageInfo: PackageInformation): void {
		this.packageInfos.set(packageInfo.id, packageInfo);
		emit(packageInfo);
	}

	public handleMoniker(moniker: Moniker): void {
		this.monikers.set(moniker.id, moniker);
	}

	public handlePackageInformationEdge(edge: packageInformation): void {
		const moniker = this.monikers.get(edge.outV);
		const packageInfo = this.packageInfos.get(edge.inV);
		// do not delete package info from the cache since it is reused by many monikers

		// we do remove the moniker since it should only be rewritten once.
		this.monikers.delete(edge.outV);

		if (moniker !== undefined) {
			if (moniker.kind === MonikerKind.import && moniker.schema === TscMoniker.schema && packageInfo !== undefined && packageInfo.manager === NpmMoniker.schema) {
				const tscMoniker = TscMoniker.parse(moniker.identifier);
				if (TscMoniker.hasPath(tscMoniker)) {
					const packageJson = this.getPackageJson(packageInfo);
					if (packageJson !== undefined) {
						const modulePart = `node_modules/${packageInfo.name}`;
						const index = tscMoniker.path.lastIndexOf(modulePart);
						const relativePath = tscMoniker.path.substr(index + modulePart.length + 1);
						if (relativePath === packageJson.main || relativePath === packageJson.typings) {
							moniker.identifier = NpmMoniker.create(packageInfo.name, undefined, tscMoniker.name);
						} else {
							moniker.identifier = NpmMoniker.create(packageInfo.name, relativePath, tscMoniker.name);
						}
						moniker.schema = NpmMoniker.schema;
					}
				}
			}
			emit(moniker);
		}
		emit(edge);
	}

	public handleMonikerEdge(edge: moniker): void {
		const vertex = this.monikers.get(edge.inV);
		// we see a moniker edge before the moniker got converted. So no
		// package information available. Simply re-emit.
		if (vertex !== undefined) {
			this.monikers.delete(edge.inV);
			emit(vertex);
		}
		emit(edge);
	}

	private getPackageJson(packageInfo: PackageInformation): PackageJson | undefined {
		let result: PackageJson | undefined | null = this.packageJsons.get(packageInfo.id);
		if (result === null) {
			return undefined;
		}
		if (result === undefined) {
			if (packageInfo.uri === undefined) {
				this.packageJsons.set(packageInfo.id, null);
				return undefined;
			}
			const filePath = URI.parse(packageInfo.uri).fsPath;
			result = PackageJson.read(filePath);
			if (result === undefined) {
				this.packageJsons.set(packageInfo.id, null);
			} else {
				this.packageJsons.set(packageInfo.id, result);
			}
		}
		return result;
	}
}

function main(): void {
	let options: Options = Object.assign(Options.defaults, minimist(process.argv.slice(2), {
		string: [
			'file', 'projectRoot'
		]
	}));
	let packageFile: string | undefined = options._[0];
	if (packageFile === undefined) {
		packageFile = 'package.json'
	}
	packageFile = makeAbsolute(packageFile);
	const packageJson: PackageJson | undefined = PackageJson.read(packageFile);

	let exportLinker: ExportLinker | undefined;
	if (packageJson === undefined) {
		console.warn(`No package.json file found. Will not rewrite export monikers.`);
	} else {
		let projectRoot = options.projectRoot;
		if (projectRoot === undefined) {
			projectRoot = path.posix.dirname(packageFile)
		}
		if (!path.isAbsolute(projectRoot)) {
			projectRoot = makeAbsolute(projectRoot);
		}
		exportLinker = new ExportLinker(projectRoot, packageJson);
	}

	//const exportLinker: undefined; //ExportLinker = new ExportLinker(packageJson);
	const importLinker: ImportLinker = new ImportLinker();
	let input: NodeJS.ReadStream | fs.ReadStream = process.stdin;
	if (options.file !== undefined && fs.existsSync(options.file)) {
		input = fs.createReadStream(options.file, { encoding: 'utf8'});
	}

	const rd = readline.createInterface(input);
	rd.on('line', (line) => {
		let element: Edge | Vertex = JSON.parse(line);
		if (element.type === ElementTypes.edge) {
			switch(element.label) {
				case EdgeLabels.moniker:
					importLinker.handleMonikerEdge(element);
					break;
				case EdgeLabels.packageInformation:
					importLinker.handlePackageInformationEdge(element);
					break;
				default:
					emit(line);
			}
		} else if (element.type === ElementTypes.vertex) {
			switch (element.label) {
				case VertexLabels.moniker:
					switch (element.kind) {
						case MonikerKind.import:
							importLinker.handleMoniker(element);
							break;
						case MonikerKind.export:
							exportLinker && exportLinker.handleMoniker(element);
							break;
						default:
							emit(line);
					}
					break;
				case VertexLabels.packageInformation:
					importLinker.handlePackageInformation(element)
					break;
				default:
					emit(line);
			}
		}
	});
}

if (require.main === module) {
	main();
}
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

import PackageJson from './package';
import {
	Edge, Vertex, Id, Moniker, PackageInformation, packageInformation, EdgeLabels, ElementTypes, VertexLabels, MonikerKind, next
}
from 'lsif-protocol';

import * as Is from 'lsif-tsc/lib/utils/is';
import { TscMoniker, NpmMoniker } from 'lsif-tsc/lib/utils/moniker';

const __out = process.stdout;
const __eol = os.EOL;

interface Options {
	help: boolean;
	version: boolean;
	package?: string;
	projectRoot?: string;
	file?: string;
}

interface OptionDescription {
	id: keyof Options;
	type: 'boolean' | 'string';
	alias?: string;
	default: any;
	values?: string[];
	description: string;
}

namespace Options {
	export const defaults: Options = {
		help: false,
		version: false,
		package: undefined,
		projectRoot: undefined,
		file: undefined
	};
	export const descriptions: OptionDescription[] = [
		{ id: 'version', type: 'boolean', alias: 'v', default: false, description: 'output the version number'},
		{ id: 'help', type: 'boolean', alias: 'h', default: false, description: 'output usage information'},
		{ id: 'package', type: 'string', default: undefined, description: 'Specifies the location of the package.json file to use. Defaults to the package.json in the current directory.'},
		{ id: 'projectRoot', type: 'string', default: undefined, description: 'Specifies the project root. Defaults to the location of the [tj]sconfig.json file.'},
		{ id: 'file', type: 'string', default: undefined, description: 'Specifies the file that contains a LSIF dump. Defaults to stdin.'},
	];
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

class Linker {

	private _idGenerator: (() => Id) | undefined;

	constructor() {
	}

	protected get idGenerator(): () => Id {
		if (this._idGenerator === undefined) {
			throw new Error(`ID Generator not initialized.`);
		}
		return this._idGenerator;
	}

	protected ensureIdGenerator(id: Id): void {
		if (this._idGenerator !== undefined) {
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

	protected createPackageInformation(packageJson: PackageJson): PackageInformation {
		let result: PackageInformation = {
			id: this.idGenerator(),
			type: ElementTypes.vertex,
			label: VertexLabels.packageInformation,
			name: packageJson.name,
			manager: 'npm',
			version: packageJson.version
		}
		if (packageJson.hasRepository()) {
			result.repository = packageJson.repository;
		}
		return result;
	}

	protected createMoniker(identifier: string, kind: MonikerKind, scheme: string): Moniker {
		return {
			id: this.idGenerator(),
			type: ElementTypes.vertex,
			label: VertexLabels.moniker,
			kind: kind,
			scheme: scheme,
			identifier: identifier
		} as Moniker;
	}

	protected createNextEdge(outV: Id, inV: Id): next {
		return {
			id: this.idGenerator(),
			type: ElementTypes.edge,
			label: EdgeLabels.next,
			outV: outV,
			inV: inV
		};
	}

	protected createPackageInformationEdge(outV: Id, inV: Id): packageInformation {
		return {
			id: this.idGenerator(),
			type: ElementTypes.edge,
			label: EdgeLabels.packageInformation,
			outV: outV,
			inV: inV
		};
	}
}

class ExportLinker extends Linker {

	private packageInformation: PackageInformation | undefined;

	constructor(private projectRoot: string, private packageJson: PackageJson) {
		super();
	}

	public handleMoniker(moniker: Moniker): void {
		if (moniker.kind !== MonikerKind.export || moniker.scheme !== TscMoniker.scheme) {
			return;
		}
		this.ensureIdGenerator(moniker.id);
		emit(moniker);
		let tscMoniker: TscMoniker = TscMoniker.parse(moniker.identifier);
		if (TscMoniker.hasPath(tscMoniker) && this.isPackaged(path.join(this.projectRoot, tscMoniker.path))) {
			this.ensurePackageInformation();
			let npmIdentifier: string;
			if (this.packageJson.main === tscMoniker.path || this.packageJson.typings === tscMoniker.path) {
				npmIdentifier = NpmMoniker.create(this.packageJson.name, undefined, tscMoniker.name);
			} else {
				npmIdentifier = NpmMoniker.create(this.packageJson.name, tscMoniker.path, tscMoniker.name);
			}
			let npmMoniker = this.createMoniker(npmIdentifier, moniker.kind, NpmMoniker.scheme);
			emit(npmMoniker);
			emit(this.createNextEdge(moniker.id, npmMoniker.id));
			emit(this.createPackageInformationEdge(npmMoniker.id, this.packageInformation!.id));
		}
	}

	private isPackaged(uri: string): boolean {
		// This needs to consult the .npmignore file and checks if the
		// document is actually published via npm. For now we return
		// true for all documents.
		return true;
	}

	private ensurePackageInformation(): void {
		if (this.packageInformation === undefined) {
			this.packageInformation = this.createPackageInformation(this.packageJson);
			emit(this.packageInformation);
		}
	}
}

class ImportLinker extends Linker {

	private packageData: Map<string,  { packageInfo: PackageInformation, packageJson: PackageJson } | null>;

	constructor(private projectRoot: string) {
		super();
		this.packageData = new Map();
	}

	public handleMoniker(moniker: Moniker): void {
		if (moniker.kind !== MonikerKind.import || moniker.scheme !== TscMoniker.scheme) {
			return;
		}
		this.ensureIdGenerator(moniker.id);
		emit(moniker);
		const tscMoniker = TscMoniker.parse(moniker.identifier);
		if (!TscMoniker.hasPath(tscMoniker)) {
			return;
		}
		let parts = tscMoniker.path.split('/');
		let packagePath: string | undefined;
		let monikerPath: string | undefined;
		for (let i = parts.length - 1; i >= 0; i--) {
			let part = parts[i];
			if (part === 'node_modules') {
				// End is exclusive and one for the name
				packagePath = path.join(this.projectRoot, ...parts.slice(0, i + 2), `package.json`);
				monikerPath = parts.slice(i + 2).join('/');
				break;
			}
		}
		if (packagePath === undefined || (monikerPath !== undefined && monikerPath.length === 0)) {
			return;
		}
		let packageData = this.packageData.get(packagePath);
		if (packageData === undefined) {
			let packageJson = PackageJson.read(packagePath);
			if (packageJson === undefined) {
				this.packageData.set(packagePath, null);
			} else {
				packageData = {
					packageInfo: this.createPackageInformation(packageJson),
					packageJson: packageJson
				};
				emit(packageData.packageInfo);
			}
		}
		if (packageData !== null && packageData !== undefined) {
			let npmIdentifier: string;
			if (packageData.packageJson.typings === monikerPath || packageData.packageJson.main === monikerPath) {
				npmIdentifier = NpmMoniker.create(packageData.packageJson.name, undefined, tscMoniker.name);
			} else {
				npmIdentifier = NpmMoniker.create(packageData.packageJson.name, monikerPath, tscMoniker.name);
			}
			let npmMoniker = this.createMoniker(npmIdentifier, moniker.kind, NpmMoniker.scheme);
			emit(npmMoniker);
			emit(this.createPackageInformationEdge(npmMoniker.id, packageData.packageInfo.id));
			emit(this.createNextEdge(npmMoniker.id, moniker.id));
		}
	}
}

export function main(): void {

	let minOpts: minimist.Opts = {
		string: [],
		boolean: [],
		default: Object.create(null),
		alias: Object.create(null)
	};

	let longestId: number = 0;
	for (let description of Options.descriptions) {
		longestId = Math.max(longestId, description.id.length);
		minOpts[description.type] = description.id;
		minOpts.default![description.id] = description.default;
		if (description.alias !== undefined) {
			minOpts.alias![description.id] = [description.alias];
		}
	}

	const options: Options = Object.assign(Options.defaults, minimist(process.argv.slice(2), minOpts));

	if (options.version) {
		console.log(require('../package.json').version);
		return;
	}

	let buffer: string[] = [];
	if (options.help) {
		buffer.push(`Languag Server Index Format tool for NPM`);
		buffer.push(`Version: ${require('../package.json').version}`);
		buffer.push('');
		buffer.push(`Usage: lsif-npm [options]`);
		buffer.push('');
		buffer.push(`Options`);
		for (let description of Options.descriptions) {
			if (description.alias !== undefined) {
				buffer.push(`  -${description.alias} --${description.id}${' '.repeat(longestId - description.id.length)} ${description.description}`);
			} else {
				buffer.push(`  --${description.id}   ${' '.repeat(longestId - description.id.length)} ${description.description}`);
			}
		}
		console.log(buffer.join('\n'));
		return;
	}


	let packageFile: string | undefined = options.package;
	if (packageFile === undefined) {
		packageFile = 'package.json'
	}
	packageFile = makeAbsolute(packageFile);
	const packageJson: PackageJson | undefined = PackageJson.read(packageFile);
	let projectRoot = options.projectRoot;
	if (projectRoot === undefined && packageFile !== undefined) {
		projectRoot = path.posix.dirname(packageFile)
		if (!path.isAbsolute(projectRoot)) {
			projectRoot = makeAbsolute(projectRoot);
		}
	}
	if (projectRoot === undefined) {
		process.exitCode = -1;
		return;
	}
	let exportLinker: ExportLinker | undefined;
	if (packageJson !== undefined) {
		exportLinker = new ExportLinker(projectRoot, packageJson);
	}
	const importLinker: ImportLinker = new ImportLinker(projectRoot);
	let input: NodeJS.ReadStream | fs.ReadStream = process.stdin;
	if (options.file !== undefined && fs.existsSync(options.file)) {
		input = fs.createReadStream(options.file, { encoding: 'utf8'});
	}

	const rd = readline.createInterface(input);
	rd.on('line', (line) => {
		let element: Edge | Vertex = JSON.parse(line);
		if (element.type === ElementTypes.vertex) {
			switch(element.label) {
				case VertexLabels.moniker:
					if (exportLinker !== undefined) {
						exportLinker.handleMoniker(element);
					}
					importLinker.handleMoniker(element);
					break;
				default:
					emit(line);
			}
		} else {
			emit(line);
		}
	});
}

if (require.main === module) {
	main();
}
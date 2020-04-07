/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import * as minimist from 'minimist';
import * as uuid from 'uuid';
import { URI } from 'vscode-uri';

import * as paths from './paths';
import PackageJson from './package';
import {
	Edge, Vertex, Id, Moniker, PackageInformation, packageInformation, EdgeLabels, ElementTypes, VertexLabels, MonikerKind, attach, UniquenessLevel,
	MonikerAttachEvent, EventScope, EventKind, Event, Group, GroupEvent
} from 'lsif-protocol';

import * as Is from 'lsif-tsc/lib/utils/is';
import { TscMoniker, NpmMoniker } from 'lsif-tsc/lib/utils/moniker';
import { StdoutWriter, FileWriter, Writer } from 'lsif-tsc/lib/utils/writer';


interface Options {
	help: boolean;
	version: boolean;
	package?: string;
	projectRoot?: string;
	in?: string;
	stdin: boolean;
	out?: string;
	stdout: boolean;
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
		in: undefined,
		stdin: false,
		out: undefined,
		stdout: false
	};
	export const descriptions: OptionDescription[] = [
		{ id: 'version', type: 'boolean', alias: 'v', default: false, description: 'output the version number'},
		{ id: 'help', type: 'boolean', alias: 'h', default: false, description: 'output usage information'},
		{ id: 'package', type: 'string', default: undefined, description: 'Specifies the location of the package.json file to use. Defaults to the package.json in the current directory.'},
		{ id: 'in', type: 'string', default: undefined, description: 'Specifies the file that contains a LSIF dump.'},
		{ id: 'stdin', type: 'boolean', default: false, description: 'Reads the dump from stdin'},
		{ id: 'out', type: 'string', default: undefined, description: 'The output file the converted dump is saved to.'},
		{ id: 'stdout', type: 'boolean', default: false, description: 'Writes the dump to stdout'},
	];
}

class AttachQueue {
	private _idGenerator: (() => Id) | undefined;
	private _idMode: 'uuid' | 'number' | undefined;
	private attachedId: Id | undefined;

	private store: (Event | PackageInformation | Moniker | attach | packageInformation)[];

	public constructor(private emit: (value: string | Edge | Vertex) => void) {
		this.store = [];
	}

	public initialize(id: Id): void {
		if (typeof id === 'number') {
			let counter = -1;
			this._idGenerator = () => {
				return counter--;
			};
			this._idMode = 'number';
		} else {
			this._idGenerator =  () => {
				return uuid.v4();
			};
			this._idMode = 'uuid';
		}

		this.attachedId = this.idGenerator();
		const startEvent: MonikerAttachEvent = {
			id: this.attachedId,
			type: ElementTypes.vertex,
			label: VertexLabels.event,
			scope: EventScope.monikerAttach,
			kind: EventKind.begin,
			data: this.attachedId
		};
		this.store.push(startEvent);
	}

	private get idGenerator(): () => Id {
		if (this._idGenerator === undefined) {
			throw new Error(`ID Generator not initialized.`);
		}
		return this._idGenerator;
	}

	public createPackageInformation(packageJson: PackageJson): PackageInformation {
		const result: PackageInformation = {
			id: this.idGenerator(),
			type: ElementTypes.vertex,
			label: VertexLabels.packageInformation,
			name: packageJson.name,
			manager: 'npm',
			version: packageJson.version
		};
		if (packageJson.hasRepository()) {
			result.repository = packageJson.repository;
		}
		this.store.push(result);
		return result;
	}

	public createMoniker(scheme: string, identifier: string, unique: UniquenessLevel, kind: MonikerKind): Moniker {
		const result: Moniker = {
			id: this.idGenerator(),
			type: ElementTypes.vertex,
			label: VertexLabels.moniker,
			scheme: scheme,
			identifier: identifier,
			unique,
			kind: kind
		};
		this.store.push(result);
		return result;
	}

	public createAttachEdge(outV: Id, inV: Id): attach {
		const result: attach = {
			id: this.idGenerator(),
			type: ElementTypes.edge,
			label: EdgeLabels.attach,
			outV: outV,
			inV: inV
		};
		this.store.push(result);
		return result;
	}

	public createPackageInformationEdge(outV: Id, inV: Id): packageInformation {
		const result: packageInformation = {
			id: this.idGenerator(),
			type: ElementTypes.edge,
			label: EdgeLabels.packageInformation,
			outV: outV,
			inV: inV
		};
		this.store.push(result);
		return result;
	}

	public duplicateEvent(event: Event) {
		const duplicate: Event = Object.assign({}, event);
		duplicate.id = this.idGenerator();
		this.store.push(duplicate);
	}

	public flush(lastId: Id): void {
		if (this.store.length === 0) {
			return;
		}

		if (this.attachedId === undefined || typeof lastId === 'number' && this._idMode !== 'number') {
			throw new Error(`Id mismatch.`);
		}

		const startEvent: MonikerAttachEvent = {
			id: this.idGenerator(),
			type: ElementTypes.vertex,
			label: VertexLabels.event,
			scope: EventScope.monikerAttach,
			kind: EventKind.begin,
			data: this.attachedId
		};
		this.store.push(startEvent);

		if (this._idMode === 'uuid') {
			this.store.forEach(element => this.emit(element));
		} else {
			const start: number = lastId as number;
			for (const element of this.store) {
				element.id = start + Math.abs(element.id as number);
				switch(element.label) {
					case VertexLabels.event:
						if (element.scope === EventScope.monikerAttach) {
							element.data = start + Math.abs(element.data as number);
						}
						break;
					case EdgeLabels.attach:
						element.outV = start + Math.abs(element.outV as number);
						break;
					case EdgeLabels.packageInformation:
						element.inV = start + Math.abs(element.inV as number);
						element.outV = start + Math.abs(element.outV as number);
						break;
				}
				this.emit(element);
			}
		}
	}
}


class Groups {

	private groups: Map<Id, Group>;

	private _activeProjectRoot: string | undefined;

	constructor() {
		this.groups = new Map();
	}

	public handleGroup(group: Group): void {
		this.groups.set(group.id, group);
	}

	public handleGroupBegin(event: GroupEvent): void {
		const group = this.groups.get(event.data);
		if (group === undefined) {
			this._activeProjectRoot = undefined;
		} else {
			this._activeProjectRoot = paths.normalizePath(URI.parse(group.rootUri).fsPath);
		}
	}

	public handleGroupEnd(event: GroupEvent): void {
		this._activeProjectRoot = undefined;
		this.groups.delete(event.data);
	}

	public get activeProjectRoot(): string | undefined {
		return this._activeProjectRoot;
	}
}

class ExportLinker {

	private packageInformation: PackageInformation | undefined;
	private pathPrefix: string;

	constructor(private groups: Groups, private packageJson: PackageJson, private queue: AttachQueue) {
		this.pathPrefix = packageJson.$location;
		if (this.pathPrefix[this.pathPrefix.length - 1] !== '/') {
			this.pathPrefix = `${this.pathPrefix}/`;
		}
	}

	public handleMoniker(moniker: Moniker): void {
		if (moniker.kind !== MonikerKind.export || moniker.scheme !== TscMoniker.scheme) {
			return;
		}
		const projectRoot: string | undefined = this.groups.activeProjectRoot;
		if (projectRoot === undefined) {
			return;
		}
		const tscMoniker: TscMoniker = TscMoniker.parse(moniker.identifier);
		if (TscMoniker.hasPath(tscMoniker) && this.isPackaged(path.join(projectRoot, tscMoniker.path))) {
			this.ensurePackageInformation();
			const monikerPath = this.getMonikerPath(projectRoot, tscMoniker);
			let npmIdentifier: string;
			if (this.packageJson.main === monikerPath || this.packageJson.typings === monikerPath) {
				npmIdentifier = NpmMoniker.create(this.packageJson.name, undefined, tscMoniker.name);
			} else {
				npmIdentifier = NpmMoniker.create(this.packageJson.name, monikerPath, tscMoniker.name);
			}
			let npmMoniker = this.queue.createMoniker(NpmMoniker.scheme, npmIdentifier, UniquenessLevel.scheme, moniker.kind);
			this.queue.createPackageInformationEdge(npmMoniker.id, this.packageInformation!.id);
			this.queue.createAttachEdge(npmMoniker.id, moniker.id);
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
			this.packageInformation = this.queue.createPackageInformation(this.packageJson);
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

class ImportLinker {

	private packageData: Map<string,  { packageInfo: PackageInformation, packageJson: PackageJson } | null>;

	constructor(private group: Groups, private queue: AttachQueue) {
		this.packageData = new Map();
	}

	public handleMoniker(moniker: Moniker): void {
		if (moniker.kind !== MonikerKind.import || moniker.scheme !== TscMoniker.scheme) {
			return;
		}
		const tscMoniker = TscMoniker.parse(moniker.identifier);
		if (!TscMoniker.hasPath(tscMoniker)) {
			return;
		}
		const projectRoot = this.group.activeProjectRoot;
		if (projectRoot === undefined) {
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
				packagePath = path.join(projectRoot, ...parts.slice(0, packageIndex), `package.json`);
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
				packageData = {
					packageInfo: this.queue.createPackageInformation(packageJson),
					packageJson: packageJson
				};
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
			const npmMoniker = this.queue.createMoniker(NpmMoniker.scheme, npmIdentifier, UniquenessLevel.scheme, moniker.kind);
			this.queue.createPackageInformationEdge(npmMoniker.id, packageData.packageInfo.id);
			this.queue.createAttachEdge(npmMoniker.id, moniker.id);
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
		(minOpts[description.type] as string[]).push(description.id);
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
		packageFile = 'package.json';
	}
	packageFile = paths.makeAbsolute(packageFile);
	const packageJson: PackageJson | undefined = PackageJson.read(packageFile);
	let projectRoot = options.projectRoot;
	if (projectRoot === undefined && packageFile !== undefined) {
		projectRoot = path.posix.dirname(packageFile);
		if (!path.isAbsolute(projectRoot)) {
			projectRoot = paths.makeAbsolute(projectRoot);
		}
	}
	if (projectRoot === undefined) {
		console.error(`No project root specified.`);
		process.exitCode = -1;
		return;
	}

	if (!options.stdin && options.in === undefined) {
		console.error(`Either a input file using --in or --stdin must be specified`);
		process.exitCode = -1;
		return;
	}

	if (!options.stdout && options.out === undefined) {
		console.error(`Either a output file using --out or --stdout must be specified.`);
		process.exitCode = -1;
		return;
	}

	if (options.in !== undefined && options.out !== undefined && paths.makeAbsolute(options.in) === paths.makeAbsolute(options.out)) {
		console.error(`Input and output file can't be the same.`);
		process.exitCode = -1;
		return;
	}

	let writer: Writer = new StdoutWriter();
	function emit(value: string | Edge | Vertex): void {
		if (Is.string(value)) {
			writer.writeln(value);
		} else {
			writer.writeln(JSON.stringify(value, undefined, 0));
		}
	}

	const queue: AttachQueue = new AttachQueue(emit);
	const groups: Groups = new Groups();
	let exportLinker: ExportLinker | undefined;
	if (packageJson !== undefined) {
		exportLinker = new ExportLinker(groups, packageJson, queue);
	}
	const importLinker: ImportLinker = new ImportLinker(groups, queue);
	let input: NodeJS.ReadStream | fs.ReadStream = process.stdin;
	if (options.in !== undefined && fs.existsSync(options.in)) {
		input = fs.createReadStream(options.in, { encoding: 'utf8'});
	}
	if (options.out !== undefined) {
		writer = new FileWriter(fs.openSync(options.out, 'w'));
	}

	let needsInitialization: boolean = true;
	let lastId: Id | undefined;
	const rd = readline.createInterface(input);
	rd.on('line', (line) => {
		emit(line);
		let element: Edge | Vertex = JSON.parse(line);
		lastId = element.id;
		if (needsInitialization) {
			queue.initialize(element.id);
			needsInitialization = false;
		}
		if (element.type === ElementTypes.vertex) {
			switch (element.label) {
				case VertexLabels.moniker:
					if (exportLinker !== undefined) {
						exportLinker.handleMoniker(element);
					}
					importLinker.handleMoniker(element);
					break;
				case VertexLabels.group:
					groups.handleGroup(element);
					break;
				case VertexLabels.event:
					queue.duplicateEvent(element);
					if (element.scope === EventScope.group) {
						if (element.kind === EventKind.begin) {
							groups.handleGroupBegin(element as GroupEvent);
						} else {
							groups.handleGroupEnd(element as GroupEvent);
						}
					}
					break;
			}
		}
	});
	rd.on('close', () => {
		if (lastId !== undefined) {
			queue.flush(lastId);
		}
	});
}

if (require.main === module) {
	main();
}
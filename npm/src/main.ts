/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import * as yargs from 'yargs';
import * as uuid from 'uuid';
import { URI } from 'vscode-uri';

import * as paths from './paths';
import PackageJson from './package';
import {
	Edge, Vertex, Id, Moniker, PackageInformation, packageInformation, EdgeLabels, ElementTypes, VertexLabels, MonikerKind, attach, UniquenessLevel,
	MonikerAttachEvent, EventScope, EventKind, Event, Source
} from 'lsif-protocol';

import { TscMoniker, NpmMoniker } from './common/moniker';
import { StdoutWriter, FileWriter, Writer } from './common/writer';

import { Options, builder } from './args';

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


class SourceInfo {

	private _workspaceRoot: string | undefined;

	public handleSource(source: Source): void {
		this._workspaceRoot = URI.parse(source.workspaceRoot).fsPath;
	}

	public get workspaceRoot(): string | undefined {
		return this._workspaceRoot;
	}
}

class ExportLinker {

	private packageInformation: PackageInformation | undefined;
	private pathPrefix: string;

	constructor(private source: SourceInfo, private packageJson: PackageJson, private queue: AttachQueue) {
		this.pathPrefix = packageJson.$location;
		if (this.pathPrefix[this.pathPrefix.length - 1] !== '/') {
			this.pathPrefix = `${this.pathPrefix}/`;
		}
	}

	public handleMoniker(moniker: Moniker): void {
		if (moniker.kind !== MonikerKind.export || moniker.scheme !== TscMoniker.scheme) {
			return;
		}
		const workspaceRoot: string | undefined = this.source.workspaceRoot;
		if (workspaceRoot === undefined) {
			return;
		}
		const tscMoniker: TscMoniker = TscMoniker.parse(moniker.identifier);
		if (TscMoniker.hasPath(tscMoniker) && this.isPackaged(path.join(workspaceRoot, tscMoniker.path))) {
			this.ensurePackageInformation();
			const monikerPath = this.getMonikerPath(workspaceRoot, tscMoniker);
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

	private isPackaged(_uri: string): boolean {
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

	constructor(private source: SourceInfo, private queue: AttachQueue) {
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
		const workspaceRoot = this.source.workspaceRoot;
		if (workspaceRoot === undefined) {
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
				packagePath = path.join(workspaceRoot, ...parts.slice(0, packageIndex), `package.json`);
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

export function run(options: Options): void {

	if (options.help) {
		return;
	}

	if (options.version) {
		console.log(require('../package.json').version);
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
		if (typeof value === 'string') {
			writer.writeln(value);
		} else {
			writer.writeln(JSON.stringify(value, undefined, 0));
		}
	}

	const queue: AttachQueue = new AttachQueue(emit);
	const sourceInfo: SourceInfo = new SourceInfo();
	let exportLinker: ExportLinker | undefined;
	if (packageJson !== undefined) {
		exportLinker = new ExportLinker(sourceInfo, packageJson, queue);
	}
	const importLinker: ImportLinker = new ImportLinker(sourceInfo, queue);
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
				case VertexLabels.source:
					sourceInfo.handleSource(element);
					break;
				case VertexLabels.event:
					queue.duplicateEvent(element);
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

export function main(): void {
	yargs.
		parserConfiguration({ 'camel-case-expansion': false }).
		exitProcess(false).
		usage(`Language Server Index Format tool for NPM monikers\nVersion: ${require('../package.json').version}\nUsage: lsif-npm [options][tsc options]`).
		example(`lsif-npm --package package.json --stdin --stdout`, `Reads an LSIF dump from stdin and transforms tsc monikers into npm monikers and prints the result to stdout.`).
		version(false).
		wrap(Math.min(100, yargs.terminalWidth()));
	const options: Options = Object.assign({}, Options.defaults, builder(yargs).argv);
	return run(options);
}

if (require.main === module) {
	main();
}
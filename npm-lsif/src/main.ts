/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import * as minimist from 'minimist';

import URI from 'vscode-uri';

import PackageJson from './package';
import * as Is from './shared/is';
import { Edge, Vertex, Id, Moniker, PackageInformation, packageInformation, moniker, EdgeLabels, ElementTypes, VertexLabels, MonikerKind } from './shared/protocol';
import { TscMoniker, NpmMoniker } from './shared/moniker'

const __out = process.stdout;
const __eol = os.EOL;

interface Options extends minimist.ParsedArgs {

	file?: string;
}

export namespace Options {
	export const defaults: Options = {
		_: [],
		file: undefined
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

const isWindows = process.platform === 'win32';
function normalizePath(value: string): string {
	return path.posix.normalize(isWindows ? value.replace(/\\/g, '/') : value);
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

	protected static isSame(p1: string, p2: string): boolean {
		let e1 = this.getEnd(p1);
		let e2 = this.getEnd(p2);
		if (e1 !== e2) {
			return false;
		}
		for (let i = 0; i < e1; i++) {
			if (p1.charCodeAt(i) !== p2.charCodeAt(i)) {
				return false;
			}
		}
		return true;
	}

	protected static getEnd(uri: string): number {
		if (uri.endsWith('.d.ts')) {
			return uri.length - 5;
		} else if (uri.endsWith('.ts')) {
			return uri.length - 3;
		} else if (uri.endsWith('.js')) {
			return uri.length - 3;
		}
		return uri.length;
	}

}

// class ExportLinker extends Linker {

// 	private outDir: string;
// 	private rootDir: string;

// 	private main: string;
// 	private typing: string;

// 	private packageInfos: Map<Id, PackageInformation>;
// 	private monikers: Map<Id, Moniker>;

// 	private droppedResults: Set<Id>;

// 	constructor(packageJson: PackageJson) {
// 		super();
// 		this.monikers = new Map();
// 		this.packageInfos = new Map();
// 		this.droppedResults = new Set();

// 		let dirname = path.dirname(packageJson.$location);

// 		this.main = URI.file(makeAbsolute(packageJson.main, dirname).replace(/\.js$/, '')).toString(true);
// 		this.typing = URI.file(makeAbsolute(packageJson.typings, dirname).replace(/\.d\.ts$/, '')).toString(true);
// 	}

// 	public addOutAndRoot(outDir: string, rootDir: string): void {
// 		this.outDir = outDir.charAt(outDir.length - 1) !== '/' ? outDir + '/' : outDir;
// 		this.rootDir = rootDir.charAt(outDir.length - 1) !== '/' ? rootDir + '/' : rootDir;
// 	}

// 	public addPackageInformation(packageInfo: PackageInformation): void {
// 		this.packageInfos.set(packageInfo.id, packageInfo);
// 	}

// 	public addMoniker(moniker: Moniker): void {
// 		this.monikers.set(moniker.id, moniker);
// 	}

// 	public packageInformation(edge: packageInformation): void {

// 	}
// 	public exports(edge: $exports): void {
// 		let document = this.documents.get(edge.outV)!;
// 		let exportResult = this.results.get(edge.inV)!;
// 		let outUri = this.mapToOut(document.uri);
// 		if (Linker.isSame(outUri, this.main) || Linker.isSame(outUri, this.typing)) {
// 			if (exportResult.result !== undefined) {
// 				for (let i = 0; i < exportResult.result.length; i++) {
// 					exportResult.result[i] = this.transformExportItem(exportResult.result[i]);
// 				}
// 			}
// 			emit(exportResult);
// 			emit(edge);
// 		} else if (this.isPackaged(outUri)) {
// 			if (exportResult.result !== undefined) {
// 				let path = outUri.substr(this.outDir.length).replace(/(\.d)?\.ts$/, '');
// 				for (let i = 0; i < exportResult.result.length; i++) {
// 					exportResult.result[i] = this.transformExportItem(exportResult.result[i], path);
// 				}
// 				emit(exportResult);
// 				emit(edge);
// 			}
// 		} else {
// 			// drop the export result;
// 			this.droppedResults.add(exportResult.id);
// 		}
// 	}

// 	public handles(edge: item) {
// 		return this.results.has(edge.outV) && this.items.has(edge.inV);
// 	}

// 	public item(edge: item): void {
// 		if (this.droppedResults.has(edge.outV)) {
// 			// We have dropped the result. Drop the item as well.
// 			// So not emit the item nor the edge.
// 			return;
// 		}
// 		let exportItem: ExportItem = this.items.get(edge.inV)!;
// 		emit(this.transformExportItem(exportItem));
// 		emit(edge);
// 	}

// 	private transformExportItem<T extends inline.ExportItem | ExportItem>(item: T, path?: string): T {
// 		let result = Object.assign(Object.create(null), item) as T;
// 		if (path !== undefined) {
// 			result.moniker =  {
// 				packageManager: 'npm',
// 				path: path,
// 				name: item.moniker.name
// 			};
// 		} else {
// 			result.moniker = {
// 				packageManager: 'npm',
// 				name: item.moniker.name
// 			};
// 		}
// 		return result;
// 	}

// 	private mapToOut(uri: string): string {
// 		if (uri.startsWith(this.rootDir)) {
// 			return this.outDir + uri.substr(this.rootDir.length);
// 		} else {
// 			return uri;
// 		}
// 	}

// 	private isPackaged(uri: string): boolean {
// 		// This needs to consult the .npmignore file and checks if the
// 		// document is actually published via npm. For now we return
// 		// true for all documents.
// 		return true;
// 	}
// }

class ImportLinker extends Linker {

	private packageJsons: Map<Id, PackageJson | null>;
	private packageInfos: Map<Id, PackageInformation>;
	private monikers: Map<Id, Moniker>;

	constructor() {
		super();
		this.packageJsons = new Map();
		this.monikers = new Map();
		this.packageInfos = new Map();
	}

	public addPackageInformation(packageInfo: PackageInformation): void {
		this.packageInfos.set(packageInfo.id, packageInfo);
		emit(packageInfo);
	}

	public addMoniker(moniker: Moniker): void {
		this.monikers.set(moniker.id, moniker);
	}

	public packageInformation(edge: packageInformation): void {
		let moniker = this.monikers.get(edge.outV);
		const packageInfo = this.packageInfos.get(edge.inV);
		// do not delete package info from the cache since it is reused by many monikers

		// we do remove the moniker since it should only be rewritten once.
		this.monikers.delete(edge.outV);

		if (moniker !== undefined) {
			if (moniker.kind === MonikerKind.import && packageInfo !== undefined && packageInfo.manager === 'npm') {
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
						moniker.schema = 'npm';
					}
				}
			}
			emit(moniker);
		}
		emit(edge);
	}

	public moniker(edge: moniker): void {
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
			'file'
		]
	}));
	let packageFile: string | undefined = options._[0];
	if (packageFile === undefined) {
		packageFile = 'package.json'
	}
	const packageJson: PackageJson | undefined = PackageJson.read(makeAbsolute(packageFile, process.cwd()));

	if (packageJson === undefined) {
		console.warn(`No package.json file found. Will not rewrite export monikers.`);
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
					importLinker.moniker(element);
					break;
				case EdgeLabels.packageInformation:
					importLinker.packageInformation(element);
					break;
				default:
					emit(line);
			}
		} else if (element.type === ElementTypes.vertex) {
			switch (element.label) {
				case VertexLabels.project:
					//exportLinker.addOutAndRoot(element.data!.outDir as string, element.data!.rootDir as string);
					emit(line);
					break;
				case VertexLabels.moniker:
					importLinker.addMoniker(element);
					break;
				case VertexLabels.packageInformation:
					importLinker.addPackageInformation(element)
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
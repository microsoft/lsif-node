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
import { Edge, Vertex, DocumentId, Document, DocumentData, ExportResult, ExportItem, ExternalImportResult, ExternalImportItem, $exports, Id, item, inline, $imports } from './shared/protocol';

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

class ExportLinker extends Linker {

	private outDir: string;
	private rootDir: string;

	private main: string;
	private typing: string;

	private documents: Map<DocumentId, Document>;
	private results: Map<Id, ExportResult>;
	private items: Map<Id, ExportItem>;

	private droppedResults: Set<Id>;

	constructor(packageJson: PackageJson) {
		super();
		this.documents = new Map();
		this.results = new Map();
		this.items = new Map();
		this.droppedResults = new Set();

		let dirname = path.dirname(packageJson.$location);

		this.main = URI.file(makeAbsolute(packageJson.main, dirname).replace(/\.js$/, '')).toString(true);
		this.typing = URI.file(makeAbsolute(packageJson.typings, dirname).replace(/\.d\.ts$/, '')).toString(true);
	}

	public addOutAndRoot(outDir: string, rootDir: string): void {
		this.outDir = outDir.charAt(outDir.length - 1) !== '/' ? outDir + '/' : outDir;
		this.rootDir = rootDir.charAt(outDir.length - 1) !== '/' ? rootDir + '/' : rootDir;
	}

	public addDocument(document: Document): void {
		this.documents.set(document.id, document);
	}

	public addResult(result: ExportResult): void {
		this.results.set(result.id, result);
	}

	public addResultItem(item: ExportItem): void {
		this.items.set(item.id, item);
	}

	public exports(edge: $exports): void {
		let document = this.documents.get(edge.outV)!;
		let exportResult = this.results.get(edge.inV)!;
		let outUri = this.mapToOut(document.uri);
		if (Linker.isSame(outUri, this.main) || Linker.isSame(outUri, this.typing)) {
			if (exportResult.result !== undefined) {
				for (let i = 0; i < exportResult.result.length; i++) {
					exportResult.result[i] = this.transformExportItem(exportResult.result[i]);
				}
			}
			emit(exportResult);
			emit(edge);
		} else if (this.isPackaged(outUri)) {
			if (exportResult.result !== undefined) {
				let path = outUri.substr(this.outDir.length).replace(/(\.d)?\.ts$/, '');
				for (let i = 0; i < exportResult.result.length; i++) {
					exportResult.result[i] = this.transformExportItem(exportResult.result[i], path);
				}
				emit(exportResult);
				emit(edge);
			}
		} else {
			// drop the export result;
			this.droppedResults.add(exportResult.id);
		}
	}

	public handles(edge: item) {
		return this.results.has(edge.outV) && this.items.has(edge.inV);
	}

	public item(edge: item): void {
		if (this.droppedResults.has(edge.outV)) {
			// We have dropped the result. Drop the item as well.
			// So not emit the item nor the edge.
			return;
		}
		let exportItem: ExportItem = this.items.get(edge.inV)!;
		emit(this.transformExportItem(exportItem));
		emit(edge);
	}

	private transformExportItem<T extends inline.ExportItem | ExportItem>(item: T, path?: string): T {
		let result = Object.assign(Object.create(null), item) as T;
		if (path !== undefined) {
			result.moniker =  {
				packageManager: 'npm',
				path: path,
				value: item.moniker.value
			};
		} else {
			result.moniker = {
				packageManager: 'npm',
				value: item.moniker.value
			};
		}
		return result;
	}

	private mapToOut(uri: string): string {
		if (uri.startsWith(this.rootDir)) {
			return this.outDir + uri.substr(this.rootDir.length);
		} else {
			return uri;
		}
	}

	private isPackaged(uri: string): boolean {
		// This needs to consult the .npmignore file and checks if the
		// document is actually published via npm. For now we return
		// true for all documents.
		return true;
	}
}

interface PackageId {
	name: string;
	subModuleName: string;
	version: string;
}

class ImportLinker extends Linker {

	private documents: Map<DocumentId, Document>;
	private results: Map<Id, ExternalImportResult>;
	private items: Map<Id, ExternalImportItem>;

	private resultToDocument: Map<Id, Document>;
	private droppedResults: Set<Id>;

	constructor() {
		super();
		this.documents = new Map();
		this.results = new Map();
		this.items = new Map();

		this.resultToDocument = new Map();
		this.droppedResults = new Set();
	}

	public addDocument(document: Document): void {
		this.documents.set(document.id, document);

	}

	public addResult(result: ExternalImportResult): void {
		this.results.set(result.id, result);
	}

	public addResultItem(item: ExternalImportItem): void {
		this.items.set(item.id, item);
	}

	public imports(edge: $imports): void {
		let document = this.documents.get(edge.outV)!;
		let importResult = this.results.get(edge.inV)!;
		if (document.data === undefined) {
			this.droppedResults.add(importResult.id);
			return;
		}
		let packageId: PackageId = document.data.package as unknown as PackageId;
		if (packageId === undefined) {
			this.droppedResults.add(importResult.id);
			return;
		}
		this.resultToDocument.set(importResult.id, document);
		if (importResult.result !== undefined) {
			for (let i = 0; i < importResult.result.length; i++) {
				importResult.result[i] = this.transformImportItem(importResult.result[i], packageId);
			}
		}
		emit(importResult);
		emit(edge);
	}

	public handles(edge: item) {
		return this.results.has(edge.outV) && this.items.has(edge.inV);
	}

	public item(edge: item): void {
		if (this.droppedResults.has(edge.outV)) {
			// We have dropped the result. Drop the item as well.
			// So not emit the item nor the edge.
			return;
		}
		let importResult: ExternalImportResult = this.results.get(edge.outV)!;
		let importItem: ExternalImportItem = this.items.get(edge.inV)!;
		let document: Document = this.resultToDocument.get(importResult.id)!;
		emit(this.transformImportItem(importItem, document.data!.package! as unknown as PackageId));
		emit(edge);
	}

	private transformImportItem<T extends inline.ExternalImportItem | ExternalImportItem>(item: T, packageId: PackageId): T {
		let result = Object.assign(Object.create(null), item) as T;
		result.moniker = {
			packageManager: 'npm',
			value: item.moniker.value
		};
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
		console.error(`No package.json file found. Tried ${packageFile}`);
		process.exitCode = -1;
		return;
	}

	const exportLinker: ExportLinker = new ExportLinker(packageJson);
	const importLinker: ImportLinker = new ImportLinker();
	let input: NodeJS.ReadStream | fs.ReadStream = process.stdin;
	if (options.file !== undefined && fs.existsSync(options.file)) {
		input = fs.createReadStream(options.file, { encoding: 'utf8'});
	}

	const rd = readline.createInterface(input);
	rd.on('line', (line) => {
		let element: Edge | Vertex = JSON.parse(line);
		if (element.type === 'edge') {
			switch(element.label) {
				case 'exports':
					exportLinker.exports(element);
					break;
				case 'imports':
					importLinker.imports(element);
					break;
				case 'item':
					if (exportLinker.handles(element)) {
						exportLinker.item(element);
					} else if (importLinker.handles(element)) {
						importLinker.item(element);
					} else {
						emit(element);
					}
					break;
				default:
					emit(line);
			}
		} else {
			switch (element.label) {
				case 'project':
					exportLinker.addOutAndRoot(element.data!.outDir as string, element.data!.rootDir as string);
					emit(line);
					break;
				case 'document':
					let tag: DocumentData | undefined = element.data;
					if (tag !== undefined && tag.kind === 'external') {
						importLinker.addDocument(element);
					} else {
						exportLinker.addDocument(element);
					}
					emit(line);
					break;
				case 'exportResult':
					exportLinker.addResult(element);
					break;
				case 'exportItem':
					exportLinker.addResultItem(element);
					break;
				case 'externalImportResult':
					importLinker.addResult(element);
					break;
				case 'externalImportItem':
					importLinker.addResultItem(element);
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
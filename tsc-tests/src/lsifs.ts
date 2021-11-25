/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';

import { URI } from 'vscode-uri';

import { Vertex, Edge, Id, ElementTypes, VertexLabels, Element } from 'lsif-protocol';

import { DiagnosticReporter } from 'lsif-tooling/lib/command';
import { ValidateCommand } from 'lsif-tooling/lib/validate';

import * as ts from 'lsif-tsc/node_modules/typescript';
import { lsif as _lsif, Options as LSIFOptions, DataManager, DataMode, Logger, NullLogger } from 'lsif-tsc/lib/lsif';
import { Builder, EmitterContext } from 'lsif-tsc/lib/common/graph';
import { Emitter } from 'lsif-tsc/lib/emitters/emitter';
import { ImportMonikers } from 'lsif-tsc/lib/npm/importMonikers';

export { ts };

export function assertElement(actual: Element | undefined, expected: Element): void {
	if (expected.label === VertexLabels.moniker && expected.identifier === '*' && actual && actual.label === VertexLabels.moniker) {
		actual.identifier = '*';
	}
	assert.deepEqual(actual, expected);
}

class TestDiagnosticReporter implements DiagnosticReporter {
	public readonly buffer: string[] = [];
	error(element: Edge | Vertex, message?: string): void {
		if (message === undefined) {
			if (element.type === ElementTypes.edge) {
				this.buffer.push(`Malformed edge ${JSON.stringify(element, undefined, 0)}:`);
			} else {
				this.buffer.push(`Malformed vertex ${JSON.stringify(element, undefined, 0)}:`);
			}
		} else {
			this.buffer.push(`\t- ${message}`);
		}
	}
	warn(element: Edge | Vertex, message?: string): void {
		this.error(element, message);
	}
	info(element: Edge | Vertex, message?: string): void {
		this.error(element, message);
	}
}

export class InMemoryLanguageServiceHost implements ts.LanguageServiceHost {

	private directories: Set<string>;
	private scriptSnapshots: Map<string, ts.IScriptSnapshot | null>;

	constructor(private cwd: string, private scripts: Map<string, string>, private options: ts.CompilerOptions) {
		this.directories = new Set();
		this.scriptSnapshots = new Map();
		for (const item of scripts.keys()) {
			this.directories.add(path.dirname(item));
		}
	}

	public getScriptFileNames(): string[] {
		return Array.from(this.scripts.keys());
	}

	public getCompilationSettings(): ts.CompilerOptions {
		return this.options;
	}

	public getScriptVersion(_fileName: string): string {
		return '0';
	}

	public getProjectVersion(): string {
		return '0';
	}

	public getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
		let result: ts.IScriptSnapshot | undefined | null = this.scriptSnapshots.get(fileName);
		if (result !== undefined && result !== null) {
			return result;
		}
		if (result === null) {
			return undefined;
		}
		let content: string | undefined;
		if (fileName.startsWith(`/@test/`)) {
			content = this.scripts.get(fileName);
		} else {
			content = ts.sys.readFile(fileName);
		}
		if (content === undefined) {
			this.scriptSnapshots.set(fileName, null);
			return undefined;
		}
		result = ts.ScriptSnapshot.fromString(content);
		this.scriptSnapshots.set(fileName, result);
		return result;
	}

	public getCurrentDirectory(): string {
		return this.cwd;
	}

	public getDefaultLibFileName(options: ts.CompilerOptions): string {
		const result = ts.getDefaultLibFilePath(options);
		return result;
	}

	public directoryExists(path: string): boolean  {
		if (path.startsWith('/@test')) {
			return this.directories.has(path);
		} else {
			return ts.sys.directoryExists(path);
		}
	}

	public getDirectories(path: string): string[] {
		const result = ts.sys.getDirectories(path);
		return result;
	}

	public fileExists(path: string): boolean {
		const result = ts.sys.fileExists(path);
		return result;
	}

	public readFile(path: string, encoding?:string): string | undefined {
		const result = ts.sys.readFile(path, encoding);
		return result;
	}

	public readDirectory(path: string, extensions?: readonly string[], exclude?: readonly string[], include?: readonly string[], depth?: number): string[] {
		const result = ts.sys.readDirectory(path, extensions, exclude, include, depth);
		return result;
	}
}

class TestEmitter implements Emitter {

	private _lastId: Id;
	public readonly sequence: (Vertex | Edge)[];
	public readonly elements: Map<Id, Vertex | Edge>;

	constructor() {
		this._lastId = -1;
		this.sequence = [];
		this.elements = new Map();
	}

	public get lastId(): Id {
		return this._lastId;
	}

	public start(): void {
	}

	emit(element: Vertex | Edge): void {
		this.sequence.push(element);
		assert.ok(!this.elements.has(element.id));
		this.elements.set(element.id, element);
		this._lastId = element.id;
	}

	public flush(): Promise<void> {
		return Promise.resolve();
	}

	public end(): Promise<void> {
		return Promise.resolve();
	}

	public toString(): string {
		const buffer: string[] = [];
		for (const element of this.sequence) {
			buffer.push(JSON.stringify(element, undefined, 0));
		}
		return buffer.join(os.EOL);
	}
}

export async function lsif(cwd: string, scripts: Map<string, string>, options: ts.CompilerOptions): Promise<TestEmitter> {
	const emitter = new TestEmitter();
	const host = new InMemoryLanguageServiceHost(cwd, scripts, options);
	const languageService = ts.createLanguageService(host);
	let counter = 1;
	const generator = (): number => {
		return counter++;
	};
	const builder = new Builder({ idGenerator: generator, emitSource: false });
	const emitterContext: EmitterContext = {
		get edge() {
			return builder.edge;
		},
		get vertex() {
			return builder.vertex;
		},
		emit(element: Vertex | Edge): void {
			emitter.emit(element);
		},
		flush(): Promise<void> {
			return emitter.flush();
		}
	};
	const reporter: Logger = new NullLogger();
	const source = builder.vertex.source(URI.file(cwd).toString(true));
	emitterContext.emit(source);
	const lsifOptions: LSIFOptions = { stdout: true, workspaceRoot: cwd, projectName: cwd, tsConfigFile: undefined, packageJsonFile: undefined, logger: reporter, dataMode: DataMode.free };
	const dataManager: DataManager = new DataManager(emitterContext, cwd, reporter, lsifOptions.dataMode);
	try {
		dataManager.begin();
		await _lsif(emitterContext, languageService, dataManager, new ImportMonikers(emitterContext, lsifOptions.workspaceRoot), undefined, [], lsifOptions);
	} finally {
		dataManager.end();
	}
	const testReporter = new TestDiagnosticReporter();
	const validate: ValidateCommand = new ValidateCommand(emitter.sequence.values(), {}, testReporter);
	await validate.run();
	if (testReporter.buffer.length !== 0) {
		throw new Error(`Validation failed:${os.EOL}${testReporter.buffer.join(os.EOL)}`);
	}
	return emitter;
}
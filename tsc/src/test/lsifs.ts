/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as os from 'os';
import * as path from 'path';

import * as ts from 'typescript';

import { Vertex, Edge, Id, Element } from 'lsif-protocol';

import { lsif as _lsif, EmitterContext, DataManager } from '../lsif';
import { Emitter } from '../emitters/emitter';
import { Builder } from '../graph';
import { URI } from 'vscode-uri';

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

	public getScriptVersion(fileName: string): string {
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

	private sequence: Element[];
	public elements: Map<Id, Element>;

	constructor() {
		this.sequence = [];
		this.elements = new Map();
	}

	public start(): void {
	}

	emit(element: Vertex | Edge): void {
		this.sequence.push(element);
		this.elements.set(element.id, element);
	}

	public end(): void {
	}

	public toString(): string {
		const buffer: string[] = [];
		for (const element of this.sequence) {
			buffer.push(JSON.stringify(element, undefined, 0));
		}
		return buffer.join(os.EOL);
	}
}

export function lsif(cwd: string, scripts: Map<string, string>, options: ts.CompilerOptions): TestEmitter {
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
		}
	};
	const group = builder.vertex.group(URI.from({ scheme: 'lsif-test', path: cwd }).toString(), cwd, URI.from({ scheme: 'lsif-test', path: cwd }).toString());
	emitterContext.emit(group);
	const dataManager: DataManager = new DataManager(emitterContext, group, false);
	try {
		dataManager.begin();
		_lsif(emitterContext, languageService, dataManager, [], { stdout: true, projectRoot: cwd, projectName: cwd, group: group, tsConfigFile: undefined });
	} finally {
		dataManager.end();
	}
	return emitter;
}
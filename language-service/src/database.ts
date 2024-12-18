/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import { URI } from 'vscode-uri';
import { Range, Id, types } from '@vscode/lsif-protocol';

import { FileType, FileSystem, DocumentInfo, FileStat } from './files';

export interface UriTransformer {
	toDatabase(uri: string): string;
	fromDatabase(uri: string): string;
}

export const noopTransformer: UriTransformer = {
	toDatabase: uri => uri,
	fromDatabase: uri => uri
};

export abstract class Database {

	private fileSystem!: FileSystem;
	private uriTransformer!: UriTransformer;

	protected constructor() {
	}

	protected initialize(transformerFactory?: (workspaceRoot: string) => UriTransformer): void {
		const workspaceRoot = this.getWorkspaceRoot().toString(true);
		this.uriTransformer = transformerFactory ? transformerFactory(workspaceRoot) : noopTransformer;
		this.fileSystem = new FileSystem(workspaceRoot, this.getDocumentInfos());
	}

	public abstract load(file: string, transformerFactory: (workspaceRoot: string) => UriTransformer): Promise<void>;

	public abstract close(): void;

	public abstract getWorkspaceRoot(): URI;

	protected abstract getDocumentInfos(): DocumentInfo[];

	public stat(uri: string): FileStat | null {
		const transformed = this.uriTransformer.toDatabase(uri);
		const result = this.fileSystem.stat(transformed);
		if (result !== null) {
			return result;
		}
		const id = this.findFile(transformed);
		if (id === undefined) {
			return null;
		}
		return FileStat.createFile();
	}

	public readDirectory(uri: string): [string, FileType][] {
		return this.fileSystem.readDirectory(this.uriTransformer.toDatabase(uri));
	}

	public readFileContent(uri: string): string | null {
		const transformed = this.uriTransformer.toDatabase(uri);
		let info = this.fileSystem.getFileInfo(transformed);
		if (info === undefined) {
			info = this.findFile(transformed);
		}
		if (info === undefined) {
			return null;
		}
		const result = this.fileContent(info);
		if (result === undefined) {
			return null;
		}
		return result;
	}

	protected abstract findFile(uri: string): { id: Id; hash: string | undefined } | undefined;

	protected abstract fileContent( info: { id: Id; hash: string | undefined } ) : string | undefined;

	public abstract foldingRanges(uri: string): types.FoldingRange[] | undefined;

	public abstract documentSymbols(uri: string): types.DocumentSymbol[] | undefined;

	public abstract hover(uri: string, position: types.Position): types.Hover | undefined;

	public abstract declarations(uri: string, position: types.Position): types.Location | types.Location[] | undefined;

	public abstract definitions(uri: string, position: types.Position): types.Location | types.Location[] | undefined;

	public abstract references(uri: string, position: types.Position, context: types.ReferenceContext): types.Location[] | undefined;

	protected asDocumentSymbol(range: Range): types.DocumentSymbol | undefined {
		const tag = range.tag;
		if (tag === undefined || !(tag.type === 'declaration' || tag.type === 'definition')) {
			return undefined;
		}
		return types.DocumentSymbol.create(
			tag.text, tag.detail || '', tag.kind,
			tag.fullRange, this.asRange(range)
		);
	}

	protected asRange(value: Range): types.Range {
		return {
			start: {
				line: value.start.line,
				character: value.start.character
			},
			end: {
				line: value.end.line,
				character: value.end.character
			}
		};
	}

	protected toDatabase(uri: string): string {
		return this.uriTransformer.toDatabase(uri);
	}

	protected fromDatabase(uri: string): string {
		return this.uriTransformer.fromDatabase(uri);
	}
}

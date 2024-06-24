/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as path from 'path';

import { Id } from 'lsif-protocol';

const ctime = Date.now();
const mtime = Date.now();

export namespace FileType {
	export const Unknown: 0 = 0;
	export const File: 1 = 1;
	export const Directory: 2 = 2;
	export const SymbolicLink: 64 = 64;
}

export type FileType = 0 | 1 | 2 | 64;

export interface FileStat {
	type: FileType;
	ctime: number;
	mtime: number;
	size: number;
}

export namespace FileStat {
	export function createFile(): FileStat {
		return { type: FileType.File, ctime: ctime, mtime: mtime, size: 0 };
	}
}

export interface DocumentInfo {
	id: Id;
	uri: string;
	hash: string;
}

interface File extends FileStat {
	type: 1;
	name: string;
	id: Id;
	hash: string;
}

namespace File {
	export function create(name: string, id: Id, hash: string): File {
		return { type: FileType.File, ctime: ctime, mtime: mtime, size: 0, name, id, hash };
	}
}

interface Directory extends FileStat {
	type: 2;
	name: string;
	children: Map<string, Entry>;
}

namespace Directory {
	export function create(name: string): Directory {
		return { type: FileType.Directory, ctime: Date.now(), mtime: Date.now(), size: 0, name, children: new Map() };
	}
}

export type Entry = File | Directory;

export class FileSystem {

	private workspaceRoot: string;
	private workspaceRootWithSlash: string;
	private filesOutsideWorkspaceRoot: Map<string, { id: Id, hash: string | undefined }>;
	private root: Directory;

	constructor(workspaceRoot: string, documents: DocumentInfo[]) {
		if (workspaceRoot.charAt(workspaceRoot.length - 1) === '/') {
			this.workspaceRoot = workspaceRoot.substr(0, workspaceRoot.length - 1);
			this.workspaceRootWithSlash = workspaceRoot;
		} else {
			this.workspaceRoot = workspaceRoot;
			this.workspaceRootWithSlash = workspaceRoot + '/';
		}
		this.root = Directory.create('');
		this.filesOutsideWorkspaceRoot = new Map();
		for (let info of documents) {
			// Do not show file outside the workspaceRoot.
			if (!info.uri.startsWith(this.workspaceRootWithSlash)) {
				this.filesOutsideWorkspaceRoot.set(info.uri, info);
				continue;
			}
			let p = info.uri.substring(workspaceRoot.length);
			let dirname = path.posix.dirname(p);
			let basename = path.posix.basename(p);
			let entry = this.lookup(dirname, true);
			if (entry && entry.type === FileType.Directory) {
				entry.children.set(basename, File.create(basename, info.id, info.hash));
			}
		}
	}

	public stat(uri: string): FileStat | null {
		if (this.filesOutsideWorkspaceRoot.has(uri)) {
			return { type: FileType.File, ctime, mtime, size: 0 };
		}
		let isRoot = this.workspaceRoot === uri;
		if (!uri.startsWith(this.workspaceRootWithSlash) && !isRoot) {
			return null;
		}
		let p = isRoot ? '' : uri.substring(this.workspaceRootWithSlash.length);
		let entry = this.lookup(p, false);
		return entry ? entry : null;
	}

	public readDirectory(uri: string): [string, FileType][] {
		let isRoot = this.workspaceRoot === uri;
		if (!uri.startsWith(this.workspaceRootWithSlash) && !isRoot) {
			return [];
		}
		let p = isRoot ? '' : uri.substring(this.workspaceRootWithSlash.length);
		let entry = this.lookup(p, false);
		if (entry === undefined || entry.type !== FileType.Directory) {
			return [];
		}
		let result: [string, FileType][] = [];
		for (let child of entry.children.values()) {
			result.push([child.name, child.type]);
		}
		return result;
	}

	public getFileInfo(uri: string): { id: Id, hash: string | undefined } | undefined {
		let result = this.filesOutsideWorkspaceRoot.get(uri);
		if (result !== undefined) {
			return result;
		}
		let isRoot = this.workspaceRoot === uri;
		if (!uri.startsWith(this.workspaceRootWithSlash) && !isRoot) {
			return undefined;
		}
		let entry = this.lookup(isRoot ? '' : uri.substring(this.workspaceRootWithSlash.length));
		return entry && entry.type === FileType.File ? entry : undefined;
	}

	private lookup(uri: string, create: boolean = false): Entry | undefined {
		let parts = uri.split('/');
		let entry: Entry = this.root;
		for (const part of parts) {
			if (!part || part === '.') {
				continue;
			}
			let child: Entry | undefined;
			if (entry.type === FileType.Directory) {
				child = entry.children.get(part);
				if (child === undefined && create) {
					child = Directory.create(part);
					entry.children.set(part, child);
				}
			}
			if (!child) {
				return undefined;
			}
			entry = child;
		}
		return entry;
	}
}
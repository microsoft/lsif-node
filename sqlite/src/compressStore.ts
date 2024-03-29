/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as os from 'os';
import * as fs from 'fs';

import { Edge, Vertex } from 'lsif-protocol';
import { Store } from './store';

const __stdout = process.stdout;
const __eol = os.EOL;

export interface Writer {

	write(...data: string[]): void;
	writeEOL(): void;
	writeln(...data: string[]): void;
}

export class StdoutWriter implements Writer {
	public constructor() {
	}

	write(...data: string[]): void {
		for (const chunk of data) {
			__stdout.write(chunk);
		}
	}

	writeEOL(): void {
		__stdout.write(__eol);
	}

	writeln(...data: string[]): void {
		for (const chunk of data) {
			__stdout.write(chunk);
		}
		__stdout.write(__eol);
	}
}

export class FileWriter implements Writer{

	public constructor(private fd: number) {
	}

	write(...data: string[]): void {
		if (data.length === 0) {
			return;
		}
		for (const chunk of data) {
			this.writeBuffer(Buffer.from(chunk, 'utf8'));
		}
	}

	writeEOL(): void {
		this.writeBuffer(Buffer.from(__eol, 'utf8'));
	}

	writeln(...data: string[]): void {
		if (data.length === 0) {
			this.writeEOL();
			return;
		}
		for (const chunk of data) {
			this.writeBuffer(Buffer.from(chunk, 'utf8'));
		}
		this.writeEOL();
	}

	private writeBuffer(buffer: Buffer): void {
		let offset: number = 0;
		while (offset < buffer.length) {
			offset += fs.writeSync(this.fd, buffer, offset);
		}
	}
}

export class CompressStore extends Store {

	private writer: Writer;

	constructor(input: NodeJS.ReadStream | fs.ReadStream, fileName?: string) {
		super(input);
		this.writer = fileName !== undefined ? new FileWriter(fs.openSync(fileName, 'w')) : new StdoutWriter();
	}

	public insert(element: Vertex | Edge): void {
		this.writer.writeln(this.compress(element));
	}
}
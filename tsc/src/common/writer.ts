/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as os from 'os';
import { promisify } from 'util';
import * as _fs from 'fs';
const fs = {
	write: promisify(_fs.write)
};

import { LinkedList } from './linkedMap';

const __stdout = process.stdout;
const __eol = os.EOL;

export interface Writer {

	write(...data: string[]): void;
	writeEOL(): void;
	writeln(...data: string[]): void;
	flush(): Promise<void>;
}

export class StdoutWriter implements Writer {
	public constructor() {
	}

	write(...data: string[]): void {
		for (let chunk of data) {
			__stdout.write(chunk);
		}
	}

	writeEOL(): void {
		__stdout.write(__eol);
	}

	writeln(...data: string[]): void {
		for (let chunk of data) {
			__stdout.write(chunk);
		}
		__stdout.write(__eol);
	}

	flush(): Promise<void> {
		return Promise.resolve();
	}
}

export class FileWriter implements Writer{

	private static BufferSize: number = 65536;

	private queue: LinkedList<Buffer>;
	private bytesPending: number;

	private pendingWrite: Promise<void> | undefined;
	private mode: 'queue' | 'flush';

	public constructor(private fd: number) {
		this.queue = new LinkedList<Buffer>();
		this.bytesPending = 0;
		this.mode = 'queue';
	}

	write(...data: string[]): void {
		if (data.length === 0) {
			return;
		}
		for (let chunk of data) {
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
		for (let chunk of data) {
			this.writeBuffer(Buffer.from(chunk, 'utf8'));
		}
		this.writeEOL();
	}

	async flush(): Promise<void> {
		this.mode = 'flush';
		if (this.pendingWrite !== undefined) {
			await this.pendingWrite;
		}
		while(this.bytesPending > 0) {
			await this.deliver(true);
		}
		this.mode = 'queue';
	}

	private writeBuffer(chunk: Buffer): void {
		this.queue.push(chunk);
		this.bytesPending+= chunk.length;
		if (this.pendingWrite === undefined && this.mode === 'queue') {
			this.deliver();
		}
	}

	private async deliver(force: boolean = false): Promise<void> {
		if (this.bytesPending < FileWriter.BufferSize && !force) {
			return;
		}
		const chunk = this.queue.shift();
		if (chunk === undefined) {
			return;
		}
		let promise: Promise<void>;
		if (chunk.length > FileWriter.BufferSize) {
			promise = this.writeChunk(chunk);
			this.bytesPending -= chunk.length;
		} else {
			const chunks: Buffer[] = [chunk];
			let size: number = chunk.length;
			while (true) {
				const head = this.queue.head;
				if (head === undefined) {
					break;
				}
				if (size + head.length > FileWriter.BufferSize) {
					break;
				}
				const chunk = this.queue.shift()!;
				if (chunk === undefined) {
					console.log(head, chunk);
				}
				size += chunk.length;
				chunks.push(chunk);
			}
			const buffer = Buffer.alloc(size);
			let index: number = 0;
			for (const chunk of chunks) {
				chunk.copy(buffer, index);
				index += chunk.length;
			}
			promise = this.writeChunk(buffer);
			this.bytesPending -= size;
		}
		this.pendingWrite = promise;
		await promise;
		this.pendingWrite = undefined;
		if (this.mode === 'queue') {
			this.deliver();
		}
	}

	private async writeChunk(chunk: Buffer): Promise<void> {
		let offset: number = 0;
		while(offset < chunk.length) {
			offset += await (await fs.write(this.fd, chunk, offset)).bytesWritten;
		}
	}
}
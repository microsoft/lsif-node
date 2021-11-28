/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';

import { Connection } from './connection';
import { Requests, Notifications } from './writerMessages';

const __stdout = process.stdout;
const __eol = os.EOL;

export interface Writer {

	write(...data: string[]): void;
	writeEOL(): void;
	writeln(...data: string[]): void;
	flush(): Promise<void>;
	close(): Promise<void>;
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

	close(): Promise<void> {
		return Promise.resolve();
	}
}

export class FileWriter implements Writer {

	private static BufferSize: number = 65536;

	private worker: Worker;
	private connection: Connection<Requests, Notifications>;

	private buffer: Buffer | undefined;
	private bytesAdded: number;

	public constructor(fileName: string) {
		this.worker = new Worker(path.join(__dirname, './writerWorker.js'));
		this.worker.terminate;
		this.connection = new Connection(this.worker);
		this.connection.listen();
		this.connection.sendNotification('open', { fileName });
		this.buffer = Buffer.alloc(FileWriter.BufferSize);
		this.bytesAdded = 0;
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
		await this.connection.sendRequest('flush');
	}

	async close(): Promise<void> {
		this.sendBuffer(true);
		await this.connection.sendRequest('close');
		this.worker.terminate();
	}

	private writeBuffer(chunk: Buffer): void {
		if (this.buffer === undefined) {
			throw new Error('Should never happen');
		}
		if (chunk.length > FileWriter.BufferSize) {
			this.sendBuffer();
			this.connection.sendNotification('write', { data: chunk.buffer, length: chunk.length });
		} else if (this.bytesAdded + chunk.length < FileWriter.BufferSize) {
			chunk.copy(this.buffer, this.bytesAdded);
			this.bytesAdded += chunk.length;
		} else {
			this.sendBuffer();
			chunk.copy(this.buffer, this.bytesAdded);
			this.bytesAdded += chunk.length;
		}
	}

	private sendBuffer(end: boolean = false): void {
		if (this.bytesAdded === 0 || this.buffer === undefined) {
			return;
		}
		this.connection.sendNotification('write', { data: this.buffer.buffer, length: this.bytesAdded });
		if (!end) {
			this.buffer = Buffer.alloc(FileWriter.BufferSize);
			this.bytesAdded = 0;
		} else {
			this.buffer = undefined;
			this.bytesAdded = 0;
		}
	}
}
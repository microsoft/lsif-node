/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { parentPort  } from 'worker_threads';
import { promisify } from 'util';
import * as _fs from 'fs';
const fs = {
	write: promisify(_fs.write)
};

import { LinkedList } from './linkedMap';
import { Connection } from './writerMessages';

if (parentPort === null) {
	process.exit();
}

const connection = new Connection(parentPort);
let fileWriter!: FileWriter;

connection.onRequest('open', async (message) => {
	if (message.method !== 'open') { return; }
	fileWriter = new FileWriter(message.fileName);
});

connection.onRequest('write', async (message) => {
	if (message.method !== 'write') { return; }
	fileWriter.write(message.data, message.length);
});

connection.onRequest('flush', async () => {
	await fileWriter.flush();
});

connection.onRequest('close', async () => {
	await fileWriter.close();
});

connection.listen();

type BufferInfo = {
	data: Buffer;
	length: number;
};

export class FileWriter {

	private fd: number;
	private queue: LinkedList<BufferInfo>;

	private pendingWrite: Promise<void> | undefined;
	private mode: 'queue' | 'flush';

	public constructor(fileName: string ) {
		this.fd = _fs.openSync(fileName, 'w');
		this.queue = new LinkedList<BufferInfo>();
		this.mode = 'queue';
	}

	async write(data: ArrayBuffer, length: number): Promise<void> {
		const buffer = Buffer.from(data);
		this.queue.push({ data: buffer, length });
		if (this.pendingWrite === undefined) {
			this.deliver();
		}
	}

	async flush(): Promise<void> {
		try {
			this.mode = 'flush';
			if (this.pendingWrite !== undefined) {
				await this.pendingWrite;
				this.pendingWrite = undefined;
			}
			while(this.queue.size > 0) {
				await this.deliver();
			}
		} finally {
			this.mode = 'queue';
		}
	}

	async close(): Promise<void> {
		await this.flush();
		_fs.closeSync(this.fd);
	}

	private async deliver(): Promise<void> {
		const bufferInfo = this.queue.shift();
		if (bufferInfo === undefined) {
			return;
		}
		this.pendingWrite = this.writeChunk(bufferInfo.data, bufferInfo.length);
		await this.pendingWrite;
		this.pendingWrite = undefined;
		if (this.mode === 'queue') {
			this.deliver();
		}
	}

	private async writeChunk(chunk: Buffer, length: number): Promise<void> {
		let offset: number = 0;
		while(offset < length) {
			const byesWritten = (await fs.write(this.fd, chunk, offset, length)).bytesWritten;
			offset += byesWritten;
			length -= byesWritten;
		}
	}
}

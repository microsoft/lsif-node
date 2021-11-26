/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { MessagePort, Worker, TransferListItem } from 'worker_threads';

// type MessageSignature<Messages extends Message> = {
// 	[M in Messages as M['method']]: (message: Omit<M, 'method'>) => void;
// };


interface Message {
	method: string;
}

export type Message2 = {
	method: 'open';
	fileName: string;
} | {
	method: 'write';
	data: ArrayBuffer;
	length: number;
} | {
	method: 'flush';
} | {
	method: 'close'
} | {
	method: 'exit'
};

interface Request extends Message {
	__brand?: 'request';
};

type Requests = Request & ({
	method: 'flush';
} | {
	method: 'close'
});

export namespace Request {
	export function is(value: any): value is Request {
		const candidate: Request = value;
		return candidate !== undefined && candidate !== null && typeof candidate.id === 'number' && typeof candidate.method === 'string';
	}
}

interface Notification extends Message {
	__brand?: 'notification';
}

type Notifications = Notification & ({
	method: 'open';
	fileName: string;
} | {
	method: 'write';
	data: ArrayBuffer;
	length: number;
});

export namespace Notification {
	export function is(value: any): value is Notification {
		const candidate: Notification & { id: undefined } = value;
		return candidate !== undefined && candidate !== null && typeof candidate.method === 'string' && candidate.id === undefined;
	}
}

type Response = { id: number; result?: any; error?: any };

namespace Response {
	export function is(value: any): value is Response {
		const candidate: Response = value;
		return candidate !== undefined && candidate !== null && typeof candidate.id === 'number' && (candidate.error !== undefined || candidate.result !== undefined);
	}
}

type ResponsePromise = {
	method: string;
	resolve: (response: any) => void;
	reject: (error: any) => void
};

type MessageHandler = {
	(message: Message): Promise<any>;
};

interface _Request extends Request {
	id: number;
}
export class Connection {

	private readonly port: MessagePort | Worker;
	private id: number;
	private readonly responsePromises: Map<number, ResponsePromise>;
	private readonly requestHandlers: Map<string, MessageHandler>;
	private readonly notificationHandlers: Map<string, MessageHandler>;

	constructor(port: MessagePort | Worker) {
		this.port = port;
		this.id = 1;
		this.responsePromises = new Map();
		this.requestHandlers = new Map();
		this.notificationHandlers = new Map();
	}

	public sendRequest(request: Request, transferList?: ReadonlyArray<TransferListItem>): Promise<any> {
		return new Promise((resolve, reject) => {
			const id = this.id++;
			const _request: _Request = Object.assign({ id }, request);
			this.responsePromises.set(id, { resolve, reject, method: request.method});
			this.port.postMessage(_request, transferList);
		});
	}

	public sendNotification(message: Notification, transferList?: ReadonlyArray<TransferListItem>): void {
		this.port.postMessage(message, transferList);
	}

	public onRequest(method: Message['method'], handler: MessageHandler): void {
		this.requestHandlers.set(method, handler);
	}

	public onNotification(method: Message): void {

	}

	public listen(): void {
		this.port.on('message', async (value) => {
			if (Request.is(value)) {
				const id = value.id;
				const handler = this.requestHandlers.get(value.method);
				if (handler !== undefined) {
					try {
						const result = await handler(value);
						this.sendResultResponse(id, result);
					} catch(error) {
						this.sendErrorResponse(id, error);
					}
				}
			} else if (Response.is(value)) {
				const id = value.id;
				const promise = this.responsePromises.get(id);
				if (promise !== undefined) {
					this.responsePromises.delete(id);
					if (value.result !== undefined) {
						promise.resolve(value.result);
					} else if (value.error !== undefined) {
						promise.reject(typeof value.error === 'string' ? new Error(value.error) : value.error);
					} else {
						promise.reject(new Error('Response hs neither a result nor an error value'));
					}
				}
			}
		});
	}

	private sendResultResponse(id: number, result: any): void {
		const response: Response =  { id, result: result === undefined ? null : result };
		this.port.postMessage(response);
	}

	private sendErrorResponse(id: number, error: any): void {
		const response: Response =  { id, error: error === undefined ? 'Unknown error' : error instanceof Error ? error.message : error };
		this.port.postMessage(response);
	}
}


let connection!: Connection;

connection.sendRequest({ method: 'open'});
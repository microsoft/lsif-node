/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { MessagePort, Worker, TransferListItem } from 'worker_threads';


export interface Message {
	method: string;
	params?: null | object;
}

export interface Request extends Message {
	result?: null | any;
	error?: null | any;
}

export interface Notification extends Message {
}

interface _Request extends Request {
	id: number;
}

namespace _Request {
	export function is(value: any): value is _Request {
		const candidate: _Request = value;
		return candidate !== undefined && candidate !== null && typeof candidate.id === 'number' && typeof candidate.method === 'string';
	}
}

type RequestHandler = {
	(params: any): Promise<any>;
};

interface _Notification extends Notification {
}

namespace _Notification {
	export function is(value: any): value is Notification {
		const candidate: Notification & { id: undefined } = value;
		return candidate !== undefined && candidate !== null && typeof candidate.method === 'string' && candidate.id === undefined;
	}
}

type NotificationHandler = {
	(params: any): void;
};

interface _Response {
	id: number;
	result?: any;
	error?: any
};

namespace _Response {
	export function is(value: any): value is _Response {
		const candidate: _Response = value;
		return candidate !== undefined && candidate !== null && typeof candidate.id === 'number' && (candidate.error !== undefined || candidate.result !== undefined);
	}
}

type ResponsePromise = {
	method: string;
	resolve: (response: any) => void;
	reject: (error: any) => void
};

type UnionToIntersection<U> =
	(U extends any ? (k: U) => void : never) extends ((k: infer I) => void) ? I : never;

type MethodKeys<Messages extends Message> = {
	[M in Messages as M['method']]: M['method'];
};

type SendRequestSignatures<Requests extends Request> = UnionToIntersection<{
 	[R in Requests as R['method']]: R['params'] extends null | undefined
	 	? (method: R['method']) => Promise<R['result'] extends null | undefined ? void : R['result']>
		: (method: R['method'], params: R['params'], transferList?: ReadonlyArray<TransferListItem>) => Promise<R['result'] extends null | undefined ? void : R['result']>;
}[keyof MethodKeys<Requests>]>;

type HandleRequestSignatures<Requests extends Request> = UnionToIntersection<{
 	[R in Requests as R['method']]: R['params'] extends null | undefined
	 	? (method: R['method'], handler: () => Promise<R['result'] extends null | undefined ? void : R['result']>) => void
		: (method: R['method'], handler: (params: R['params']) => Promise<R['result'] extends null | undefined ? void : R['result']>) => void;
}[keyof MethodKeys<Requests>]>;

type SendNotificationSignatures<Notifications extends Notification> = UnionToIntersection<{
	[N in Notifications as N['method']]: N['params'] extends null | undefined
		? (method: N['method']) => void
		: (method: N['method'], params: N['params'], transferList?: ReadonlyArray<TransferListItem>) => void;
}[keyof MethodKeys<Notifications>]>;

type HandleNotificationSignatures<Notifications extends Notification> = UnionToIntersection<{
	[N in Notifications as N['method']]: N['params'] extends null | undefined
		? (method: N['method'], handler: () => void) => void
		: (method: N['method'], handler: (params: N['params']) => void) => void;
}[keyof MethodKeys<Notifications>]>;

export class Connection<Requests extends Request, Notifications extends Notification> {

	private readonly port: MessagePort | Worker;
	private id: number;
	private readonly responsePromises: Map<number, ResponsePromise>;
	private readonly requestHandlers: Map<string, RequestHandler>;
	private readonly notificationHandlers: Map<string, NotificationHandler>;

	constructor(port: MessagePort | Worker) {
		this.port = port;
		this.id = 1;
		this.responsePromises = new Map();
		this.requestHandlers = new Map();
		this.notificationHandlers = new Map();
	}

	get sendRequest(): SendRequestSignatures<Requests> {
		return this._sendRequest as SendRequestSignatures<Requests>;
	}

	private _sendRequest(method: string, params?: any, transferList?: ReadonlyArray<TransferListItem>): Promise<any> {
		return new Promise((resolve, reject) => {
			const id = this.id++;
			const _request: _Request = { id, method };
			if (params !== undefined) {
				_request.params = params;
			}
			this.responsePromises.set(id, { resolve, reject, method: _request.method});
			this.port.postMessage(_request, transferList);
		});
	}

	public get onRequest(): HandleRequestSignatures<Requests> {
		return this._onRequest as HandleRequestSignatures<Requests>;
	}

	private _onRequest(method: string, handler: RequestHandler): void {
		this.requestHandlers.set(method, handler);
	}

	public get sendNotification(): SendNotificationSignatures<Notifications> {
		return this._sendNotification as SendNotificationSignatures<Notifications>;
	}

	private _sendNotification(method: string, params?: any, transferList?: ReadonlyArray<TransferListItem>): void {
		const _notification: _Notification = { method };
		if (params !== undefined) {
			_notification.params = params;
		}
		this.port.postMessage(_notification, transferList);
	}

	public get onNotification(): HandleNotificationSignatures<Notifications> {
		return this._onNotification as HandleNotificationSignatures<Notifications>;
	}

	private _onNotification(method: string, handler: NotificationHandler): void {
		this.notificationHandlers.set(method, handler);
	}

	public listen(): void {
		this.port.on('message', async (value) => {
			if (_Request.is(value)) {
				const id = value.id;
				const handler = this.requestHandlers.get(value.method);
				if (handler !== undefined) {
					try {
						const result = await handler(value.params);
						this.sendResultResponse(id, result);
					} catch(error) {
						this.sendErrorResponse(id, error);
					}
				}
			} else if (_Notification.is(value)) {
				const handler = this.notificationHandlers.get(value.method);
				if (handler !== undefined) {
					handler(value.params);
				}
			} else if (_Response.is(value)) {
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
		const response: _Response =  { id, result: result === undefined ? null : result };
		this.port.postMessage(response);
	}

	private sendErrorResponse(id: number, error: any): void {
		const response: _Response =  { id, error: error === undefined ? 'Unknown error' : error instanceof Error ? error.message : error };
		this.port.postMessage(response);
	}
}
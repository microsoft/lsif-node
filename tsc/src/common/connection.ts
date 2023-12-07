/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { MessagePort, Worker, TransferListItem } from 'worker_threads';


export type MessageType = {
	method: string;
	params?: null | object;
};

export type RequestType = MessageType & ({
	result: null | any;
	error?: undefined;
} | {
	result?: undefined;
	error: null | any;
});

export type NotificationType = MessageType;

type Message = {
	method: string;
	params?: null | undefined | object;
};

type Request = {
	id: number;
} & Message;

namespace Request {
	export function is(value: any): value is Request {
		const candidate: Request = value;
		return candidate !== undefined && candidate !== null && typeof candidate.id === 'number' && typeof candidate.method === 'string';
	}
}

type RequestHandler = {
	(params: any): Promise<any>;
};

type Notification = Message;

namespace Notification {
	export function is(value: any): value is NotificationType {
		const candidate: NotificationType & { id: undefined } = value;
		return candidate !== undefined && candidate !== null && typeof candidate.method === 'string' && candidate.id === undefined;
	}
}

type NotificationHandler = {
	(params: any): void;
};

interface Response {
	id: number;
	result?: any;
	error?: any
};

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

type UnionToIntersection<U> =
	(U extends any ? (k: U) => void : never) extends ((k: infer I) => void) ? I : never;

type MethodKeys<Messages extends MessageType> = {
	[M in Messages as M['method']]: M['method'];
};

type _SendRequestSignatures<Requests extends RequestType> = UnionToIntersection<{
 	[R in Requests as R['method']]: R['params'] extends null | undefined
	 	? (method: R['method']) => Promise<R['result'] extends null | undefined ? void : R['result']>
		: (method: R['method'], params: R['params'], ...transferList: ReadonlyArray<TransferListItem>) => Promise<R['result'] extends null | undefined ? void : R['result']>;
}[keyof MethodKeys<Requests>]>;

type SendRequestSignatures<Requests extends RequestType | undefined> = [Requests] extends [RequestType] ? _SendRequestSignatures<Requests> : undefined;

type _HandleRequestSignatures<Requests extends RequestType> = UnionToIntersection<{
 	[R in Requests as R['method']]: R['params'] extends null | undefined
	 	? (method: R['method'], handler: () => Promise<R['result'] extends null | undefined ? void : R['result']>) => void
		: (method: R['method'], handler: (params: R['params']) => Promise<R['result'] extends null | undefined ? void : R['result']>) => void;
}[keyof MethodKeys<Requests>]>;

type HandleRequestSignatures<Requests extends RequestType | undefined> = [Requests] extends [RequestType] ?_HandleRequestSignatures<Requests> : undefined;

type _SendNotificationSignatures<Notifications extends NotificationType> = UnionToIntersection<{
	[N in Notifications as N['method']]: N['params'] extends null | undefined
		? (method: N['method']) => void
		: (method: N['method'], params: N['params'], ...transferList: ReadonlyArray<TransferListItem>) => void;
}[keyof MethodKeys<Notifications>]>;

type SendNotificationSignatures<Notifications extends NotificationType | undefined> = [Notifications] extends [NotificationType] ? _SendNotificationSignatures<Notifications> : undefined;

type _HandleNotificationSignatures<Notifications extends NotificationType> = UnionToIntersection<{
	[N in Notifications as N['method']]: N['params'] extends null | undefined
		? (method: N['method'], handler: () => void) => void
		: (method: N['method'], handler: (params: N['params']) => void) => void;
}[keyof MethodKeys<Notifications>]>;

type HandleNotificationSignatures<Notifications extends NotificationType | undefined> = [Notifications] extends [NotificationType] ? _HandleNotificationSignatures<Notifications> : undefined;

export class Connection<Requests extends RequestType | undefined, Notifications extends NotificationType | undefined, RequestHandlers extends RequestType | undefined = undefined, NotificationHandlers extends NotificationType | undefined = undefined> {

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

	public readonly sendRequest: SendRequestSignatures<Requests> = this._sendRequest as SendRequestSignatures<Requests>;

	private _sendRequest(method?: string, params?: any, transferList?: ReadonlyArray<TransferListItem>): Promise<any> {
		if (method === undefined) {
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			const id = this.id++;
			const _request: Request = { id, method };
			if (params !== undefined) {
				_request.params = params;
			}
			this.responsePromises.set(id, { resolve, reject, method: _request.method});
			this.port.postMessage(_request, transferList);
		});
	}

	public readonly onRequest: HandleRequestSignatures<RequestHandlers> = this._onRequest as HandleRequestSignatures<RequestHandlers>;

	private _onRequest(method?: string, handler?: RequestHandler): void {
		if (method === undefined || handler === undefined) {
			return;
		}
		this.requestHandlers.set(method, handler);
	}

	public readonly sendNotification: SendNotificationSignatures<Notifications> = this._sendNotification as SendNotificationSignatures<Notifications>;

	private _sendNotification(method?: string, params?: any, transferList?: ReadonlyArray<TransferListItem>): void {
		if (method === undefined) {
			return;
		}
		const _notification: Notification = { method };
		if (params !== undefined) {
			_notification.params = params;
		}
		this.port.postMessage(_notification, transferList);
	}

	public readonly onNotification: HandleNotificationSignatures<NotificationHandlers> = this._onNotification as HandleNotificationSignatures<NotificationHandlers>;

	private _onNotification(method?: string, handler?: NotificationHandler): void {
		if (method === undefined || handler === undefined) {
			return;
		}
		this.notificationHandlers.set(method, handler);
	}

	public listen(): void {
		this.port.on('message', async (value) => {
			if (Request.is(value)) {
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
			} else if (Notification.is(value)) {
				const handler = this.notificationHandlers.get(value.method);
				if (handler !== undefined) {
					handler(value.params);
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
						promise.reject(new Error('Response has neither a result nor an error value'));
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
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

export type Notifications = {
	method: 'open';
	params: {
		fileName: string;
	}
} | {
	method: 'write';
	params: {
		data: ArrayBuffer;
		length: number;
	}
};

export type Requests = {
	method: 'flush';
	params: null;
	result: null;
} | {
	method: 'close';
	params: null;
	result: null;
};
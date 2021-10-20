/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import { Emitter, Create } from './emitter';
import { Vertex, Edge } from 'lsif-protocol';
import { Writer } from '../common/writer';


export const create: Create = (_writer: Writer): Emitter => {
	return {
		start: () => {},
		emit: (_element: Vertex | Edge) => {
			// writer.writeln(JSON.stringify(element, undefined, 0));
		},
		end: () => {}
	};
};
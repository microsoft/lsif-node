/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import { Emitter, Create } from './emitter';
import { Vertex, Edge } from 'lsif-protocol';
import { Writer } from '../common/writer';

export const create: Create = (writer: Writer): Emitter => {
	let isFirst: boolean = true;
	return {
		start: () => {
			writer.writeln('[');
		},
		emit: (element: Vertex | Edge) => {
			if (!isFirst) {
				writer.writeln(',');
			}
			writer.write('\t', JSON.stringify(element, undefined, 0));
			isFirst = false;
		},
		flush: () => {
			return writer.flush();
		},
		end: () => {
			if (!isFirst) {
				writer.writeEOL();
			}
			writer.writeln(']');
			return writer.close();
		}
	};
};
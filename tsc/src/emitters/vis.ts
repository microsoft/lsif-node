/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as path from 'path';

import URI from 'vscode-uri';

import { Emitter, Create } from './emitter';
import { Vertex, Edge } from 'lsif-protocol';

const __out = process.stdout;

interface VisNode {
	id: number;
	label: string;
}

interface VisEdge {
	from: number;
	to: number;
	label: string;
}

interface VisData {
	nodes: VisNode[];
	edges: VisEdge[];
}

function baseName(uri: string): string {
	return path.basename(URI.parse(uri).fsPath);
}

export const create: Create = (): Emitter => {
	let data: VisData = {
		nodes: [],
		edges: []
	};
	return {
		start: () => {

		},
		emit: (element: Vertex | Edge) => {
			if (element.type === 'vertex') {
				// if (element._kind === 'hoverResult') {
				// 	return;
				// }
				let label: string;
				switch (element.label) {
					case 'project':
						label = `${element.resource !== undefined ? path.basename(path.dirname(element.resource)) + ' ' : ''}[project]`;
						break;
					case 'document':
						label = `${baseName(element.uri)} [document]`;
						break;
					case 'resultSet':
						label = `[result set]`;
						break;
					case 'range':
						label = '[range]';
						if (element.tag !== undefined) {
							switch (element.tag.type) {
								case 'declaration':
									label =  `${element.tag.text} [decl]`;
									break;
								case 'definition':
									label =  `${element.tag.text} [def]`;
									break;
								case 'reference':
									label = `${element.tag.text} [ref]`;
									break;
							}
						}
						break;
					default:
						label = element.label;
				}
				let node: VisNode = {
					id: element.id as number,
					label: label
				}
				data.nodes.push(node);
			} else if (element.type === 'edge') {
				// if (element._kind === 'textDocument/hover' || element._kind === 'contains' || element._kind === 'child') {
				// 	return;
				// }
				let edge: VisEdge = {
					from: element.outV as number,
					to: 10, //element.inV as number,
					label: element.label
				}
				data.edges.push(edge)
			}
		},
		end: () => {
			__out.write(JSON.stringify(data, undefined, 4));
		}
	}
}
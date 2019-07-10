/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as path from 'path';

import { URI } from 'vscode-uri';

import { Emitter, Create } from './emitter';
import { Vertex, Edge, VertexLabels } from 'lsif-protocol';
import { Writer } from '../utils/writer';

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

const include: Set<VertexLabels> = new Set([VertexLabels.document, VertexLabels.range, VertexLabels.resultSet, VertexLabels.referenceResult]);
function filterVertex(element: Vertex): boolean {
	return !include.has(element.label);
}

export const create: Create = (writer: Writer): Emitter => {
	let data: VisData = {
		nodes: [],
		edges: []
	};
	return {
		start: () => {

		},
		emit: (element: Vertex | Edge) => {
			if (element.type === 'vertex') {
				if (filterVertex(element)) {
					return;
				}
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
				if (Edge.is11(element)) {
					data.edges.push({
						from: element.outV as number,
						to: element.inV as number,
						label: element.label
					});
				} else {
					for (let inV of element.inVs) {
						data.edges.push({
							from: element.outV as number,
							to: inV as number,
							label: element.label
						});
					}
				}
			}
		},
		end: () => {
			writer.write(JSON.stringify(data, undefined, 4));
		}
	}
}
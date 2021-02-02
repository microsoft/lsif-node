/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import { Emitter, Create } from './emitter';
import { Vertex, Edge, Id, EdgeLabels, ElementTypes } from 'lsif-protocol';
import { Writer } from '../utils/writer';

interface GraphSonProperty {
	id: Id;
	value: string | number | boolean;
}

interface GraphSonPropertyMap {
	[key: string]: GraphSonProperty[];
}

interface GraphSonOutEdge {
	id: Id;
	inV: Id;
	properties?: GraphSonPropertyMap
}

interface GraphSonOutEdgeMap {
	[label: string]: GraphSonOutEdge[];
}

interface GraphSonInEdge {
	id: Id;
	outV: Id;
	properties?: GraphSonPropertyMap;
}

interface GraphSonInEdgeMap {
	[label: string]: GraphSonInEdge[];
}
interface GraphSonVertex {
	id: Id;
	label: string;
	outE?: GraphSonOutEdgeMap,
	inE?: GraphSonInEdgeMap,
	properties?: GraphSonPropertyMap;
}

export const create: Create = (writer: Writer, idGenerator: () => Id): Emitter => {
	let vertices: Map<Id, GraphSonVertex>;
	const labelMap: Map<EdgeLabels, string> = new Map<EdgeLabels, string>([
		[EdgeLabels.item, 'item'],
		[EdgeLabels.contains, 'contains'],
		[EdgeLabels.next, 'next'],
		[EdgeLabels.textDocument_documentSymbol, 'textDocument.documentSymbol'],
		[EdgeLabels.textDocument_foldingRange, 'textDocument.foldingRange'],
		[EdgeLabels.textDocument_diagnostic, 'textDocument.diagnostic'],
		[EdgeLabels.textDocument_documentLink, 'textDocument.documentLink'],
		[EdgeLabels.textDocument_definition, 'textDocument.definition'],
		[EdgeLabels.textDocument_typeDefinition, 'textDocument.typeDefinition'],
		[EdgeLabels.textDocument_hover, 'textDocument.hover'],
		[EdgeLabels.textDocument_references, 'textDocument.references'],
		[EdgeLabels.textDocument_implementation, 'textDocument.implementation'],
	]);
	return {
		start: () => {
			vertices = new Map();
		},
		emit: (element: Vertex | Edge) => {
			if (element.type === ElementTypes.vertex) {
				let gs: GraphSonVertex;
				let values: GraphSonProperty[];
				switch (element.label) {
					case 'project':
						gs = {
							id: element.id,
							label: element.label
						};
						vertices.set(gs.id, gs);
						break;
					case 'document':
						gs = {
							id: element.id,
							label: element.label,
							properties: {
								uri: [ { id: idGenerator(), value: element.uri } ]
							}
						};
						vertices.set(gs.id, gs);
						break;
					case 'resultSet':
						gs = {
							id: element.id,
							label: element.label,
						};
						break;
					case 'range':
						gs = {
							id: element.id,
							label: element.label,
							properties: {
								startLine: [ { id: idGenerator(), value: element.start.line }],
								startCharacter: [ { id: idGenerator(), value: element.start.character } ],
								endLine: [ { id: idGenerator(), value: element.end.line }],
								endCharacter: [ { id: idGenerator(), value: element.end.character }]
							}
						};
						if (element.tag !== undefined) {
							gs.properties!['tag.type'] = [ { id: idGenerator(), value: element.tag.type }];
							if (element.tag.type === 'declaration' || element.tag.type === 'definition') {
								gs.properties!['tag.text'] = [ { id: idGenerator(), value: element.tag.text }];
								gs.properties!['tag.kind'] = [ { id: idGenerator(), value: element.tag.kind }];
							} else if (element.tag.type === 'reference') {
								gs.properties!['tag.text'] = [ { id: idGenerator(), value: element.tag.text }];
							} else if (element.tag.type === 'unknown') {
								gs.properties!['tag.text'] = [ { id: idGenerator(), value: element.tag.text }];
							}
						}
						vertices.set(gs.id, gs);
						break;
					case 'documentSymbolResult':
						gs = {
							id: element.id,
							label: element.label,
						};
						if (element.result) {
							values = [];
							for (let documentSymbol of element.result) {
								values.push({
									id: idGenerator(),
									value: JSON.stringify(documentSymbol, undefined, 0)
								});
							}
							gs.properties = { values };
						}
						vertices.set(gs.id, gs);
						break;
					case 'diagnosticResult':
						gs = {
							id: element.id,
							label: element.label
						};
						if (element.result) {
							values = [];
							for (let diagnostic of element.result) {
								values.push({
									id: idGenerator(),
									value: JSON.stringify(diagnostic, undefined, 0)
								});
							}
							gs.properties = { values };
						}
						vertices.set(gs.id, gs);
						break;
					case 'foldingRangeResult':
						gs = {
							id: element.id,
							label: element.label
						};
						if (element.result) {
							values = [];
							for (let foldingRange of element.result) {
								values.push({
									id: idGenerator(),
									value: JSON.stringify(foldingRange, undefined, 0)
								});
							}
							gs.properties = { values };
						}
						vertices.set(gs.id, gs);
						break;
					case 'hoverResult':
						gs = {
							id: element.id,
							label: element.label,
							properties: {
								contents: [ { id: idGenerator(), value: JSON.stringify(element.result.contents, undefined, 0)}]
							}
						};
						if (element.result.range !== undefined) {
							gs.properties!.range = [ { id: idGenerator(), value: JSON.stringify(element.result.range, undefined, 0)}];
						}
						vertices.set(gs.id, gs);
						break;
					case 'definitionResult':
						gs = {
							id: element.id,
							label: element.label /*,
							properties: {
								result: [ { id: idGenerator(), value: JSON.stringify(element.result, undefined, 0)}]
							}*/
						};
						vertices.set(gs.id, gs);
						break;
					case 'typeDefinitionResult':
						gs = {
							id: element.id,
							label: element.label,
							// properties: {
							// 	result: [ { id: idGenerator(), value: JSON.stringify(element.result, undefined, 0) }]
							// }
						};
						vertices.set(gs.id, gs);
						break;
					case 'referenceResult':
						gs = {
							id: element.id,
							label: element.label,
							properties: {}
						};
						// if (element.declarations) {
						// 	gs.properties!.declarations = [ { id: idGenerator(), value: JSON.stringify(element.declarations, undefined, 0) }];
						// }
						// if (element.references) {
						// 	gs.properties!.references = [ { id: idGenerator(), value: JSON.stringify(element.references, undefined, 0) }];
						// }
						// if (element.referenceResults) {
						// 	gs.properties!.referenceResults = [ { id: idGenerator(), value: JSON.stringify(element.referenceResults, undefined, 0) }];
						// }
						vertices.set(gs.id, gs);
						break;
					case 'implementationResult':
						gs = {
							id: element.id,
							label: element.label,
						};
						// if (element.result) {
						// 	gs.properties =  {
						// 		result: [ { id: idGenerator(), value: JSON.stringify(element.result, undefined, 0) }]
						// 	};
						// }
						vertices.set(gs.id, gs);
						break;
				}
			} else {
				let from: GraphSonVertex | undefined = vertices.get(element.outV);
				let to: GraphSonVertex | undefined; // = vertices.get(element.inV);

				if (from === undefined || to === undefined) {
					// throw new Error(`Outgoing vertex for ${JSON.stringify(element, undefined, 0)} not found.`);
					return;
				}

				let properties: GraphSonPropertyMap | undefined;
				if (element.label === 'item') {
					properties = { };
					if (element.property !== undefined) {
						properties.property = [ { id: idGenerator(), value: element.property } ];
					}
				}

				let label = labelMap.get(element.label);
				if (label === undefined) {
					label = element.label;
				}
				if (from.outE === undefined) {
					from.outE = Object.create(null) as GraphSonOutEdgeMap;
				}
				let outData = from.outE[label];
				if (outData === undefined) {
					outData = [];
					from.outE[label] = outData;
				}
				let outEdge: GraphSonOutEdge = {
					id: element.id,
					inV: 10 // element.inV as any
				};
				if (properties) {
					outEdge.properties = properties;
				}
				outData.push(outEdge);

				if (to.inE === undefined) {
					to.inE = Object.create(null) as GraphSonInEdgeMap;
				}

				let inData = to.inE[label];
				if (inData === undefined) {
					inData = [];
					to.inE[label] = inData;
				}

				let inEdge: GraphSonInEdge = {
					id: element.id,
					outV: element.outV
				};
				if (properties) {
					inEdge.properties = properties;
				}
				inData.push(inEdge);
			}
		},
		end: () => {
			for (let vertex of vertices.values()) {
				writer.writeln(JSON.stringify(vertex, undefined, 0));
			}
		}
	};
};
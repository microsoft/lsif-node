/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as fs from 'fs';

import { Cardinality, Edge, EdgeLabels, ElementTypes, EventKind, EventScope, Id, Range, V, Vertex, VertexDescriptor, VertexLabels } from 'lsif-protocol';

import { Command, DiagnosticReporter } from './command';

export interface ValidateOptions {
}

export class ValidateCommand extends Command {

	private readonly options: ValidateOptions;

	private readonly vertices: Map<Id, VertexLabels>;
	private readonly edges: Map<Id, EdgeLabels>;
	private readonly cardinality: Map<string /* CardinalityKey */, number>;
	private readonly edgeInformation: Map<EdgeLabels, Map<VertexDescriptor<V>, Set<VertexDescriptor<V>>>>;
	private readonly openElements: Set<Id>;
	private readonly closedElements: Set<Id>;
	private readonly associatedRanges: Set<Id>;
	private readonly ranges: Map<Id, Range>;
	private readonly rangesPreDocument: Map<Id, Set<string>>;

	constructor(input: NodeJS.ReadStream | fs.ReadStream | IterableIterator<Edge | Vertex>, options: ValidateOptions, reporter: DiagnosticReporter) {
		super(input, reporter);
		this.options = options;
		this.vertices = new Map();
		this.edges = new Map();
		this.cardinality = new Map();
		this.edgeInformation = new Map();
		this.openElements = new Set();
		this.closedElements = new Set();
		this.associatedRanges = new Set();
		this.ranges = new Map();
		this.rangesPreDocument = new Map();
		this.options;
	}

	protected async process(element: Edge | Vertex ): Promise<void> {
		if (element.type === ElementTypes.edge) {
			// Filter deprecated belongsTo edge
			if ((element.label as string) === 'belongsTo') {
				this.reporter.warn(element);
				this.reporter.warn(element, `edge belongsTo is deprecated`);
				return;
			}
			this.validateEdge(element as Edge);
		} else if (element.type === ElementTypes.vertex) {
			// Filter deprecated group vertex
			if((element.label as string) === 'group') {
				this.reporter.warn(element);
				this.reporter.warn(element, `vertex group is deprecated`);
				return;
			}
			this.validateVertex(element as Vertex);
		}
	}

	private validateVertex(vertex: Vertex): void {
		const descriptor = Vertex.getDescriptor(vertex);
		const valid = descriptor.validate(vertex);
		this.vertices.set(vertex.id, vertex.label);

		let isClosed: Id | undefined = undefined;
		if (valid) {
			if (vertex.label === VertexLabels.event) {
				if (vertex.kind === EventKind.begin) {
					if (this.closedElements.has(vertex.data)) {
						isClosed = vertex.data;
					}
					this.openElements.add(vertex.data);
					if (vertex.scope === EventScope.document) {
						this.rangesPreDocument.set(vertex.data, new Set());
					}
				} else if (vertex.kind === EventKind.end) {
					this.openElements.delete(vertex.data);
					this.closedElements.add(vertex.data);
					if (vertex.scope === EventScope.document) {
						this.rangesPreDocument.delete(vertex.data);
					}
				}
			}
			if (vertex.label === VertexLabels.range) {
				this.ranges.set(vertex.id, vertex);
			}
		}

		if (!valid || isClosed !== undefined) {
			this.reporter.error(vertex);
			if (!valid) {
				this.reporter.error(vertex, 'vertex has invalid property values.');
			}
			if (isClosed !== undefined) {
				this.reporter.error(vertex, `vertex ${isClosed} got already closed and shouldn't be reopened.`);
			}
		}
	}

	private validateEdge(edge: Edge): void {
		this.edges.set(edge.id, edge.label);
		const descriptor = Edge.getDescriptor(edge);
		const valid = descriptor.validate(edge);
		const vertices = this.vertices;
		let hasInVs: boolean = true;
		let sameInVs: boolean = true;
		let verticesEmitted: boolean = true;
		let inOutCorrect: boolean = true;
		let cardinalityCorrect: boolean = true;
		let isOpen: boolean = true;
		let isClosed: boolean = false;
		let freeRanges: Id[] = [];

		if (valid) {
			const referencedVertices: [VertexLabels | undefined, VertexLabels | undefined][] = [];
			if (Edge.is11(edge)) {
				referencedVertices.push([vertices.get(edge.outV), vertices.get(edge.inV)]);
			} else if (Edge.is1N(edge)) {
				const outVertexLabel = vertices.get(edge.outV);
				if (edge.inVs.length === 0) {
					hasInVs = false;
				} else {
					const inVertexLabel = vertices.get(edge.inVs[0]);
					referencedVertices.push([outVertexLabel, inVertexLabel]);
					for (let i = 1; i < edge.inVs.length; i++) {
						const label = vertices.get(edge.inVs[i]);
						if (inVertexLabel !== label) {
							sameInVs = false;
							referencedVertices.push([outVertexLabel, label]);
						}
					}
				}
			}
			for (const item of referencedVertices) {
				if (item[0] === undefined || item[1] === undefined) {
					verticesEmitted = false;
				} else {
					const edgeDescriptions = this.getEdgeDescriptions(edge);
					const validIns = edgeDescriptions.get(Vertex.getDescriptor(item[0]));
					if (validIns === undefined) {
						inOutCorrect = false;
					} else {
						if (!validIns.has(Vertex.getDescriptor(item[1]))) {
							inOutCorrect = false;
						}
					}
				}
			}
			const cardinalityKey: string = JSON.stringify({ k: edge.outV, el: edge.label }, undefined, 0);
			let cardinality = this.cardinality.get(cardinalityKey);
			if (cardinality === undefined) {
				cardinality = 1;
			} else {
				cardinality++;
			}
			this.cardinality.set(cardinalityKey, cardinality);
			if (descriptor.cardinality === Cardinality.one2one && cardinality !== 1) {
				cardinalityCorrect = false;
			}
			if (edge.label === EdgeLabels.contains) {
				const vertexLabel = this.vertices.get(edge.outV);
				if (vertexLabel === VertexLabels.document) {
					const ranges = this.rangesPreDocument.get(edge.outV);
					if (ranges === undefined) {
						this.reporter.error(edge, `edge points to a range vertex for which no document ranges can be found`);
					}
					for (const range of edge.inVs) {
						this.associatedRanges.add(range);
						const rangeVertex = this.ranges.get(range);
						this.ranges.delete(range);
						if (rangeVertex === undefined) {
							this.reporter.error(edge, `edge points to a range vertex that can't be found.`);
							continue;
						}
						if (ranges !== undefined) {
							const key = Range.key(rangeVertex);
							if (ranges.has(key)) {
								this.reporter.error(edge, `a range with [${JSON.stringify(rangeVertex.start)},${JSON.stringify(rangeVertex.end)}] is emitted twice for the document with Id: ${edge.outV}`);
							} else {
								ranges.add(key);
							}
						}
					}

				}
			}
			if (edge.label === EdgeLabels.item) {
				isOpen = this.openElements.has(edge.shard)!!;
				isClosed = this.closedElements.has(edge.shard)!!;
				for (const inV of edge.inVs) {
					const vertexLabel = this.vertices.get(inV);
					if (vertexLabel === VertexLabels.range && !this.associatedRanges.has(inV)) {
						freeRanges.push(inV);
					}
				}
			}
		}
		if (!valid || !sameInVs || !verticesEmitted || !inOutCorrect || !isOpen || !cardinalityCorrect || freeRanges.length > 0) {
			this.reporter.error(edge);
			if (!valid) {
				this.reporter.error(edge, 'edge has invalid property values.');
			}
			if (!verticesEmitted) {
				this.reporter.error(edge, 'references vertices are not emitted yet.');
			}
			if (!hasInVs) {
				this.reporter.error(edge, `inVs property is empty.`);
			}
			if (!sameInVs) {
				this.reporter.error(edge, `vertices referenced via the inVs property are of different types.`);
			}
			if (!inOutCorrect) {
				this.reporter.error(edge, `vertices referenced via the edge are of unsupported type for this edge.`);
			}
			if (!cardinalityCorrect) {
				this.reporter.error(edge, `The cardinality of the edge is 1:1 but the out vertex already has an edge of type ${edge.label}`);
			}
			if (!isOpen) {
				if (isClosed) {
					this.reporter.error(edge, `the vertex referenced via the shard property is already closed.`);
				} else {
					this.reporter.error(edge, `the vertex referenced via the shard property is not open yet.`);
				}
			}
			if (freeRanges.length > 0) {
				this.reporter.error(edge, `the ranges [${freeRanges.join(',')}] referenced via the edge are not associated with a document.`);
			}
		}
	}

	private getEdgeDescriptions(edge: Edge): Map<VertexDescriptor<V>, Set<VertexDescriptor<V>>> {
		let result = this.edgeInformation.get(edge.label);
		if (result !== undefined) {
			return result;
		}
		result = new Map();
		this.edgeInformation.set(edge.label, result);
		const descriptor = Edge.getDescriptor(edge);
		const edgeDescriptions = descriptor.edgeDescriptions;
		for (const description of edgeDescriptions) {
			let inSet = result.get(description[0]);
			if (inSet === undefined) {
				inSet = new Set();
				result.set(description[0], inSet);
			}
			inSet.add(description[1]);
		}
		return result;
	}
}
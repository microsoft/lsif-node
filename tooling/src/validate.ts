/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as fs from 'fs';

import { Edge, EdgeLabels, ElementTypes, Id, V, Vertex, VertexDescriptor, VertexLabels } from 'lsif-protocol';

import { Command } from './command';

export interface ValidateOptions {
}

export class ValidateCommand extends Command {

	private readonly options: ValidateOptions;

	private readonly vertices: Map<Id, VertexLabels>;
	private readonly edges: Map<Id, EdgeLabels>;
	private readonly edgeInformation: Map<EdgeLabels, Map<VertexDescriptor<V>, Set<VertexDescriptor<V>>>>;

	constructor(input: NodeJS.ReadStream | fs.ReadStream, options: ValidateOptions) {
		super(input);
		this.options = options;
		this.vertices = new Map();
		this.edges = new Map();
		this.edgeInformation = new Map();
		this.options;
	}

	protected async process(element: Edge | Vertex ): Promise<void> {
		if (element.type === ElementTypes.edge) {
			this.validateEdge(element as Edge);
		} else if (element.type === ElementTypes.vertex) {
			this.validateVertex(element as Vertex);
		}
	}

	private validateVertex(vertex: Vertex): void {
		this.vertices.set(vertex.id, vertex.label);
		const descriptor = Vertex.getDescriptor(vertex);
		const valid = descriptor.validate(vertex);
		if (!valid) {
			console.log(`Malformed vertex: ${JSON.stringify(vertex, undefined, 0)}`);
			if (!valid) {
				console.log(`\t - vertex has invalid property values.`);
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
		}
		if (!valid || !sameInVs || !verticesEmitted || !inOutCorrect) {
			console.log(`Malformed edge: ${JSON.stringify(edge, undefined, 0)}`);
			if (!valid) {
				console.log(`\t - edge has invalid property values.`);
			}
			if (!verticesEmitted) {
				console.log(`\t- references vertices are not emitted yet.`);
			}
			if (!hasInVs) {
				console.log(`\t- inVs property is empty.`);
			}
			if (!sameInVs) {
				console.log(`\t- vertices referenced via the inVs property are of different types.`);
			}
			if (!inOutCorrect) {
				console.log(`\t- vertices referenced via the edge are of unsupported type for this edge.`);
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
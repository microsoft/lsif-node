/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as fs from 'fs';
import * as readline from 'readline';


import { Edge, Vertex, ElementTypes, VertexLabels, Id, MonikerKind, UniquenessLevel } from 'lsif-protocol';
import { CompressorPropertyDescription, MetaData } from './protocol.compress';
import { Compressor, CompressorProperty, vertexShortForms, edgeShortForms, vertexCompressor, edge11Compressor, itemEdgeCompressor, CompressorOptions, monikerKindShortForms, monikerUniqueShortForms } from './compress';

export abstract class Store {

	protected compressorOptions: CompressorOptions;

	constructor(private input: NodeJS.ReadStream | fs.ReadStream) {
		this.compressorOptions = { mode: 'store' };
	}

	protected setIdTransformer(transformer: (value: Id) => Id): void {
		this.compressorOptions.idTransformer = transformer;
	}

	async run(): Promise<void> {
		return new Promise((resolve, _reject) => {
			const rd = readline.createInterface(this.input);
			rd.on('line', (line) => {
				if (!line) {
					return;
				}
				let element: Edge | Vertex;
				try {
					element = JSON.parse(line);
				} catch (err) {
					console.log(`Parsing failed for line:\n${line}`);
					throw err;
				}
				if (element.type === ElementTypes.vertex && element.label === VertexLabels.metaData) {
					const convertMetaData = (data: CompressorProperty): CompressorPropertyDescription => {
						const result: CompressorPropertyDescription = {
							name: data.name as string,
							index: data.index,
							compressionKind: data.compressionKind
						};
						if (data.shortForm !== undefined) {
							const long: Set<string> = new Set();
							const short: Set<string | number> = new Set();
							result.shortForm = [];
							for (const elem of data.shortForm) {
								const [key, value] = elem;
								if (long.has(key)) {
									throw new Error(`Duplicate key ${key} in short form.`);
								}
								long.add(key);
								if (short.has(value)) {
									throw new Error(`Duplicate value ${value} in short form.`);
								}
								short.add(value);
								result.shortForm.push([key, value]);
							}
						}
						return result;
					};
					const compressors = Compressor.allCompressors();
					if (compressors.length > 0) {
						const compressMetaData: MetaData = element as MetaData;
						compressMetaData.compressors = {
							vertexCompressor: vertexCompressor.id,
							edgeCompressor: edge11Compressor.id,
							itemEdgeCompressor: itemEdgeCompressor.id,
							all: []
						};
						for (let compressor of compressors) {
							compressMetaData.compressors.all.push({
								id: compressor.id,
								parent: compressor.parent !== undefined ? compressor.parent.id : undefined,
								properties: compressor.metaData().map(convertMetaData)
							});
						}
					}
					this.insert(element);
				} else {
					this.insert(element);
				}
			});
			rd.on('close', () => {
				resolve();
			});
		});
	}

	protected abstract insert(element: Vertex | Edge): void;

	protected compress(element: Vertex | Edge): string {
		if (element.type === ElementTypes.vertex && element.label === VertexLabels.metaData) {
			return JSON.stringify(element, undefined, 0);
		}
		let compressor = Compressor.getCompressor(element);
		if (compressor === undefined) {
			throw new Error(`No compressor found for ${element.label}`);
		}
		return JSON.stringify(compressor.compress(element, this.compressorOptions));
	}

	protected transformId(id: Id): Id {
		return this.compressorOptions.idTransformer !== undefined ? this.compressorOptions.idTransformer(id): id;
	}

	protected shortForm(element: Vertex | Edge): number {
		let result: number | undefined;
		if (element.type === ElementTypes.vertex) {
			result = vertexShortForms.get(element.label);
		} else {
			result = edgeShortForms.get(element.label);
		}
		if (result === undefined) {
			throw new Error(`Can't compute short form for ${element.label}`);
		}
		return result;
	}

	protected shortFormMonikerKind(kind: MonikerKind | undefined): number {
		if (kind === undefined) {
			return -1;
		}

		const result = monikerKindShortForms.get(kind);
		return result === undefined ? -1 : result;
	}

	protected shortFormMonikerUnique(level: UniquenessLevel | undefined): number {
		if (level === undefined) {
			return -1;
		}

		const result = monikerUniqueShortForms.get(level);
		return result === undefined ? -1 : result;
	}
}
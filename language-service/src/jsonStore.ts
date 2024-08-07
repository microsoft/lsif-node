/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as readline from 'readline';

import { URI } from 'vscode-uri';
import * as SemVer from 'semver';

import {
	Id, Vertex, Project, Document, Range, DiagnosticResult, DocumentSymbolResult, FoldingRangeResult, DocumentLinkResult, DefinitionResult,
	TypeDefinitionResult, HoverResult, ReferenceResult, ImplementationResult, Edge, RangeBasedDocumentSymbol, DeclarationResult,
	ElementTypes, VertexLabels, EdgeLabels, ItemEdgeProperties, EventScope, EventKind, ProjectEvent, Moniker as PMoniker, MonikerKind,
	types, type MetaData
} from '@vscode/lsif-protocol';

import { DocumentInfo } from './files';
import { Database, UriTransformer } from './database';

interface Moniker extends PMoniker {
	key: string;
}

interface Vertices {
	all: Map<Id, Vertex>;
	projects: Map<Id, Project>;
	documents: Map<Id, Document>;
	ranges: Map<Id, Range>;
}

type ItemTarget =
	Range |
	{ type: ItemEdgeProperties.declarations; range: Range } |
	{ type: ItemEdgeProperties.definitions; range: Range } |
	{ type: ItemEdgeProperties.references; range: Range } |
	{ type: ItemEdgeProperties.referenceResults; result: ReferenceResult } |
	{ type: ItemEdgeProperties.referenceLinks; result: Moniker };

interface Out {
	contains: Map<Id, Document[] | Range[]>;
	item: Map<Id, ItemTarget[]>;
	next: Map<Id, Vertex>;
	moniker: Map<Id, Moniker>;
	documentSymbol: Map<Id, DocumentSymbolResult>;
	foldingRange: Map<Id, FoldingRangeResult>;
	documentLink: Map<Id, DocumentLinkResult>;
	diagnostic: Map<Id, DiagnosticResult>;
	declaration: Map<Id, DeclarationResult>;
	definition: Map<Id, DefinitionResult>;
	typeDefinition: Map<Id, TypeDefinitionResult>;
	hover: Map<Id, HoverResult>;
	references: Map<Id, ReferenceResult>;
	implementation: Map<Id, ImplementationResult>;
}

interface In {
	contains: Map<Id, Project | Document>;
	moniker: Map<Id, Vertex[]>;
}

interface Indices {
	monikers: Map<string, Moniker[]>;
	contents: Map<string, string>;
	documents: Map<string, { hash: string; documents: Document[] }>;
}

interface ResultPath<T> {
	path: { vertex: Id; moniker: Moniker | undefined }[];
	result: { value: T; moniker: Moniker | undefined } | undefined;
}

namespace Locations {
	export function makeKey(location: types.Location): string {
		const range = location.range;
		return crypto.createHash('md5').update(JSON.stringify({ d: location.uri, sl: range.start.line, sc: range.start.character, el: range.end.line, ec: range.end.character }, undefined, 0)).digest('base64');
	}
}

export class JsonStore extends Database {

	private version: string | undefined;
	private workspaceRoot!: URI;
	protected activeProject: Id | undefined;

	private vertices: Vertices;
	private indices: Indices;
	private out: Out;
	private in: In;

	constructor() {
		super();
		this.vertices = {
			all: new Map(),
			projects: new Map(),
			documents: new Map(),
			ranges: new Map()
		};

		this.indices = {
			contents: new Map(),
			documents: new Map(),
			monikers: new Map(),
		};

		this.out = {
			contains: new Map(),
			item: new Map(),
			next: new Map(),
			moniker: new Map(),
			documentSymbol: new Map(),
			foldingRange: new Map(),
			documentLink: new Map(),
			diagnostic: new Map(),
			declaration: new Map(),
			definition: new Map(),
			typeDefinition: new Map(),
			hover: new Map(),
			references: new Map(),
			implementation: new Map()
		};

		this.in = {
			contains: new Map(),
			moniker: new Map()
		};
	}

	public load(file: string, transformerFactory?: (workspaceRoot: string) => UriTransformer): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const input: fs.ReadStream = fs.createReadStream(file, { encoding: 'utf8'});
			input.on('error', reject);
			const rd = readline.createInterface(input);
			rd.on('line', (line: string) => {
				if (!line || line.length === 0) {
					return;
				}
				try {
					const element: Edge | Vertex = JSON.parse(line);
					switch (element.type) {
						case ElementTypes.vertex:
							this.processVertex(element);
							break;
						case ElementTypes.edge:
							this.processEdge(element);
							break;
					}
				} catch (error) {
					input.destroy();
					reject(error);
				}
			});
			rd.on('close', () => {
				if (this.workspaceRoot === undefined) {
					reject(new Error('No project root provided.'));
					return;
				}
				if (this.version === undefined) {
					reject(new Error('No version found.'));
					return;
				} else {
					const semVer = SemVer.parse(this.version);
					if (!semVer) {
						reject(new Error(`No valid semantic version string. The version is: ${this.version}`));
						return;
					}
					const range: SemVer.Range = new SemVer.Range('>=0.5.0 <=0.6.0-next.7');
					range.includePrerelease = true;
					if (!SemVer.satisfies(semVer, range)) {
						reject(new Error(`Requires version range >=0.5.0 <=0.6.0-next.7 but received: ${this.version}`));
						return;
					}
				}
				resolve();
			});
		}).then(() => {
			this.initialize(transformerFactory);
		});
	}

	public getWorkspaceRoot(): URI {
		return this.workspaceRoot;
	}

	public close(): void {
	}

	private processVertex(vertex: Vertex): void {
		interface LegacyMetaData extends MetaData {
			projectRoot?: string;
		}
		this.vertices.all.set(vertex.id, vertex);
		switch(vertex.label) {
			case VertexLabels.metaData:
				this.version = vertex.version;
				if (this.workspaceRoot === undefined && (vertex as LegacyMetaData).projectRoot !== undefined) {
					this.workspaceRoot = URI.parse((vertex as LegacyMetaData).projectRoot!);
				}
				break;
			case VertexLabels.source:
				this.workspaceRoot = URI.parse(vertex.workspaceRoot);
				break;
			case VertexLabels.project:
				this.vertices.projects.set(vertex.id, vertex);
				break;
			case VertexLabels.event:
				if (vertex.kind === EventKind.begin) {
					switch (vertex.scope) {
						case EventScope.project:
							this.activeProject = (vertex as ProjectEvent).data;
							break;
					}
				}
				break;
			case VertexLabels.document:
				this.doProcessDocument(vertex);
				break;
			case VertexLabels.moniker:
				if (vertex.kind !== MonikerKind.local) {
					const key = crypto.createHash('md5').update(JSON.stringify({ s: vertex.scheme, i: vertex.identifier }, undefined, 0)).digest('base64');
					(vertex as Moniker).key = key;
					let values = this.indices.monikers.get(key);
					if (values === undefined) {
						values = [];
						this.indices.monikers.set(key, values);
					}
					values.push(vertex as Moniker);
				}
				break;
			case VertexLabels.range:
				this.vertices.ranges.set(vertex.id, vertex);
				break;
		}
	}

	private doProcessDocument(document: Document): void {
		// Normalize the document uri to the format used in VS Code.
		document.uri = URI.parse(document.uri).toString(true);
		const contents = document.contents !== undefined ? document.contents : 'No content provided.';
		this.vertices.documents.set(document.id, document);
		const hash = crypto.createHash('md5').update(contents).digest('base64');
		this.indices.contents.set(hash, contents);

		let value = this.indices.documents.get(document.uri);
		if (value === undefined) {
			value = { hash, documents: [] };
			this.indices.documents.set(document.uri, value);
		}
		if (hash !== value.hash) {
			console.error(`Document ${document.uri} has different content.`);
		}
		value.documents.push(document);
	}

	private processEdge(edge: Edge): void {
		let property: ItemEdgeProperties | undefined;
		if (edge.label === 'item') {
			property = edge.property;
		}
		if (Edge.is11(edge)) {
			this.doProcessEdge(edge.label, edge.outV, edge.inV, property);
		} else if (Edge.is1N(edge)) {
			for (const inV of edge.inVs) {
				this.doProcessEdge(edge.label, edge.outV, inV, property);
			}
		}
	}

	private doProcessEdge(label: EdgeLabels, outV: Id, inV: Id, property?: ItemEdgeProperties): void {
		const from: Vertex | undefined = this.vertices.all.get(outV);
		const to: Vertex | undefined = this.vertices.all.get(inV);
		if (from === undefined) {
			throw new Error(`No vertex found for Id ${outV}`);
		}
		if (to === undefined) {
			throw new Error(`No vertex found for Id ${inV}`);
		}
		let values: any[] | undefined;
		let itemTarget: ItemTarget | undefined;
		switch (label) {
			case EdgeLabels.contains:
				values = this.out.contains.get(from.id);
				if (values === undefined) {
					values = [ to as any ];
					this.out.contains.set(from.id, values);
				} else {
					values.push(to);
				}
				this.in.contains.set(to.id, from as any);
				break;
			case EdgeLabels.item:
				values = this.out.item.get(from.id);
				if (property !== undefined) {
					switch (property) {
						case ItemEdgeProperties.references:
							itemTarget = { type: property, range: to as Range };
							break;
						case ItemEdgeProperties.declarations:
							itemTarget = { type: property, range: to as Range };
							break;
						case ItemEdgeProperties.definitions:
							itemTarget = { type: property, range: to as Range };
							break;
						case ItemEdgeProperties.referenceResults:
							itemTarget = { type: property, result: to as ReferenceResult };
							break;
						case ItemEdgeProperties.referenceLinks:
							itemTarget = { type: property, result: to as Moniker };
					}
				} else {
					itemTarget = to as Range;
				}
				if (itemTarget !== undefined) {
					if (values === undefined) {
						values = [ itemTarget ];
						this.out.item.set(from.id, values);
					} else {
						values.push(itemTarget);
					}
				}
				break;
			case EdgeLabels.next:
				this.out.next.set(from.id, to);
				break;
			case EdgeLabels.moniker:
				this.out.moniker.set(from.id, to as Moniker);
				values = this.in.moniker.get(to.id);
				if (values === undefined) {
					values = [];
					this.in.moniker.set(to.id, values);
				}
				values.push(from);
				break;
			case EdgeLabels.textDocument_documentSymbol:
				this.out.documentSymbol.set(from.id, to as DocumentSymbolResult);
				break;
			case EdgeLabels.textDocument_foldingRange:
				this.out.foldingRange.set(from.id, to as FoldingRangeResult);
				break;
			case EdgeLabels.textDocument_documentLink:
				this.out.documentLink.set(from.id, to as DocumentLinkResult);
				break;
			case EdgeLabels.textDocument_diagnostic:
				this.out.diagnostic.set(from.id, to as DiagnosticResult);
				break;
			case EdgeLabels.textDocument_definition:
				this.out.definition.set(from.id, to as DefinitionResult);
				break;
			case EdgeLabels.textDocument_typeDefinition:
				this.out.typeDefinition.set(from.id, to as TypeDefinitionResult);
				break;
			case EdgeLabels.textDocument_hover:
				this.out.hover.set(from.id, to as HoverResult);
				break;
			case EdgeLabels.textDocument_references:
				this.out.references.set(from.id, to as ReferenceResult);
				break;
		}
	}

	public getDocumentInfos(): DocumentInfo[] {
		const result: DocumentInfo[] = [];
		this.indices.documents.forEach((value, key) => {
			// We take the id of the first document.
			result.push({ uri: key, id: value.documents[0].id, hash: value.hash });
		});
		return result;
	}

	protected findFile(uri: string): { id: Id; hash: string } | undefined {
		const result = this.indices.documents.get(uri);
		if (result === undefined) {
			return undefined;
		}
		return { id: result.documents[0].id, hash: result.hash };
	}

	protected fileContent(info: { id: Id; hash: string }): string | undefined {
		return this.indices.contents.get(info.hash);
	}

	public foldingRanges(uri: string): types.FoldingRange[] | undefined {
		const value = this.indices.documents.get(this.toDatabase(uri));
		if (value === undefined) {
			return undefined;
		}
		// Take the id of the first document with that content. We assume that
		// all documents with the same content have the same folding ranges.
		const id = value.documents[0].id;
		const foldingRangeResult = this.out.foldingRange.get(id);
		if (foldingRangeResult === undefined) {
			return undefined;
		}
		const result: types.FoldingRange[] = [];
		for (const item of foldingRangeResult.result) {
			result.push(Object.assign(Object.create(null), item));
		}
		return result;
	}

	public documentSymbols(uri: string): types.DocumentSymbol[] | undefined {
		const value = this.indices.documents.get(this.toDatabase(uri));
		if (value === undefined) {
			return undefined;
		}
		// Take the id of the first document with that content. We assume that
		// all documents with the same content have the same document symbols.
		const id = value.documents[0].id;
		const documentSymbolResult = this.out.documentSymbol.get(id);
		if (documentSymbolResult === undefined || documentSymbolResult.result.length === 0) {
			return undefined;
		}
		const first = documentSymbolResult.result[0];
		const result: types.DocumentSymbol[] = [];
		if (types.DocumentSymbol.is(first)) {
			for (const item of documentSymbolResult.result) {
				result.push(Object.assign(Object.create(null), item));
			}
		} else {
			for (const item of (documentSymbolResult.result as RangeBasedDocumentSymbol[])) {
				const converted = this.toDocumentSymbol(item);
				if (converted !== undefined) {
					result.push(converted);
				}
			}
		}
		return result;
	}

	private toDocumentSymbol(value: RangeBasedDocumentSymbol): types.DocumentSymbol | undefined {
		const range = this.vertices.ranges.get(value.id)!;
		const tag = range.tag;
		if (tag === undefined || !(tag.type === 'declaration' || tag.type === 'definition')) {
			return undefined;
		}
		const result: types.DocumentSymbol = types.DocumentSymbol.create(
			tag.text, tag.detail || '', tag.kind,
			tag.fullRange, this.asRange(range)
		);
		if (value.children && value.children.length > 0) {
			result.children = [];
			for (const child of value.children) {
				const converted = this.toDocumentSymbol(child);
				if (converted !== undefined) {
					result.children.push(converted);
				}
			}
		}
		return result;
	}

	public hover(uri: string, position: types.Position): types.Hover | undefined {
		const ranges = this.findRangesFromPosition(this.toDatabase(uri), position);
		if (ranges === undefined) {
			return undefined;
		}

		// We assume that for the same document URI the same position results in the same
		// hover. So we take the first range.
		const range = ranges[0];
		const hoverResult = this.getResultPath(range.id, this.out.hover).result?.value;
		if (hoverResult === undefined) {
			return undefined;
		}

		const hoverRange = hoverResult.result.range !== undefined ? hoverResult.result.range : range;
		return {
			contents: hoverResult.result.contents,
			range: hoverRange
		};
	}

	public declarations(uri: string, position: types.Position): types.Location | types.Location[] | undefined {
		return this.findTargets(uri, position, this.out.declaration);
	}

	public definitions(uri: string, position: types.Position): types.Location | types.Location[] | undefined {
		return this.findTargets(uri, position, this.out.definition);
	}

	private findTargets<T extends (DefinitionResult | DeclarationResult)>(uri: string, position: types.Position, edges: Map<Id, T>): types.Location | types.Location[] | undefined {
		const ranges = this.findRangesFromPosition(this.toDatabase(uri), position);
		if (ranges === undefined) {
			return undefined;
		}

		const resolveTargets = (result: types.Location[], dedupLocations: Set<string>, targetResult: T): void => {
			const ranges = this.item(targetResult);
			if (ranges === undefined) {
				return undefined;
			}
			for (const element of ranges) {
				this.addLocation(result, element, dedupLocations);
			}
		};

		const _findTargets = (result: types.Location[], dedupLocations: Set<string>, dedupMonikers: Set<string>, range: Range): void => {
			const resultPath = this.getResultPath(range.id, edges);
			if (resultPath.result === undefined) {
				return undefined;
			}

			const mostSpecificMoniker = this.getMostSpecificMoniker(resultPath);
			const monikers: Moniker[] = mostSpecificMoniker !== undefined ? [mostSpecificMoniker] : [];

			resolveTargets(result, dedupLocations, resultPath.result.value);
			for (const moniker of monikers) {
				if (dedupMonikers.has(moniker.key)) {
					continue;
				}
				dedupMonikers.add(moniker.key);
				const matchingMonikers = this.indices.monikers.get(moniker.key);
				if (matchingMonikers !== undefined) {
					for (const matchingMoniker of matchingMonikers) {
						const vertices = this.findVerticesForMoniker(matchingMoniker);
						if (vertices !== undefined) {
							for (const vertex of vertices) {
								const resultPath = this.getResultPath(vertex.id, edges);
								if (resultPath.result === undefined) {
									continue;
								}
								resolveTargets(result, dedupLocations, resultPath.result.value);
							}
						}
					}
				}
			}
		};

		const result: types.Location[] = [];
		const dedupLocations: Set<string> = new Set();
		const dedupMonikers: Set<string> = new Set();
		for (const range of ranges) {
			_findTargets(result, dedupLocations, dedupMonikers, range);
		}
		return result;
	}

	public references(uri: string, position: types.Position, context: types.ReferenceContext): types.Location[] | undefined {
		const ranges = this.findRangesFromPosition(this.toDatabase(uri), position);
		if (ranges === undefined) {
			return undefined;
		}

		const findReferences = (result: types.Location[], dedupLocations: Set<string>, dedupMonikers: Set<string>, range: Range): void => {
			const resultPath = this.getResultPath(range.id, this.out.references);
			if (resultPath.result === undefined) {
				return;
			}
			const mostSpecificMoniker = this.getMostSpecificMoniker(resultPath);
			const monikers: Moniker[] = mostSpecificMoniker !== undefined ? [mostSpecificMoniker] : [];
			this.resolveReferenceResult(result, dedupLocations, monikers, resultPath.result.value, context);
			for (const moniker of monikers) {
				if (dedupMonikers.has(moniker.key)) {
					continue;
				}
				dedupMonikers.add(moniker.key);
				const matchingMonikers = this.indices.monikers.get(moniker.key);
				if (matchingMonikers !== undefined) {
					for (const matchingMoniker of matchingMonikers) {
						if (moniker.id === matchingMoniker.id) {
							continue;
						}
						const vertices = this.findVerticesForMoniker(matchingMoniker);
						if (vertices !== undefined) {
							for (const vertex of vertices) {
								const resultPath = this.getResultPath(vertex.id, this.out.references);
								if (resultPath.result === undefined) {
									continue;
								}
								this.resolveReferenceResult(result, dedupLocations, monikers, resultPath.result.value, context);
							}
						}
					}
				}
			}
		};

		const result: types.Location[] = [];
		const dedupLocations: Set<string> = new Set();
		const dedupMonikers: Set<string> = new Set();
		for (const range of ranges) {
			findReferences(result, dedupLocations, dedupMonikers, range);
		}

		return result;
	}

	private getResultPath<T>(start: Id, edges: Map<Id, T>): ResultPath<T> {
		let currentId = start;
		const result: ResultPath<T> = { path: [], result: undefined };
		do {
			const value: T | undefined = edges.get(currentId);
			const moniker: Moniker | undefined = this.out.moniker.get(currentId);
			if (value !== undefined) {
				result.result = { value, moniker };
				return result;
			}
			result.path.push({ vertex: currentId, moniker });
			const next = this.out.next.get(currentId);
			if (next === undefined) {
				return result;
			}
			currentId = next.id;
		} while (true);
	}

	private getMostSpecificMoniker<T>(result: ResultPath<T>): Moniker | undefined {
		if (result.result?.moniker !== undefined) {
			return result.result.moniker;
		}
		for (let i = result.path.length - 1; i >= 0; i--) {
			if (result.path[i].moniker !== undefined) {
				return result.path[i].moniker;
			}
		}
		return undefined;
	}

	private findVerticesForMoniker(moniker: Moniker): Vertex[] | undefined {
		return this.in.moniker.get(moniker.id);
	}

	private resolveReferenceResult(locations: types.Location[], dedupLocations: Set<string>, monikers: Moniker[], referenceResult: ReferenceResult, context: types.ReferenceContext): void {
		const targets = this.item(referenceResult);
		if (targets === undefined) {
			return undefined;
		}
		for (const target of targets) {
			if (target.type === ItemEdgeProperties.declarations && context.includeDeclaration) {
				this.addLocation(locations, target.range, dedupLocations);
			} else if (target.type === ItemEdgeProperties.definitions && context.includeDeclaration) {
				this.addLocation(locations, target.range, dedupLocations);
			} else if (target.type === ItemEdgeProperties.references) {
				this.addLocation(locations, target.range, dedupLocations);
			} else if (target.type === ItemEdgeProperties.referenceResults) {
				this.resolveReferenceResult(locations, dedupLocations, monikers, target.result, context);
			} else if (target.type === ItemEdgeProperties.referenceLinks) {
				monikers.push(target.result);
			}
		}
	}

	private item(value: DefinitionResult | DeclarationResult): Range[];
	private item(value: ReferenceResult): ItemTarget[];
	private item(value: DeclarationResult | DefinitionResult | ReferenceResult): Range[] | ItemTarget[] | undefined {
		if (value.label === 'declarationResult') {
			return this.out.item.get(value.id) as Range[];
		} else if (value.label === 'definitionResult') {
			return this.out.item.get(value.id) as Range[];
		} else if (value.label === 'referenceResult') {
			return this.out.item.get(value.id) as ItemTarget[];
		} else {
			return undefined;
		}
	}

	private addLocation(result: types.Location[], value: Range | types.Location, dedup: Set<string>): void {
		let location: types.Location;
		if (types.Location.is(value)) {
			location = value;
		} else {
			const document = this.in.contains.get(value.id)!;
			location = types.Location.create(this.fromDatabase((document as Document).uri), this.asRange(value));
		}
		const key = Locations.makeKey(location);
		if (!dedup.has(key)) {
			dedup.add(key);
			result.push(location);
		}
	}

	private findRangesFromPosition(file: string, position: types.Position): Range[] | undefined {
		const value = this.indices.documents.get(file);
		if (value === undefined) {
			return undefined;
		}
		const result: Range[] = [];
		for (const document of value.documents) {
			const id = document.id;
			const contains = this.out.contains.get(id);
			if (contains === undefined || contains.length === 0) {
				return undefined;
			}

			let candidate: Range | undefined;
			for (const item of contains) {
				if (item.label !== VertexLabels.range) {
					continue;
				}
				if (JsonStore.containsPosition(item, position)) {
					if (!candidate) {
						candidate = item;
					} else {
						if (JsonStore.containsRange(candidate, item)) {
							candidate = item;
						}
					}
				}
			}
			if (candidate !== undefined) {
				result.push(candidate);
			}
		}
		return result.length > 0 ? result : undefined;
	}

	private static containsPosition(range: types.Range, position: types.Position): boolean {
		if (position.line < range.start.line || position.line > range.end.line) {
			return false;
		}
		if (position.line === range.start.line && position.character < range.start.character) {
			return false;
		}
		if (position.line === range.end.line && position.character > range.end.character) {
			return false;
		}
		return true;
	}

	/**
	 * Test if `otherRange` is in `range`. If the ranges are equal, will return true.
	 */
	public static containsRange(range: types.Range, otherRange: types.Range): boolean {
		if (otherRange.start.line < range.start.line || otherRange.end.line < range.start.line) {
			return false;
		}
		if (otherRange.start.line > range.end.line || otherRange.end.line > range.end.line) {
			return false;
		}
		if (otherRange.start.line === range.start.line && otherRange.start.character < range.start.character) {
			return false;
		}
		if (otherRange.end.line === range.end.line && otherRange.end.character > range.end.character) {
			return false;
		}
		return true;
	}
}
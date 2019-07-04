/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as crypto from 'crypto';
import * as fs from 'fs';

import * as Sqlite from 'better-sqlite3';

import * as uuid from 'uuid';

import * as lsp from 'vscode-languageserver-protocol';
import { Compressor, foldingRangeCompressor, CompressorOptions, diagnosticCompressor } from './compress';

import {
	Edge, Vertex, ElementTypes, VertexLabels, Document, Range, EdgeLabels, contains, Event, EventScope, EventKind, Id, DocumentEvent, FoldingRangeResult,
	RangeBasedDocumentSymbol, DocumentSymbolResult, DiagnosticResult, Moniker, next, ResultSet, moniker, HoverResult, textDocument_hover, textDocument_foldingRange,
	textDocument_documentSymbol, textDocument_diagnostic, MonikerKind, textDocument_declaration, textDocument_definition, textDocument_references, item,
	ItemEdgeProperties, DeclarationResult, DefinitionResult, ReferenceResult
} from 'lsif-protocol';

function assertDefined<T>(value: T | undefined | null): T {
	if (value === undefined || value === null) {
		throw new Error(`Element must be defined`);
	}
	return value;
}

namespace Ranges {
	export function compare(r1: lsp.Range, r2: lsp.Range): number {
		if (r1.start.line < r2.start.line) {
			return -1;
		}
		if (r1.start.line > r2.start.line) {
			return 1;
		}
		if (r1.start.character < r2.start.character) {
			return -1;
		}
		if (r1.start.character > r2.start.character) {
			return 1;
		}
		if (r1.end.line < r2.end.line) {
			return -1;
		}
		if (r1.end.line > r2.end.line) {
			return 1;
		}
		if (r1.end.character < r2.end.character) {
			return -1;
		}
		if (r1.end.character > r2.end.character) {
			return 1;
		}
		return 0;
	}
}

namespace Strings {
	export function compare(s1: string, s2: string): number {
		return ( s1 == s2 ) ? 0 : ( s1 > s2 ) ? 1 : -1;
	}
}

namespace Monikers {
	export function compare(m1: MonikerData, m2: MonikerData): number {
		let result = Strings.compare(m1.identifier, m2.identifier);
		if (result !== 0) {
			return result;
		}
		result = Strings.compare(m1.scheme, m2.scheme);
		if (result !== 0) {
			return result;
		}
		if (m1.kind === m2.kind) {
			return 0;
		}
		const k1 = m1.kind !== undefined ? m1.kind : MonikerKind.import;
		const k2 = m2.kind !== undefined ? m2.kind : MonikerKind.import;
		if (k1 === MonikerKind.import && k2 === MonikerKind.export) {
			return -1;
		}
		if (k1 === MonikerKind.export && k2 === MonikerKind.import) {
			return 1;
		}
		return 0;
	}

	export function isLocal(moniker: MonikerData): boolean {
		return moniker.scheme === '$local';
	}
}

namespace Diagnostics {
	export function compare(d1: lsp.Diagnostic, d2: lsp.Diagnostic): number {
		let result = Ranges.compare(d1.range, d2.range);
		if (result !== 0) {
			return result;
		}
		result = Strings.compare(d1.message, d2.message);
		if (result !== 0) {
			return result;
		}
		return 0;
	}
}

interface LiteralMap<T> {
	[key: string]: T;
	[key: number]: T;
}

namespace LiteralMap {

	export function create<T = any>(): LiteralMap<T> {
		return Object.create(null);
	}

	export function values<T>(map: LiteralMap<T>): T[] {
		let result: T[] = [];
		for (let key of Object.keys(map)) {
			result.push(map[key]);
		}
		return result;
	}
}

interface RangeData extends Pick<Range, 'start' | 'end' | 'tag'> {
	moniker?: Id;
	next?: Id;
	hoverResult?: Id;
	declarationResult?: Id;
	definitionResult?: Id;
	referenceResult?: Id;
}

interface ResultSetData {
	moniker?: Id;
	next?: Id;
	hoverResult?: Id;
	declarationResult?: Id;
	definitionResult?: Id;
	referenceResult?: Id;
}

interface DeclarationResultData {
	values: Id[];
}

interface DefinitionResultData {
	values: Id[];
}

interface ReferenceResultData {
	declarations?: Id[];
	definitions?: Id[];
	references?: Id[];
}

type MonikerData = Pick<Moniker, 'scheme' | 'identifier' | 'kind'>;

interface DocumentBlob {
	contents: string;
	ranges: LiteralMap<RangeData>;
	resultSets?: LiteralMap<ResultSetData>;
	monikers?: LiteralMap<MonikerData>;
	hovers?: LiteralMap<lsp.Hover>;
	declarationResults?: LiteralMap<DeclarationResultData>;
	definitionResults?: LiteralMap<DefinitionResultData>;
	referenceResults?: LiteralMap<ReferenceResultData>;
	foldingRanges?: lsp.FoldingRange[];
	documentSymbols?: lsp.DocumentSymbol[] | RangeBasedDocumentSymbol[];
	diagnostics?: lsp.Diagnostic[];
}

interface DataProvider {
	getResultData(id: Id): ResultSetData | undefined;
	removeResultSetData(id: Id): void;
	getMonikerData(id: Id): MonikerData | undefined;
	removeMonikerData(id: Id): void;
	getHoverData(id: Id): lsp.Hover | undefined;
	getAndDeleteDeclarations(declarationResult: Id, documentId: Id): DeclarationResultData;
	getAndDeleteDefinitions(definitionResult: Id, documentId: Id): DefinitionResultData;
	getAndDeleteReferences(referencResult: Id, documentId: Id): ReferenceResultData;
}

interface DocumentDatabaseData {
	hash: string;
	blob: string;
	declarations?: [number, number, number, number][];
	definitions?: [number, number, number, number][];
	references?: {
		declarations?: [number, number, number, number][];
		definitions?: [number, number, number, number][];
		references?: [number, number, number, number][];
	}
}

class DocumentData {

	private provider: DataProvider;

	private id: Id;
	private _uri: string;
	private blob: DocumentBlob;

	constructor(document: Document, provider: DataProvider) {
		this.provider = provider;
		this.id = document.id;
		this._uri = document.uri;
		this.blob = { contents: document.contents!, ranges: Object.create(null) };
	}

	get uri(): string {
		return this._uri;
	}

	public addRangeData(id: Id, data: RangeData): void {
		this.blob.ranges[id] = data;
		this.addReferencedData(id, data);
	}

	private addResultSetData(id: Id, resultSet: ResultSetData): void {
		if (this.blob.resultSets === undefined) {
			this.blob.resultSets = LiteralMap.create();
		}
		this.blob.resultSets![id] = resultSet;
		this.addReferencedData(id, resultSet);
	}

	private addReferencedData(id: Id, item: RangeData | ResultSetData): void {
		let moniker: MonikerData | undefined;
		if (item.moniker !== undefined) {
			moniker = assertDefined(this.provider.getMonikerData(item.moniker));
			this.addMoniker(item.moniker, moniker);
		}
		if (item.next !== undefined) {
			this.addResultSetData(item.next, assertDefined(this.provider.getResultData(item.next)));
		}
		if (item.hoverResult !== undefined) {
			if (moniker === undefined || Monikers.isLocal(moniker)) {
				this.addHover(item.hoverResult)
			}
		}
		if (item.declarationResult) {
			if (this.blob.declarationResults === undefined) {
				this.blob.declarationResults = LiteralMap.create();
			}
			this.blob.declarationResults[item.declarationResult] = this.provider.getAndDeleteDeclarations(item.declarationResult, this.id);
		}
		if (item.definitionResult) {
			if (this.blob.definitionResults === undefined) {
				this.blob.definitionResults = LiteralMap.create();
			}
			this.blob.definitionResults[item.definitionResult] = this.provider.getAndDeleteDefinitions(item.definitionResult, this.id);
		}
		if (item.referenceResult) {
			if (this.blob.referenceResults === undefined) {
				this.blob.referenceResults = LiteralMap.create();
			}
			this.blob.referenceResults[item.referenceResult] = this.provider.getAndDeleteReferences(item.referenceResult, this.id);
		}
	}

	public addFoldingRangeResult(value: lsp.FoldingRange[]): void {
		this.blob.foldingRanges = value;
	}

	public addDocumentSymbolResult(value: lsp.DocumentSymbol[] | RangeBasedDocumentSymbol[]): void {
		this.blob.documentSymbols = value;
	}

	public addDiagnostics(value: lsp.Diagnostic[]): void {
		this.blob.diagnostics = value;
	}

	private addMoniker(id: Id, moniker: MonikerData): void {
		if (this.blob.monikers === undefined) {
			this.blob.monikers = LiteralMap.create();
		}
		this.blob.monikers![id] = moniker;
	}

	private addHover(id: Id): void {
		if (this.blob.hovers === undefined) {
			this.blob.hovers = LiteralMap.create();
		}
		this.blob.hovers![id] = assertDefined(this.provider.getHoverData(id));
	}

	public finalize(): DocumentDatabaseData {
		return {
			hash: this.computeHash(),
			blob: JSON.stringify(this.blob, undefined, 0),
		}
	}

	private computeHash(): string {
		const hash = crypto.createHash('md5');
		hash.update(this.blob.contents);
		const options: CompressorOptions = { mode: 'hash' };
		const compressor = assertDefined(Compressor.getVertexCompressor(VertexLabels.range));
		const rangeHashes: Map<Id, string> = new Map();
		for (let key of Object.keys(this.blob.ranges)) {
			const range = this.blob.ranges[key];
			const rangeHash = crypto.createHash('md5').update(JSON.stringify(compressor.compress(range, options), undefined, 0)).digest('base64');
			rangeHashes.set(Number(key), rangeHash);
		}
		for (let item of Array.from(rangeHashes.values()).sort(Strings.compare)) {
			hash.update(item);
		}

		// moniker
		if (this.blob.monikers !== undefined) {
			const monikers = LiteralMap.values(this.blob.monikers).sort(Monikers.compare);
			const compressor = assertDefined(Compressor.getVertexCompressor(VertexLabels.moniker));
			for (let moniker of monikers) {
				const compressed = compressor.compress(moniker, options);
				hash.update(JSON.stringify(compressed, undefined, 0));
			}
		}

		// Assume that folding ranges are already sorted
		if (this.blob.foldingRanges) {
			const compressor = foldingRangeCompressor;
			for (let range of this.blob.foldingRanges) {
				const compressed = compressor.compress(range, options);
				hash.update(JSON.stringify(compressed, undefined, 0))
			}
		}
		// Unsure if we need to sort the children by range or not?
		if (this.blob.documentSymbols && this.blob.documentSymbols.length > 0) {
			const first = this.blob.documentSymbols[0];
			const compressor = lsp.DocumentSymbol.is(first) ? undefined : assertDefined(Compressor.getVertexCompressor(VertexLabels.range));
			if (compressor === undefined) {
				throw new Error(`Document symbol compression not supported`);
			}
			const inline = (result: any[], value: RangeBasedDocumentSymbol) => {
				const item: any[] = [];
				const rangeHash = assertDefined(rangeHashes.get(value.id));
				item.push(rangeHash);
				if (value.children && value.children.length > 0) {
					const children: any[] = [];
					for (let child of value.children) {
						inline(children, child);
					}
					item.push(children);
				}
				result.push(item);
			}
			let compressed: any[] = [];
			for (let symbol of (this.blob.documentSymbols as RangeBasedDocumentSymbol[])) {
				inline(compressed, symbol);
			}
			hash.update(JSON.stringify(compressed, undefined, 0));
		}

		// Diagnostics
		if (this.blob.diagnostics && this.blob.diagnostics.length > 0) {
			this.blob.diagnostics = this.blob.diagnostics.sort(Diagnostics.compare);
			const compressor = diagnosticCompressor;
			for (let diagnostic of this.blob.diagnostics) {
				let compressed = compressor.compress(diagnostic, options);
				hash.update(JSON.stringify(compressed, undefined, 0));
			}
		}

		return hash.digest('base64');
	}
}

export class Database implements DataProvider {

	private db: Sqlite.Database;
	private insertBlobStatement: Sqlite.Statement;
	private insertDocumentStatement: Sqlite.Statement;
	private insertVersionStatement: Sqlite.Statement;


	private documents: Map<Id, Document>;
	private documentDatas: Map<Id, DocumentData | null>;

	private foldingRanges: Map<Id, lsp.FoldingRange[]>;
	private documentSymbols: Map<Id, lsp.DocumentSymbol[] | RangeBasedDocumentSymbol[]>;
	private diagnostics: Map<Id, lsp.Diagnostic[]>;

	private rangeDatas: Map<Id, RangeData>;
	private resultSetDatas: Map<Id, ResultSetData>;
	private monikerDatas: Map<Id, MonikerData>;
	private hoverDatas: Map<Id, lsp.Hover>;
	private declarationDatas: Map<Id /* result id */, Map<Id /* document id */, DeclarationResultData>>;
	private definitionDatas: Map<Id /* result id */, Map<Id /* document id */, DefinitionResultData>>;
	private referenceDatas: Map<Id /* result id */, Map<Id /* document id */, ReferenceResultData>>;

	private containsDatas: Map<Id, Id[]>;

	constructor(filename: string) {
		this.documents = new Map();

		this.documentDatas = new Map();

		this.foldingRanges = new Map();
		this.documentSymbols = new Map();
		this.diagnostics = new Map();

		this.rangeDatas = new Map();
		this.resultSetDatas = new Map();
		this.monikerDatas = new Map();
		this.hoverDatas = new Map();
		this.declarationDatas = new Map();
		this.definitionDatas = new Map();
		this.referenceDatas = new Map();
		this.containsDatas = new Map();

		try {
			fs.unlinkSync(filename);
		} catch (err) {
		}
		this.db = new Sqlite(filename);
		this.db.pragma('synchronous = OFF');
		this.db.pragma('journal_mode = MEMORY');
		this.createTables();
		this.insertBlobStatement = this.db.prepare('Insert Into blobs (documentId, content) VALUES (?, ?)');
		this.insertDocumentStatement = this.db.prepare('Insert Into documents (documentId, uri) VALUES (?, ?)');
		this.insertVersionStatement = this.db.prepare('Insert Into versions (versionId, documentId) VALUES (?, ?)');
	}

	private createTables(): void {
		this.db.exec('Create Table blobs (documentId Text Unique Primary Key, content Blob Not Null)');
		this.db.exec('Create Table documents (documentId Text Not Null, uri Text Not Null)');
		this.db.exec('Create Table versions (versionId Text Not Null, documentId Text Not Null)');
		this.db.exec('Create Table decls (scheme Text Not Null, identifier Text Not Null, documentId Text Not Null, ranges Blob Not Null)');
		this.db.exec('Create Table defs (scheme Text Not Null, identifier Text Not Null, documentId Text Not Null, ranges Blob Not Null)');
		this.db.exec('Create Table refs (scheme Text Not Null, identifier Text Not Null, documentId Text Not Null, ranges Blob Not Null)');
	}

	private createIndices(): void {
		this.db.exec('Create Index _blobs on blobs (documentId)');
		this.db.exec('Create Index _documents on documents (documentId)');
		this.db.exec('Create Index _versions on versions (versionId)');
		this.db.exec('Create Index _decls on decls (identifier, scheme, documentId)');
		this.db.exec('Create Index _defs on defs (identifier, scheme, documentId)');
		this.db.exec('Create Index _refs on refs (identifier, scheme, documentId)');
	}

	public insert(element: Edge | Vertex): void {
		if (element.type === ElementTypes.vertex) {
			switch(element.label) {
				case VertexLabels.document:
					this.documents.set(element.id, element);
					break;
				case VertexLabels.range:
					this.handleRange(element);
					break;
				case VertexLabels.resultSet:
					this.handleResultSet(element);
					break;
				case VertexLabels.moniker:
					this.handleMoniker(element);
					break;
				case VertexLabels.hoverResult:
					this.handleHover(element);
					break;
				case VertexLabels.declarationResult:
					this.handleDeclarationResult(element);
					break;
				case VertexLabels.definitionResult:
					this.handleDefinitionResult(element);
					break;
				case VertexLabels.referenceResult:
					this.handleReferenceResult(element);
					break;
				case VertexLabels.foldingRangeResult:
					this.handleFoldingRange(element);
					break;
				case VertexLabels.documentSymbolResult:
					this.handleDocumentSymbols(element);
					break;
				case VertexLabels.diagnosticResult:
					this.handleDiagnostics(element);
					break;
				case VertexLabels.event:
					this.handleEvent(element);
					break;
			}
		} else if (element.type === ElementTypes.edge) {
			switch(element.label) {
				case EdgeLabels.next:
					this.handleNextEdge(element);
					break;
				case EdgeLabels.moniker:
					this.handleMonikerEdge(element)
					break;
				case EdgeLabels.textDocument_foldingRange:
					this.handleFoldingRangeEdge(element);
					break;
				case EdgeLabels.textDocument_documentSymbol:
					this.handleDocumentSymbolEdge(element);
					break;
				case EdgeLabels.textDocument_diagnostic:
					this.handleDiagnosticsEdge(element);
					break;
				case EdgeLabels.textDocument_hover:
					this.handleHoverEdge(element);
					break;
				case EdgeLabels.textDocument_declaration:
					this.handleDeclarationEdge(element);
					break;
				case EdgeLabels.textDocument_definition:
					this.handleDefinitionEdge(element);
					break;
				case EdgeLabels.textDocument_references:
					this.handleReferenceEdge(element);
					break;
				case EdgeLabels.item:
					this.handleItemEdge(element);
					break;
				case EdgeLabels.contains:
					this.handleContains(element);
					break;
			}
		}
	}

	public getResultData(id: Id): ResultSetData | undefined {
		return this.resultSetDatas.get(id);
	}

	public removeResultSetData(id: Id): void {
		this.resultSetDatas.delete(id);
	}

	public getMonikerData(id: Id): MonikerData | undefined {
		return this.monikerDatas.get(id);
	}

	public removeMonikerData(id: Id): void {
		this.monikerDatas.delete(id);
	}

	public getHoverData(id: Id): lsp.Hover | undefined {
		return this.hoverDatas.get(id);
	}

	public getAndDeleteDeclarations(declaratinResult: Id, documentId: Id): DeclarationResultData {
		const map = assertDefined(this.declarationDatas.get(declaratinResult));
		const result = map.get(documentId) || { values: [] };
		map.delete(documentId);
		return result;
	}

	public getAndDeleteDefinitions(definitionResult: Id, documentId: Id): DefinitionResultData {
		const map = assertDefined(this.definitionDatas.get(definitionResult));
		const result = map.get(documentId) || { values: [] };
		map.delete(documentId);
		return result;
	}

	public getAndDeleteReferences(referenceResult: Id, documentId: Id): ReferenceResultData {
		const map = assertDefined(this.referenceDatas.get(referenceResult));
		const result = map.get(documentId) || {};
		map.delete(documentId);
		return result;
	}

	public runInsertTransaction(cb: (db: Database) => void): void {
		cb(this);
	}

	public close(): void {
		this.createIndices();
		this.db.close();
	}

	private handleEvent(event: Event): void {
		if (event.scope === EventScope.project) {

		} else if (event.scope === EventScope.document) {
			let documentEvent = event as DocumentEvent;
			switch (event.kind) {
				case EventKind.begin:
					this.handleDocumentBegin(documentEvent);
					break;
				case EventKind.end:
					this.handleDocumentEnd(documentEvent);
					break;
			}
		}
	}

	private handleDocumentBegin(event: DocumentEvent) {
		const document = this.documents.get(event.data);
		if (document === undefined) {
			throw new Error(`Document with id ${event.data} not known`);
		}
		this.getOrCreateDocumentData(document);
		this.documents.delete(event.data);
	}

	private handleRange(range: Range): void {
		let data: RangeData = { start: range.start, end: range.end, tag: range.tag };
		this.rangeDatas.set(range.id, data);
	}

	private handleResultSet(set: ResultSet): void {
		let data: ResultSetData = {};
		this.resultSetDatas.set(set.id, data);
	}

	private handleMoniker(moniker: Moniker): void {
		let data: MonikerData = { scheme: moniker.scheme, identifier: moniker.identifier, kind: moniker.kind };
		this.monikerDatas.set(moniker.id, data);
	}

	private handleMonikerEdge(moniker: moniker): void {
		const source: RangeData | ResultSetData = assertDefined(this.rangeDatas.get(moniker.outV) || this.resultSetDatas.get(moniker.outV));
		assertDefined(this.monikerDatas.get(moniker.inV));
		source.moniker = moniker.inV;
	}

	private handleHover(hover: HoverResult): void {
		this.hoverDatas.set(hover.id, hover.result);
	}

	private handleHoverEdge(edge: textDocument_hover): void {
		const outV: RangeData | ResultSetData = assertDefined(this.rangeDatas.get(edge.outV) || this.resultSetDatas.get(edge.outV));
		assertDefined(this.hoverDatas.get(edge.inV));
		outV.hoverResult = edge.inV;
	}

	private handleDeclarationResult(result: DeclarationResult): void {
		this.declarationDatas.set(result.id, new Map());
	}

	private handleDeclarationEdge(edge: textDocument_declaration): void {
		const outV: RangeData | ResultSetData = assertDefined(this.rangeDatas.get(edge.outV) || this.resultSetDatas.get(edge.outV));
		this.ensureMoniker(outV);
		assertDefined(this.declarationDatas.get(edge.inV));
		outV.declarationResult = edge.inV;
	}

	private handleDefinitionResult(result: DefinitionResult): void {
		this.definitionDatas.set(result.id, new Map());
	}

	private handleDefinitionEdge(edge: textDocument_definition): void {
		const outV: RangeData | ResultSetData = assertDefined(this.rangeDatas.get(edge.outV) || this.resultSetDatas.get(edge.outV));
		this.ensureMoniker(outV);
		assertDefined(this.definitionDatas.get(edge.inV));
		outV.definitionResult = edge.inV;
	}

	private handleReferenceResult(result: ReferenceResult): void {
		this.referenceDatas.set(result.id, new Map());
	}

	private handleReferenceEdge(edge: textDocument_references): void {
		const outV: RangeData | ResultSetData = assertDefined(this.rangeDatas.get(edge.outV) || this.resultSetDatas.get(edge.outV));
		this.ensureMoniker(outV);
		assertDefined(this.referenceDatas.get(edge.inV));
		outV.referenceResult = edge.inV;
	}

	private ensureMoniker(data: RangeData | ResultSetData): void {
		if (data.moniker !== undefined) {
			return;
		}
		const monikerData: MonikerData = { scheme: '$synthetic', identifier: uuid.v4() };
		data.moniker = monikerData.identifier;
		this.monikerDatas.set(monikerData.identifier, monikerData);
	}

	// private lookupMoniker(id: Id): MonikerData | undefined {
	// 	let data = this.rangeDatas.get(id) || this.resultSetDatas.get(id);
	// 	if (data === undefined  || data.moniker === undefined) {
	// 		return undefined;
	// 	}
	// 	return this.monikerDatas.get(data.moniker);
	// }

	private handleItemEdge(edge: item): void {
		let property: ItemEdgeProperties | undefined = edge.property;
		if (property === undefined) {
			const map: Map<Id, DefinitionResultData> | Map<Id, DeclarationResultData> = assertDefined(this.declarationDatas.get(edge.outV) || this.definitionDatas.get(edge.outV));
			let data: DefinitionResultData | DeclarationResultData | undefined = map.get(edge.document);
			if (data === undefined) {
				data = { values: edge.inVs.slice() };
				map.set(edge.document, data);
			} else {
				data.values.push(...edge.inVs);
			}
		} else {
			const map: Map<Id, ReferenceResultData> = assertDefined(this.referenceDatas.get(edge.outV));
			let data: ReferenceResultData | undefined = map.get(edge.document);
			if (data === undefined) {
				data = {};
				map.set(edge.document, data);
			}
			switch (property) {
				case ItemEdgeProperties.declarations:
					if (data.declarations === undefined) {
						data.declarations = edge.inVs.slice();
					} else {
						data.declarations.push(...edge.inVs);
					}
					break;
				case ItemEdgeProperties.definitions:
					if (data.definitions === undefined) {
						data.definitions = edge.inVs.slice();
					} else {
						data.definitions.push(...edge.inVs);
					}
					break;
				case ItemEdgeProperties.references:
					if (data.references === undefined) {
						data.references = edge.inVs.slice();
					} else {
						data.references.push(...edge.inVs);
					}
					break;
			}
		}
	}

	private handleFoldingRange(folding: FoldingRangeResult): void {
		this.foldingRanges.set(folding.id, folding.result);
	}

	private handleFoldingRangeEdge(edge: textDocument_foldingRange): void {
		const source = assertDefined(this.getDocumentData(edge.outV));
		source.addFoldingRangeResult(assertDefined(this.foldingRanges.get(edge.inV)));
	}

	private handleDocumentSymbols(symbols: DocumentSymbolResult): void {
		this.documentSymbols.set(symbols.id, symbols.result);
	}

	private handleDocumentSymbolEdge(edge: textDocument_documentSymbol): void {
		const source = assertDefined(this.getDocumentData(edge.outV));
		source.addDocumentSymbolResult(assertDefined(this.documentSymbols.get(edge.inV)));
	}

	private handleDiagnostics(diagnostics: DiagnosticResult): void {
		this.diagnostics.set(diagnostics.id, diagnostics.result);
	}

	private handleDiagnosticsEdge(edge: textDocument_diagnostic): void {
		const source = assertDefined(this.getDocumentData(edge.outV));
		source.addDiagnostics(assertDefined(this.diagnostics.get(edge.inV)));
	}

	private handleNextEdge(edge: next): void {
		const outV: RangeData | ResultSetData = assertDefined(this.rangeDatas.get(edge.outV) || this.resultSetDatas.get(edge.outV));
		assertDefined(this.resultSetDatas.get(edge.inV));
		outV.next = edge.inV;
	}

	private handleContains(contains: contains): boolean {
		let values = this.containsDatas.get(contains.outV);
		if (values === undefined) {
			values = [];
			this.containsDatas.set(contains.outV, values);
		}
		values.push(...contains.inVs);
		return true;
	}

	private handleDocumentEnd(event: DocumentEvent) {
		const documentData = this.getEnsureDocumentData(event.data);
		const contains = this.containsDatas.get(event.data);
		if (contains !== undefined) {
			for (let id of contains) {
				const range = assertDefined(this.rangeDatas.get(id));
				documentData.addRangeData(id, range);
			}
		}
		let data = documentData.finalize();
		this.insertBlobStatement.run(data.hash, data.blob);
		this.insertDocumentStatement.run(data.hash, documentData.uri);
		this.insertVersionStatement.run('v1', data.hash);
		this.documentDatas.set(event.id, null);
	}

	private getOrCreateDocumentData(document: Document): DocumentData {
		let result: DocumentData | undefined | null = this.documentDatas.get(document.id);
		if (result === null) {
			throw new Error(`The document ${document.uri} has already been processed`);
		}
		result = new DocumentData(document, this);
		this.documentDatas.set(document.id, result);
		return result;
	}

	private getDocumentData(id: Id): DocumentData | undefined {
		let result: DocumentData | undefined | null = this.documentDatas.get(id);
		if (result === null) {
			throw new Error(`The document with Id ${id} has already been processed.`);
		}
		return result;
	}

	private getEnsureDocumentData(id: Id): DocumentData {
		let result: DocumentData | undefined | null = this.documentDatas.get(id);
		if (result === undefined) {
			throw new Error(`No document data found for id ${id}`);
		}
		if (result === null) {
			throw new Error(`The document with Id ${id} has already been processed.`);
		}
		return result;
	}
}
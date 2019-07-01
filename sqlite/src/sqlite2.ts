/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as crypto from 'crypto';
// import * as fs from 'fs';

// import * as Sqlite from 'better-sqlite3';

import * as lsp from 'vscode-languageserver-protocol';

import {
	Edge, Vertex, ElementTypes, VertexLabels, Document, Range, EdgeLabels, contains, Event, EventScope, EventKind, Id, DocumentEvent, FoldingRangeResult,
	RangeBasedDocumentSymbol, DocumentSymbolResult, DiagnosticResult, Moniker, next, ResultSet, moniker, HoverResult, textDocument_hover, textDocument_foldingRange, textDocument_documentSymbol, textDocument_diagnostic, RangeTagTypes
} from 'lsif-protocol';

function assertDefined<T>(value: T | undefined | null): T {
	if (value === undefined || value === null) {
		throw new Error(`Element must be defined`);
	}
	return value;
}

function isLocalMoniker(moniker: MonikerData): boolean {
	return moniker.scheme === '$local';
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
	export function hash(hash: crypto.Hash, range: Range): void {
		const values: any[] = [];
		values.push(range.start.line, range.start.character, range.end.line, range.end.character);
		if (range.tag !== undefined) {
			values.push(range.tag.type, range.tag.text);
			if (range.tag.type === RangeTagTypes.definition || range.tag.type === RangeTagTypes.declaration) {
				let fullRange = range.tag.fullRange;
				let fullRangeValue: any[] = [];
				fullRangeValue.push(fullRange.start.line, fullRange.start.character, fullRange.end.line, fullRange.end.character);
				values.push(range.tag.kind, !!range.tag.deprecated, fullRangeValue, range.tag.detail !== undefined ? range.tag.detail : '');
			}
		} else {
			values.push(null);
		}
		hash.update(JSON.stringify(values, undefined, 0));
	}
}

namespace Strings {
	export function compare(s1: string, s2: string): number {
		return ( s1 == s2 ) ? 0 : ( s1 > s2 ) ? 1 : -1;
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

	export function hash(hash: crypto.Hash, diag: lsp.Diagnostic): void {

	}

}

interface LiteralMap<T> {
	[key: string]: T;
	[key: number]: T;
}

interface DocumentBlob {
	contents: string;
	ranges: LiteralMap<RangeData>;
	resultSets?: LiteralMap<ResultSetData>;
	monikers?: LiteralMap<MonikerData>;
	hovers?: LiteralMap<lsp.Hover>;
	foldingRanges?: lsp.FoldingRange[];
	documentSymbols?: lsp.DocumentSymbol[] | RangeBasedDocumentSymbol[];
	diagnostics?: lsp.Diagnostic[];
}

interface RangeData extends Pick<Range, 'start' | 'end' | 'tag'> {
	declarationResult?: Id[];
	definitionResult?: Id[]
	referenceResult?: Id[];
	hoverResult?: Id;
	moniker?: Id;
	next?: Id;
}

interface ResultSetData {
	declarationResult?: Id[];
	definitionResult?: Id[]
	referenceResult?: Id[];
	hoverResult?: Id;
	moniker?: Id;
	next?: Id;
}

type MonikerData = Pick<Moniker, 'scheme' | 'identifier' | 'kind'>;

interface DataProvider {
	getResultData(id: Id): ResultSetData | undefined;
	removeResultSetData(id: Id): void;
	getMonikerData(id: Id): MonikerData | undefined;
	removeMonikerData(id: Id): void;
	getHoverData(id: Id): lsp.Hover | undefined;
}

class DocumentData {

	private provider: DataProvider;
	private blob: DocumentBlob;

	private Ids: Set<Id>;
	private documentSymbolResult: DocumentSymbolResult | undefined;

	constructor(document: Document, provider: DataProvider) {
		this.provider = provider;
		this.blob = { contents: document.contents!, ranges: Object.create(null) };

		this.Ids = new Set();
	}

	public clearCache(vertexCache: Map<Id, Vertex>): void {
		for (let id of this.Ids.values()) {
			vertexCache.delete(id);
		}
	}

	public addRangeData(id: Id, data: RangeData): void {
		this.blob.ranges[id] = data;
		let moniker: MonikerData | undefined;
		if (data.moniker !== undefined) {
			moniker = assertDefined(this.provider.getMonikerData(data.moniker))
			this.addMoniker(data.moniker, moniker);
		}
		if (data.next !== undefined) {
			this.addResultSetData(data.next, assertDefined(this.provider.getResultData(data.next)));
		}
		if (data.hoverResult !== undefined) {
			if (moniker === undefined || isLocalMoniker(moniker)) {
				this.addHover(data.hoverResult)
			}
		}
	}

	private addResultSetData(id: Id, resultSet: ResultSetData): void {
		if (this.blob.resultSets === undefined) {
			this.blob.resultSets = Object.create(null);
		}
		this.blob.resultSets![id] = resultSet;

		let moniker: MonikerData | undefined;
		if (resultSet.moniker !== undefined) {
			moniker = assertDefined(this.provider.getMonikerData(resultSet.moniker));
			this.addMoniker(resultSet.moniker, moniker);
		}
		if (resultSet.next !== undefined) {
			this.addResultSetData(resultSet.next, assertDefined(this.provider.getResultData(resultSet.next)));
		}
		if (resultSet.hoverResult !== undefined) {
			if (moniker === undefined || isLocalMoniker(moniker)) {
				this.addHover(resultSet.hoverResult)
			}
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
			this.blob.monikers = Object.create(null);
		}
		this.blob.monikers![id] = moniker;
	}

	private addHover(id: Id): void {
		if (this.blob.hovers === undefined) {
			this.blob.hovers = Object.create(null);
		}
		this.blob.hovers![id] = assertDefined(this.provider.getHoverData(id));
	}

	public finalize(): string {
		if (this.documentSymbolResult !== undefined) {
			for (let item of this.documentSymbolResult.result) {
				if (!lsp.DocumentSymbol.is(item)) {
					this.validateDocumentSymbols(item);
				}
			}
		}
		return this.computeHash();
	}

	private validateDocumentSymbols(value: RangeBasedDocumentSymbol): void {
		if (!this.Ids.has(value.id)) {
			throw Error(`Range based document symbol result refers to unknown range ${value.id}`);
		}
		if (value.children !== undefined) {
			for (let child of value.children) {
				this.validateDocumentSymbols(child);
			}
		}
	}

	private computeHash(): string {
		let hash = crypto.createHash('md5');
		hash.write(this.blob.contents);
		// Assume that folding ranges are already sorted
		if (this.blob.foldingRanges) {
			hash.write(JSON.stringify(this.blob.foldingRanges, undefined, 0));
		}
		return hash.digest('base64');
	}

	private sortDiagnostics(): void {
		if (this.blob.diagnostics === undefined) {
			return;
		}
		this.blob.diagnostics = this.blob.diagnostics.sort(Diagnostics.compare);
	}
}

export class Database implements DataProvider {

	private documents: Map<Id, Document>;

	private documentDatas: Map<Id, DocumentData | null>;

	private foldingRanges: Map<Id, lsp.FoldingRange[]>;
	private documentSymbols: Map<Id, lsp.DocumentSymbol[] | RangeBasedDocumentSymbol[]>;
	private diagnostics: Map<Id, lsp.Diagnostic[]>;


	private rangeDatas: Map<Id, RangeData>;
	private resultSetDatas: Map<Id, ResultSetData>;
	private monikerDatas: Map<Id, MonikerData>;
	private hoverDatas: Map<Id, lsp.Hover>;

	constructor() {
		this.documents = new Map();

		this.documentDatas = new Map();

		this.foldingRanges = new Map();
		this.documentSymbols = new Map();
		this.diagnostics = new Map();

		this.rangeDatas = new Map();
		this.resultSetDatas = new Map();
		this.monikerDatas = new Map();
		this.hoverDatas = new Map();
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
				case EdgeLabels.textDocument_hover:
					this.handleHoverEdge(element);
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
				case EdgeLabels.contains:
					if (!this.handleDocumentContains(element)) {
						this.handleProjectContains(element);
					}
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

	public runInsertTransaction(cb: (db: Database) => void): void {
		cb(this);
	}

	public close(): void {
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

	private handleDocumentEnd(event: DocumentEvent) {
		let documentData = this.getEnsureDocumentData(event.data);
		console.log(documentData.finalize());
		// Insert into DB
		this.documentDatas.set(event.id, null);
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

	private handleDocumentContains(contains: contains): boolean {
		let documentData = this.getDocumentData(contains.outV);
		if (documentData === undefined) {
			return false;
		}
		for (let inV of contains.inVs) {
			const data = assertDefined(this.rangeDatas.get(inV));
			documentData.addRangeData(inV, data)
		}
		return true;
	}

	private handleProjectContains(contains: contains): boolean {
		return true;
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
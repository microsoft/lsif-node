/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as crypto from 'crypto';
import * as fs from 'fs';

import * as Sqlite from 'better-sqlite3';

import * as lsp from 'vscode-languageserver-protocol';

import { Edge, Vertex, ElementTypes, VertexLabels, Document, Range, Project, MetaData, EdgeLabels, contains, PackageInformation, item, Event, EventScope, EventKind, Id, DocumentEvent, FoldingRangeResult, RangeBasedDocumentSymbol, DocumentSymbolResult, DiagnosticResult } from 'lsif-protocol';


type VertexCopy = { id: Id | undefined };

interface DocumentBlob {
	contents: string;
	ranges: [number, number, number, number][];
	foldingRanges?: lsp.FoldingRange[];
	documentSymbols?: lsp.DocumentSymbol[] | RangeBasedDocumentSymbol[];
	diagnostics: lsp.Diagnostic[];
}

class DocumentData {

	private blob: DocumentBlob;

	private Ids: Set<Id>;
	private documentSymbolResult: DocumentSymbolResult | undefined;

	constructor(document: Document) {
		this.blob = { contents: document.contents!, ranges: [] };

		this.Ids = new Set();
	}

	public clearCache(vertexCache: Map<Id, Vertex>): void {
		for (let id of this.Ids.values()) {
			vertexCache.delete(id);
		}
	}

	public addRanges(ranges: Range[]): void {
		for (let range of ranges) {
			this.Ids.add(range.id);
			this.blob.ranges.push([range.start.line, range.start.character, range.end.line, range.end.character]);
		}
	}

	public addFoldingRangeResult(value: FoldingRangeResult): void {
		this.Ids.add(value.id);
		this.blob.foldingRanges = value.result;
	}

	public addDocumentSymbolResult(value: DocumentSymbolResult): void {
		this.Ids.add(value.id);
		this.blob.documentSymbols = value.result;
	}

	public addDiagnostics(value: DiagnosticResult): void {
		this.
		this.data.push(value);
		const copy = Object.assign(Object.create(null), value) as VertexCopy;
		copy.id = undefined;
		this.hash.update(JSON.stringify(copy));
	}

	public finalize(): string {
		if (this.documentSymbolResult !== undefined) {
			for (let item of this.documentSymbolResult.result) {
				if (!lsp.DocumentSymbol.is(item)) {
					this.validateDocumentSymbols(item);
				}
			}

		}
		return this.hash.digest('base64');
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
}

export class Database {

	private documents: Map<Id, Document>;
	private vertexCache: Map<Id, Vertex>;

	private documentDatas: Map<Id, DocumentData | null>;

	constructor() {
		this.documents = new Map();
		this.vertexCache = new Map();

		this.documentDatas = new Map();
	}

	public insert(element: Edge | Vertex): void {
		if (element.type === ElementTypes.vertex) {
			switch(element.label) {
				case VertexLabels.document:
					this.documents.set(element.id, element);
					break;
				case VertexLabels.range:
					this.cacheVertex(element);
					break;
				case VertexLabels.event:
					this.handleEvent(element);
					break;
			}
		} else if (element.type === ElementTypes.edge) {
			switch(element.label) {
				case EdgeLabels.contains:
					if (!this.handleDocumentContains(element)) {
						this.handleProjectContains(element);
					}
			}
		}
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
		// Insert into DB
		this.documentDatas.set(event.id, null);
	}

	private handleDocumentContains(contains: contains): boolean {
		let documentData = this.getDocumentData(contains.outV);
		if (documentData === undefined) {
			return false;
		}
		let ranges: Range[] = [];
		for (let inV of contains.inVs) {
			let range = this.getCachedVertex(inV, VertexLabels.range);
			if (range == undefined) {
				throw new Error(`Unknown range with id ${inV}`);
			}
			ranges.push(range);
		}
		documentData.addRanges(ranges);
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
		result = new DocumentData(document);
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

	private cacheVertex(vertex: Vertex): void {
		this.vertexCache.set(vertex.id, vertex);
	}

	private getCachedVertex(id: Id, label: VertexLabels.range): Range | undefined;
	private getCachedVertex(id: Id, label: VertexLabels): Vertex | undefined {
		let result: Vertex | undefined = this.vertexCache.get(id);
		if (result === undefined) {
			return undefined;
		}
		if (result.label !== label) {
			throw new Error(`Found ${JSON.stringify(result, undefined, 0)} in cache but has incorrect type. Expected ${label}`);
		}
		return result;
	}
}
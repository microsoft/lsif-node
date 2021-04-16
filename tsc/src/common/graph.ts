/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import { URI } from 'vscode-uri';

import {
	lsp, Id, Vertex, E, Edge,
	Project, Document, HoverResult, ReferenceResult,
	contains, textDocument_definition, textDocument_references, textDocument_diagnostic, textDocument_hover, item, DiagnosticResult,
	Range, RangeTag, DeclarationRange, ReferenceRange, DocumentSymbolResult, textDocument_documentSymbol, ReferenceTag, DeclarationTag,
	UnknownTag, DefinitionResult, ImplementationResult, textDocument_implementation, textDocument_typeDefinition, TypeDefinitionResult, FoldingRangeResult,
	textDocument_foldingRange, RangeBasedDocumentSymbol, DefinitionTag, DefinitionRange, ResultSet, MetaData, Location, ElementTypes, VertexLabels, EdgeLabels,
	Moniker, PackageInformation, moniker, packageInformation, MonikerKind, ItemEdgeProperties, Event, EventKind, EventScope, DocumentEvent, ProjectEvent,
	DeclarationResult, textDocument_declaration, next, UniquenessLevel, Uri, MonikerAttachEvent, attach, Source, CatalogInfo, Capabilities
} from 'lsif-protocol';

export interface BuilderOptions {
	idGenerator?: () => Id;
	emitSource?: boolean;
}

export interface ResolvedBuilderOptions {
	idGenerator: () => Id;
	emitSource: boolean;
}

export class VertexBuilder {

	constructor(private options: ResolvedBuilderOptions) {
	}

	private nextId(): Id {
		return this.options.idGenerator();
	}

	private get emitSource(): boolean {
		return this.options.emitSource;
	}

	public metaData(version: string): MetaData {
		return {
			id: this.nextId(),
			type: ElementTypes.vertex,
			label: VertexLabels.metaData,
			version,
			positionEncoding: 'utf-16'
		};
	}

	public event(scope: EventScope.project, kind: EventKind, data: Project): Event;
	public event(scope: EventScope.document, kind: EventKind, data: Document): Event;
	public event(scope: EventScope.monikerAttach, kind: EventKind): Event;
	public event(scope: EventScope, kind: EventKind, data?: Vertex): Event {
		const id = this.nextId();
		const dataId = data !== undefined ? data.id : id;
		const result: ProjectEvent | DocumentEvent | MonikerAttachEvent = {
			id: id,
			type: ElementTypes.vertex,
			label: VertexLabels.event,
			scope: scope,
			kind,
			data: dataId
		};
		return result;
	}

	public source(workspaceRoot: Uri): Source {
		const result: Source = {
			id: this.nextId(),
			type: ElementTypes.vertex,
			label: VertexLabels.source,
			workspaceRoot
		};
		return result;
	}

	public catalogInfo(uri: Uri, name: string): CatalogInfo {
		const result: CatalogInfo = {
			id: this.nextId(),
			type: ElementTypes.vertex,
			label: VertexLabels.catalogInfo,
			uri,
			name,
			conflictResolution: 'takeDB'
		};
		return result;
	}

	public capabilities(defaultValue: boolean = false): Capabilities {
		return {
			id: this.nextId(),
			type: ElementTypes.vertex,
			label: VertexLabels.capabilities,
			hoverProvider: defaultValue,
			declarationProvider: defaultValue,
			definitionProvider: defaultValue,
			typeDefinitionProvider: defaultValue,
			referencesProvider: defaultValue,
			documentSymbolProvider: defaultValue,
			foldingRangeProvider: defaultValue,
			diagnosticProvider: defaultValue
		};
	}

	public project(name: string, contents?: string): Project {
		const result: Project = {
			id: this.nextId(),
			type: ElementTypes.vertex,
			label: VertexLabels.project,
			kind: 'typescript',
			name
		};
		if (contents) {
			result.contents = this.encodeString(contents);
		}
		return result;
	}

	public document(path: string, contents?: string): Document {
		const result: Document = {
			id: this.nextId(),
			type: ElementTypes.vertex,
			label: VertexLabels.document,
			uri: URI.file(path).toString(true),
			languageId: 'typescript'
		};
		if (contents) {
			result.contents = this.encodeString(contents);
		}
		return result;
	}

	public moniker(scheme: string, identifier: string, unique: UniquenessLevel, kind?: MonikerKind): Moniker {
		const result: Moniker = {
			id: this.nextId(),
			type: ElementTypes.vertex,
			label: VertexLabels.moniker,
			scheme,
			identifier,
			unique
		};
		if (kind !== undefined) {
			result.kind = kind;
		}
		return result;
	}

	public packageInformation(name: string, manager: string): PackageInformation {
		return {
			id: this.nextId(),
			type: ElementTypes.vertex,
			label: VertexLabels.packageInformation,
			name,
			manager
		};
	}

	public resultSet(): ResultSet {
		const result: ResultSet = {
			id: this.nextId(),
			type: ElementTypes.vertex,
			label: VertexLabels.resultSet
		};
		return result;
	}

	public range(range: lsp.Range, tag: UnknownTag): Range;
	public range(range: lsp.Range, tag: DeclarationTag): DeclarationRange;
	public range(range: lsp.Range, tag: DefinitionTag): DefinitionRange;
	public range(range: lsp.Range, tag: ReferenceTag): ReferenceRange;
	public range(range: lsp.Range, tag?: RangeTag): Range {
		const result: Range = {
			id: this.nextId(),
			type: ElementTypes.vertex,
			label: VertexLabels.range,
			start: range.start,
			end: range.end,
		};
		if (tag !== undefined) {
			result.tag = tag;
		}
		return result;
	}

	public location(range: lsp.Range): Location {
		return {
			id: this.nextId(),
			type: ElementTypes.vertex,
			label: VertexLabels.location,
			range: range
		};
	}

	public documentSymbolResult(values: lsp.DocumentSymbol[] | RangeBasedDocumentSymbol[]): DocumentSymbolResult {
		return {
			id: this.nextId(),
			type: ElementTypes.vertex,
			label: VertexLabels.documentSymbolResult,
			result: values
		};
	}

	public diagnosticResult(values: lsp.Diagnostic[]): DiagnosticResult {
		return {
			id: this.nextId(),
			type: ElementTypes.vertex,
			label: VertexLabels.diagnosticResult,
			result: values
		};
	}

	public foldingRangeResult(values: lsp.FoldingRange[]): FoldingRangeResult {
		return {
			id: this.nextId(),
			type: ElementTypes.vertex,
			label: VertexLabels.foldingRangeResult,
			result: values
		};
	}

	public hoverResult(value: lsp.Hover): HoverResult;
	public hoverResult(contents: lsp.MarkupContent | lsp.MarkedString | lsp.MarkedString[]): HoverResult;
	public hoverResult(value: lsp.Hover | lsp.MarkupContent | lsp.MarkedString | lsp.MarkedString[]): HoverResult {
		if (lsp.Hover.is(value)) {
			return {
				id: this.nextId(),
				type: ElementTypes.vertex,
				label: VertexLabels.hoverResult,
				result: {
					contents: value.contents,
					range: value.range
				}
			};
		} else {
			return {
				id: this.nextId(),
				type: ElementTypes.vertex,
				label: VertexLabels.hoverResult,
				result: {
					contents: value as (lsp.MarkupContent | lsp.MarkedString | lsp.MarkedString[])
				}
			};
		}
	}

	public declarationResult(): DeclarationResult {
		return {
			id: this.nextId(),
			type: ElementTypes.vertex,
			label: VertexLabels.declarationResult
		};
	}

	public definitionResult(): DefinitionResult {
		return {
			id: this.nextId(),
			type: ElementTypes.vertex,
			label: VertexLabels.definitionResult
		};
	}

	public typeDefinitionResult(): TypeDefinitionResult {
		return {
			id: this.nextId(),
			type: ElementTypes.vertex,
			label: VertexLabels.typeDefinitionResult
		};
	}

	public referencesResult(): ReferenceResult {
		return {
			id: this.nextId(),
			type: ElementTypes.vertex,
			label: VertexLabels.referenceResult
		};
	}

	public implementationResult(): ImplementationResult {
		return {
			id: this.nextId(),
			type: ElementTypes.vertex,
			label: VertexLabels.implementationResult
		};
	}

	private encodeString(contents: string): string | undefined {
		return this.emitSource
			? Buffer.from(contents).toString('base64')
			: undefined;
	}
}

export class EdgeBuilder {

	private _options: ResolvedBuilderOptions;

	constructor(options: ResolvedBuilderOptions) {
		this._options = options;
	}

	private nextId(): Id {
		return this._options.idGenerator();
	}

	public raw(kind: EdgeLabels, from: Id, to: Id): E<Vertex, Vertex, EdgeLabels> {
		return {
			id: this.nextId(),
			type: ElementTypes.edge,
			label: kind,
			outV: from,
			inV: to
		};
	}

	public contains(from: Project, to: Document[]): contains;
	public contains(from: Document, to: Range[]): contains;
	public contains(from: Vertex, to: Vertex[]): contains {
		return {
			id: this.nextId(),
			type: ElementTypes.edge,
			label: EdgeLabels.contains,
			outV: from.id,
			inVs: to.map(v => v.id)
		};
	}

	public next(from: Range, to: ResultSet): next;
	public next(from: ResultSet, to: ResultSet): next;
	public next(from: Range | ResultSet, to: ResultSet): next {
		return {
			id: this.nextId(),
			type: ElementTypes.edge,
			label: EdgeLabels.next,
			outV: from.id,
			inV: to.id
		};
	}

	public moniker(from: ResultSet, to: Moniker): moniker;
	public moniker(from: Range, to: Moniker): moniker;
	public moniker(from: Range | ResultSet, to: Moniker): moniker {
		return {
			id: this.nextId(),
			type: ElementTypes.edge,
			label: EdgeLabels.moniker,
			outV: from.id,
			inV: to.id
		};
	}

	public packageInformation(from: Moniker, to: PackageInformation): packageInformation {
		return {
			id: this.nextId(),
			type: ElementTypes.edge,
			label: EdgeLabels.packageInformation,
			outV: from.id,
			inV: to.id
		};
	}

	public documentSymbols(from: Document, to: DocumentSymbolResult): textDocument_documentSymbol {
		return {
			id: this.nextId(),
			type: ElementTypes.edge,
			label: EdgeLabels.textDocument_documentSymbol,
			outV: from.id,
			inV: to.id
		};
	}

	public foldingRange(from: Document, to: FoldingRangeResult): textDocument_foldingRange {
		return {
			id: this.nextId(),
			type: ElementTypes.edge,
			label: EdgeLabels.textDocument_foldingRange,
			outV: from.id,
			inV: to.id
		};
	}

	public diagnostic(from: Project | Document, to: DiagnosticResult): textDocument_diagnostic {
		return {
			id: this.nextId(),
			type: ElementTypes.edge,
			label: EdgeLabels.textDocument_diagnostic,
			outV: from.id,
			inV: to.id
		};
	}

	public hover(from: Range | ResultSet, to: HoverResult): textDocument_hover {
		return {
			id: this.nextId(),
			type: ElementTypes.edge,
			label: EdgeLabels.textDocument_hover,
			outV: from.id,
			inV: to.id
		};
	}

	public declaration(from: Range | ResultSet, to: DeclarationResult): textDocument_declaration {
		return {
			id: this.nextId(),
			type: ElementTypes.edge,
			label: EdgeLabels.textDocument_declaration,
			outV: from.id,
			inV: to.id
		};
	}

	public definition(from: Range | ResultSet, to: DefinitionResult): textDocument_definition {
		return {
			id: this.nextId(),
			type: ElementTypes.edge,
			label: EdgeLabels.textDocument_definition,
			outV: from.id,
			inV: to.id
		};
	}

	public typeDefinition(from: Range | ResultSet, to: TypeDefinitionResult): textDocument_typeDefinition {
		return {
			id: this.nextId(),
			type: ElementTypes.edge,
			label: EdgeLabels.textDocument_typeDefinition,
			outV: from.id,
			inV: to.id
		};
	}

	public references(from: Range | ResultSet, to: ReferenceResult): textDocument_references {
		return {
			id: this.nextId(),
			type: ElementTypes.edge,
			label: EdgeLabels.textDocument_references,
			outV: from.id,
			inV: to.id
		};
	}

	public implementation(from: Range | ResultSet, to: ImplementationResult): textDocument_implementation {
		return {
			id: this.nextId(),
			type: ElementTypes.edge,
			label: EdgeLabels.textDocument_implementation,
			outV: from.id,
			inV: to.id
		};
	}

	public item(from: DeclarationResult, to: Range[], shard: Document | Project): item;
	public item(from: DefinitionResult, to: Range[], shard: Document | Project): item;
	public item(from: TypeDefinitionResult, to: Range[], shard: Document | Project): item;
	public item(from: ReferenceResult, to: ReferenceResult[], shard: Document | Project): item;
	public item(from: ReferenceResult, to: Range[], shard: Document | Project, property: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): item;
	public item(from: ReferenceResult, to: Moniker[], shard: Document | Project): item;
	public item(from: ImplementationResult, to: Range[], shard: Document | Project): item;
	public item(from: ImplementationResult, to: ImplementationResult[], shard: Document | Project): item;
	public item(from: DeclarationResult | DefinitionResult | TypeDefinitionResult | ReferenceResult | ImplementationResult, to: Vertex[], shard: Document | Project, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): item {
		if (to.length === 0) {
			const result: item = {
				id: this.nextId(),
				type: ElementTypes.edge,
				label: EdgeLabels.item,
				outV: from.id,
				inVs: [],
				shard: shard.id
			};
			// We have an empty to array. So treat the empty set as references or use the property provided.
			if (from.label === 'referenceResult') {
				result.property = property !== undefined ? property : ItemEdgeProperties.references;
			}
			return result;
		}
		const toKind = to[0].label;
		const result: item = {
			id: this.nextId(),
			type: ElementTypes.edge,
			label: EdgeLabels.item,
			outV: from.id,
			inVs: to.map(v => v.id),
			shard: shard.id
		};
		switch (from.label) {
			case 'declarationResult':
				break;
			case 'definitionResult':
				break;
			case 'referenceResult':
				switch (toKind) {
					case VertexLabels.range:
						if (property === undefined) {
							throw new Error(`An item edge pointing to ranges needs to define a property.`);
						}
						result.property = property;
						break;
					case VertexLabels.referenceResult:
						result.property = ItemEdgeProperties.referenceResults;
						break;
					case VertexLabels.moniker:
						result.property = ItemEdgeProperties.referenceLinks;
						break;
					default:
						throw new Error('Should never happen.');
				}
				break;
			case 'implementationResult':
				switch (toKind) {
					case VertexLabels.implementationResult:
						result.property = ItemEdgeProperties.implementationResults;
						break;
					case VertexLabels.moniker:
						result.property = ItemEdgeProperties.implementationLinks;
						break;
				}
				break;
			default:
				throw new Error('Shouldn\'t happen');
		}
		return result;
	}

	public attach(from: Moniker, to: Moniker): attach {
		return {
			id: this.nextId(),
			type: ElementTypes.edge,
			label: EdgeLabels.attach,
			outV: from.id,
			inV: to.id
		};
	}
}

export class Builder {

	private _vertex: VertexBuilder;
	private _edge: EdgeBuilder;

	constructor(options: ResolvedBuilderOptions) {
		this._vertex = new VertexBuilder(options);
		this._edge = new EdgeBuilder(options);
	}

	public get vertex(): VertexBuilder {
		return this._vertex;
	}

	public get edge(): EdgeBuilder {
		return this._edge;
	}
}

export interface EmitterContext {
	vertex: VertexBuilder;
	edge: EdgeBuilder;
	emit(element: Vertex | Edge): void;
}
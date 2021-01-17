/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as os from 'os';
// In typescript all paths are /. So use the posix layer only
import * as path from 'path';

import { URI } from 'vscode-uri';
import * as ts from 'typescript';

import * as tss from './typescripts';

import {
	lsp, Vertex, Edge, Project, Group, Document, ReferenceResult, RangeTagTypes, RangeBasedDocumentSymbol,
	ResultSet, DefinitionRange, DefinitionResult, MonikerKind, ItemEdgeProperties,
	Range, EventKind, TypeDefinitionResult, Moniker, VertexLabels, UniquenessLevel, EventScope, Id
} from 'lsif-protocol';

import { VertexBuilder, EdgeBuilder } from './graph';

import { LRUCache } from './utils/linkedMap';

import * as paths from './utils/paths';
import { TscMoniker } from './utils/moniker';

interface Disposable {
	(): void;
}

namespace Converter {

	const DiagnosticCategory = ts.DiagnosticCategory;
	const DiagnosticSeverity = lsp.DiagnosticSeverity;

	export function asDiagnostic(this: void, value: ts.DiagnosticWithLocation): lsp.Diagnostic {
		return {
			severity: asDiagnosticSeverity(value.category),
			code: value.code,
			message: tss.flattenDiagnosticMessageText(value.messageText, os.EOL),
			range: asRange(value.file, value.start, value.length)
		};
	}

	export function asDiagnosticSeverity(this: void, value: ts.DiagnosticCategory): lsp.DiagnosticSeverity {
		switch (value) {
			case DiagnosticCategory.Message:
				return DiagnosticSeverity.Information;
			case DiagnosticCategory.Suggestion:
				return DiagnosticSeverity.Hint;
			case DiagnosticCategory.Warning:
				return DiagnosticSeverity.Warning;
			case DiagnosticCategory.Error:
				return DiagnosticSeverity.Error;
			default:
				return lsp.DiagnosticSeverity.Error;
		}
	}

	export function asRange(this: void, file: ts.SourceFile, offset: number, length: number): lsp.Range {
		let start = file.getLineAndCharacterOfPosition(offset);
		let end = file.getLineAndCharacterOfPosition(offset + length);
		return {
			start: { line: start.line, character: start.character },
			end: { line: end.line, character: end.character }
		};
	}

	export function rangeFromNode(this: void, file: ts.SourceFile, node: ts.Node, includeJsDocComment?: boolean): lsp.Range {
		let start: ts.LineAndCharacter;
		if (file === node) {
			start = { line: 0, character: 0 };
		} else {
			start = file.getLineAndCharacterOfPosition(node.getStart(file, includeJsDocComment));
		}
		let end = file.getLineAndCharacterOfPosition(node.getEnd());
		return {
			start: { line: start.line, character: start.character },
			end: { line: end.line, character: end.character }
		};
	}

	export function rangeFromTextSpan(this: void, file: ts.SourceFile, textSpan: ts.TextSpan): lsp.Range {
		let start = file.getLineAndCharacterOfPosition(textSpan.start);
		let end = file.getLineAndCharacterOfPosition(textSpan.start + textSpan.length);
		return {
			start: { line: start.line, character: start.character },
			end: { line: end.line, character: end.character }
		};
	}

	export function asFoldingRange(this: void, file: ts.SourceFile, span: ts.OutliningSpan): lsp.FoldingRange {
		let kind = getFoldingRangeKind(span);
		let start = file.getLineAndCharacterOfPosition(span.textSpan.start);
		let end = file.getLineAndCharacterOfPosition(span.textSpan.start + span.textSpan.length);
		return {
			kind,
			startLine: start.line,
			startCharacter: start.character,
			endLine: end.line,
			endCharacter: end.character
		} as lsp.FoldingRange;
	}

	function getFoldingRangeKind(span: ts.OutliningSpan): lsp.FoldingRangeKind | undefined {
		switch (span.kind) {
			case 'comment':
				return lsp.FoldingRangeKind.Comment;
			case 'region':
				return lsp.FoldingRangeKind.Region;
			case 'imports':
				return lsp.FoldingRangeKind.Imports;
			case 'code':
			default:
				return undefined;
		}
	}

	const symbolKindMap: Map<number, lsp.SymbolKind> = new Map<number, lsp.SymbolKind>([
		[ts.SyntaxKind.ClassDeclaration, lsp.SymbolKind.Class],
		[ts.SyntaxKind.InterfaceDeclaration, lsp.SymbolKind.Interface],
		[ts.SyntaxKind.TypeParameter, lsp.SymbolKind.TypeParameter],
		[ts.SyntaxKind.MethodDeclaration, lsp.SymbolKind.Method],
		[ts.SyntaxKind.FunctionDeclaration, lsp.SymbolKind.Function]
	]);

	export function asSymbolKind(this: void, node: ts.Node): lsp.SymbolKind {
		let result: lsp.SymbolKind | undefined = symbolKindMap.get(node.kind);
		if (result === undefined) {
			result = lsp.SymbolKind.Property;
		}
		return result;
	}

	export function asHover(this: void, _file: ts.SourceFile, value: ts.QuickInfo): lsp.Hover {
		let content: lsp.MarkedString[] = [];
		if (value.displayParts !== undefined) {
			content.push({ language: 'typescript', value: displayPartsToString(value.displayParts)});
		}
		if (value.documentation && value.documentation.length > 0) {
			content.push(displayPartsToString(value.documentation));
		}
		return {
			contents: content
		};
	}

	function displayPartsToString(this: void, displayParts: ts.SymbolDisplayPart[] | undefined) {
		if (displayParts) {
			return displayParts.map(displayPart => displayPart.text).join('');
		}
		return '';
	}

	export function asLocation(file: ts.SourceFile, definition: ts.DefinitionInfo): lsp.Location {
		return { uri: URI.file(definition.fileName).toString(true), range: rangeFromTextSpan(file , definition.textSpan) } as lsp.Location;
	}
}

type SymbolId = string;
type ProjectId = number;
namespace ProjectId {
	let counter = 1;
	export function next(): ProjectId {
		return counter++;
	}
}


export interface EmitterContext {
	vertex: VertexBuilder;
	edge: EdgeBuilder;
	emit(element: Vertex | Edge): void;
}

interface SymbolDataContext extends EmitterContext {
	getDocumentData(fileName: string): DocumentData | undefined;
	managePartitionLifeCycle(shard: Shard, symbolData: SymbolData): void;
}

abstract class LSIFData<T extends EmitterContext> {
	protected constructor(private readonly _context: T) {
	}

	public abstract begin(): void;

	public abstract end(): void;

	protected emit(value: Vertex | Edge): void {
		this._context.emit(value);
	}

	protected get vertex(): VertexBuilder {
		return this._context.vertex;
	}

	protected get edge(): EdgeBuilder {
		return this._context.edge;
	}

	protected get context(): T {
		return this._context;
	}
}

class ProjectData extends LSIFData<EmitterContext> {

	private documents: Document[];
	private diagnostics: lsp.Diagnostic[];

	public constructor(emitter: EmitterContext, public readonly group: Group | undefined, public readonly project: Project) {
		super(emitter);
		this.documents = [];
		this.diagnostics = [];
	}

	public begin(): void {
		this.emit(this.project);
		if (this.group !== undefined) {
			this.emit(this.edge.belongsTo(this.project, this.group));
		}
		this.emit(this.vertex.event(EventScope.project, EventKind.begin, this.project));
	}

	public addDocument(document: Document): void {
		this.documents.push(document);
		if (this.documents.length > 32) {
			this.emit(this.edge.contains(this.project, this.documents));
			this.documents = [];
		}
	}

	public addDiagnostic(diagnostic: lsp.Diagnostic): void {
		this.diagnostics.push(diagnostic);
	}

	public end(): void {
		if (this.documents.length > 0) {
			this.emit(this.edge.contains(this.project, this.documents));
			this.documents = [];
		}
		if (this.diagnostics.length > 0) {
			let dr = this.vertex.diagnosticResult(this.diagnostics);
			this.emit(dr);
			this.emit(this.edge.diagnostic(this.project, dr));
		}
		this.emit(this.vertex.event(EventScope.project, EventKind.end, this.project));
	}
}

class DocumentData extends LSIFData<EmitterContext> {

	private static EMPTY_ARRAY = Object.freeze([]) as unknown as any[];

	public readonly projectId: ProjectId;
	public readonly next: DocumentData | undefined;
	private _isClosed: boolean;
	private ranges: Range[];
	private diagnostics: lsp.Diagnostic[];
	private foldingRanges: lsp.FoldingRange[];
	private documentSymbols: RangeBasedDocumentSymbol[];

	public constructor(projectId: ProjectId, emitter: EmitterContext, public document: Document, public moduleSystem: ModuleSystemKind, public monikerFilePath: string | undefined, public external: boolean, next: DocumentData | undefined) {
		super(emitter);
		this.projectId = projectId;
		this.next = next;
		this._isClosed = false;
		this.ranges = [];
		this.diagnostics = DocumentData.EMPTY_ARRAY;
		this.foldingRanges = DocumentData.EMPTY_ARRAY;
		this.documentSymbols = DocumentData.EMPTY_ARRAY;
	}

	public get isClosed(): boolean {
		return this._isClosed;
	}

	public close(): void {
		this._isClosed = true;
		this.ranges = DocumentData.EMPTY_ARRAY;
		this.diagnostics = DocumentData.EMPTY_ARRAY;
		this.foldingRanges = DocumentData.EMPTY_ARRAY;
		this.documentSymbols = DocumentData.EMPTY_ARRAY;
	}

	private checkClosed(): void {
		if (this.isClosed) {
			throw new Error(`Document data for document ${this.document.uri} is already closed`);
		}
	}

	public begin(): void {
		this.checkClosed();
		this.emit(this.document);
		this.emit(this.vertex.event(EventScope.document, EventKind.begin, this.document));
	}

	public addRange(range: Range): void {
		this.checkClosed();
		this.emit(range);
		this.ranges.push(range);
	}

	public addDiagnostics(diagnostics: lsp.Diagnostic[]): void {
		this.checkClosed();
		this.diagnostics = diagnostics;
	}

	public addFoldingRanges(foldingRanges: lsp.FoldingRange[]): void {
		this.checkClosed();
		this.foldingRanges = foldingRanges;
	}

	public addDocumentSymbols(documentSymbols: RangeBasedDocumentSymbol[]): void {
		this.checkClosed();
		this.documentSymbols = documentSymbols;
	}

	public end(): void {
		this.checkClosed();
		if (this.ranges.length >= 0) {
			this.emit(this.edge.contains(this.document, this.ranges));
		}
		if (this.diagnostics !== DocumentData.EMPTY_ARRAY) {
			let dr = this.vertex.diagnosticResult(this.diagnostics);
			this.emit(dr);
			this.emit(this.edge.diagnostic(this.document, dr));
		}
		if (this.foldingRanges !== DocumentData.EMPTY_ARRAY) {
			const fr = this.vertex.foldingRangeResult(this.foldingRanges);
			this.emit(fr);
			this.emit(this.edge.foldingRange(this.document, fr));
		}
		if (this.documentSymbols !== DocumentData.EMPTY_ARRAY) {
			const ds = this.vertex.documentSymbolResult(this.documentSymbols);
			this.emit(ds);
			this.emit(this.edge.documentSymbols(this.document, ds));
		}
		this.emit(this.vertex.event(EventScope.document, EventKind.end, this.document));
	}
}

class SymbolDataPartition extends LSIFData<EmitterContext> {

	private static EMPTY_ARRAY = Object.freeze([]) as unknown as any[];
	private static EMPTY_MAP= Object.freeze(new Map()) as unknown as Map<any, any>;

	public readonly projectId: ProjectId;
	private readonly symbolData: SymbolData;
	private readonly shard: Shard;
	private definitionRanges: DefinitionRange[];
	private typeDefinitionRanges: DefinitionRange[];

	private referenceRanges: Map<ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references, Range[]>;
	private referenceResults: ReferenceResult[];
	private referenceCascades: Moniker[];
	private _next: SymbolDataPartition | undefined;

	public constructor(projectId: ProjectId, context: EmitterContext, symbolData: SymbolData, shard: Shard, next: SymbolDataPartition | undefined) {
		super(context);
		this.projectId = projectId;
		this.symbolData = symbolData;
		this.shard = shard;
		this.definitionRanges = SymbolDataPartition.EMPTY_ARRAY;
		this.typeDefinitionRanges = SymbolDataPartition.EMPTY_ARRAY;
		this.referenceRanges = SymbolDataPartition.EMPTY_MAP;
		this.referenceResults = SymbolDataPartition.EMPTY_ARRAY;
		this.referenceCascades = SymbolDataPartition.EMPTY_ARRAY;
		this._next = next;
	}

	public get next(): SymbolDataPartition | undefined {
		return this._next;
	}

	public setNext(next: SymbolDataPartition | undefined): void {
		this._next = next;
	}

	public begin(): void {
		// Do nothing.
	}

	public addDefinition(value: DefinitionRange, recordAsReference: boolean = true): void {
		if (this.definitionRanges === SymbolDataPartition.EMPTY_ARRAY) {
			this.definitionRanges = [];
		}
		this.definitionRanges.push(value);
		if (recordAsReference) {
			this.addReference(value, ItemEdgeProperties.definitions);
		}
	}

	public findDefinition(range: lsp.Range): DefinitionRange | undefined {
		if (this.definitionRanges === SymbolDataPartition.EMPTY_ARRAY) {
			return undefined;
		}
		for (let definitionRange of this.definitionRanges) {
			if (definitionRange.start.line === range.start.line && definitionRange.start.character === range.start.character &&
				definitionRange.end.line === range.end.line && definitionRange.end.character === range.end.character)
			{
				return definitionRange;
			}
		}
		return undefined;
	}

	public addTypeDefinition(range: DefinitionRange): void {
		if (this.typeDefinitionRanges === SymbolDataPartition.EMPTY_ARRAY) {
			this.typeDefinitionRanges = [];
		}
		this.typeDefinitionRanges.push(range);
	}

	public addReference(value: Range, property: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void;
	public addReference(value: ReferenceResult): void;
	public addReference(value: Moniker): void;
	public addReference(value: Range | ReferenceResult | Moniker, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		if (value.label === VertexLabels.moniker) {
			if (this.referenceCascades === SymbolDataPartition.EMPTY_ARRAY) {
				this.referenceCascades = [];
			}
			this.referenceCascades.push(value);
		} else if (value.label === VertexLabels.range && property !== undefined) {
			if (this.referenceRanges === SymbolDataPartition.EMPTY_MAP) {
				this.referenceRanges = new Map();
			}
			let values = this.referenceRanges.get(property);
			if (values === undefined) {
				values = [];
				this.referenceRanges.set(property, values);
			}
			values.push(value);
		} else if (value.label === VertexLabels.referenceResult) {
			if (this.referenceResults === SymbolDataPartition.EMPTY_ARRAY) {
				this.referenceResults = [];
			}
			this.referenceResults.push(value);
		}
	}

	public end(): void {
		if (this.definitionRanges !== SymbolDataPartition.EMPTY_ARRAY) {
			let definitionResult = this.symbolData.getOrCreateDefinitionResult();
			this.emit(this.edge.item(definitionResult, this.definitionRanges, this.shard));
		}
		if (this.typeDefinitionRanges !== SymbolDataPartition.EMPTY_ARRAY) {
			const typeDefinitionResult = this.symbolData.getOrCreateTypeDefinitionResult();
			this.emit(this.edge.item(typeDefinitionResult, this.typeDefinitionRanges, this.shard));
		}
		if (this.referenceRanges !== SymbolDataPartition.EMPTY_MAP) {
			const referenceResult = this.symbolData.getOrCreateReferenceResult();
			for (const property of this.referenceRanges.keys()) {
				const values = this.referenceRanges.get(property)!;
				this.emit(this.edge.item(referenceResult, values, this.shard, property));
			}
		}
		if (this.referenceResults !== SymbolDataPartition.EMPTY_ARRAY) {
			const referenceResult = this.symbolData.getOrCreateReferenceResult();
			this.emit(this.edge.item(referenceResult, this.referenceResults, this.shard));
		}
		if (this.referenceCascades !== SymbolDataPartition.EMPTY_ARRAY) {
			const referenceResult = this.symbolData.getOrCreateReferenceResult();
			this.emit(this.edge.item(referenceResult, this.referenceCascades, this.shard));
		}
	}
}

enum SymbolDataVisibility {
	internal = 1,
	unknown = 2,
	transient = 3,
	indirectExported = 4,
	exported = 5,
}

type Shard = Document | Project;

abstract class SymbolData extends LSIFData<SymbolDataContext> {

	public readonly projectId: ProjectId;
	public readonly symbolId: SymbolId;
	public  readonly moduleSystem: ModuleSystemKind;
	private visibility: SymbolDataVisibility;
	private _next: SymbolData | undefined;

	private declarationInfo: tss.DefinitionInfo | tss.DefinitionInfo[] | undefined;

	protected resultSet: ResultSet;
	private _moniker: undefined | Moniker | Moniker[];

	public constructor(projectId: ProjectId, symbolId: SymbolId, moduleSystem: ModuleSystemKind, visibility: SymbolDataVisibility, context: SymbolDataContext, next: SymbolData | undefined) {
		super(context);
		this.projectId = projectId;
		this.symbolId = symbolId;
		this.moduleSystem = moduleSystem;
		this.visibility = visibility;
		this._next = next;
		this.resultSet = this.vertex.resultSet();
	}

	public get next(): SymbolData | undefined {
		return this._next;
	}

	public setNext(next: SymbolData | undefined): void {
		this._next = next;
	}

	public getVisibility(): SymbolDataVisibility {
		return this.visibility;
	}

	public changeVisibility(value: SymbolDataVisibility.indirectExported | SymbolDataVisibility.internal): void {
		if (value === SymbolDataVisibility.indirectExported) {
			if (this.visibility === SymbolDataVisibility.exported || this.visibility === SymbolDataVisibility.indirectExported) {
				return;
			}
			if (this.visibility === SymbolDataVisibility.internal) {
				throw new Error(`Can't upgrade symbol data visibility from ${this.visibility} to ${value}`);
			}
			this.visibility = value;
			return;
		}
		if (value === SymbolDataVisibility.internal) {
			if (this.visibility === SymbolDataVisibility.internal) {
				return;
			}
			if (this.visibility === SymbolDataVisibility.indirectExported || this.visibility === SymbolDataVisibility.exported) {
				throw new Error(`Can't downgrade symbol data visibility from ${this.visibility} to ${value}`);
			}
			this.visibility = value;
			return;
		}
		throw new Error (`Should never happen`);
	}

	public isExported(): boolean {
		return this.visibility === SymbolDataVisibility.exported;
	}

	public isIndirectExported(): boolean {
		return this.visibility === SymbolDataVisibility.indirectExported;
	}

	public isAtLeastIndirectExported(): boolean {
		return this.visibility === SymbolDataVisibility.indirectExported || this.visibility === SymbolDataVisibility.exported;
	}

	public isTransient(): boolean {
		return this.visibility === SymbolDataVisibility.transient;
	}

	public keep(): boolean {
		return this.visibility === SymbolDataVisibility.exported || this.visibility === SymbolDataVisibility.indirectExported || this.visibility === SymbolDataVisibility.transient;
	}

	public isInternal(): boolean {
		return this.visibility === SymbolDataVisibility.internal;
	}

	public isUnknown(): boolean {
		return this.visibility === SymbolDataVisibility.unknown;
	}

	public release(): boolean {
		return this.visibility === SymbolDataVisibility.internal || this.visibility === SymbolDataVisibility.unknown;
	}

	public getResultSet(): ResultSet {
		return this.resultSet;
	}

	public begin(): void {
		this.emit(this.resultSet);
	}

	public recordDefinitionInfo(info: tss.DefinitionInfo): void {
		if (this.declarationInfo === undefined) {
			this.declarationInfo = info;
		} else if (Array.isArray(this.declarationInfo)) {
			this.declarationInfo.push(info);
		} else {
			this.declarationInfo = [this.declarationInfo];
			this.declarationInfo.push(info);
		}
	}

	public hasDefinitionInfo(info: tss.DefinitionInfo): boolean {
		if (this.declarationInfo === undefined) {
			return false;
		} else if (Array.isArray(this.declarationInfo)) {
			for (const item of this.declarationInfo) {
				if (tss.DefinitionInfo.equals(item, info)) {
					return true;
				}
			}
			return false;
		} else {
			return tss.DefinitionInfo.equals(this.declarationInfo, info);
		}
	}

	public addHover(hover: lsp.Hover) {
		const hr = this.vertex.hoverResult(hover);
		this.emit(hr);
		this.emit(this.edge.hover(this.resultSet, hr));
	}

	public addMoniker(identifier: string, kind: MonikerKind): void {
		if (this._moniker !== undefined) {
			throw new Error(`Symbol data ${this.symbolId} already has a primary moniker`);
		}
		const unique: UniquenessLevel = kind === MonikerKind.local ? UniquenessLevel.document : UniquenessLevel.group;
		const moniker = this.vertex.moniker('tsc', identifier, unique, kind);
		this.emit(moniker);
		this.emit(this.edge.moniker(this.resultSet, moniker));
		this._moniker = moniker;
	}

	public attachMoniker(identifier: string, unique: UniquenessLevel, kind: MonikerKind): void {
		const primary = this.getPrimaryMoniker();
		if (primary === undefined) {
			throw new Error(`Symbol data ${this.symbolId} has no primary moniker attached`);
		}
		const moniker = this.vertex.moniker('tsc', identifier, unique, kind);
		this.emit(moniker);
		this.emit(this.edge.attach(moniker, primary));
		if (Array.isArray(this._moniker)) {
			this._moniker.push(moniker);
		} else {
			this._moniker = [primary, moniker];
		}
	}

	public getPrimaryMoniker(): Moniker | undefined {
		if (this._moniker === undefined) {
			return undefined;
		}
		if (Array.isArray(this._moniker)) {
			return this._moniker[0];
		} else {
			return this._moniker;
		}
	}

	public getMostUniqueMoniker(): Moniker | undefined {
		if (this._moniker === undefined) {
			return undefined;
		}
		if (Array.isArray(this._moniker)) {
			// In TS we only have group and document
			for (const moniker of this._moniker) {
				if (moniker.unique === UniquenessLevel.group) {
					return moniker;
				}
			}
			return this._moniker[0];
		} else {
			return this._moniker;
		}
	}

	public abstract getOrCreateDefinitionResult(): DefinitionResult;

	public abstract addDefinition(projectId: ProjectId, shard: Shard, definition: DefinitionRange): void;
	public abstract findDefinition(projectId: ProjectId, shard: Shard, range: lsp.Range): DefinitionRange | undefined;

	public abstract getOrCreateReferenceResult(): ReferenceResult;

	public abstract addReference(projectId: ProjectId, shard: Shard, reference: Range, property: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void;
	public abstract addReference(projectId: ProjectId, shard: Shard, reference: ReferenceResult): void;

	public abstract getOrCreateTypeDefinitionResult(): TypeDefinitionResult;

	public abstract addTypeDefinition(projectId: ProjectId, shard: Shard, definition: DefinitionRange): void;

	public abstract getOrCreatePartition(projectId: ProjectId, shard: Shard): SymbolDataPartition;

	public abstract endPartition(projectId: ProjectId, shard: Shard): void;

	public abstract endPartitions(projectId: ProjectId, shards: Set<Shard>): void;

	public abstract end(forceSingle?: boolean): void;
}

class StandardSymbolData extends SymbolData {

	private definitionResult: DefinitionResult | undefined;
	private referenceResult: ReferenceResult | undefined;
	private typeDefinitionResult: TypeDefinitionResult | undefined;

	private clearedPartitions: Map<Id /* Document | Project */, Set<ProjectId>> | undefined;

	private partitions: Map<Id /* Document | Project */, SymbolDataPartition> | null | undefined;

	public constructor(projectId: ProjectId, symbolId: SymbolId, moduleSystem: ModuleSystemKind, visibility: SymbolDataVisibility, context: SymbolDataContext, next: SymbolData | undefined) {
		super(projectId, symbolId, moduleSystem, visibility, context, next);
	}

	public addDefinition(projectId: ProjectId, shard: Shard, definition: DefinitionRange, recordAsReference: boolean = true): void {
		this.emit(this.edge.next(definition, this.resultSet));
		this.getOrCreatePartition(projectId, shard).addDefinition(definition, recordAsReference);
	}

	public findDefinition(projectId: ProjectId, shard: Shard, range: lsp.Range): DefinitionRange | undefined {
		const [partition, ] = this.getPartition(projectId, shard);
		if (partition === undefined) {
			return undefined;
		}
		return partition.findDefinition(range);
	}

	public addReference(projectId: ProjectId, shard: Shard, reference: Range, property: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void;
	public addReference(projectId: ProjectId, shard: Shard, reference: ReferenceResult): void;
	public addReference(projectId: ProjectId, shard: Shard, reference: Moniker): void;
	public addReference(projectId: ProjectId, shard: Shard, reference: Range | ReferenceResult | Moniker, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void;
	public addReference(projectId: ProjectId, shard: Shard, reference: Range | ReferenceResult | Moniker, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		if (reference.label === VertexLabels.range) {
			this.emit(this.edge.next(reference, this.resultSet));
		}
		this.getOrCreatePartition(projectId, shard).addReference(reference as any, property as any);
	}

	public addTypeDefinition(projectId: ProjectId, shard: Shard, definition: DefinitionRange): void {
		this.getOrCreatePartition(projectId, shard).addTypeDefinition(definition);
	}

	public getOrCreateDefinitionResult(): DefinitionResult {
		if (this.definitionResult === undefined ) {
			this.definitionResult = this.vertex.definitionResult();
			this.emit(this.definitionResult);
			this.emit(this.edge.definition(this.resultSet, this.definitionResult));
		}
		return this.definitionResult;
	}

	public getOrCreateReferenceResult(): ReferenceResult {
		if (this.referenceResult === undefined) {
			this.referenceResult = this.vertex.referencesResult();
			this.emit(this.referenceResult);
			this.emit(this.edge.references(this.resultSet, this.referenceResult));
		}
		return this.referenceResult;
	}

	public getOrCreateTypeDefinitionResult(): TypeDefinitionResult {
		if (this.typeDefinitionResult === undefined) {
			this.typeDefinitionResult = this.vertex.typeDefinitionResult();
			this.emit(this.typeDefinitionResult);
			this.emit(this.edge.typeDefinition(this.resultSet, this.typeDefinitionResult));
		}
		return this.typeDefinitionResult;
	}

	private getPartition(projectId: ProjectId, shard: Shard): [SymbolDataPartition | undefined, SymbolDataPartition | undefined] {
		if (this.partitions === null) {
			throw new Error (`The partitions for symbol ${this.symbolId} have already been cleared.`);
		}
		if (this.partitions === undefined) {
			this.partitions = new Map();
		}
		const current = this.partitions.get(shard.id);
		let candidate = current;
		while(candidate !== undefined) {
			if (candidate.projectId === projectId) {
				return [candidate, undefined];
			}
			candidate = candidate.next;
		}
		// It is not active. See if it got cleared.
		if (this.clearedPartitions !== undefined) {
			const cleared = this.clearedPartitions.get(shard.id);
			if (cleared !== undefined && cleared.has(projectId)) {
				throw new Error(`Symbol data ${this.symbolId} already cleared the partition for shard ${JSON.stringify(shard, undefined, 0)}.`);
			}
		}
		return [undefined, current];
	}

	public getOrCreatePartition(projectId: ProjectId, shard: Shard): SymbolDataPartition {
		let [result, current] = this.getPartition(projectId, shard);
		if (result !== undefined) {
			return result;
		}

		result = new SymbolDataPartition(projectId, this.context, this, shard, current);
		this.context.managePartitionLifeCycle(shard, this);
		result.begin();
		// Get either throws or creates the map.
		this.partitions!.set(shard.id, result);
		return result;
	}

	public endPartition(projectId: ProjectId, shard: Shard): void {
		if (this.partitions === null) {
			throw new Error (`The partitions for symbol ${this.symbolId} have already been cleared.`);
		}
		if (this.partitions === undefined) {
			return;
		}
		const current = this.partitions.get(shard.id);
		let partition = current;
		while(partition !== undefined) {
			if (partition.projectId === projectId) {
				break;
			}
			partition = partition.next;
		}
		if (partition === undefined) {
			return;
		}
		partition.end();
		if (partition === current) {
			if (current.next === undefined) {
				this.partitions!.delete(shard.id);
			} else {
				this.partitions!.set(shard.id, current.next);
			}
		} else {
			let previous = current;
			while (previous !== undefined && previous.next !== partition) {
				previous = previous.next;
			}
			if (previous !== undefined) {
				previous.setNext(partition.next);
			}

		}
		partition.setNext(undefined);
		if (this.clearedPartitions === undefined) {
			this.clearedPartitions = new Map();
			this.clearedPartitions.set(shard.id, new Set([projectId]));
		} else {
			let cleared = this.clearedPartitions.get(shard.id);
			if (cleared === undefined) {
				cleared = new Set();
				this.clearedPartitions.set(shard.id, cleared);
			}
			cleared.add(projectId);
		}
	}

	public endPartitions(projectId: ProjectId, shards: Set<Shard>): void {
		for (const shard of shards) {
			this.endPartition(projectId, shard);
		}
	}

	public end(forceSingle: boolean = false): void {
		if (this.partitions === undefined) {
			return;
		}
		if (this.partitions === null) {
			throw new Error (`Partitions for symbol ${this.symbolId} have already been cleared`);
		}
		if (forceSingle && this.partitions.size > 1) {
			throw new Error(`Symbol data has more than one partition.`);
		}
		for (let entry of this.partitions.entries()) {
			entry[1].end();
		}
		this.clearedPartitions = undefined;
		this.partitions = null;
	}
}

class AliasSymbolData extends StandardSymbolData {

	private readonly aliased: SymbolData;
	private readonly renames: boolean;

	constructor(projectId: ProjectId, symbolId: SymbolId, aliased: SymbolData, moduleSystem: ModuleSystemKind, visibility: SymbolDataVisibility, renames: boolean, context: SymbolDataContext, next: SymbolData | undefined) {
		super(projectId, symbolId, moduleSystem, visibility, context, next);
		this.aliased = aliased;
		this.renames = renames;
	}

	public begin(): void {
		super.begin();
		this.emit(this.edge.next(this.resultSet, this.aliased.getResultSet()));
	}

	public addDefinition(projectId: ProjectId, shard: Shard, definition: DefinitionRange): void {
		if (this.renames) {
			super.addDefinition(projectId, shard, definition, false);
		} else {
			this.emit(this.edge.next(definition, this.resultSet));
			this.aliased.getOrCreatePartition(projectId, shard).addReference(definition, ItemEdgeProperties.references);
		}
	}

	public findDefinition(projectId: ProjectId, shard: Shard, range: lsp.Range): DefinitionRange | undefined {
		if (this.renames) {
			return super.findDefinition(projectId, shard, range);
		} else {
			return this.aliased.findDefinition(projectId, shard, range);
		}
	}

	public addReference(projectId: ProjectId, shard: Shard, reference: Range | ReferenceResult | Moniker, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		if (reference.label === 'range') {
			this.emit(this.edge.next(reference, this.resultSet));
		}
		this.aliased.getOrCreatePartition(projectId, shard).addReference(reference as any, property as any);
	}

	public getOrCreateReferenceResult(): ReferenceResult {
		throw new Error(`Shouldn't be called`);
	}
}

class MethodSymbolData extends StandardSymbolData {

	private shard: Shard | undefined;
	private readonly rootSymbolData: SymbolData[] | undefined;

	constructor(projectId: ProjectId, symbolId: SymbolId, shard: Shard, rootSymbolData: SymbolData[] | undefined, moduleSystem: ModuleSystemKind, visibility: SymbolDataVisibility, context: SymbolDataContext, next: SymbolData | undefined) {
		super(projectId, symbolId, moduleSystem, visibility, context, next);
		this.shard = shard;
		if (rootSymbolData !== undefined && rootSymbolData.length === 0) {
			this.rootSymbolData = undefined;
		} else {
			this.rootSymbolData = rootSymbolData;
		}
	}

	public begin(): void {
		super.begin();
		// We take the first source file to cluster this. We might want to find a source
		// file that has already changed to make the diff minimal.
		if (this.rootSymbolData !== undefined) {
			for (let root of this.rootSymbolData) {
				super.addReference(this.projectId, this.shard!, root.getOrCreateReferenceResult());
				const moniker = root.getMostUniqueMoniker();
				if (moniker !== undefined && moniker.scheme !== 'local') {
					super.addReference(this.projectId, this.shard!, moniker);
				}
			}
		}
		this.shard = undefined;
	}

	public addDefinition(projectId: ProjectId, shard: Shard, definition: DefinitionRange): void {
		super.addDefinition(projectId, shard, definition, this.rootSymbolData === undefined);
		if (this.rootSymbolData !== undefined) {
			for (let base of this.rootSymbolData) {
				base.getOrCreatePartition(projectId, shard).addReference(definition, ItemEdgeProperties.definitions);
			}
		}
	}

	public addReference(projectId: ProjectId, shard: Shard, reference: Range | ReferenceResult | Moniker, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		if (this.rootSymbolData !== undefined) {
			if (reference.label === 'range') {
				this.emit(this.edge.next(reference, this.resultSet));
			}
			for (let root of this.rootSymbolData) {
				root.getOrCreatePartition(projectId, shard).addReference(reference as any, property as any);
			}
		} else {
			super.addReference(projectId, shard, reference, property);
		}
	}
}

class SymbolDataWithRoots extends StandardSymbolData {

	private readonly elements: SymbolData[];
	private shard: Shard | undefined;

	constructor(projectId: ProjectId, symbolId: SymbolId, shard: Shard, elements: SymbolData[], moduleSystem: ModuleSystemKind, visibility: SymbolDataVisibility, context: SymbolDataContext, next: SymbolData | undefined) {
		super(projectId, symbolId, moduleSystem, visibility, context, next);
		this.elements = elements;
		this.shard = shard;
	}

	public begin(): void {
		super.begin();
		for (let element of this.elements) {
			const moniker = element.getMostUniqueMoniker();
			super.addReference(this.projectId, this.shard!, element.getOrCreateReferenceResult());
			if (moniker !== undefined && moniker.scheme !== 'local') {
				super.addReference(this.projectId, this.shard!, moniker);
			}
		}
		this.shard = undefined;
	}

	public recordDefinitionInfo(_info: tss.DefinitionInfo): void {
	}

	public addDefinition(_projectId: ProjectId, _shard: Shard, _definition: DefinitionRange): void {
		// We don't do anything for definitions since they a transient anyways.
	}

	public addReference(projectId: ProjectId, shard: Shard, reference: Range | ReferenceResult | Moniker, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		if (reference.label === 'range') {
			this.emit(this.edge.next(reference, this.resultSet));
		}
		for (let element of this.elements) {
			element.getOrCreatePartition(projectId, shard).addReference(reference as any, property as any);
		}
	}
}

class TransientSymbolData extends StandardSymbolData {

	constructor(projectId: ProjectId, symbolId: SymbolId, moduleSystem: ModuleSystemKind, visibility: SymbolDataVisibility, context: SymbolDataContext, next: SymbolData | undefined) {
		super(projectId, symbolId, moduleSystem, visibility, context, next);
	}

	public begin(): void {
		super.begin();
	}

	public recordDefinitionInfo(_info: tss.DefinitionInfo): void {
	}

	public addDefinition(_projectId: ProjectId, _shard: Shard, _definition: DefinitionRange): void {
		// We don't do anything for definitions since they a transient anyways.
	}

	public addReference(projectId: ProjectId, shard: Shard, reference: Range | ReferenceResult | Moniker, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		super.addReference(projectId, shard, reference, property);
	}
}


enum ModuleSystemKind {
	unknown = 1,
	module = 2,
	global = 3
}

interface ExportPathsContext {
	getOrCreateSymbolData(symbol: ts.Symbol): SymbolData;
	getSymbolData(symbolId: SymbolId): SymbolData | undefined;
}

enum FlowMode {
	exported = 1,
	imported = 2
}

namespace FlowMode {
	export function reverse(mode: FlowMode): FlowMode {
		switch (mode) {
			case FlowMode.exported:
				return FlowMode.imported;
			case FlowMode.imported:
				return FlowMode.exported;
			default:
				throw new Error(`Unknown flow mode ${mode}`);
		}
	}
}

enum TraverseMode {
	done = 1,
	noMark = 2,
	mark = 3,
	noExport = 4,
	export = 5
}

namespace TraverseMode {
	export function forParameter(current: TraverseMode, flowMode: FlowMode): TraverseMode {
		if (current === TraverseMode.done) {
			return current;
		}
		switch (flowMode) {
			case FlowMode.exported:
				switch (current) {
					case TraverseMode.noMark:
					case TraverseMode.mark:
						return TraverseMode.noMark;
					case TraverseMode.noExport:
					case TraverseMode.export:
						return TraverseMode.noExport;
				}
			case FlowMode.imported:
				switch (current) {
					case TraverseMode.noMark:
					case TraverseMode.mark:
						return TraverseMode.mark;
					case TraverseMode.noExport:
					case TraverseMode.export:
						return TraverseMode.export;
				}
		}
	}

	export function forReturn(current: TraverseMode, flowMode: FlowMode): TraverseMode {
		if (current === TraverseMode.done) {
			return current;
		}
		switch (flowMode) {
			case FlowMode.exported:
				switch (current) {
					case TraverseMode.noMark:
					case TraverseMode.mark:
						return TraverseMode.mark;
					case TraverseMode.noExport:
					case TraverseMode.export:
						return TraverseMode.export;
				}
			case FlowMode.imported:
				switch (current) {
					case TraverseMode.noMark:
					case TraverseMode.mark:
						return TraverseMode.noMark;
					case TraverseMode.noExport:
					case TraverseMode.export:
						return TraverseMode.noExport;
				}
		}
	}
}

class Types {

	public constructor(private typeChecker: ts.TypeChecker) {
	}

	public getBaseTypes(type: ts.Type): ts.Type[] | undefined {
		return type.getBaseTypes();
	}

	public getExtendsTypes(type: ts.Type): ts.Type[] | undefined {
		const symbol = type.getSymbol();
		if (symbol === undefined) {
			return undefined;
		}
		const declarations = symbol.getDeclarations();
		if (declarations === undefined) {
			return undefined;
		}
		const result: ts.Type[] = [];
		for (const declaration of declarations) {
			if (ts.isClassDeclaration(declaration)) {
				const heritageClauses = declaration.heritageClauses;
				if (heritageClauses !== undefined) {
					for (const heritageClause of heritageClauses) {
						for (const type of heritageClause.types) {
							result.push(this.typeChecker.getTypeAtLocation(type.expression));
						}
					}
				}
			}
		}
		return result;
	}
}

class Symbols {

	private static TopLevelPaths: Map<number, number[]> = new Map([
		[ts.SyntaxKind.VariableDeclaration, [ts.SyntaxKind.VariableDeclarationList, ts.SyntaxKind.VariableStatement, ts.SyntaxKind.SourceFile]]
	]);

	private static InternalSymbolNames: Map<string, string> = new Map([
		[ts.InternalSymbolName.Call, '1I'],
		[ts.InternalSymbolName.Constructor, '2I'],
		[ts.InternalSymbolName.New, '3I'],
		[ts.InternalSymbolName.Index, '4I'],
		[ts.InternalSymbolName.ExportStar, '5I'],
		[ts.InternalSymbolName.Global, '6I'],
		[ts.InternalSymbolName.Missing, '7I'],
		[ts.InternalSymbolName.Type, '8I'],
		[ts.InternalSymbolName.Object, '9I'],
		[ts.InternalSymbolName.JSXAttributes, '10I'],
		[ts.InternalSymbolName.Class, '11I'],
		[ts.InternalSymbolName.Function, '12I'],
		[ts.InternalSymbolName.Computed, '13I'],
		[ts.InternalSymbolName.Resolving, '14I'],
		[ts.InternalSymbolName.ExportEquals, '15I'],
		[ts.InternalSymbolName.Default, '16I'],
		[ts.InternalSymbolName.This, '17I']
	]);


	public static isSourceFile(symbol: ts.Symbol): boolean  {
		const declarations = symbol.getDeclarations();
		return declarations !== undefined && declarations.length === 1 && ts.isSourceFile(declarations[0]);
	}

	public static mayBeSourceFile(symbol: ts.Symbol): boolean {
		const declarations = symbol.getDeclarations();
		if (declarations === undefined) {
			return false;
		}
		for (const declaration of declarations) {
			if (ts.isSourceFile(declaration)) {
				return true;
			}
		}
		return false;

	}

	public static isFunctionScopedVariable(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.FunctionScopedVariable) !== 0;
	}

	public static isFunctionScopedVariableAndNotParameter(symbol: ts.Symbol): boolean {
		if (symbol === undefined || (symbol.getFlags() & ts.SymbolFlags.FunctionScopedVariable) === 0) {
			return false;
		}
		const declarations = symbol.getDeclarations();
		if (declarations === undefined || declarations.length !== 1) {
			return false;
		}
		return !ts.isParameter(declarations[0]);
	}

	public static asParameterDeclaration(symbol: ts.Symbol): ts.ParameterDeclaration | undefined {
		const declarations = symbol.getDeclarations();
		if (declarations === undefined || declarations.length !== 1) {
			return undefined;
		}
		return ts.isParameter(declarations[0]) ? declarations[0] as ts.ParameterDeclaration : undefined;
	}

	public static isBlockScopedVariable(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.BlockScopedVariable) !== 0;
	}

	public static isFunction(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Function) !== 0;
	}

	public static isClass(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Class) !== 0;
	}

	public static isInterface(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Interface) !== 0;
	}

	public static isTypeLiteral(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.TypeLiteral) !== 0;
	}

	public static isMethodSymbol(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Method) !== 0;
	}

	public static isAliasSymbol(symbol: ts.Symbol): boolean  {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Alias) !== 0;
	}

	public static isValueModule(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.ValueModule) !== 0;
	}

	public static isTypeParameter(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.TypeParameter) !== 0;
	}

	public static isTransient(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Transient) !== 0;
	}

	public static isTypeAlias(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.TypeAlias) !== 0;
	}

	public static isPrototype(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Prototype) !== 0;
	}

	public static isPrivate(symbol: ts.Symbol): boolean {
		const declarations = symbol.getDeclarations();
		if (declarations) {
			for (const declaration of declarations) {
				const modifierFlags = ts.getCombinedModifierFlags(declaration);
				if ((modifierFlags & ts.ModifierFlags.Private) === 0) {
					return false;
				}
			}
		}
		return true;
	}

	public static isStatic(symbol: ts.Symbol): boolean {
		const declarations = symbol.getDeclarations();
		if (declarations) {
			for (const declaration of declarations) {
				const modifierFlags = ts.getCombinedModifierFlags(declaration);
				if ((modifierFlags & ts.ModifierFlags.Static) === 0) {
					return false;
				}
			}
		}
		return true;
	}

	public readonly types: Types;

	private readonly baseSymbolCache: LRUCache<string, ts.Symbol[]>;
	private readonly baseMemberCache: LRUCache<string, LRUCache<string, ts.Symbol[]>>;
	private readonly exportPathCache: LRUCache<ts.Symbol, string | null>;

	private readonly sourceFilesContainingAmbientDeclarations: Set<string>;

	constructor(private typeChecker: ts.TypeChecker) {
		this.types = new Types(typeChecker);
		this.baseSymbolCache = new LRUCache(2048);
		this.baseMemberCache = new LRUCache(2048);
		this.exportPathCache = new LRUCache(2048);

		this.sourceFilesContainingAmbientDeclarations = new Set();

		const ambientModules = this.typeChecker.getAmbientModules();
		for (const module of ambientModules) {
			const declarations = module.getDeclarations();
			if (declarations !== undefined) {
				for (const declaration of declarations) {
					const sourceFile = declaration.getSourceFile();
					this.sourceFilesContainingAmbientDeclarations.add(sourceFile.fileName);
				}
			}
		}
	}

	public getType(symbol: ts.Symbol, location: ts.Node): ts.Type {
		return Symbols.isTypeAlias(symbol) || Symbols.isInterface(symbol)
			? this.typeChecker.getDeclaredTypeOfSymbol(symbol)
			: this.typeChecker.getTypeOfSymbolAtLocation(symbol, symbol.declarations !== undefined ? symbol.declarations[0] : location);
	}

	public getSymbolsOfType(type: ts.Type): ts.Symbol[] {
		if (type.isUnionOrIntersection()) {
			const result: ts.Symbol[] = [];
			for (const part of type.types) {
				const symbol = part.getSymbol();
				if (symbol !== undefined) {
					result.push(symbol);
				}
			}
			return result;
		} else {
			const result = type.getSymbol();
			return result !== undefined ? [result] : [];
		}
	}

	public computeAdditionalExportPaths(context: ExportPathsContext, sourceFile: ts.SourceFile, start: ts.Symbol | ts.Type, exportName: string, moduleSystem: ModuleSystemKind, traverseMode?: TraverseMode): [SymbolData, string][] {
		const result: [SymbolData, string][] = [];
		const seenSymbol: Set<string> = new Set();
		const seenType: Set<ts.Type> = new Set();

		const symbolTraverseMode = (symbol: ts.Symbol, current: TraverseMode): TraverseMode => {
			if (current === TraverseMode.done || current === TraverseMode.mark || current === TraverseMode.noMark) {
				return current;
			}
			const symbolData = context.getOrCreateSymbolData(symbol);
			if (symbolData.isAtLeastIndirectExported()) {
				return TraverseMode.done;
			}
			return current;
		};

		const typeTraverseMode = (type: ts.Type, current: TraverseMode): TraverseMode => {
			// Always continue with call signatures even if they are exported.
			if (current === TraverseMode.done || current === TraverseMode.mark || current === TraverseMode.noMark
			 	|| tss.Type.hasCallSignature(type) || tss.Type.hasConstructSignatures(type)
				|| type.aliasTypeArguments !== undefined
				|| (tss.Type.isObjectType(type) && tss.Type.isTypeReference(type) && this.typeChecker.getTypeArguments(type).length > 0)) {
				return current;
			}
			const symbol = type.getSymbol();
			if (symbol === undefined) {
				return current;
			}
			const symbolData = context.getOrCreateSymbolData(symbol);
			if (symbolData.isAtLeastIndirectExported()) {
				return TraverseMode.done;
			}
			const escapedName = symbol.escapedName;
			if (Symbols.InternalSymbolNames.has(escapedName as string)) {
				return TraverseMode.export;
			}
			return TraverseMode.mark;
		};

		const visitSymbol = (symbol: ts.Symbol, parentPath: string, traverseMode: TraverseMode): [boolean, string | undefined] => {
			if (Symbols.isPrototype(symbol) || Symbols.isTypeParameter(symbol)) {
				return [false, undefined];
			}
			const symbolData = context.getOrCreateSymbolData(symbol);
			const escapedName = symbol.escapedName;
			let identifier = parentPath;
			if (!Symbols.InternalSymbolNames.has(escapedName as string)) {
				identifier = `${parentPath}.${this.getExportSymbolName(symbol)}`;
				if (traverseMode === TraverseMode.export) {
					result.push([symbolData, identifier]);
				}
			}
			if (!symbolData.isAtLeastIndirectExported()) {
				symbolData.changeVisibility(SymbolDataVisibility.indirectExported);
			}
			return [true, identifier];
		};

		const forEachChild = (symbol: ts.Symbol, parentPath: string, mode: FlowMode, traverseMode: TraverseMode, level: number): void => {
			const handler = (child: ts.Symbol) => {
				const childTraverseMode = symbolTraverseMode(child, traverseMode);
				if (childTraverseMode === TraverseMode.done) {
					return;
				}
				const [cont, identifier] = visitSymbol(child, parentPath, childTraverseMode);
				if (cont === false || identifier === undefined) {
					return;
				}
				walkSymbol(child, identifier, mode, traverseMode, level + 1);
			};
			symbol.exports?.forEach(handler);
			symbol.members?.forEach(handler);
		};

		const walkType = (type: ts.Type, parentPath: string, moduleSystem: ModuleSystemKind, mode: FlowMode, traverseMode: TraverseMode, level: number): void => {
			if (seenType.has(type)) {
				return;
			}
			seenType.add(type);
			if (traverseMode === TraverseMode.done) {
				return;
			}

			// We have a call signature
			if (tss.Type.hasCallSignature(type) || tss.Type.hasConstructSignatures(type)) {
				for (const signature of type.getCallSignatures().concat(type.getConstructSignatures())) {
					// In a global module system signature can be merged hence type parameters need to be exported. Do that before
					//we walt the parameter and return type since they can reference a type parameter
					if (moduleSystem === ModuleSystemKind.global) {
						const typeParameters = signature.getTypeParameters();
						if (typeParameters !== undefined) {
							for (const typeParameter of typeParameters) {
								const symbol = typeParameter.getSymbol();
								if (symbol !== undefined) {
									const symbolData = context.getOrCreateSymbolData(symbol);
									if (!seenSymbol.has(symbolData.symbolId) && !symbolData.isAtLeastIndirectExported()) {
										seenSymbol.add(symbolData.symbolId);
										symbolData.changeVisibility(SymbolDataVisibility.indirectExported);
										if (traverseMode === TraverseMode.export) {
											result.push([symbolData, `${parentPath}.${this.getExportSymbolName(symbol)}`]);
										}
									}
								}
							}
						}
					}
					for (const parameter of signature.getParameters()) {
						const parameterType = this.getType(parameter, sourceFile);
						const parameterTraverseMode = typeTraverseMode(parameterType, traverseMode);
						const exportIdentifier = `${parentPath}.${this.getExportSymbolName(parameter)}`;
						const newMode = tss.Type.hasCallSignature(parameterType) ? FlowMode.reverse(mode) : mode;
						walkType(parameterType, exportIdentifier, moduleSystem, newMode, TraverseMode.forParameter(parameterTraverseMode, newMode), level + 1);
					}
					const returnType = signature.getReturnType();
					walkType(returnType, parentPath, moduleSystem, mode, TraverseMode.forReturn(typeTraverseMode(returnType, traverseMode), mode), level + 1);
				}
			}

			if (type.isUnionOrIntersection()) {
				for (const part of type.types) {
					walkType(part, parentPath, moduleSystem, mode, typeTraverseMode(part, traverseMode), level + 1);
				}
			}

			if (tss.Type.isInterface(type)) {
				const bases = this.types.getBaseTypes(type);
				if (bases !== undefined) {
					for (const base of bases) {
						walkType(base, parentPath, moduleSystem, mode, typeTraverseMode(base, traverseMode), level + 1);
					}
				}
			}

			if (tss.Type.isClass(type)) {
				const bases = this.types.getExtendsTypes(type);
				if (bases !== undefined) {
					for (const base of bases) {
						walkType(base, parentPath, moduleSystem, mode, typeTraverseMode(base, traverseMode), level + 1);
					}
				}
			}

			if (tss.Type.isObjectType(type)) {
				if (tss.Type.isTypeReference(type)) {
					const typeReferences = this.typeChecker.getTypeArguments(type);
					for (const reference of typeReferences) {
						walkType(reference, parentPath, moduleSystem, mode, typeTraverseMode(reference, traverseMode), level + 1);
					}
				}
			}

			if (type.aliasTypeArguments !== undefined) {
				for (const aliasTypeArgument of type.aliasTypeArguments) {
					walkType(aliasTypeArgument, parentPath, moduleSystem, mode, typeTraverseMode(aliasTypeArgument, traverseMode), level + 1);
				}
			}

			if (tss.Type.isConditionalType(type)) {
				walkType(type.checkType, parentPath, moduleSystem, mode, typeTraverseMode(type.checkType, traverseMode), level + 1);
				walkType(type.extendsType, parentPath, moduleSystem, mode, typeTraverseMode(type.extendsType, traverseMode), level + 1);
				walkType(type.resolvedTrueType, parentPath, moduleSystem, mode, typeTraverseMode(type.resolvedTrueType, traverseMode), level + 1);
				walkType(type.resolvedFalseType, parentPath, moduleSystem, mode, typeTraverseMode(type.resolvedFalseType, traverseMode), level + 1);
			}

			const symbol = type.getSymbol();
			if (walkSymbol && symbol !== undefined) {
				const key = tss.Symbol.createKey(this.typeChecker, symbol);
				if (!seenSymbol.has(key)) {
					seenSymbol.add(key);
					const newTraverseMode = symbolTraverseMode(symbol, traverseMode);
					if (newTraverseMode === TraverseMode.done) {
						return;
					}
					// We don't need to visit the symbol since it represents a type.
					const symbolData = context.getOrCreateSymbolData(symbol);
					if (!symbolData.isAtLeastIndirectExported()) {
						symbolData.changeVisibility(SymbolDataVisibility.indirectExported);
					}
					forEachChild(symbol, parentPath, mode, newTraverseMode, level + 1);
				}
			}
		};

		const walkSymbol = (symbol: ts.Symbol, exportIdentifier: string, mode: FlowMode, traverseMode: TraverseMode, level: number): void => {
			// The prototype symbol has no range in source.
			if (Symbols.isPrototype(symbol) || traverseMode === TraverseMode.done) {
				return;
			}

			const symbolKey = tss.Symbol.createKey(this.typeChecker, symbol);
			if (seenSymbol.has(symbolKey)) {
				return;
			}

			const symbolData = context.getOrCreateSymbolData(symbol);
			const type = this.getType(symbol, sourceFile);
			// On the first level we start with a symbol or type that is exported. So don't recompute the
			// traverse mode.
			walkType(type, exportIdentifier, symbolData.moduleSystem, mode, level === 0 ? traverseMode : typeTraverseMode(type, traverseMode), level);
			if (seenSymbol.has(symbolKey)) {
				return;
			}
			seenSymbol.add(symbolKey);
			forEachChild(symbol, exportIdentifier, mode, traverseMode, level);
		};

		// We start in export mode since this is why we got called.
		if (tss.Symbol.is(start)) {
			walkSymbol(start, exportName, FlowMode.exported, traverseMode ?? symbolTraverseMode(start, TraverseMode.export), 0);
			// If the symbol is not exported now mark it at least as indirect exported.
			const symbolData = context.getOrCreateSymbolData(start);
			if (!symbolData.isExported()) {
				symbolData.changeVisibility(SymbolDataVisibility.indirectExported);
			}
		} else {
			walkType(start, exportName, moduleSystem, FlowMode.exported, traverseMode ?? typeTraverseMode(start, TraverseMode.export), 0);
		}
		return result;
	}

	private isExported(parent: ts.Symbol, symbol: ts.Symbol): boolean {
		return parent.exports !== undefined && parent.exports.has(symbol.getEscapedName() as ts.__String);
	}

	public getBaseSymbols(symbol: ts.Symbol): ts.Symbol[] | undefined {
		const key = tss.Symbol.createKey(this.typeChecker, symbol);
		let result = this.baseSymbolCache.get(key);
		if (result !== undefined) {
			return result;
		}
		if (Symbols.isTypeLiteral(symbol)) {
			// ToDo@dirk: compute base symbols for type literals.
			return undefined;
		} else if (Symbols.isInterface(symbol)) {
			result = this.computeBaseSymbolsForInterface(symbol);
		} else if (Symbols.isClass(symbol)) {
			result = this.computeBaseSymbolsForClass(symbol);
		}
		if (result !== undefined) {
			this.baseSymbolCache.set(key, result);
		}
		return result;
	}

	private computeBaseSymbolsForClass(symbol: ts.Symbol): ts.Symbol[] | undefined {
		let result: ts.Symbol[] = [];
		let declarations = symbol.getDeclarations();
		if (declarations === undefined) {
			return undefined;
		}
		let typeChecker = this.typeChecker;
		for (let declaration of declarations) {
			if (ts.isClassDeclaration(declaration)) {
				let heritageClauses = declaration.heritageClauses;
				if (heritageClauses) {
					for (let heritageClause of heritageClauses) {
						for (let type of heritageClause.types) {
							let tsType = typeChecker.getTypeAtLocation(type.expression);
							if (tsType !== undefined) {
								let baseSymbol = tsType.getSymbol();
								if (baseSymbol !== undefined && baseSymbol !== symbol) {
									result.push(baseSymbol);
								}
							}
						}
					}
				}
			}
		}
		return result.length === 0 ? undefined : result;
	}

	private computeBaseSymbolsForInterface(symbol: ts.Symbol): ts.Symbol[] | undefined {
		let result: ts.Symbol[] = [];
		let tsType = this.typeChecker.getDeclaredTypeOfSymbol(symbol);
		if (tsType === undefined) {
			return undefined;
		}
		let baseTypes = tsType.getBaseTypes();
		if (baseTypes !== undefined) {
			for (let base of baseTypes) {
				let symbol = base.getSymbol();
				if (symbol) {
					result.push(symbol);
				}
			}
		}
		return result.length === 0 ? undefined : result;
	}

	public findRootMembers(symbol: ts.Symbol, memberName: string): ts.Symbol[] | undefined {
		const key = tss.Symbol.createKey(this.typeChecker, symbol);
		let cache = this.baseMemberCache.get(key);
		if (cache === undefined) {
			cache = new LRUCache(64);
			this.baseMemberCache.set(key, cache);
		}
		let result: ts.Symbol[] | undefined = cache.get(memberName);
		if (result !== undefined) {
			return result;
		}
		const baseSymbols = this.getBaseSymbols(symbol);
		if (baseSymbols !== undefined) {
			const baseResult: Map<string, ts.Symbol> = new Map();
			for (const base of baseSymbols) {
				const symbols = this.findRootMembers(base, memberName);
				if (symbols !== undefined) {
					for (const symbol of symbols) {
						baseResult.set(tss.Symbol.createKey(this.typeChecker, symbol), symbol);
					}
				}
			}
			// The method is an override of something already defined in a base type
			if (baseResult.size > 0) {
				result = Array.from(baseResult.values());
			}
		} else if (symbol.members) {
			const member = symbol.members.get(memberName as ts.__String);
			if (member !== undefined) {
				result = [member];
			}
		}
		if (result !== undefined) {
			cache.set(memberName, result);
		} else {
			cache.set(memberName, []);
		}
		return result;
	}

	public getExportPath(symbol: ts.Symbol, kind: ModuleSystemKind): string | undefined {
		let result = this.exportPathCache.get(symbol);
		if (result !== undefined) {
			return result === null ? undefined : result;
		}
		if (Symbols.isSourceFile(symbol) && (kind === ModuleSystemKind.module || kind === ModuleSystemKind.unknown)) {
			this.exportPathCache.set(symbol, '');
			return '';
		}
		const parent = tss.Symbol.getParent(symbol);
		const name = this.getExportSymbolName(symbol);
		if (parent === undefined) {
			// In a global module system symbol inside other namespace don't have a parent
			// if the symbol is not exported. So we need to check if the symbol is a top
			// level symbol
			if (kind === ModuleSystemKind.global) {
				if (this.isTopLevelSymbol(symbol)) {
					this.exportPathCache.set(symbol, name);
					return name;
				}
				// In a global module system signature can be merged across file. So even parameters
				// must be exported to allow merging across files.
				const parameterDeclaration = Symbols.asParameterDeclaration(symbol);
				if (parameterDeclaration !== undefined && parameterDeclaration.parent.name !== undefined) {
					const parentSymbol = this.typeChecker.getSymbolAtLocation(parameterDeclaration.parent.name);
					if (parentSymbol !== undefined) {
						const parentValue = this.getExportPath(parentSymbol, kind);
						if (parentValue !== undefined) {
							result = `${parentValue}.${name}`;
							this.exportPathCache.set(symbol, result);
							return result;
						}
					}
				}
			}
			this.exportPathCache.set(symbol, null);
			return undefined;
		} else {
			const parentValue = this.getExportPath(parent, kind);
			// The parent is not exported so any member isn't either
			if (parentValue === undefined) {
				this.exportPathCache.set(symbol, null);
				return undefined;
			} else {
				if (Symbols.isInterface(parent) || Symbols.isClass(parent) || Symbols.isTypeLiteral(parent)) {
					result = `${parentValue}.${name}`;
					this.exportPathCache.set(symbol, result);
					return result;
				} else if (this.isExported(parent, symbol)) {
					result = parentValue.length > 0 ? `${parentValue}.${name}` : name;
					this.exportPathCache.set(symbol, result);
					return result;
				} else {
					this.exportPathCache.set(symbol, null);
					return undefined;
				}
			}
		}
	}

	public getExportSymbolName(symbol: ts.Symbol, internalName?: string): string {
		const escapedName = symbol.getEscapedName();
		// export default foo && export = foo
		if (Symbols.isAliasSymbol(symbol) && (escapedName === ts.InternalSymbolName.Default || escapedName === ts.InternalSymbolName.ExportEquals)) {
			const declarations = symbol.getDeclarations();
			if (declarations !== undefined && declarations.length === 1) {
				const declaration = declarations[0];
				if (ts.isExportAssignment(declaration)) {
					return declaration.expression.getText();
				}
			}
		}
		const internalSymbolId: string | undefined = Symbols.InternalSymbolNames.get(escapedName as string);
		if (internalSymbolId !== undefined) {
			return internalName ?? internalSymbolId;
		}
		const name = symbol.getName();
		if (name.charAt(0) === '\"' || name.charAt(0) === '\'') {
			return name.substr(1, name.length - 2);
		}
		return name;
	}

	public isTopLevelSymbol(symbol: ts.Symbol): boolean {
		const declarations: ts.Declaration[] | undefined = symbol.declarations;
		if (declarations === undefined || declarations.length === 0) {
			return false;
		}

		let result: boolean = false;
		for (const declaration of declarations) {
			const path: number[] | undefined = Symbols.TopLevelPaths.get(declaration.kind);
			if (path === undefined) {
				if (declaration.parent === undefined || ts.isSourceFile(declaration)) {
					result = false;
				} else {
					result = result || ts.isSourceFile(declaration.parent);
				}
			} else {
				result = result || this.matchPath(declaration.parent, path);
			}
		}
		return result;
	}

	private matchPath(node: ts.Node, path: number[]): boolean {
		for (const kind of path) {
			if (node === undefined || node.kind !== kind) {
				return false;
			}
			node = node.parent;
		}
		return true;
	}
}


interface FactoryResult {
	readonly symbolData: SymbolData;
	readonly exportPath?: string;
	readonly moduleSystem?: ModuleSystemKind;
	readonly validateVisibilityOn?: ts.SourceFile[];
}

interface FactoryContext {
	getOrCreateSymbolData(symbol: ts.Symbol): SymbolData;
}


abstract class SymbolDataFactory {

	protected readonly typeChecker: ts.TypeChecker;
	protected readonly symbols: Symbols;
	protected readonly factoryContext: FactoryContext;
	protected readonly symbolDataContext: SymbolDataContext;


	constructor(typeChecker: ts.TypeChecker, symbols: Symbols, factoryContext: FactoryContext, symbolDataContext: SymbolDataContext) {
		this.typeChecker = typeChecker;
		this.symbols = symbols;
		this.factoryContext = factoryContext;
		this.symbolDataContext = symbolDataContext;
	}

	public getDeclarationNodes(symbol: ts.Symbol): ts.Node[] | undefined {
		return symbol.getDeclarations();
	}

	public getDeclarationSourceFiles(symbol: ts.Symbol): ts.SourceFile[]  | undefined {
		let sourceFiles = tss.getUniqueSourceFiles(symbol.getDeclarations());
		if (sourceFiles.size === 0) {
			return [];
		}
		return Array.from(sourceFiles.values());
	}

	public useGlobalProjectDataManager(_symbol: ts.Symbol): boolean {
		return false;
	}

	public getIdentifierInformation(symbol: ts.Symbol, declaration: ts.Node): [ts.Node, string] | [undefined, undefined] {
		if (tss.Node.isNamedDeclaration(declaration)) {
			let name = declaration.name;
			return [name, name.getText()];
		}
		if (Symbols.isValueModule(symbol) && ts.isSourceFile(declaration)) {
			return [declaration, ''];
		}
		return [undefined, undefined];
	}

	private getModuleSystemKind(sourceFiles: ts.SourceFile[] | undefined): ModuleSystemKind {
		if (sourceFiles === undefined || sourceFiles.length === 0) {
			return ModuleSystemKind.unknown;
		}
		let moduleCount: number = 0;
		let globalCount: number = 0;
		for (let sourceFile of sourceFiles) {
			// files that represent a module do have a resolve symbol.
			if (this.typeChecker.getSymbolAtLocation(sourceFile) !== undefined) {
				moduleCount++;
				continue;
			}
			// Things that are global in case we need to treat them special later on
			// tss.Program.isSourceFileDefaultLibrary
			// this.sourceFilesContainingAmbientDeclarations.has(sourceFile.fileName)
			globalCount++;

			// tss.Program.isSourceFileFromExternalLibrary doesn't give any clear hint whether it
			// is global or module.
		}
		const numberOfFiles = sourceFiles.length;
		if (moduleCount === numberOfFiles) {
			return ModuleSystemKind.module;
		}
		if (globalCount === numberOfFiles) {
			return ModuleSystemKind.global;
		}
		return ModuleSystemKind.unknown;
	}

	private getVisibility(symbol: ts.Symbol, exportPath: string | undefined, _moduleSystem: ModuleSystemKind | undefined, _parseMode: ParseMode): SymbolDataVisibility {
		// The symbol is exported.
		if (exportPath !== undefined) {
			return SymbolDataVisibility.exported;
		}
		if (Symbols.isTransient(symbol)) {
			return SymbolDataVisibility.transient;
		}

		return SymbolDataVisibility.unknown;
	}

	protected getExportData(symbol: ts.Symbol, declarationSourceFiles: ts.SourceFile[] | undefined, parseMode: ParseMode): [ModuleSystemKind, string | undefined, SymbolDataVisibility] {
		const moduleSystem = this.getModuleSystemKind(declarationSourceFiles);
		const exportPath = this.symbols.getExportPath(symbol, moduleSystem);
		const visibility = this.getVisibility(symbol, exportPath, moduleSystem, parseMode);
		return [moduleSystem, exportPath, visibility];
	}

	public abstract create(projectId: ProjectId, symbol: ts.Symbol, symbolId: SymbolId, declarationSourceFiles: ts.SourceFile[] | undefined, projectDataManager: ProjectDataManager, currentParsedSourceFile: ts.SourceFile | undefined, next: SymbolData | undefined): FactoryResult;
}

class StandardSymbolDataFactory extends SymbolDataFactory {

	constructor(typeChecker: ts.TypeChecker, symbols: Symbols, resolverContext: FactoryContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}

	public create(projectId: ProjectId, symbol: ts.Symbol, symbolId: SymbolId, declarationSourceFiles: ts.SourceFile[] | undefined, projectDataManager: ProjectDataManager, _currentParsedSourceFile: ts.SourceFile | undefined, next: SymbolData | undefined): FactoryResult {
		const [moduleSystem, exportPath, visibility] = this.getExportData(symbol, declarationSourceFiles, projectDataManager.getParseMode());
		return {
			symbolData: new StandardSymbolData(projectId, symbolId, moduleSystem, visibility, this.symbolDataContext, next),
			exportPath, moduleSystem,
			validateVisibilityOn: declarationSourceFiles
		};
	}
}

class AliasFactory extends SymbolDataFactory {

	constructor(typeChecker: ts.TypeChecker, symbols: Symbols, resolverContext: FactoryContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}

	public create(projectId: ProjectId, symbol: ts.Symbol, symbolId: SymbolId, declarationSourceFiles: ts.SourceFile[] | undefined, projectDataManager: ProjectDataManager, _currentParsedSourceFile: ts.SourceFile | undefined, next: SymbolData | undefined): FactoryResult {
		const parseMode = projectDataManager.getParseMode();
		const [moduleSystem, exportPath, visibility] = this.getExportData(symbol, declarationSourceFiles, parseMode);
		const aliased = this.typeChecker.getAliasedSymbol(symbol);
		let symbolData: SymbolData | undefined;
		if (aliased !== undefined) {
			const renames = this.symbols.getExportSymbolName(symbol) !== this.symbols.getExportSymbolName(aliased);
			const aliasedSymbolData = this.factoryContext.getOrCreateSymbolData(aliased);
			if (aliasedSymbolData !== undefined) {
				symbolData = new AliasSymbolData(projectId, symbolId, aliasedSymbolData, moduleSystem, visibility, renames, this.symbolDataContext, next);
			}
		}
		if (symbolData === undefined) {
			symbolData = new StandardSymbolData(projectId, symbolId, moduleSystem, visibility, this.symbolDataContext, next);
		}
		return {
			symbolData,
			moduleSystem, exportPath,
			validateVisibilityOn: declarationSourceFiles,
		};
	}
}

class MethodFactory extends SymbolDataFactory {

	constructor(typeChecker: ts.TypeChecker, symbols: Symbols, resolverContext: FactoryContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}

	public create(projectId: ProjectId, symbol: ts.Symbol, symbolId: SymbolId, declarationSourceFiles: ts.SourceFile[] | undefined, projectDataManager: ProjectDataManager, _currentParsedSourceFile: ts.SourceFile | undefined, next: SymbolData | undefined): FactoryResult {
		if (declarationSourceFiles === undefined || declarationSourceFiles.length === 0) {
			throw new Error(`Need to understand how a method symbol can exist without a source file`);
		}

		const documentData = this.symbolDataContext.getDocumentData(declarationSourceFiles[0].fileName);
		const shard = documentData !== undefined ? documentData.document : projectDataManager.getProjectData().project;

		const parseMode = projectDataManager.getParseMode();
		const [moduleSystem, exportPath, visibility] = this.getExportData(symbol, declarationSourceFiles, parseMode);
		const container = tss.Symbol.getParent(symbol);
		if (container === undefined) {
			return { symbolData: new MethodSymbolData(projectId, symbolId, shard, undefined, moduleSystem, visibility, this.symbolDataContext, next), exportPath, moduleSystem, validateVisibilityOn: declarationSourceFiles };
		}
		const mostAbstractMembers = this.symbols.findRootMembers(container, symbol.getName());
		// No abstract members found
		if (mostAbstractMembers === undefined || mostAbstractMembers.length === 0) {
			return { symbolData: new MethodSymbolData(projectId, symbolId, shard, undefined, moduleSystem, visibility, this.symbolDataContext, next), exportPath, moduleSystem, validateVisibilityOn: declarationSourceFiles };
		}
		// It is the symbol itself
		if (mostAbstractMembers.length === 1 && mostAbstractMembers[0] === symbol) {
			return { symbolData: new MethodSymbolData(projectId, symbolId, shard, undefined, moduleSystem, visibility, this.symbolDataContext, next), exportPath, moduleSystem, validateVisibilityOn: declarationSourceFiles };
		}
		const mostAbstractSymbolData = mostAbstractMembers.map(member => this.factoryContext.getOrCreateSymbolData(member));
		return { symbolData: new MethodSymbolData(projectId, symbolId, shard, mostAbstractSymbolData, moduleSystem, visibility, this.symbolDataContext, next), exportPath, moduleSystem, validateVisibilityOn: declarationSourceFiles };
	}
}

class SymbolDataWithRootsFactory extends SymbolDataFactory {

	constructor(typeChecker: ts.TypeChecker, symbols: Symbols, resolverContext: FactoryContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}

	public useGlobalProjectDataManager(symbol: ts.Symbol): boolean {
		if (Symbols.isTransient(symbol)) {
			return true;
		}
		return false;
	}

	public create(projectId: ProjectId, symbol: ts.Symbol, symbolId: SymbolId, declarationSourceFiles: ts.SourceFile[] | undefined, projectDataManager: ProjectDataManager, _currentParsedSourceFile: ts.SourceFile | undefined, next: SymbolData | undefined): FactoryResult {
		const parseMode = projectDataManager.getParseMode();
		const [moduleSystem,,visibility] = this.getExportData(symbol, declarationSourceFiles, parseMode);
		const shard = projectDataManager.getProjectData().project;

		const roots = this.typeChecker.getRootSymbols(symbol);
		if (roots.length === 0) {
			throw new Error(`Root symbol data factory called with symbol without roots.`);
		}
		const symbolDataItems: SymbolData[] = [];
		// The root symbols are not unique. So skipped the once we have already seen
		const seen: Set<SymbolId> = new Set();
		seen.add(tss.Symbol.createKey(this.typeChecker, symbol));
		for (const symbol of roots) {
			const symbolData = this.factoryContext.getOrCreateSymbolData(symbol);
			if (!seen.has(symbolData.symbolId)) {
				seen.add(symbolData.symbolId);
				symbolDataItems.push(symbolData);
			}
		}
		if (Symbols.isTransient(symbol)) {
			// For the moniker we need to find out the ands and ors. Not sure how to do this.
			let monikerIds: Set<string> = new Set();
			for (const symbolData of symbolDataItems) {
				const moniker = symbolData.getMostUniqueMoniker();
				if (moniker === undefined) {
					monikerIds.clear();
					break;
				} else {
					monikerIds.add(moniker.identifier);
				}
			}
			if (monikerIds.size > 0) {
				const exportPath: string = monikerIds.size === 1
					? monikerIds.values().next().value
					: `[${Array.from(monikerIds).sort().join(',')}]`;
				return {
					symbolData: new SymbolDataWithRoots(projectId, symbolId, shard, symbolDataItems, moduleSystem, visibility, this.symbolDataContext, next),
					moduleSystem: ModuleSystemKind.global,
					exportPath: exportPath
				};
			} else {
				return {
					symbolData: new SymbolDataWithRoots(projectId, symbolId, shard, symbolDataItems, moduleSystem, visibility, this.symbolDataContext, next),
				};
			}
		} else {
			const [moduleSystem, exportPath] = this.getExportData(symbol, declarationSourceFiles, parseMode);
			return {
				symbolData: new SymbolDataWithRoots(projectId, symbolId, shard, symbolDataItems, moduleSystem, visibility, this.symbolDataContext, next),
				moduleSystem, exportPath
			};
		}
	}

	public getIdentifierInformation(symbol: ts.Symbol, declaration: ts.Node): [ts.Node, string] | [undefined, undefined] {
		if (Symbols.isTransient(symbol)) {
			return [undefined, undefined];
		}
		return [declaration, declaration.getText()];
	}
}

class TransientFactory extends SymbolDataFactory {

	constructor(typeChecker: ts.TypeChecker, symbols: Symbols, resolverContext: FactoryContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}

	public useGlobalProjectDataManager(): boolean {
		return true;
	}

	public create(projectId: ProjectId, symbol: ts.Symbol, symbolId: SymbolId, declarationSourceFiles: ts.SourceFile[] | undefined, projectDataManager: ProjectDataManager, _currentParsedSourceFile: ts.SourceFile | undefined, next: SymbolData | undefined): FactoryResult {
		const parseMode = projectDataManager.getParseMode();
		const [moduleSystem, exportPath, visibility] = this.getExportData(symbol, declarationSourceFiles, parseMode);
		return { symbolData: new TransientSymbolData(projectId, symbolId, moduleSystem, visibility, this.symbolDataContext, next), moduleSystem, exportPath, validateVisibilityOn: undefined };
	}
}

class TypeAliasFactory extends StandardSymbolDataFactory {
	constructor(typeChecker: ts.TypeChecker, symbols: Symbols, resolverContext: FactoryContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}
}

export interface Reporter {
	reportProgress(scannedFiles: number): void;
	reportStatus(projectName: string, numberOfSymbols: number, numberOfDocuments: number, time: number | undefined): void;
	reportInternalSymbol(symbol: ts.Symbol, symbolId: SymbolId, location: ts.Node | undefined): void;
}

export interface Options {
	group: Group;
	groupRoot: string;
	projectName: string;
	tsConfigFile: string | undefined;
	stdout: boolean;
	dataMode: DataMode;
	reporter: Reporter;
}

enum ParseMode {
	referenced = 1,
	full = 2
}

abstract class ProjectDataManager {

	public readonly id: ProjectId;
	private startTime: number | undefined;

	protected readonly emitter: EmitterContext;
	private readonly projectData: ProjectData;
	private readonly reporter: Reporter;

	private documentStats: number;
	private readonly documentDataItems: DocumentData[];
	private symbolStats: number;
	// We only need to keep public symbol data. Private symbol data are cleared when the
	// corresponding node is processed.
	private readonly managedSymbolDataItems: SymbolData[];

	public constructor(id: ProjectId, emitter: EmitterContext, group: Group, project: Project, reporter: Reporter) {
		this.id = id;
		this.emitter = emitter;
		this.projectData = new ProjectData(emitter, group, project);
		this.reporter = reporter;
		this.documentStats = 0;
		this.documentDataItems = [];
		this.symbolStats = 0;
		this.managedSymbolDataItems = [];
	}

	public abstract getParseMode(): ParseMode;

	public manageSymbolData(symbolData: SymbolData): void {
		this.managedSymbolDataItems.push(symbolData);
	}

	public begin(): void {
		this.startTime = Date.now();
		this.projectData.begin();
	}

	public getProjectData(): ProjectData {
		return this.projectData;
	}

	public createDocumentData(_fileName: string, document: Document, moduleSystem: ModuleSystemKind, monikerPath: string | undefined, external: boolean, next: DocumentData | undefined): DocumentData {
		const result = new DocumentData(this.id, this.emitter, document, moduleSystem, monikerPath, external, next);
		result.begin();
		this.projectData.addDocument(document);
		this.documentStats++;
		this.documentDataItems.push(result);
		return result;
	}

	public createSymbolData(_symbolId: SymbolId, create: (projectDataManager: ProjectDataManager) => FactoryResult): FactoryResult {
		const result = create(this);
		if (result.symbolData.getVisibility() !== SymbolDataVisibility.unknown) {
			this.managedSymbolDataItems.push(result.symbolData);
		}
		this.symbolStats++;
		return result;
	}

	public abstract end(): void;

	protected doEnd(documents: Set<Document> | undefined): void {
		for (const symbolData of this.managedSymbolDataItems) {
			if (documents === undefined) {
				symbolData.end();
			} else {
				symbolData.endPartitions(this.id, documents);
			}
		}
		for (const data of this.documentDataItems) {
			if (!data.isClosed) {
				data.end();
				data.close();
			}
		}
		this.projectData.end();
		let name: string;
		if (this.projectData.project.resource !== undefined && this.projectData.group !== undefined) {
			const uri = this.projectData.project.resource;
			const root = this.projectData.group.rootUri;
			if (uri.startsWith(root)) {
				name = uri.substr(root.length + 1);
			} else {
				name = `${this.getName()} (${uri})`;
			}
		} else {
			name = this.getName();
		}
		this.reporter.reportStatus(name, this.symbolStats, this.documentStats, this.startTime !== undefined ? Date.now() - this.startTime : undefined);
	}

	protected getName(): string {
		return this.projectData.project.resource || this.projectData.project.name;
	}
}

enum LazyProjectDataManagerState {
	start = 1,
	beginCalled = 2,
	beginExecuted = 3,
	endCalled = 4
}

class LazyProjectDataManager extends ProjectDataManager {

	private state: LazyProjectDataManagerState;

	public constructor(id: ProjectId, emitter: EmitterContext, group: Group, project: Project, reporter: Reporter) {
		super(id, emitter, group, project, reporter);
		this.state = LazyProjectDataManagerState.start;
	}

	public getParseMode(): ParseMode {
		return ParseMode.referenced;
	}

	public begin(): void {
		this.state = LazyProjectDataManagerState.beginCalled;
	}

	private executeBegin(): void {
		super.begin();
		this.state = LazyProjectDataManagerState.beginExecuted;
	}

	private checkState(): void {
		if (this.state !== LazyProjectDataManagerState.beginExecuted) {
			throw new Error(`Project data manager has wrong state ${this.state}`);
		}
	}

	public end(): void {
		if (this.state === LazyProjectDataManagerState.beginExecuted) {
			super.doEnd(undefined);
		}
		this.state = LazyProjectDataManagerState.endCalled;
	}

	public getProjectData(): ProjectData {
		if (this.state === LazyProjectDataManagerState.beginCalled) {
			this.executeBegin();
		}
		this.checkState();
		return super.getProjectData();
	}

	public createDocumentData(fileName: string, document: Document, moduleSystem: ModuleSystemKind, monikerPath: string | undefined, external: boolean, next: DocumentData | undefined): DocumentData {
		if (this.state === LazyProjectDataManagerState.beginCalled) {
			this.executeBegin();
		}
		this.checkState();
		return super.createDocumentData(fileName, document, moduleSystem, monikerPath, external, next);
	}

	public createSymbolData(symbolId: SymbolId, create: (projectDataManager: ProjectDataManager) => FactoryResult): FactoryResult {
		if (this.state === LazyProjectDataManagerState.beginCalled) {
			this.executeBegin();
		}
		this.checkState();
		return super.createSymbolData(symbolId, create);
	}
}

class GlobalProjectDataManager extends LazyProjectDataManager {

	public constructor(id: ProjectId, emitter: EmitterContext, group: Group, project: Project, reporter: Reporter) {
		super(id, emitter, group, project, reporter);
	}

	protected getName(): string {
		return 'Global libraries';
	}
}


class DefaultLibsProjectDataManager extends LazyProjectDataManager {

	public constructor(id: ProjectId, emitter: EmitterContext, group: Group, project: Project, reporter: Reporter) {
		super(id, emitter, group, project, reporter);
	}

	protected getName(): string {
		return 'TypeScript default libraries';
	}
}

class GroupProjectDataManager extends LazyProjectDataManager {

	private readonly groupName: string;
	private readonly groupRoot: string;

	public constructor(id: ProjectId, emitter: EmitterContext, group: Group, project: Project, groupRoot: string, reporter: Reporter) {
		super(id, emitter, group, project, reporter);
		this.groupName = group.name;
		this.groupRoot = groupRoot;
	}

	public handles(sourceFile: ts.SourceFile): boolean {
		const fileName = sourceFile.fileName;
		return paths.isParent(this.groupRoot, fileName);
	}

	protected getName(): string {
		return `Workspace libraries for ${this.groupName}`;
	}
}

class TSConfigProjectDataManager extends ProjectDataManager {

	private readonly sourceRoot: string;
	private readonly projectFiles: Set<string>;
	private readonly managedDocuments: Set<Document>;

	public constructor(id: ProjectId, emitter: EmitterContext, group: Group, project: Project, sourceRoot: string, projectFiles: ReadonlyArray<string> | undefined, reporter: Reporter) {
		super(id, emitter, group, project, reporter);
		this.sourceRoot = sourceRoot;
		this.projectFiles = new Set(projectFiles);
		this.managedDocuments = new Set();
	}

	public getParseMode(): ParseMode {
		return ParseMode.full;
	}

	public handles(sourceFile: ts.SourceFile): boolean {
		const fileName = sourceFile.fileName;
		return this.projectFiles.has(fileName) || paths.isParent(this.sourceRoot, fileName);
	}

	public createDocumentData(fileName: string, document: Document, moduleSystem: ModuleSystemKind, monikerPath: string | undefined, external: boolean, next: DocumentData | undefined): DocumentData {
		this.managedDocuments.add(document);
		return super.createDocumentData(fileName, document, moduleSystem, monikerPath, external, next);
	}

	public end(): void {
		this.doEnd(this.managedDocuments);
	}
}

interface TSProjectConfig {
	groupRoot: string;
	configLocation: string | undefined;
	sourceRoot: string;
	outDir: string;
	dependentOutDirs: string[];
}

interface TSProjectContext extends EmitterContext {
	getDocumentData(sourceFile: ts.SourceFile): DocumentData | undefined;
	getOrCreateDocumentData(sourceFile: ts.SourceFile): DocumentData;
	getSymbolData(symbol: ts.Symbol | string): SymbolData | undefined;
	getOrCreateSymbolData(symbol: ts.Symbol): SymbolData;
}

class TSProject {

	public readonly id: ProjectId;
	private context: TSProjectContext;
	private languageService: ts.LanguageService;
	private typeChecker: ts.TypeChecker;
	public readonly references: ProjectInfo[];

	private config: TSProjectConfig;
	private referencedProjectIds: Set<ProjectId>;

	private rootFileNames: Set<string>;
	private sourceFilesToIndex: ts.SourceFile[] | undefined;
	private symbols: Symbols;
	private symbolDataFactories: {
		standard: StandardSymbolDataFactory;
		alias: AliasFactory;
		method: MethodFactory;
		withRoots: SymbolDataWithRootsFactory;
		transient: TransientFactory;
		typeAlias: TypeAliasFactory;
	};

	constructor(context: TSProjectContext, languageService: ts.LanguageService, references: ProjectInfo[], options: Options, symbolDataContext: SymbolDataContext) {
		this.id = ProjectId.next();
		this.context = context;
		this.languageService = languageService;
		this.references = references;
		const program = languageService.getProgram()!;
		const typeChecker = program.getTypeChecker();
		this.typeChecker = typeChecker;

		let dependentOutDirs = [];
		for (const info of references) {
			dependentOutDirs.push(info.outDir);
		}
		dependentOutDirs.sort((a, b) => {
			return b.length - a.length;
		});

		const configLocation = options.tsConfigFile !== undefined ? path.dirname(options.tsConfigFile) : undefined;
		const compilerOptions = program.getCompilerOptions();
		let sourceRoot: string;
		if (compilerOptions.rootDir !== undefined) {
			sourceRoot = tss.makeAbsolute(compilerOptions.rootDir, configLocation);
		} else if (compilerOptions.baseUrl !== undefined) {
			sourceRoot = tss.makeAbsolute(compilerOptions.baseUrl, configLocation);
		} else {
			sourceRoot = tss.normalizePath(tss.Program.getCommonSourceDirectory(program));
		}
		let outDir: string;
		if (compilerOptions.outDir !== undefined) {
			outDir = tss.makeAbsolute(compilerOptions.outDir, configLocation);
		} else {
			outDir = sourceRoot;
		}

		this.config = {
			groupRoot: options.groupRoot,
			configLocation,
			sourceRoot,
			outDir,
			dependentOutDirs
		};

		this.referencedProjectIds = new Set();
		const flatten = (projectInfo: ProjectInfo): void => {
			this.referencedProjectIds.add(projectInfo.id);
			projectInfo.references.forEach(flatten);
		};
		references.forEach(flatten);
		this.rootFileNames = new Set(program.getRootFileNames());

		this.symbols = new Symbols(typeChecker);
		this.symbolDataFactories = {
			standard: new StandardSymbolDataFactory(typeChecker, this.symbols, context, symbolDataContext),
			alias: new AliasFactory(typeChecker, this.symbols, context, symbolDataContext),
			method: new MethodFactory(typeChecker, this.symbols, context, symbolDataContext),
			withRoots: new SymbolDataWithRootsFactory(typeChecker, this.symbols, context, symbolDataContext),
			transient: new TransientFactory(typeChecker, this.symbols, context, symbolDataContext),
			typeAlias: new TypeAliasFactory(typeChecker, this.symbols, context, symbolDataContext)
		};
	}

	protected get vertex(): VertexBuilder {
		return this.context.vertex;
	}

	protected get edge(): EdgeBuilder {
		return this.context.edge;
	}

	protected emit(element: Vertex | Edge): void {
		this.context.emit(element);
	}

	public contains(projectId: ProjectId): boolean {
		return this.id === projectId || this.referencedProjectIds.has(projectId);
	}

	public hasAccess(fileName: string, data: DocumentData): boolean {
		if (this.id === data.projectId) {
			return true;
		}
		if (this.rootFileNames.has(fileName)) {
			return false;
		}
		if (this.referencedProjectIds.has(data.projectId)) {
			return true;
		}
		return false;
	}

	public getConfig(): TSProjectConfig {
		return this.config;
	}

	public setSymbolChainCache(cache: ts.SymbolChainCache): void {
		this.typeChecker.setSymbolChainCache(cache);
	}

	public getProgram(): ts.Program {
		return this.languageService.getProgram()!;
	}

	public getSymbols(): Symbols {
		return this.symbols;
	}

	public getSymbolId(symbol: ts.Symbol): SymbolId {
		return tss.Symbol.createKey(this.typeChecker, symbol);
	}

	public getRootFileNames(): ReadonlyArray<string> {
		return this.getProgram().getRootFileNames();
	}

	public getSourceFilesToIndex(): ReadonlyArray<ts.SourceFile> {
		if (this.sourceFilesToIndex !== undefined) {
			return this.sourceFilesToIndex;
		}
		this.sourceFilesToIndex = [];
		const program = this.getProgram();
		for (const sourceFile of program.getSourceFiles()) {
			if (tss.Program.isSourceFileFromExternalLibrary(program, sourceFile) || tss.Program.isSourceFileDefaultLibrary(program, sourceFile)) {
				continue;
			}
			const documentData = this.context.getDocumentData(sourceFile);
			if (documentData !== undefined && this.hasAccess(sourceFile.fileName, documentData)) {
				continue;
			}
			this.sourceFilesToIndex.push(sourceFile);
		}
		return this.sourceFilesToIndex;
	}

	public getSourceFilesToIndexFileNames(): ReadonlyArray<string> {
		return this.getSourceFilesToIndex().map(sourceFile => sourceFile.fileName);
	}

	public getSymbolAtLocation(node: ts.Node): ts.Symbol | undefined {
		let result = this.typeChecker.getSymbolAtLocation(node);
		if (result === undefined) {
			result = tss.Node.getSymbol(node);
		}
		return result;
	}

	public getTypeAtLocation(node: ts.Node): ts.Type {
		return this.typeChecker.getTypeAtLocation(node);
	}

	public getTypeOfSymbolAtLocation(symbol: ts.Symbol, node: ts.Node): ts.Type {
		return this.typeChecker.getTypeOfSymbolAtLocation(symbol, node);
	}

	public getAliasedSymbol(symbol: ts.Symbol): ts.Symbol {
		return this.typeChecker.getAliasedSymbol(symbol);
	}

	public isSourceFileDefaultLibrary(sourceFile: ts.SourceFile): boolean {
		return tss.Program.isSourceFileDefaultLibrary(this.getProgram(), sourceFile);
	}

	public isSourceFileFromExternalLibrary(sourceFile: ts.SourceFile): boolean {
		return tss.Program.isSourceFileFromExternalLibrary(this.getProgram(), sourceFile);
	}

	public getCommonSourceDirectory(): string {
		return tss.Program.getCommonSourceDirectory(this.getProgram());
	}

	public getFactory(symbol: ts.Symbol): SymbolDataFactory {
		const rootSymbols = this.typeChecker.getRootSymbols(symbol);
		if (rootSymbols.length > 0 && rootSymbols[0] !== symbol) {
			return this.symbolDataFactories.withRoots;
		}

		if (Symbols.isTransient(symbol)) {
			return this.symbolDataFactories.transient;
		}
		if (Symbols.isTypeAlias(symbol)) {
			return this.symbolDataFactories.typeAlias;
		}
		if (Symbols.isAliasSymbol(symbol)) {
			return this.symbolDataFactories.alias;
		}
		if (Symbols.isMethodSymbol(symbol)) {
			return this.symbolDataFactories.method;
		}
		return this.symbolDataFactories.standard;
	}

	public createDocumentData(manager: ProjectDataManager, sourceFile: ts.SourceFile, next: DocumentData | undefined): [DocumentData, ts.Symbol | undefined] {
		const groupRoot = this.config.groupRoot;
		const sourceRoot = this.config.sourceRoot;
		const outDir = this.config.outDir;
		const dependentOutDirs = this.config.dependentOutDirs;

		const isFromExternalLibrary = (sourceFile: ts.SourceFile): boolean => {
			return tss.Program.isSourceFileFromExternalLibrary(this.languageService.getProgram()!, sourceFile);
		};

		const isFromProjectSources = (sourceFile: ts.SourceFile): boolean => {
			const fileName = sourceFile.fileName;
			return !sourceFile.isDeclarationFile || paths.isParent(sourceRoot, fileName);
		};

		const isFromDependentProject = (sourceFile: ts.SourceFile): boolean => {
			if (!sourceFile.isDeclarationFile) {
				return false;
			}
			const fileName = sourceFile.fileName;
			for (let outDir of dependentOutDirs) {
				if (fileName.startsWith(outDir)) {
					return true;
				}
			}
			return false;
		};

		const isFromGroupRoot = (sourceFile: ts.SourceFile): boolean => {
			return paths.isParent(groupRoot, sourceFile.fileName);
		};

		const document = this.vertex.document(sourceFile.fileName, sourceFile.text);
		const fileName = sourceFile.fileName;

		let monikerPath: string | undefined;
		let external: boolean = false;
		if (isFromExternalLibrary(sourceFile)) {
			external = true;
			monikerPath = tss.computeMonikerPath(groupRoot, fileName);
		} else if (isFromProjectSources(sourceFile)) {
			monikerPath = tss.computeMonikerPath(groupRoot, tss.toOutLocation(fileName, sourceRoot, outDir));
		} else if (isFromDependentProject(sourceFile)) {
			external = true;
			monikerPath = tss.computeMonikerPath(groupRoot, fileName);
		} else if (isFromGroupRoot(sourceFile)) {
			external = sourceFile.isDeclarationFile;
			monikerPath = tss.computeMonikerPath(groupRoot, fileName);
		}

		const symbol = this.typeChecker.getSymbolAtLocation(sourceFile);
		return [manager.createDocumentData(fileName, document, symbol !== undefined ? ModuleSystemKind.module : ModuleSystemKind.global, monikerPath, external, next), symbol];
	}

	public createSymbolData(manager: ProjectDataManager, created: (data: SymbolData) => void, symbol: ts.Symbol, next: SymbolData | undefined, __location?: ts.Node, __parsedSourceFile?: ts.SourceFile): { symbolData: SymbolData; validateVisibilityOn?: ts.SourceFile[] } {
		const symbolId: SymbolId = tss.Symbol.createKey(this.typeChecker, symbol);
		const factory = this.getFactory(symbol);
		const declarations: ts.Node[] | undefined = factory.getDeclarationNodes(symbol);
		const declarationSourceFiles: ts.SourceFile[] | undefined = factory.getDeclarationSourceFiles(symbol);
		// Make sure all referenced document data for the source files containing declarations exist
		if (declarationSourceFiles !== undefined) {
			for (const sourceFile of declarationSourceFiles) {
				this.context.getOrCreateDocumentData(sourceFile);
			}
		}

		const result = manager.createSymbolData(symbolId, (projectDataManager) => {
			const result = factory.create(projectDataManager.id, symbol, symbolId, declarationSourceFiles, projectDataManager, __parsedSourceFile, next);
			created(result.symbolData);
			return result;
		});
		const { symbolData, moduleSystem, exportPath, validateVisibilityOn } = result;

		const [monikerIdentifer, external] = this.getMonikerIdentifier(declarationSourceFiles, Symbols.isSourceFile(symbol), moduleSystem, exportPath);

		if (monikerIdentifer === undefined) {
			symbolData.addMoniker(symbolId, MonikerKind.local);
		} else {
			if (external === true) {
				symbolData.addMoniker(monikerIdentifer, MonikerKind.import);
			} else {
				symbolData.addMoniker(monikerIdentifer, MonikerKind.export);
			}
		}

		if (declarations === undefined || declarations.length === 0 || Symbols.isTransient(symbol)) {
			return result;
		}

		let hover: lsp.Hover | undefined;
		for (let declaration of declarations) {
			const sourceFile = declaration.getSourceFile();
			const [identifierNode, identifierText] = factory.getIdentifierInformation(symbol, declaration);
			if (identifierNode !== undefined && identifierText !== undefined) {
				const documentData = this.context.getDocumentData(sourceFile);
				if (documentData === undefined) {
					throw new Error(`No document data for ${sourceFile.fileName} found`);
				}
				const range = ts.isSourceFile(declaration) ? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } : Converter.rangeFromNode(sourceFile, identifierNode);
				const definition = this.vertex.range(range, {
					type: RangeTagTypes.definition,
					text: identifierText,
					kind: Converter.asSymbolKind(declaration),
					fullRange: Converter.rangeFromNode(sourceFile, declaration),
				});
				documentData.addRange(definition);
				symbolData.addDefinition(manager.id, documentData.document, definition);
				symbolData.recordDefinitionInfo(tss.createDefinitionInfo(sourceFile, identifierNode));
				if (hover === undefined && tss.Node.isNamedDeclaration(declaration)) {
					// let start = Date.now();
					hover = this.getHover(declaration.name, sourceFile);
					// this.hoverCalls++;
					// let diff = Date.now() - start;
					// this.hoverTotal += diff;
					// if (diff > 100) {
					// 	console.log(`Computing hover took ${diff} ms for symbol ${id} | ${symbol.getName()} | ${this.hoverCalls} | ${this.hoverTotal}`)
					// }
					if (hover) {
						symbolData.addHover(hover);
					} else {
						// console.log(`Hover returned undefined for $symbol ${id} | ${symbol.getName()}`);
					}
				}
			}
		}
		return { symbolData, validateVisibilityOn };
	}

	private getMonikerIdentifier(sourceFiles: ts.SourceFile[] | undefined, isSourceFile: boolean, moduleSystem: ModuleSystemKind | undefined, exportPath: string | undefined): [string | undefined, boolean | undefined] {
		const documentDataItems: DocumentData[] | undefined = sourceFiles !== undefined
			? sourceFiles.map((sourceFile) => this.context.getOrCreateDocumentData(sourceFile))
			: undefined;

		let monikerIdentifer: string | undefined;
		const monikerFilePaths: Set<string> = new Set();
		let external: boolean | undefined;
		if (documentDataItems !== undefined) {
			for (const data of documentDataItems) {
				if (data.monikerFilePath !== undefined) {
					monikerFilePaths.add(data.monikerFilePath);
				}
				if (external === undefined) {
					external = data.external;
				} else {
					external = external && data.external;
				}
			}
		}
		const monikerFilePath: string | undefined = monikerFilePaths.size === 0
			? undefined
			: monikerFilePaths.size === 1
				? monikerFilePaths.values().next().value
				: `[${Array.from(monikerFilePaths.values()).join(',')}]`;

		if (isSourceFile && monikerFilePath !== undefined) {
			monikerIdentifer = tss.createMonikerIdentifier(monikerFilePath, undefined);
		}
		if (monikerIdentifer === undefined && exportPath !== undefined) {
			if (moduleSystem === undefined || moduleSystem === ModuleSystemKind.global) {
				monikerIdentifer = tss.createMonikerIdentifier(undefined, exportPath);
			}
			if (monikerIdentifer === undefined && monikerFilePath !== undefined) {
				monikerIdentifer = tss.createMonikerIdentifier(monikerFilePath, exportPath);
			}
		}
		return [monikerIdentifer, external];
	}

	private getHover(node: ts.DeclarationName, sourceFile?: ts.SourceFile): lsp.Hover | undefined {
		if (sourceFile === undefined) {
			sourceFile = node.getSourceFile();
		}
		// ToDo@dbaeumer Crashes sometimes with.
		// TypeError: Cannot read property 'kind' of undefined
		// 	at pipelineEmitWithHint (C:\Users\dirkb\Projects\mseng\VSCode\lsif-node\tsc\node_modules\typescript\lib\typescript.js:84783:39)
		// 	at print (C:\Users\dirkb\Projects\mseng\VSCode\lsif-node\tsc\node_modules\typescript\lib\typescript.js:84683:13)
		// 	at Object.writeNode (C:\Users\dirkb\Projects\mseng\VSCode\lsif-node\tsc\node_modules\typescript\lib\typescript.js:84543:13)
		// 	at C:\Users\dirkb\Projects\mseng\VSCode\lsif-node\tsc\node_modules\typescript\lib\typescript.js:109134:50
		// 	at Object.mapToDisplayParts (C:\Users\dirkb\Projects\mseng\VSCode\lsif-node\tsc\node_modules\typescript\lib\typescript.js:97873:13)
		// 	at Object.getSymbolDisplayPartsDocumentationAndSymbolKind (C:\Users\dirkb\Projects\mseng\VSCode\lsif-node\tsc\node_modules\typescript\lib\typescript.js:109132:61)
		// 	at C:\Users\dirkb\Projects\mseng\VSCode\lsif-node\tsc\node_modules\typescript\lib\typescript.js:122472:41
		// 	at Object.runWithCancellationToken (C:\Users\dirkb\Projects\mseng\VSCode\lsif-node\tsc\node_modules\typescript\lib\typescript.js:31637:28)
		// 	at Object.getQuickInfoAtPosition (C:\Users\dirkb\Projects\mseng\VSCode\lsif-node\tsc\node_modules\typescript\lib\typescript.js:122471:34)
		// 	at Visitor.getHover (C:\Users\dirkb\Projects\mseng\VSCode\lsif-node\tsc\lib\lsif.js:1498:46)
		try {
			let quickInfo = this.languageService.getQuickInfoAtPosition(node, sourceFile);
			if (quickInfo === undefined) {
				return undefined;
			}
			return Converter.asHover(sourceFile, quickInfo);
		} catch (err) {
			return undefined;
		}
	}

	public computeAdditionalExportPaths(sourceFile: ts.SourceFile, start: ts.Symbol | ts.Type, exportName: string, moduleSystem: ModuleSystemKind, traverseMode?: TraverseMode): [SymbolData, string][] {
		return this.symbols.computeAdditionalExportPaths(this.context, sourceFile, start, exportName, moduleSystem, traverseMode);
	}
}

export enum DataMode {
	free = 1,
	keep = 2
}

export class DataManager implements SymbolDataContext {

	private static readonly GlobalId: string = 'bc450df0-741c-4ee7-9e0e-eddd95f8f314';
	private static readonly DefaultLibsId: string = '5779b280-596f-4b5d-90d8-b87441d7afa0';

	private readonly context: EmitterContext;
	private readonly group: Group;
	private readonly reporter: Reporter;
	private readonly dataMode: DataMode;

	private readonly globalPDM: GlobalProjectDataManager;
	private readonly defaultLibsPDM: DefaultLibsProjectDataManager;
	private readonly groupPDM: GroupProjectDataManager;

	private currentTSProject: TSProject | undefined;
	private currentPDM: TSConfigProjectDataManager | undefined;

	private readonly documentDataItems: Map<string, DocumentData>;
	private readonly symbolDataItems: Map<string, SymbolData>;
	private readonly clearedSymbolDataItems: Map<string, ProjectId[]>;
	private readonly partitionLifeCycle: Map<Id /* Document | Project */, SymbolData[]>;
	private readonly validateVisibilityCounter: Map<string, { projectDataManager: ProjectDataManager; counter: number }>;
	private readonly validateVisibilityOn: Map<string, SymbolData[]>

	public constructor(context: EmitterContext, group: Group, groupRoot: string, reporter: Reporter, dataMode: DataMode) {
		this.context = context;
		this.group = group;
		this.reporter = reporter;
		this.dataMode = dataMode;
		this.documentDataItems = new Map();
		this.symbolDataItems = new Map();
		this.clearedSymbolDataItems = new Map();
		this.partitionLifeCycle = new Map();
		this.validateVisibilityCounter = new Map();
		this.validateVisibilityOn = new Map();

		this.globalPDM = new GlobalProjectDataManager(ProjectId.next(), this, this.group, this.context.vertex.project(DataManager.GlobalId), reporter);
		this.defaultLibsPDM = new DefaultLibsProjectDataManager(ProjectId.next(), this, this.group, this.context.vertex.project(DataManager.DefaultLibsId), reporter);
		this.groupPDM = new GroupProjectDataManager(ProjectId.next(), this, this.group, this.context.vertex.project(group.name), groupRoot, reporter);
	}

	public get vertex(): VertexBuilder {
		return this.context.vertex;
	}

	public get edge(): EdgeBuilder {
		return this.context.edge;
	}

	public emit(element: Vertex | Edge): void {
		this.context.emit(element);
	}

	public begin(): void {
		this.globalPDM.begin();
		this.defaultLibsPDM.begin();
		this.groupPDM.begin();
	}

	public beginProject(tsProject: TSProject, project: Project): void {
		if (this.currentPDM !== undefined) {
			throw new Error(`There is already a current program data manager set`);
		}
		this.currentTSProject = tsProject;
		this.currentPDM = new TSConfigProjectDataManager(tsProject.id, this, this.group, project, tsProject.getConfig().sourceRoot, tsProject.getSourceFilesToIndexFileNames(), this.reporter);
		this.currentPDM.begin();
	}

	private assertTSProject(value: TSProject | undefined): asserts value is TSProject {
		if (value === undefined) {
			throw new Error(`No current TS project set.`);
		}
	}

	public getProjectData(): ProjectData {
		if (this.currentPDM === undefined) {
			throw new Error(`No current project`);
		}
		return this.currentPDM.getProjectData();
	}

	public getTSProject(): TSProject {
		this.assertTSProject(this.currentTSProject);
		return this.currentTSProject;
	}

	public endProject(tsProject: TSProject): void {
		if (this.currentTSProject !== tsProject || this.currentPDM === undefined) {
			throw new Error(`Current project is not the one passed to end.`);
		}
		this.currentPDM.end();
		this.currentPDM = undefined;
		this.currentTSProject = undefined;
	}

	public end(): void {
		this.globalPDM.end();
		this.defaultLibsPDM.end();
		this.groupPDM.end();
	}

	public getDocumentData(stringOrSourceFile: ts.SourceFile | string): DocumentData | undefined {
		const fileName: string = typeof stringOrSourceFile === 'string' ? stringOrSourceFile : stringOrSourceFile.fileName;
		let candidate = this.documentDataItems.get(fileName);
		if (candidate === undefined) {
			return candidate;
		}
		this.assertTSProject(this.currentTSProject);
		while (candidate !== undefined) {
			const id = candidate.projectId;
			if (this.isGlobalProjectId(id) || this.currentTSProject.hasAccess(fileName, candidate)) {
				return candidate;
			}
			candidate = candidate.next;
		}
		return undefined;
	}

	public getOrCreateDocumentData(sourceFile: ts.SourceFile): DocumentData {
		let result = this.getDocumentData(sourceFile);
		if (result !== undefined) {
			return result;
		}
		this.assertTSProject(this.currentTSProject);
		const fileName = sourceFile.fileName;
		const manager: ProjectDataManager = this.getProjectDataManager(sourceFile);
		const next = this.documentDataItems.get(fileName);
		let symbol: ts.Symbol | undefined;
		[result, symbol] = this.currentTSProject.createDocumentData(manager, sourceFile, next);
		this.documentDataItems.set(fileName, result);
		if (symbol !== undefined) {
			this.getOrCreateSymbolData(symbol, sourceFile);
		}
		return result;
	}

	public getProjectId(sourceFile: ts.SourceFile): ProjectId {
		return this.getProjectDataManager(sourceFile).id;
	}

	private getProjectDataManager(sourceFile: ts.SourceFile): ProjectDataManager {
		if (this.currentTSProject !== undefined && tss.Program.isSourceFileDefaultLibrary(this.currentTSProject.getProgram(), sourceFile)) {
			return this.defaultLibsPDM;
		} else if (this.currentPDM !== undefined && this.currentPDM.handles(sourceFile)) {
			return this.currentPDM;
		} else if (this.groupPDM.handles(sourceFile)) {
			return this.groupPDM;
		} else {
			return this.globalPDM;
		}
	}

	public documentProcessed(sourceFile: ts.SourceFile): void {
		const fileName = sourceFile.fileName;
		const data = this.getDocumentData(sourceFile);
		if (data === undefined) {
			throw new Error(`No document data for file ${fileName}`);
		}
		const handledSymbolData: Set<string> = new Set();
		const validateVisibilityOn = this.validateVisibilityOn.get(fileName);
		this.validateVisibilityOn.delete(fileName);
		if (validateVisibilityOn !== undefined) {
			for (const symbolData of validateVisibilityOn) {
				const symbolId = symbolData.symbolId;
				const counter = this.validateVisibilityCounter.get(symbolId);
				// If the counter is already gone then the visibility already changed.
				if (counter !== undefined) {
					if (symbolData.keep()) {
						counter.projectDataManager.manageSymbolData(symbolData);
						this.validateVisibilityCounter.delete(symbolId);
					} else if (counter.counter === 1) {
						if (symbolData.release()) {
							symbolData.changeVisibility(SymbolDataVisibility.internal);
							if (this.dataMode === DataMode.free) {
								handledSymbolData.add(symbolId);
								symbolData.end();
								let cleared = this.clearedSymbolDataItems.get(symbolId);
								if (cleared === undefined) {
									cleared = [];
									this.clearedSymbolDataItems.set(symbolId, cleared);
								}
								cleared.push(symbolData.projectId);
								this.removeSymbolData(symbolData);
							} else {
								counter.projectDataManager.manageSymbolData(symbolData);
							}
						}
						this.validateVisibilityCounter.delete(symbolId);
					} else {
						counter.counter--;
					}
				}
			}
		}
		const items = this.partitionLifeCycle.get(data.document.id);
		if (items !== undefined) {
			for (const symbolData of items) {
				if (!handledSymbolData.has(symbolData.symbolId)) {
					symbolData.endPartition(this.getProjectId(sourceFile), data.document);
				}
			}
		}
		data.end();
		data.close();
	}

	private removeSymbolData(symbolData: SymbolData): void {
		const symbolId = symbolData.symbolId;
		let cleared = this.clearedSymbolDataItems.get(symbolId);
		if (cleared === undefined) {
			cleared = [];
			this.clearedSymbolDataItems.set(symbolId, cleared);
		}
		cleared.push(symbolData.projectId);
		const current = this.symbolDataItems.get(symbolId);
		// This is the 99% case
		if (current === symbolData) {
			if (symbolData.next === undefined) {
				this.symbolDataItems.delete(symbolId);
			} else {
				this.symbolDataItems.set(symbolId, symbolData.next);
			}
		} else {
			let previous = current;
			while (previous !== undefined && previous.next !== symbolData) {
				previous = previous.next;
			}
			if (previous !== undefined) {
				previous.setNext(symbolData.next);
			}
		}
		symbolData.setNext(undefined);
	}

	public handleSymbol(documentData: DocumentData, symbol: ts.Symbol, location: ts.Node, sourceFile: ts.SourceFile): void {
		const symbolData = this.getOrCreateSymbolData(symbol, location, sourceFile);
		if (symbolData.hasDefinitionInfo(tss.createDefinitionInfo(sourceFile, location))) {
			return;
		}

		const reference = this.vertex.range(Converter.rangeFromNode(sourceFile, location), { type: RangeTagTypes.reference, text: location.getText() });
		documentData.addRange(reference);
		symbolData.addReference(this.getProjectId(sourceFile), documentData.document, reference, ItemEdgeProperties.references);
	}

	public getSymbolData(symbol: SymbolId | ts.Symbol): SymbolData | undefined {
		this.assertTSProject(this.currentTSProject);
		let symbolId: SymbolId;
		if (typeof symbol === 'string') {
			symbolId = symbol;
		} else {
			symbolId = this.currentTSProject.getSymbolId(symbol);
		}
		const cleared = this.clearedSymbolDataItems.get(symbolId);
		if (cleared !== undefined) {
			for (const projectId of cleared) {
				if (this.currentTSProject.contains(projectId)) {
					throw new Error(`There was already a managed symbol data for id: ${symbolId}`);
				}
			}
		}
		let candidate = this.symbolDataItems.get(symbolId);
		while (candidate !== undefined) {
			const projectId = candidate.projectId;
			if (this.isGlobalProjectId(projectId) || this.currentTSProject.contains(projectId)) {
				return candidate;
			}
			candidate = candidate.next;
		}
		return undefined;
	}

	public getOrCreateSymbolData(symbol: ts.Symbol, __location?: ts.Node, __parsedSourceFile?: ts.SourceFile): SymbolData {
		let symbolData = this.getSymbolData(symbol);
		if (symbolData !== undefined) {
			return symbolData;
		}
		this.assertTSProject(this.currentTSProject);
		const symbolId = this.currentTSProject.getSymbolId(symbol);
		if (symbolId === 'pI+jLJFVyQNRx9JWm7T1vg==') {
			debugger;
		}
		const factory = this.currentTSProject.getFactory(symbol);
		const sourceFiles = factory.getDeclarationSourceFiles(symbol);
		const useGlobalProjectDataManager = factory.useGlobalProjectDataManager(symbol);
		let manager: ProjectDataManager;
		if (useGlobalProjectDataManager || sourceFiles === undefined || sourceFiles.length === 0) {
			manager = this.globalPDM;
		} else {
			manager = this.getProjectDataManager(sourceFiles[0]);
			for (let i = 1; i < sourceFiles.length; i++) {
				if (manager !== this.getProjectDataManager(sourceFiles[i])) {
					manager = this.globalPDM;
					break;
				}
			}
		}
		const next = this.symbolDataItems.get(symbolId);
		const result = this.currentTSProject.createSymbolData(manager, (symbolData) => {
			this.symbolDataItems.set(symbolData.symbolId, symbolData);
			symbolData.begin();
		}, symbol, next, __location, __parsedSourceFile);

		symbolData = result.symbolData;
		if (manager.getParseMode() === ParseMode.full && symbolData.getVisibility() === SymbolDataVisibility.unknown && result.validateVisibilityOn !== undefined && result.validateVisibilityOn.length > 0) {
			const counter = result.validateVisibilityOn.length;
			this.validateVisibilityCounter.set(symbolData.symbolId, { counter, projectDataManager: manager });
			for (const sourceFile of result.validateVisibilityOn) {
				let items = this.validateVisibilityOn.get(sourceFile.fileName);
				if (items === undefined) {
					items = [];
					this.validateVisibilityOn.set(sourceFile.fileName, items);
				}
				items.push(symbolData);
			}
		}

		return symbolData;
	}

	public managePartitionLifeCycle(shard: Shard, symbolData: SymbolData): void {
		let items = this.partitionLifeCycle.get(shard.id);
		if (items === undefined) {
			items = [];
			this.partitionLifeCycle.set(shard.id, items);
		}
		items.push(symbolData);
	}

	private isGlobalProjectId(id: ProjectId): boolean {
		return id === this.globalPDM.id || id === this.defaultLibsPDM.id || id === this.groupPDM.id;
	}
}

export interface ProjectInfo {
	id: ProjectId;
	sourceRoot: string;
	outDir: string;
	references: ProjectInfo[];
}

export class SimpleSymbolChainCache implements ts.SymbolChainCache {

	public lookup(key: ts.SymbolChainCacheKey): ts.Symbol[] {
		return [key.symbol];
	}
	public cache(_key: ts.SymbolChainCacheKey, _value: ts.Symbol[]): void {
		// do nothing;
	}
}

export class FullSymbolChainCache implements ts.SymbolChainCache {

	private store: LRUCache<string, ts.Symbol[]> = new LRUCache(4096);

	constructor(private typeChecker: ts.TypeChecker) {
	}

	public lookup(key: ts.SymbolChainCacheKey): ts.Symbol[] | undefined {
		if (key.endOfChain) {
			return undefined;
		}
		let sKey = this.makeKey(key);
		let result = this.store.get(sKey);
		//process.stdout.write(result === undefined ? '0' : '1');
		return result;
	}
	public cache(key: ts.SymbolChainCacheKey, value: ts.Symbol[]): void {
		if (key.endOfChain) {
			return;
		}
		let sKey = this.makeKey(key);
		this.store.set(sKey, value);
	}

	private makeKey(key: ts.SymbolChainCacheKey): string {
		let symbolKey = tss.Symbol.createKey(this.typeChecker, key.symbol);
		let declaration = key.enclosingDeclaration ? `${key.enclosingDeclaration.pos}|${key.enclosingDeclaration.end}` : '';
		return `${symbolKey}|${declaration}|${key.flags}|${key.meaning}|${!!key.yieldModuleSymbol}`;
	}
}

class Visitor {

	private tsProject: TSProject;

	private project: Project;
	private currentSourceFile: ts.SourceFile | undefined;
	private _currentDocumentData: DocumentData | undefined;
	private disposables: Map<string, Disposable[]>;
	private symbolContainer: RangeBasedDocumentSymbol[];
	private recordDocumentSymbol: boolean[];
	private dataManager: DataManager;

	constructor(private emitter: EmitterContext, private languageService: ts.LanguageService, dataManager: DataManager, dependsOn: ProjectInfo[], private options: Options) {
		this.symbolContainer = [];
		this.recordDocumentSymbol = [];
		this.project = this.vertex.project(options.projectName);
		this.project.resource = options.tsConfigFile !== undefined ? URI.file(options.tsConfigFile).toString(true) : undefined;
		this.dataManager = dataManager;
		this.tsProject = new TSProject(this.dataManager, languageService, dependsOn, options, this.dataManager);

		this.dataManager.beginProject(this.tsProject, this.project);
		this.disposables = new Map();
	}

	public visitProgram(): ProjectInfo {
		const program = this.tsProject.getProgram();
		let sourceFiles = program.getSourceFiles();
		if (sourceFiles.length > 256) {
			this.tsProject.setSymbolChainCache(new SimpleSymbolChainCache());
		}
		for (const sourceFile of this.tsProject.getSourceFilesToIndex()) {

			this.visit(sourceFile);
		}
		const config = this.tsProject.getConfig();
		return {
			id: this.tsProject.id,
			sourceRoot: config.sourceRoot,
			outDir: config.outDir,
			references: this.tsProject.references
		};
	}

	public endVisitProgram(): void {
		this.dataManager.endProject(this.tsProject);
	}

	protected visit(node: ts.Node): void {
		switch (node.kind) {
			case ts.SyntaxKind.SourceFile:
				this.doVisit(this.visitSourceFile, this.endVisitSourceFile, node as ts.SourceFile);
				break;
			case ts.SyntaxKind.ModuleDeclaration:
				this.doVisit(this.visitModuleDeclaration, this.endVisitModuleDeclaration, node as ts.ModuleDeclaration);
				break;
			case ts.SyntaxKind.ClassDeclaration:
				this.doVisit(this.visitClassOrInterfaceDeclaration, this.endVisitClassOrInterfaceDeclaration, node as (ts.ClassDeclaration | ts.InterfaceDeclaration));
				break;
			case ts.SyntaxKind.InterfaceDeclaration:
				this.doVisit(this.visitClassOrInterfaceDeclaration, this.endVisitClassOrInterfaceDeclaration, node as (ts.ClassDeclaration | ts.InterfaceDeclaration));
				break;
			case ts.SyntaxKind.TypeParameter:
				this.doVisit(this.visitTypeParameter, this.endVisitTypeParameter, node as ts.TypeParameterDeclaration);
				break;
			case ts.SyntaxKind.MethodDeclaration:
				this.doVisit(this.visitMethodDeclaration, this.endVisitMethodDeclaration, node as ts.MethodDeclaration);
				break;
			case ts.SyntaxKind.MethodSignature:
				this.doVisit(this.visitMethodSignature, this.endVisitMethodSignature, node as ts.MethodSignature);
				break;
			case ts.SyntaxKind.FunctionDeclaration:
				this.doVisit(this.visitFunctionDeclaration, this.endVisitFunctionDeclaration, node as ts.FunctionDeclaration);
				break;
			case ts.SyntaxKind.PropertyDeclaration:
				this.doVisit(this.visitPropertyDeclaration, this.endVisitPropertyDeclaration, node as ts.PropertyDeclaration);
				break;
			case ts.SyntaxKind.PropertySignature:
				this.doVisit(this.visitPropertySignature, this.endVisitPropertySignature, node as ts.PropertySignature);
				break;
			case ts.SyntaxKind.Parameter:
				this.doVisit(this.visitParameterDeclaration, this.endVisitParameterDeclaration, node as ts.ParameterDeclaration);
				break;
			case ts.SyntaxKind.ClassExpression:
				this.doVisit(this.visitClassExpression, this.endVisitClassExpression, node as ts.ClassExpression);
				break;
			case ts.SyntaxKind.ExportAssignment:
				this.doVisit(this.visitExportAssignment, this.endVisitExportAssignment, node as ts.ExportAssignment);
				break;
			case ts.SyntaxKind.ExportDeclaration:
				this.doVisit(this.visitExportDeclaration, this.endVisitExportDeclaration, node as ts.ExportDeclaration);
				break;
			case ts.SyntaxKind.VariableStatement:
				this.doVisit(this.visitVariableStatement, this.endVisitVariableStatement, node as ts.VariableStatement);
				break;
			case ts.SyntaxKind.TypeAliasDeclaration:
				this.doVisit(this.visitTypeAliasDeclaration, this.endVisitTypeAliasDeclaration, node as ts.TypeAliasDeclaration);
				break;
			case ts.SyntaxKind.SetAccessor:
				this.doVisit(this.visitGeneric, this.endVisitSetAccessor, node as ts.SetAccessorDeclaration);
				break;
			case ts.SyntaxKind.GetAccessor:
				this.doVisit(this.visitGeneric, this.endVisitGetAccessor, node as ts.GetAccessorDeclaration);
				break;
			case ts.SyntaxKind.ArrayType:
				this.doVisit(this.visitArrayType, this.endVisitArrayType, node as ts.ArrayTypeNode);
				break;
			case ts.SyntaxKind.Constructor:
				this.doVisit(this.visitGeneric, this.endVisitConstructor, node as ts.ConstructorDeclaration);
				break;
			case ts.SyntaxKind.Identifier:
				let identifier = node as ts.Identifier;
				this.visitIdentifier(identifier);
				break;
			case ts.SyntaxKind.StringLiteral:
				let literal = node as ts.StringLiteral;
				this.visitStringLiteral(literal);
				break;
			default:
				this.doVisit(this.visitGeneric, this.endVisitGeneric, node);
				break;
		}
	}

	private doVisit<T extends ts.Node>(visit: (node: T) => boolean, endVisit: (node: T) => void, node: T): void {
		if (visit.call(this, node)) {
			node.forEachChild(child => this.visit(child));
		}
		endVisit.call(this, node);
	}

	private visitSourceFile(sourceFile: ts.SourceFile): boolean {
		const disposables: Disposable[] = [];
		if (this.isFullContentIgnored(sourceFile)) {
			return false;
		}
		this.options.reporter.reportProgress(1);

		this.currentSourceFile = sourceFile;
		const documentData = this.dataManager.getOrCreateDocumentData(sourceFile);
		this._currentDocumentData = documentData;
		this.symbolContainer.push({ id: documentData.document.id, children: [] });
		this.recordDocumentSymbol.push(true);
		this.disposables.set(sourceFile.fileName, disposables);
		return true;
	}

	private endVisitSourceFile(sourceFile: ts.SourceFile): void {
		if (this.isFullContentIgnored(sourceFile)) {
			return;
		}
		const program = this.tsProject.getProgram();
		const documentData = this.currentDocumentData;
		// Diagnostics
		const diagnostics: lsp.Diagnostic[] = [];
		const syntactic = program.getSyntacticDiagnostics(sourceFile);
		for (const element of syntactic) {
			diagnostics.push(Converter.asDiagnostic(element));
		}
		const semantic = program.getSemanticDiagnostics(sourceFile);
		for (const element of semantic) {
			if (element.file !== undefined && element.start !== undefined && element.length !== undefined) {
				diagnostics.push(Converter.asDiagnostic(element as ts.DiagnosticWithLocation));
			}
		}
		if (diagnostics.length > 0) {
			documentData.addDiagnostics(diagnostics);
		}

		// Folding ranges
		const spans = this.languageService.getOutliningSpans(sourceFile as any);
		if (ts.textSpanEnd.length > 0) {
			const foldingRanges: lsp.FoldingRange[] = [];
			for (const span of spans) {
				foldingRanges.push(Converter.asFoldingRange(sourceFile,span));
			}
			if (foldingRanges.length > 0) {
				documentData.addFoldingRanges(foldingRanges);
			}
		}

		// Document symbols.
		const values = (this.symbolContainer.pop() as RangeBasedDocumentSymbol).children;
		if (values !== undefined && values.length > 0) {
			documentData.addDocumentSymbols(values);
		}
		this.recordDocumentSymbol.pop();

		this.currentSourceFile = undefined;
		this._currentDocumentData = undefined;
		this.dataManager.documentProcessed(sourceFile);
		for (const disposable of this.disposables.get(sourceFile.fileName)!) {
			disposable();
		}
		this.disposables.delete(sourceFile.fileName);
		if (this.symbolContainer.length !== 0) {
			throw new Error(`Unbalanced begin / end calls`);
		}
	}

	public isFullContentIgnored(sourceFile: ts.SourceFile): boolean {
		return this.tsProject.isSourceFileDefaultLibrary(sourceFile) ||
			this.tsProject.isSourceFileFromExternalLibrary(sourceFile);
	}

	private visitModuleDeclaration(node: ts.ModuleDeclaration): boolean {
		this.visitDeclaration(node, true);
		return true;
	}

	private endVisitModuleDeclaration(node: ts.ModuleDeclaration): void {
		this.endVisitDeclaration(node);
	}

	private visitClassOrInterfaceDeclaration(node: ts.ClassDeclaration | ts.InterfaceDeclaration): boolean {
		this.visitDeclaration(node, true);
		return true;
	}

	private endVisitClassOrInterfaceDeclaration(node: ts.ClassDeclaration | ts.InterfaceDeclaration): void {
		this.endVisitDeclaration(node);
		this.handleBase(node);
		// This could be a function signature declaration
		if (ts.isInterfaceDeclaration(node)) {
			const [symbol, symbolData, monikerParts] = this.getSymbolAndMonikerPartsIfExported(node);
			if (symbol === undefined || symbolData === undefined || monikerParts === undefined) {
				return;
			}
			const type = this.tsProject.getTypeAtLocation(node.name);
			if (tss.Type.hasCallSignature(type) || tss.Type.hasConstructSignatures(type)) {
				this.emitAttachedMonikers(
					monikerParts.path,
					this.tsProject.computeAdditionalExportPaths(node.getSourceFile(), type, monikerParts.name, symbolData.moduleSystem)
				);
			}
		}
	}

	private visitMethodDeclaration(node: ts.MethodDeclaration): boolean {
		this.visitDeclaration(node, true);
		return true;
	}

	private endVisitMethodDeclaration(node: ts.MethodDeclaration): void {
		this.handleSignatures(node);
		this.endVisitDeclaration(node);
	}

	private visitMethodSignature(node: ts.MethodSignature): boolean {
		this.visitDeclaration(node, true);
		return true;
	}

	private endVisitMethodSignature(node: ts.MethodSignature): void {
		this.handleSignatures(node);
		this.endVisitDeclaration(node);
	}

	private visitFunctionDeclaration(node: ts.FunctionDeclaration): boolean {
		this.visitDeclaration(node, true);
		return true;
	}

	private endVisitFunctionDeclaration(node: ts.FunctionDeclaration): void {
		this.handleSignatures(node);
		this.endVisitDeclaration(node);
	}

	private visitPropertyDeclaration(node: ts.PropertyDeclaration): boolean {
		this.visitDeclaration(node, false);
		return true;
	}

	private endVisitPropertyDeclaration(node: ts.PropertyDeclaration): void {
		this.handlePropertyType(node);
		this.endVisitDeclaration(node);
	}

	private visitPropertySignature(node: ts.PropertySignature): boolean {
		this.visitDeclaration(node, false);
		return true;
	}

	private endVisitPropertySignature(node: ts.PropertySignature): void {
		this.handlePropertyType(node);
		this.endVisitDeclaration(node);
	}
	private visitVariableStatement(_node: ts.VariableStatement): boolean {
		return true;
	}

	private endVisitVariableStatement(node: ts.VariableStatement): void {
		for (const declaration of node.declarationList.declarations) {
			const [symbol, symbolData, monikerParts] = this.getSymbolAndMonikerPartsIfExported(declaration);
			if (symbol === undefined || symbolData === undefined || monikerParts === undefined) {
				continue;
			}
			const type = this.tsProject.getSymbols().getType(symbol, node);
			this.emitAttachedMonikers(monikerParts.path, this.tsProject.computeAdditionalExportPaths(node.getSourceFile(), type, monikerParts.name, symbolData.moduleSystem));
		}
	}

	private getSymbolAndMonikerPartsIfExported(node: ts.Node & { name?: ts.Identifier | ts.PropertyName | ts.BindingName } ): [ts.Symbol | undefined, SymbolData | undefined, TscMoniker | undefined] {
		const emptyResult: [ts.Symbol | undefined, SymbolData | undefined, TscMoniker | undefined] = [undefined, undefined, undefined];
		const symbol = this.tsProject.getSymbolAtLocation(node.name !== undefined ? node.name : node);
		if (symbol === undefined) {
			return emptyResult;
		}
		const symbolData = this.dataManager.getSymbolData(this.tsProject.getSymbolId(symbol));
		if (symbolData === undefined) {
			return emptyResult;
		}
		if (!symbolData.isExported() && !symbolData.isIndirectExported()) {
			return emptyResult;
		}
		const moniker = symbolData.getPrimaryMoniker();
		if (moniker === undefined) {
			return emptyResult;
		}
		return [symbol, symbolData, TscMoniker.parse(moniker.identifier)];
	}

	private handleSignatures(node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.MethodSignature | ts.PropertyDeclaration | ts.SetAccessorDeclaration | ts.GetAccessorDeclaration): void {
		// The return type of a function could be an inferred type or a literal type
		// In both cases the type has no name and therefore the symbol has no monikers.
		// Ensure that the return symbol has the correct visibility and moniker.
		const [symbol, symbolData, monikerParts] = this.getSymbolAndMonikerPartsIfExported(node);
		if (symbol === undefined || symbolData === undefined || monikerParts === undefined) {
			return;
		}

		const type = this.tsProject.getTypeOfSymbolAtLocation(symbol, node);
		this.emitAttachedMonikers(
			monikerParts.path,
			this.tsProject.computeAdditionalExportPaths(node.getSourceFile(), type, monikerParts.name, symbolData.moduleSystem)
		);
	}

	private handlePropertyType(node: ts.PropertyDeclaration | ts.PropertySignature | ts.ParameterDeclaration): void {
		const [symbol, symbolData,  monikerParts] = this.getSymbolAndMonikerPartsIfExported(node);
		if (symbol === undefined || symbolData === undefined || monikerParts === undefined) {
			return;
		}
		const symbols = this.tsProject.getSymbols();
		this.emitAttachedMonikers(
			monikerParts.path,
			this.tsProject.computeAdditionalExportPaths(node.getSourceFile(), symbols.getType(symbol, node), monikerParts.name, symbolData.moduleSystem)
		);
	}

	private handleBase(node: ts.ClassDeclaration | ts.InterfaceDeclaration): void {
		const [symbol, symbolData, monikerParts] = this.getSymbolAndMonikerPartsIfExported(node);
		if (symbol === undefined || symbolData === undefined || monikerParts === undefined) {
			return;
		}
		const symbols = this.tsProject.getSymbols();
		const type = symbols.getType(symbol, node);
		// We don't need t traverse the class or interface itself. Only the parents.
		const bases = symbols.types.getBaseTypes(type);
		if (bases !== undefined) {
			for (const type of bases) {
				this.emitAttachedMonikers(monikerParts.path, this.tsProject.computeAdditionalExportPaths(node.getSourceFile(), type, monikerParts.name, symbolData.moduleSystem));
			}
		}
		const extendz = symbols.types.getExtendsTypes(type);
		if (extendz !== undefined) {
			for (const type of extendz) {
				this.emitAttachedMonikers(monikerParts.path, this.tsProject.computeAdditionalExportPaths(node.getSourceFile(), type, monikerParts.name, symbolData.moduleSystem));
			}
		}
	}

	private visitParameterDeclaration(node: ts.ParameterDeclaration): boolean {
		this.visitDeclaration(node, false);
		return true;
	}

	private endVisitParameterDeclaration(node: ts.ParameterDeclaration): void {
		this.endVisitDeclaration(node);
	}

	private visitTypeParameter(node: ts.TypeParameterDeclaration): boolean {
		this.visitDeclaration(node, false);
		return true;
	}

	private endVisitTypeParameter(node: ts.TypeParameterDeclaration): void {
		this.endVisitDeclaration(node);
	}

	private visitClassExpression(_node: ts.ClassExpression): boolean {
		return true;
	}

	private endVisitClassExpression(_node: ts.ClassExpression): void {
	}

	private visitTypeAliasDeclaration(_node: ts.TypeAliasDeclaration): boolean {
		return true;
	}

	private endVisitTypeAliasDeclaration(node: ts.TypeAliasDeclaration): void {
		const [symbol, symbolData, monikerParts] = this.getSymbolAndMonikerPartsIfExported(node);
		if (symbol === undefined || symbolData === undefined || monikerParts === undefined || !Symbols.isTypeAlias(symbol)) {
			return;
		}
		const symbols = this.tsProject.getSymbols();
		this.emitAttachedMonikers(
			monikerParts.path,
			this.tsProject.computeAdditionalExportPaths(node.getSourceFile(), symbols.getType(symbol, node), monikerParts.name, symbolData.moduleSystem)
		);
	}

	private visitDeclaration(node: tss.Node.Declaration, isContainer: boolean): void {
		let recordDocumentSymbol: boolean = this.currentRecordDocumentSymbol && isContainer;
		let didRecord: boolean = recordDocumentSymbol;
		if (recordDocumentSymbol) {
			didRecord = this.addDocumentSymbol(node);
		}
		this.recordDocumentSymbol.push(didRecord);
		return;
	}

	private endVisitDeclaration(_node: tss.Node.Declaration): void {
		let didRecord = this.recordDocumentSymbol.pop();
		if (didRecord) {
			this.symbolContainer.pop();
		}
	}

	private visitExportAssignment(node: ts.ExportAssignment): boolean {
		// Todo@dbaeumer TS compiler doesn't return symbol for export assignment.
		const symbol = this.tsProject.getSymbolAtLocation(node) || tss.Node.getSymbol(node);
		if (symbol === undefined) {
			return false;
		}
		// Handle the export assignment.
		this.handleSymbol(symbol, node);
		const symbolData = this.dataManager.getSymbolData(this.tsProject.getSymbolId(symbol));
		if (symbolData === undefined) {
			return false;
		}
		const moniker = symbolData.getMostUniqueMoniker();
		if (moniker === undefined || moniker.unique === UniquenessLevel.document) {
			return false;
		}

		const monikerParts = TscMoniker.parse(moniker.identifier);
		const aliasedSymbol = this.tsProject.getSymbolAtLocation(node.expression) || tss.Node.getSymbol(node.expression);
		this.handleSymbol(aliasedSymbol, node.expression);
		if (aliasedSymbol !== undefined && monikerParts.path !== undefined) {
			const name = node.expression.getText();
			const sourceFile = node.getSourceFile();
			this.emitAttachedMonikers(
				monikerParts.path,
				this.tsProject.computeAdditionalExportPaths(sourceFile, aliasedSymbol, name, symbolData.moduleSystem)
			);
		}
		return false;
	}

	private endVisitExportAssignment(_node: ts.ExportAssignment): void {
		// Do nothing;
	}

	private visitExportDeclaration(node: ts.ExportDeclaration): boolean {
		// `export { foo }` ==> ExportDeclaration
		// `export { _foo as foo }` ==> ExportDeclaration
		if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
			for (const element of node.exportClause.elements) {
				const symbol = this.tsProject.getSymbolAtLocation(element.name);
				if (symbol === undefined) {
					continue;
				}
				this.handleSymbol(symbol, element.name);
				const symbolData = this.dataManager.getSymbolData(this.tsProject.getSymbolId(symbol));
				if (symbolData === undefined) {
					return false;
				}
				const moniker = symbolData.getMostUniqueMoniker();
				if (moniker === undefined || moniker.unique === UniquenessLevel.document) {
					continue;
				}
				const monikerParts = TscMoniker.parse(moniker.identifier);
				const aliasedSymbol = Symbols.isAliasSymbol(symbol)
					? this.tsProject.getAliasedSymbol(symbol)
					: element.propertyName !== undefined
						? this.tsProject.getSymbolAtLocation(element.propertyName)
						: undefined;
				if (element.propertyName !== undefined) {
					this.handleSymbol(aliasedSymbol, element.propertyName);
				}
				if (aliasedSymbol !== undefined && monikerParts.path !== undefined) {
					const sourceFile = node.getSourceFile();
					this.emitAttachedMonikers(
						monikerParts.path,
						this.tsProject.computeAdditionalExportPaths(sourceFile, aliasedSymbol, monikerParts.name, symbolData.moduleSystem)
					);
				}
			}
		}
		return false;
	}

	private endVisitExportDeclaration(_node: ts.ExportDeclaration): void {
	}

	private endVisitSetAccessor(node: ts.SetAccessorDeclaration): void {
		this.handleSignatures(node);
	}

	private endVisitGetAccessor(node: ts.GetAccessorDeclaration): void {
		this.handleSignatures(node);
	}
	private endVisitConstructor(node: ts.ConstructorDeclaration): void {
		for (const param of node.parameters) {
			const flags  = ts.getCombinedModifierFlags(param);
			if ((flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Public)) !== 0) {
				this.handlePropertyType(param);
			}
		}
	}

	private visitArrayType(_node: ts.ArrayTypeNode): boolean {
		return true;
	}

	private endVisitArrayType(node: ts.ArrayTypeNode): void {
		// make sure we emit information for the Array symbol from standard libs
		this.handleSymbol(this.tsProject.getTypeAtLocation(node).getSymbol(), node);
	}

	private visitIdentifier(node: ts.Identifier): void {
		this.handleSymbol(this.tsProject.getSymbolAtLocation(node), node);
	}

	private visitStringLiteral(node: ts.StringLiteral): void {
		this.handleSymbol(this.tsProject.getSymbolAtLocation(node), node);
	}

	private visitGeneric(_node: ts.Node): boolean {
		return true;
	}

	private endVisitGeneric(node: ts.Node): void {
		const symbol = this.tsProject.getSymbolAtLocation(node);
		if (symbol === undefined) {
			return;
		}
		const id = this.tsProject.getSymbolId(symbol);
		let symbolData = this.dataManager.getSymbolData(id);
		if (symbolData !== undefined) {
			// Todo@dbaeumer thinks about whether we should add a reference here.
			return;
		}
		const sourceFile = this.currentSourceFile!;
		this.dataManager.handleSymbol(this.currentDocumentData, symbol, node, sourceFile);
		return;
	}

	private emitAttachedMonikers(path: string | undefined, exports: [SymbolData, string][]): void {
		for (const item of exports) {
			const originalMoniker = item[0].getPrimaryMoniker();
			const identifier = tss.createMonikerIdentifier(path, item[1]);
			// We don't have a moniker yet
			if (originalMoniker === undefined) {
				item[0].addMoniker(identifier, MonikerKind.export);
			} else {
				item[0].attachMoniker(identifier, UniquenessLevel.group, MonikerKind.export);
			}
		}
	}

	private addDocumentSymbol(node: tss.Node.Declaration): boolean {
		const rangeNode = node.name !== undefined ? node.name : node;
		const symbol = this.tsProject.getSymbolAtLocation(rangeNode);
		const declarations = symbol !== undefined ? symbol.getDeclarations() : undefined;
		if (symbol === undefined || declarations === undefined || declarations.length === 0) {
			return false;
		}
		const sourceFile = this.currentSourceFile!;
		const symbolData = this.dataManager.getOrCreateSymbolData(symbol, node, sourceFile);
		const projectId = this.dataManager.getProjectId(sourceFile);
		const definition = symbolData.findDefinition(projectId, this.currentDocumentData.document, Converter.rangeFromNode(sourceFile, rangeNode));
		if (definition === undefined) {
			return false;
		}
		const currentContainer = this.symbolContainer[this.symbolContainer.length - 1];
		const child: RangeBasedDocumentSymbol = { id: definition.id };
		if (currentContainer.children === undefined) {
			currentContainer.children = [ child ];
		} else {
			currentContainer.children.push(child);
		}
		this.symbolContainer.push(child);
		return true;
	}

	private handleSymbol(symbol: ts.Symbol | undefined, location: ts.Node): void {
		if (symbol === undefined) {
			return;
		}
		const sourceFile = this.currentSourceFile!;
		this.dataManager.handleSymbol(this.currentDocumentData, symbol, location, sourceFile);
	}

	public getDefinitionAtPosition(sourceFile: ts.SourceFile, node: ts.Identifier): ReadonlyArray<ts.DefinitionInfo> | undefined {
		return this.languageService.getDefinitionAtPosition(sourceFile.fileName, node.getStart(sourceFile));
	}

	public getTypeDefinitionAtPosition(sourceFile: ts.SourceFile, node: ts.Identifier): ReadonlyArray<ts.DefinitionInfo> | undefined {
		return this.languageService.getTypeDefinitionAtPosition(sourceFile.fileName, node.getStart(sourceFile));
	}

	public get vertex(): VertexBuilder {
		return this.emitter.vertex;
	}

	public get edge(): EdgeBuilder {
		return this.emitter.edge;
	}

	public emit(element: Vertex | Edge): void {
		this.emitter.emit(element);
	}

	private get currentDocumentData(): DocumentData {
		if (this._currentDocumentData === undefined) {
			throw new Error(`No current document partition`);
		}
		return this._currentDocumentData;
	}

	private get currentRecordDocumentSymbol(): boolean {
		return this.recordDocumentSymbol[this.recordDocumentSymbol.length - 1];
	}
}

export function lsif(emitter: EmitterContext, languageService: ts.LanguageService, dataManager: DataManager, dependsOn: ProjectInfo[], options: Options): ProjectInfo | number {
	let visitor = new Visitor(emitter, languageService, dataManager, dependsOn, options);
	let result = visitor.visitProgram();
	visitor.endVisitProgram();
	return result;
}
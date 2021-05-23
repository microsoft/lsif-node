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
	lsp, Vertex, Edge, Project, Document, ReferenceResult, RangeTagTypes, RangeBasedDocumentSymbol,
	ResultSet, DefinitionRange, DefinitionResult, MonikerKind, ItemEdgeProperties,
	Range, EventKind, TypeDefinitionResult, Moniker, VertexLabels, UniquenessLevel, EventScope, Id
} from 'lsif-protocol';

import { VertexBuilder, EdgeBuilder, EmitterContext } from './common/graph';

import { LRUCache, LinkedMap } from './common/linkedMap';

import * as paths from './common/paths';
import { TscMoniker } from './common/moniker';
import { ExportMonikers } from './npm/exportMonikers';
import { ImportMonikers } from './npm/importMonikers';

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

	public constructor(emitter: EmitterContext, public readonly project: Project) {
		super(emitter);
		this.documents = [];
		this.diagnostics = [];
	}

	public begin(): void {
		this.emit(this.project);
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
	public readonly document: Document;
	public readonly moduleSystem: ModuleSystemKind;
	public readonly monikerPath: string | undefined;
	public readonly external: boolean;
	public readonly next: DocumentData | undefined;
	private _isClosed: boolean;
	private ranges: Range[];
	private rangesEmitted: boolean;
	private diagnostics: lsp.Diagnostic[];
	private foldingRanges: lsp.FoldingRange[];
	private documentSymbols: RangeBasedDocumentSymbol[];

	public constructor(projectId: ProjectId, emitter: EmitterContext, document: Document, moduleSystem: ModuleSystemKind, monikerPath: string | undefined, external: boolean, next: DocumentData | undefined) {
		super(emitter);
		this.projectId = projectId;
		this.document = document;
		this.moduleSystem = moduleSystem;
		this.monikerPath = monikerPath;
		this.external = external;
		this.next = next;
		this._isClosed = false;
		this.ranges = [];
		this.rangesEmitted = false;
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

	public flushRanges(): void {
		if (this.ranges.length > 0) {
			this.emit(this.edge.contains(this.document, this.ranges));
			this.ranges = [];
			this.rangesEmitted = true;
		}
	}

	public end(): void {
		this.checkClosed();
		if (this.ranges.length > 0 || (!this.rangesEmitted && this.ranges.length === 0)) {
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

	private readonly symbolData: SymbolData;
	private readonly shard: Shard;
	private definitionRanges: DefinitionRange[];
	private typeDefinitionRanges: DefinitionRange[];

	private referenceRanges: Map<ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references, Range[]>;
	private referenceResults: ReferenceResult[];
	private referenceCascades: Moniker[];

	public constructor(context: EmitterContext, symbolData: SymbolData, shard: Shard) {
		super(context);
		this.symbolData = symbolData;
		this.shard = shard;
		this.definitionRanges = SymbolDataPartition.EMPTY_ARRAY;
		this.typeDefinitionRanges = SymbolDataPartition.EMPTY_ARRAY;
		this.referenceRanges = SymbolDataPartition.EMPTY_MAP;
		this.referenceResults = SymbolDataPartition.EMPTY_ARRAY;
		this.referenceCascades = SymbolDataPartition.EMPTY_ARRAY;
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
			const definitionResult = this.symbolData.getOrCreateDefinitionResult();
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
	public readonly isNamed: boolean;
	private visibility: SymbolDataVisibility;
	private _next: SymbolData | undefined;

	private declarationInfo: tss.DefinitionInfo | tss.DefinitionInfo[] | undefined;

	protected resultSet: ResultSet;
	private _moniker: undefined | Moniker | Moniker[];

	public constructor(context: SymbolDataContext, projectId: ProjectId, symbolId: SymbolId, moduleSystem: ModuleSystemKind, visibility: SymbolDataVisibility, isNamed: boolean, next: SymbolData | undefined) {
		super(context);
		this.projectId = projectId;
		this.symbolId = symbolId;
		this.moduleSystem = moduleSystem;
		this.isNamed = isNamed;
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

	public hasDefinitionInfo(sourceFile: ts.SourceFile, node: ts.Node): boolean {
		if (this.declarationInfo === undefined) {
			return false;
		} else if (Array.isArray(this.declarationInfo)) {
			for (const item of this.declarationInfo) {
				if (tss.DefinitionInfo.equals(item, sourceFile, node)) {
					return true;
				}
			}
			return false;
		} else {
			return tss.DefinitionInfo.equals(this.declarationInfo, sourceFile, node);
		}
	}

	public addHover(hover: lsp.Hover) {
		const hr = this.vertex.hoverResult(hover);
		this.emit(hr);
		this.emit(this.edge.hover(this.resultSet, hr));
	}

	public addMoniker(identifier: string, kind: MonikerKind): Moniker {
		if (this._moniker !== undefined) {
			throw new Error(`Symbol data ${this.symbolId} already has a primary moniker`);
		}
		const unique: UniquenessLevel = kind === MonikerKind.local ? UniquenessLevel.document : UniquenessLevel.workspace;
		const moniker = this.vertex.moniker('tsc', identifier, unique, kind);
		this.emit(moniker);
		this.emit(this.edge.moniker(this.resultSet, moniker));
		this._moniker = moniker;
		return moniker;
	}

	public attachMoniker(identifier: string, unique: UniquenessLevel, kind: MonikerKind): Moniker {
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
		return moniker;
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
				if (moniker.unique === UniquenessLevel.workspace) {
					return moniker;
				}
			}
			return this._moniker[0];
		} else {
			return this._moniker;
		}
	}

	public abstract getOrCreateDefinitionResult(): DefinitionResult;

	public abstract addDefinition(shard: Shard, definition: DefinitionRange): void;
	public abstract findDefinition(shard: Shard, range: lsp.Range): DefinitionRange | undefined;

	public abstract getOrCreateReferenceResult(): ReferenceResult;

	public abstract addReference(shard: Shard, reference: Range, property: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void;
	public abstract addReference(shard: Shard, reference: ReferenceResult): void;

	public abstract getOrCreateTypeDefinitionResult(): TypeDefinitionResult;

	public abstract addTypeDefinition(shard: Shard, definition: DefinitionRange): void;

	public abstract getOrCreatePartition(shard: Shard): SymbolDataPartition;

	public abstract endPartition(shard: Shard): void;

	public abstract endPartitions(shards: Set<Shard>): void;

	public abstract end(forceSingle?: boolean): void;
}

class StandardSymbolData extends SymbolData {

	private definitionResult: DefinitionResult | undefined;
	private referenceResult: ReferenceResult | undefined;
	private typeDefinitionResult: TypeDefinitionResult | undefined;

	private partitions: Map<Id /* Document | Project */, SymbolDataPartition> | null | undefined;
	private clearedPartitions: Set<Id /* Document | Project */> | undefined;

	public constructor(context: SymbolDataContext, projectId: ProjectId, symbolId: SymbolId, moduleSystem: ModuleSystemKind, visibility: SymbolDataVisibility, isNamed: boolean, next: SymbolData | undefined) {
		super(context, projectId, symbolId, moduleSystem, visibility, isNamed, next);
	}

	public addDefinition(shard: Shard, definition: DefinitionRange, recordAsReference: boolean = true): void {
		this.emit(this.edge.next(definition, this.resultSet));
		this.getOrCreatePartition(shard).addDefinition(definition, recordAsReference);
	}

	public findDefinition(shard: Shard, range: lsp.Range): DefinitionRange | undefined {
		const partition = this.getPartition(shard);
		if (partition === undefined) {
			return undefined;
		}
		return partition.findDefinition(range);
	}

	public addReference(shard: Shard, reference: Range, property: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void;
	public addReference(shard: Shard, reference: ReferenceResult): void;
	public addReference(shard: Shard, reference: Moniker): void;
	public addReference(shard: Shard, reference: Range | ReferenceResult | Moniker, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void;
	public addReference(shard: Shard, reference: Range | ReferenceResult | Moniker, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		if (reference.label === VertexLabels.range) {
			this.emit(this.edge.next(reference, this.resultSet));
		}
		this.getOrCreatePartition(shard).addReference(reference as any, property as any);
	}

	public addTypeDefinition(shard: Shard, definition: DefinitionRange): void {
		this.getOrCreatePartition(shard).addTypeDefinition(definition);
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

	private getPartition(shard: Shard): SymbolDataPartition | undefined {
		if (this.partitions === null) {
			throw new Error (`The partitions for symbol ${this.symbolId} have already been cleared.`);
		}
		if (this.partitions === undefined) {
			this.partitions = new Map();
		}
		const partition = this.partitions.get(shard.id);
		// It is not active. See if it got cleared.
		if (this.clearedPartitions !== undefined) {
			if (this.clearedPartitions.has(shard.id)) {
				throw new Error(`Symbol data ${this.symbolId} already cleared the partition for shard ${JSON.stringify(shard, undefined, 0)}.`);
			}
		}
		return partition;
	}

	public getOrCreatePartition(shard: Shard): SymbolDataPartition {
		let result = this.getPartition(shard);
		if (result !== undefined) {
			return result;
		}

		result = new SymbolDataPartition(this.context, this, shard);
		this.context.managePartitionLifeCycle(shard, this);
		result.begin();
		// Get either throws or creates the map.
		this.partitions!.set(shard.id, result);
		return result;
	}

	public endPartition(shard: Shard): void {
		if (this.partitions === null) {
			throw new Error (`The partitions for symbol ${this.symbolId} have already been cleared.`);
		}
		if (this.partitions === undefined) {
			return;
		}
		const partition = this.partitions.get(shard.id);
		if (partition === undefined) {
			return;
		}
		this.partitions.delete(shard.id);
		partition.end();
		if (this.clearedPartitions === undefined) {
			this.clearedPartitions = new Set();
		}
		this.clearedPartitions.add(shard.id);
	}

	public endPartitions(shards: Set<Shard>): void {
		for (const shard of shards) {
			this.endPartition(shard);
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
		for (const entry of this.partitions.entries()) {
			entry[1].end();
		}
		this.clearedPartitions = undefined;
		this.partitions = null;
	}
}

class AliasSymbolData extends StandardSymbolData {

	private readonly aliased: SymbolData;
	private readonly ownReferences: boolean;
	private initialized: boolean;

	constructor(context: SymbolDataContext, projectId: ProjectId, symbolId: SymbolId, aliased: SymbolData, moduleSystem: ModuleSystemKind, visibility: SymbolDataVisibility, isNamed: boolean, renames: boolean, next: SymbolData | undefined) {
		super(context, projectId, symbolId, moduleSystem, visibility, isNamed, next);
		this.aliased = aliased;
		this.ownReferences = isNamed && renames;
		this.initialized = false;
	}

	public begin(): void {
		super.begin();
		// Is the symbol is not renamed forward everything to the original symbol.
		if (!this.ownReferences) {
			this.emit(this.edge.next(this.resultSet, this.aliased.getResultSet()));
			this.initialized = true;
		}
	}

	public addDefinition(shard: Shard, definition: DefinitionRange): void {
		this.checkInitialized(shard);
		// import { foo as bar } from './provide'
		// This renames the symbol, however go to declaration on bar should move to
		// the real declaration of foo. This is why even on rename declarations of
		// bar is recorded as a reference of foo.
		this.emit(this.edge.next(definition, this.resultSet));
		this.aliased.getOrCreatePartition(shard).addReference(definition, ItemEdgeProperties.references);
	}

	public findDefinition(shard: Shard, _range: lsp.Range): DefinitionRange | undefined {
		this.checkInitialized(shard);
		// Aliased symbols don't record own definitions. Find definition is only used
		// for document outline. Since aliases aren't outlined we return undefined. If
		// this needs to change we need to collect definitions in its own property to find
		// them again
		return undefined;
	}

	public addReference(shard: Shard, reference: Range | ReferenceResult | Moniker, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		this.checkInitialized(shard);
		if (this.ownReferences) {
			super.addReference(shard, reference, property);
		} else {
			if (reference.label === 'range') {
				this.emit(this.edge.next(reference, this.resultSet));
			}
			this.aliased.getOrCreatePartition(shard).addReference(reference as any, property as any);
		}
	}

	public getOrCreateReferenceResult(): ReferenceResult {
		if (this.ownReferences) {
			return super.getOrCreateReferenceResult();
		} else {
			return this.aliased.getOrCreateReferenceResult();
		}
	}

	private checkInitialized(shard: Shard): void {
		if (this.initialized) {
			return;
		}
		if (this.ownReferences) {
			const referenceResult = super.getOrCreateReferenceResult();
			this.aliased.addReference(shard, referenceResult);
		}
		this.initialized = true;
	}
}

class MethodSymbolData extends StandardSymbolData {

	private shard: Shard | undefined;
	private readonly rootSymbolData: SymbolData[] | undefined;

	constructor(context: SymbolDataContext, projectId: ProjectId, symbolId: SymbolId, shard: Shard, rootSymbolData: SymbolData[] | undefined, moduleSystem: ModuleSystemKind, visibility: SymbolDataVisibility, isNamed: boolean, next: SymbolData | undefined) {
		super(context, projectId, symbolId, moduleSystem, visibility, isNamed, next);
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
				super.addReference(this.shard!, root.getOrCreateReferenceResult());
				const moniker = root.getMostUniqueMoniker();
				if (moniker !== undefined && moniker.scheme !== 'local') {
					super.addReference(this.shard!, moniker);
				}
			}
		}
		this.shard = undefined;
	}

	public addDefinition(shard: Shard, definition: DefinitionRange): void {
		super.addDefinition(shard, definition, this.rootSymbolData === undefined);
		if (this.rootSymbolData !== undefined) {
			for (let base of this.rootSymbolData) {
				base.getOrCreatePartition(shard).addReference(definition, ItemEdgeProperties.definitions);
			}
		}
	}

	public addReference(shard: Shard, reference: Range | ReferenceResult | Moniker, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		if (this.rootSymbolData !== undefined) {
			if (reference.label === 'range') {
				this.emit(this.edge.next(reference, this.resultSet));
			}
			for (let root of this.rootSymbolData) {
				root.getOrCreatePartition(shard).addReference(reference as any, property as any);
			}
		} else {
			super.addReference(shard, reference, property);
		}
	}
}

class SymbolDataWithRoots extends StandardSymbolData {

	private readonly elements: SymbolData[];
	private shard: Shard | undefined;

	constructor(context: SymbolDataContext, projectId: ProjectId, symbolId: SymbolId, shard: Shard, elements: SymbolData[], moduleSystem: ModuleSystemKind, visibility: SymbolDataVisibility, isNamed: boolean, next: SymbolData | undefined) {
		super(context, projectId, symbolId, moduleSystem, visibility, isNamed, next);
		this.elements = elements;
		this.shard = shard;
	}

	public begin(): void {
		super.begin();
		for (let element of this.elements) {
			const moniker = element.getMostUniqueMoniker();
			super.addReference(this.shard!, element.getOrCreateReferenceResult());
			if (moniker !== undefined && moniker.scheme !== 'local') {
				super.addReference(this.shard!, moniker);
			}
		}
		this.shard = undefined;
	}

	public recordDefinitionInfo(_info: tss.DefinitionInfo): void {
	}

	public addDefinition(_shard: Shard, _definition: DefinitionRange): void {
		// We don't do anything for definitions since they a transient anyways.
	}

	public addReference(shard: Shard, reference: Range | ReferenceResult | Moniker, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		if (reference.label === 'range') {
			this.emit(this.edge.next(reference, this.resultSet));
		}
		for (let element of this.elements) {
			element.getOrCreatePartition(shard).addReference(reference as any, property as any);
		}
	}
}

class TransientSymbolData extends StandardSymbolData {

	constructor(context: SymbolDataContext, projectId: ProjectId, symbolId: SymbolId, moduleSystem: ModuleSystemKind, visibility: SymbolDataVisibility, isNamed: boolean, next: SymbolData | undefined) {
		super(context, projectId, symbolId, moduleSystem, visibility, isNamed, next);
	}

	public begin(): void {
		super.begin();
	}

	public recordDefinitionInfo(_info: tss.DefinitionInfo): void {
	}

	public addDefinition(_shard: Shard, _definition: DefinitionRange): void {
		// We don't do anything for definitions since they a transient anyways.
	}

	public addReference(shard: Shard, reference: Range | ReferenceResult | Moniker, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		super.addReference(shard, reference, property);
	}
}

enum ModuleSystemKind {
	unknown = 1,
	module = 2,
	global = 3
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

	public getTypeArguments(type: ts.TypeReference): readonly ts.Type[] {
		return this.typeChecker.getTypeArguments(type);
	}
}

interface SymbolWalkerContext {
	getSymbolData(symbol: ts.Symbol): SymbolData | undefined;
	getOrCreateSymbolData(symbol: ts.Symbol): SymbolData;
}

abstract class SymbolWalker {

	// Use a linked map to keep the order.
	protected _result: LinkedMap<SymbolData, string>;
	protected readonly context: SymbolWalkerContext;
	protected readonly symbols: Symbols;
	private readonly walkSymbolFromTopLevelType: boolean;

	private readonly visitedSymbols: Set<ts.Symbol>;
	private readonly visitedTypes: Set<ts.Type>;
	private readonly walkedSymbolsFromType: Set<ts.Symbol>;
	private readonly locationNodes: (ts.Node | undefined)[];

	public constructor(context: SymbolWalkerContext, symbols: Symbols, locationNode: ts.Node | undefined, walkSymbolFromTopLevelType: boolean) {
		this._result = new LinkedMap();
		this.context = context;
		this.symbols = symbols;
		this.walkSymbolFromTopLevelType = walkSymbolFromTopLevelType;
		this.visitedSymbols = new Set();
		this.visitedTypes = new Set();
		this.walkedSymbolsFromType = new Set();
		this.locationNodes = [locationNode];
	}

	protected addResult(symbolData: SymbolData, exportPath: string): void {
		const current = this._result.get(symbolData);
		if (current === undefined || current.length > exportPath.length) {
			this._result.set(symbolData, exportPath);
		}
	}

	public walk(start: ts.Symbol | ts.Type, moduleSystem: ModuleSystemKind, path: string, mode: FlowMode = FlowMode.exported): Map<SymbolData, string> {
		this._result.clear();
		if (tss.Symbol.is(start)) {
			this.walkSymbol(start, mode, false, path, 0);
			// If the symbol is not exported now mark it at least as indirect exported.
			const symbolData = this.context.getOrCreateSymbolData(start);
			if (!symbolData.isExported()) {
				symbolData.changeVisibility(SymbolDataVisibility.indirectExported);
			}
		} else {
			this.walkType(start, mode, false, moduleSystem, path, 0);
		}
		return this._result;
	}

	protected walkType(type: ts.Type, mode: FlowMode, markOnly: boolean, moduleSystem: ModuleSystemKind, path: string, level: number): void {
		if (this.visitedTypes.has(type)) {
			return;
		}

		this.visitedTypes.add(type);
		let walkSymbol: boolean = this.walkSymbolFromTopLevelType || level > 0;
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
							if (symbol !== undefined && !this.visitedSymbols.has(symbol)) {
								this.visitedSymbols.add(symbol);
								this.changeVisibility(symbol);
							}
						}
					}
				}
				for (const parameter of signature.getParameters()) {
					const parameterType = this.symbols.getTypeOfSymbol(parameter, () => { return this.getLocationNode(); });
					const exportIdentifier = `${path}.__arg.${this.symbols.getExportSymbolName(parameter)}`;
					const newMode = tss.Type.hasCallSignature(parameterType) ? FlowMode.reverse(mode) : mode;
					this.walkType(parameterType, newMode, markOnly, moduleSystem, exportIdentifier, level + 1);
				}
				const returnType = signature.getReturnType();
				this.walkType(returnType, mode, markOnly, moduleSystem, `${path}.__rt`, level + 1);
			}
		}
		if (type.isUnionOrIntersection()) {
			for (const part of type.types) {
				this.walkType(part, mode, markOnly, moduleSystem, path, level + 1);
			}
		}

		if (tss.Type.isInterface(type)) {
			const bases = this.symbols.types.getBaseTypes(type);
			if (bases !== undefined) {
				for (const base of bases) {
					this.walkType(base, mode, markOnly, moduleSystem, path, level + 1);
				}
			}
		}

		if (tss.Type.isClass(type)) {
			const bases = this.symbols.types.getExtendsTypes(type);
			if (bases !== undefined) {
				for (const base of bases) {
					this.walkType(base, mode, markOnly, moduleSystem, path, level + 1);
				}
			}
		}

		if (tss.Type.isObjectType(type)) {
			if (tss.Type.isTypeReference(type)) {
				const typeReferences = this.symbols.types.getTypeArguments(type);
				for (const reference of typeReferences) {
					this.walkType(reference, mode, markOnly, moduleSystem, path, level + 1);
				}
			} else if (tss.Type.isAnonymous(type)) {
				walkSymbol = true;
			}
		}

		if (type.aliasTypeArguments !== undefined) {
			for (const aliasTypeArgument of type.aliasTypeArguments) {
				this.walkType(aliasTypeArgument, mode, markOnly, moduleSystem, path, level + 1);
			}
		}

		if (tss.Type.isConditionalType(type)) {
			this.walkType(type.checkType, mode, markOnly, moduleSystem, path, level + 1);
			this.walkType(type.extendsType, mode, markOnly, moduleSystem, path, level + 1);
			this.walkType(type.resolvedTrueType, mode, markOnly, moduleSystem, path, level + 1);
			this.walkType(type.resolvedFalseType, mode, markOnly, moduleSystem, path, level + 1);
		}

		const symbol = type.getSymbol();
		if (symbol !== undefined && walkSymbol) {
			// We don't need a stack or a counter since we guard
			// against double visit with the visitedSymbols and visitedTypes
			this.walkedSymbolsFromType.add(symbol);
			this.walkSymbol(symbol, mode, !Symbols.isInternal(symbol), path, level + 1);
			this.walkedSymbolsFromType.delete(symbol);
		}
	}

	protected walkSymbol(symbol: ts.Symbol, mode: FlowMode, markOnly: boolean, path: string, level: number): void {
		if (this.visitedSymbols.has(symbol)) {
			return;
		}
		this.visitedSymbols.add(symbol);
		this.locationNodes.push(symbol.declarations !== undefined && symbol.declarations.length > 0 ? symbol.declarations[0] : undefined);
		const newPath = this.visitSymbol(symbol, markOnly, path);
		if (newPath !== undefined) {
			if (!this.walkedSymbolsFromType.has(symbol)) {
				const type = this.symbols.getTypeOfSymbol(symbol, () => { return this.getLocationNode(); });
				// First walk the type to handle unnamed types correctly
				this.walkType(type, mode, markOnly, this.symbols.getModuleSystemKind(symbol), newPath, level +1);
			}
			if (symbol.exports !== undefined) {
				const iterator = symbol.exports.values();
				for (let item = iterator.next(); !item.done; item = iterator.next()) {
					this.walkSymbol(item.value, mode, markOnly, newPath, level + 1);
				}
			}
			if (symbol.members !== undefined) {
				const iterator = symbol.members.values();
				for (let item = iterator.next(); !item.done; item = iterator.next()) {
					this.walkSymbol(item.value, mode, markOnly, newPath, level + 1);
				}
			}
		}
		this.locationNodes.pop();
	}

	private getLocationNode(): ts.Node | undefined {
		for (let i = this.locationNodes.length - 1; i >= 0; i--) {
			if (this.locationNodes[i] !== undefined) {
				return this.locationNodes[i];
			}
		}
		return undefined;
	}

	protected changeVisibility(symbol: ts.Symbol, symbolData?: SymbolData): void {
		symbolData = symbolData ?? this.context.getSymbolData(symbol);
		if (symbolData !== undefined) {
			symbolData.changeVisibility(SymbolDataVisibility.indirectExported);
		} else {
			this.symbols.storeSymbolInitializationData(symbol, SymbolDataVisibility.indirectExported);
		}
	}

	protected abstract visitSymbol(symbol: ts.Symbol, markOnly: boolean, path: string): string | undefined;
}

/**
 * Marks symbols as indirect exported and generates Monikers for unnamed
 * symbols that are indirectly exported. Examples are:
 *
 * - export const foo: { count: number; };
 * - export function foo(callback: (param: { count: number; }) => void): void;
 *
 * It doesn't generate a Monikers for named symbols that are indirectly exported.
 */
class IndirectExportWalker extends SymbolWalker {

	private continueOnIndirectExport: boolean;

	public constructor(context: SymbolWalkerContext, symbols: Symbols, locationNode: ts.Node | undefined,  walkSymbolFromTopLevelType: boolean, continueOnIndirectExport: boolean) {
		super(context, symbols, locationNode, walkSymbolFromTopLevelType);
		this.continueOnIndirectExport = continueOnIndirectExport;
	}

	protected visitSymbol(symbol: ts.Symbol, markOnly: boolean, path: string): string | undefined {
		let symbolData: SymbolData | undefined = this.context.getSymbolData(symbol);
		const isExported: boolean = symbolData?.isExported() ?? this.symbols.isExported(symbol);
		if (isExported) {
			return undefined;
		}
		if (!this.continueOnIndirectExport && symbolData?.isAtLeastIndirectExported() === true) {
			return undefined;
		}
		this.changeVisibility(symbol, symbolData);

		const isInternal = Symbols.isInternal(symbol);
		const newPath = isInternal ? path : `${path}.${this.symbols.getExportSymbolName(symbol)}`;

		if (markOnly) {
			return newPath;
		}

		if (!isInternal) {
			// we actually need to create the symbol data since we need to attach a
			// moniker to it.
			symbolData = symbolData ?? this.context.getOrCreateSymbolData(symbol);
			this.addResult(symbolData, newPath);
			return newPath;
		} else {
			return newPath;
		}
	}
}

/**
 * Symbol walker that creates monikers for symbols that are (re-)exported
 * via a export statement.
 */
enum ChildKind {
	unknown = 1,
	exports = 2,
	members = 3
}

class ExportSymbolWalker {

	private readonly _result: LinkedMap<SymbolData, string>;
	private readonly context: SymbolWalkerContext;
	private readonly symbols: Symbols;
	private readonly locationNode: ts.Node | undefined;
	private readonly skipRoot: boolean;

	private readonly visitedSymbol: Set<ts.Symbol>;

	constructor(context: SymbolWalkerContext, symbols: Symbols, locationNode: ts.Node | undefined, skipRoot: boolean = false) {
		this._result = new LinkedMap();
		this.context = context;
		this.symbols = symbols;
		this.locationNode = locationNode;
		this.skipRoot = skipRoot;
		this.visitedSymbol = new Set();
	}

	public walk(symbol: ts.Symbol, path: string): Map<SymbolData, string> {
		this._result.clear();
		this.walkSymbol(undefined, symbol, ChildKind.unknown, path, 0);
		return this._result;
	}

	protected addResult(symbolData: SymbolData, exportPath: string): void {
		const current = this._result.get(symbolData);
		if (current === undefined || current.length > exportPath.length) {
			this._result.set(symbolData, exportPath);
		}
	}

	protected walkSymbol(parent: ts.Symbol | undefined, symbol: ts.Symbol, kind: ChildKind, path: string, level: number): void {
		if (this.visitedSymbol.has(symbol)) {
			return;
		}
		const symbolData = this.context.getOrCreateSymbolData(symbol);
		const newPath = level === 0 && this.skipRoot ? path : this.visitSymbol(parent, symbol, symbolData, kind, path);
		let hasChildren: boolean = false;
		if (symbol.exports !== undefined) {
			const iterator = symbol.exports.values();
			for (let item = iterator.next(); !item.done; item = iterator.next()) {
				hasChildren = true;
				this.walkSymbol(symbol, item.value, ChildKind.exports, newPath, level + 1);
			}
		}
		if (symbol.members !== undefined) {
			const iterator = symbol.members.values();
			for (let item = iterator.next(); !item.done; item = iterator.next()) {
				hasChildren = true;
				this.walkSymbol(symbol, item.value, ChildKind.members, newPath, level + 1);
			}
		}
		// This is a leave symbol. Check if we have a type and try to walk for indirect exports
		if (!hasChildren && this.symbols.needsIndirectExportCheck(symbol)) {
			const type = this.symbols.getTypeOfSymbol(symbol, this.locationNode);
			const indirectExportWalker = new IndirectExportWalker(this.context, this.symbols, Symbols.getFirstDeclarationNode(symbol) ?? this.locationNode, symbol !== type.getSymbol(), true);
			const indirect = indirectExportWalker.walk(type, symbolData.moduleSystem, newPath, FlowMode.exported);
			for (const entry of indirect) {
				this.addResult(entry[0], entry[1]);
			}
		}
	}

	protected visitSymbol(parent: ts.Symbol | undefined, symbol: ts.Symbol, symbolData: SymbolData, kind: ChildKind, path: string): string {
		symbolData.changeVisibility(SymbolDataVisibility.indirectExported);
		// We are at the first level. If path is not empty we take the path for the first symbol. This
		// support cases were we rename the top level symbol during export.
		const symbolName = parent === undefined || kind !== ChildKind.exports
			? this.symbols.getExportSymbolName(symbol)
			: Symbols.isClass(parent)
				? Symbols.isPrototype(symbol)
					? this.symbols.getExportSymbolName(symbol)
					: `__static__.${this.symbols.getExportSymbolName(symbol)}`
				: this.symbols.getExportSymbolName(symbol);

		const exportName = path.length === 0 ? symbolName : `${path}.${symbolName}`;
		this.addResult(symbolData, exportName);
		return exportName;
	}
}

type CachedSymbolInformation = [/* exportPath */ string | undefined | null, ModuleSystemKind, /* declaration source files */ ts.SourceFile[]];

class Symbols {

	private static TopLevelPaths: Map<number, number[]> = new Map([
		[ts.SyntaxKind.VariableDeclaration, [ts.SyntaxKind.VariableDeclarationList, ts.SyntaxKind.VariableStatement, ts.SyntaxKind.SourceFile]]
	]);

	private static internalSymbolNames: Set<string>;
	public static isInternal(symbol: ts.Symbol): boolean {
		if (this.internalSymbolNames === undefined) {
			this.internalSymbolNames = new Set();
			for (const item in ts.InternalSymbolName) {
				this.internalSymbolNames.add((ts.InternalSymbolName as any)[item]);
			}
		}
		return this.internalSymbolNames.has(symbol.escapedName as string);
	}

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

	public static asParameterDeclaration(symbol: ts.Symbol): ts.ParameterDeclaration | undefined {
		const declarations = symbol.getDeclarations();
		if (declarations === undefined || declarations.length !== 1) {
			return undefined;
		}
		return ts.isParameter(declarations[0]) ? declarations[0] as ts.ParameterDeclaration : undefined;
	}

	public static isFunctionScopedVariable(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.FunctionScopedVariable) !== 0;
	}

	public static isBlockScopedVariable(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.BlockScopedVariable) !== 0;
	}

	public static isFunction(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Function) !== 0;
	}

	public static isProperty(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Property) !== 0;
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

	public static isExportStar(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.ExportStar) !== 0;
	}

	public static isVariableDeclaration(symbol: ts.Symbol): boolean {
		if (!Symbols.isBlockScopedVariable(symbol)) {
			return false;
		}
		const declarations = symbol.declarations;
		if (declarations === undefined || declarations.length !== 1) {
			return false;
		}
		return declarations[0].kind === ts.SyntaxKind.VariableDeclaration;
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

	public static getFirstDeclarationNode(symbol: ts.Symbol): ts.Node | undefined {
		return symbol.declarations !== undefined && symbol.declarations.length > 0 ? symbol.declarations[0] : undefined;
	}

	public readonly types: Types;

	private readonly baseSymbolCache: LRUCache<string, ts.Symbol[]>;
	private readonly baseMemberCache: LRUCache<string, LRUCache<string, ts.Symbol[]>>;
	private readonly symbolCache: LRUCache<ts.Symbol, CachedSymbolInformation>;
	private readonly symbolInitializationData: Map<string, SymbolDataVisibility>;

	private readonly sourceFilesContainingAmbientDeclarations: Set<string>;

	constructor(private typeChecker: ts.TypeChecker) {
		this.types = new Types(typeChecker);
		this.baseSymbolCache = new LRUCache(2048);
		this.baseMemberCache = new LRUCache(2048);
		this.symbolCache = new LRUCache(4096);
		this.symbolInitializationData = new Map();

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

	public getSymbolId(symbol: ts.Symbol): SymbolId {
		return tss.Symbol.createKey(this.typeChecker, symbol);
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

	public getTypeOfSymbol(symbol: ts.Symbol, location?: ts.Node | (() => ts.Node | undefined)): ts.Type {
		if (Symbols.isTypeAlias(symbol) || Symbols.isInterface(symbol)) {
			return this.typeChecker.getDeclaredTypeOfSymbol(symbol);
		}
		let node: ts.Node | undefined = this.inferLocationNode(symbol);
		if (node === undefined) {
			node = typeof location === 'function' ? location() : location;
		}
		if (node === undefined) {
			const result = tss.Symbol.getTypeFromSymbolLink(symbol);
			if (result !== undefined) {
				return result;
			}
		}
		if (node === undefined) {
			throw new Error(`No location provided when querying types of a symbol ${symbol.name}`);
		}
		return this.typeChecker.getTypeOfSymbolAtLocation(symbol, node);
	}

	private inferLocationNode(symbol: ts.Symbol): ts.Node | undefined {
		const declarations = symbol.declarations;
		if (declarations !== undefined && declarations.length > 0) {
			return declarations[0];
		}
		if (Symbols.isPrototype(symbol)) {
			const parent = tss.Symbol.getParent(symbol);
			if (parent !== undefined) {
				return this.inferLocationNode(parent);
			}
		}
		return undefined;
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

	public getExportPath(symbol: ts.Symbol): string | undefined {
		const result = this.getCachedSymbolInformation(symbol)[0];
		return result === null ? undefined : result;
	}

	public isExported(symbol: ts.Symbol): boolean {
		const result = this.getCachedSymbolInformation(symbol)[0];
		return result === undefined ? false : true;
	}

	public getModuleSystemKind(symbol: ts.Symbol): ModuleSystemKind {
		return this.getCachedSymbolInformation(symbol)[1];
	}

	public getDeclarationSourceFiles(symbol: ts.Symbol): ts.SourceFile[] {
		return this.getCachedSymbolInformation(symbol)[2];
	}

	public getCachedSymbolInformation(symbol: ts.Symbol): CachedSymbolInformation {
		let result: CachedSymbolInformation | undefined = this.symbolCache.get(symbol);
		if (result !== undefined) {
			return result;
		}

		const declarationSourceFiles = this.computeDeclarationSourceFiles(symbol);
		const moduleSystem = this.computeModuleSystemKind(declarationSourceFiles);
		const exportPath = this.computeExportPath(symbol, moduleSystem);
		result = [exportPath, moduleSystem, declarationSourceFiles];
		this.symbolCache.set(symbol, result);
		return result;
	}

	private computeDeclarationSourceFiles(symbol: ts.Symbol): ts.SourceFile[] {
		const sourceFiles = tss.getUniqueSourceFiles(symbol.getDeclarations());
		return sourceFiles.size === 0 ? [] : Array.from(sourceFiles.values());
	}

	private computeModuleSystemKind(sourceFiles: ts.SourceFile[] | undefined): ModuleSystemKind {
		if (sourceFiles === undefined || sourceFiles.length === 0) {
			return ModuleSystemKind.unknown;
		}
		let moduleCount: number = 0;
		let globalCount: number = 0;
		for (let sourceFile of sourceFiles) {
			// files that represent a module do have a resolve symbol.
			if (this.getSymbolAtLocation(sourceFile) !== undefined) {
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

	private computeExportPath(symbol: ts.Symbol, kind: ModuleSystemKind): string | undefined | null {
		// For a declaration like export default function foo()
		if (Symbols.isSourceFile(symbol) && (kind === ModuleSystemKind.module || kind === ModuleSystemKind.unknown)) {
			return '';
		}
		const parent = tss.Symbol.getParent(symbol);
		const isNotNamed = (Symbols.isInternal(symbol) && (symbol.escapedName !== ts.InternalSymbolName.Default && symbol.escapedName !== ts.InternalSymbolName.ExportEquals));
		if (parent === undefined) {
			// In a global module system symbol inside other namespace don't have a parent
			// if the symbol is not exported. So we need to check if the symbol is a top
			// level symbol
			if (kind === ModuleSystemKind.global) {
				if (this.isTopLevelSymbol(symbol)) {
					return isNotNamed ? null : this.getExportSymbolName(symbol);
				}
				// In a global module system signature can be merged across file. So even parameters
				// must be exported to allow merging across files.
				const parameterDeclaration = Symbols.asParameterDeclaration(symbol);
				if (parameterDeclaration !== undefined && parameterDeclaration.parent.name !== undefined) {
					const parentSymbol = this.getSymbolAtLocation(parameterDeclaration.parent.name);
					if (parentSymbol !== undefined) {
						const parentValue = this.getCachedSymbolInformation(parentSymbol);
						if (parentValue !== undefined) {
							return isNotNamed ? null : `${parentValue}.${this.getExportSymbolName(symbol)}`;
						}
					}
				}
			}
			return undefined;
		} else {
			const [parentValue] = this.getCachedSymbolInformation(parent);
			// The parent is not exported so any member isn't either
			if (parentValue === undefined) {
				return undefined;
			} else {
				if (Symbols.isInterface(parent) || Symbols.isClass(parent) || Symbols.isTypeLiteral(parent)) {
					return isNotNamed || parentValue === null ? null : `${parentValue}.${this.getExportSymbolName(symbol)}`;
				} else if (this.parentExports(parent, symbol)) {
					return isNotNamed || parentValue === null ? null : parentValue.length > 0 ? `${parentValue}.${this.getExportSymbolName(symbol)}` : this.getExportSymbolName(symbol);
				} else {
					return undefined;
				}
			}
		}
	}

	private parentExports(parent: ts.Symbol, symbol: ts.Symbol): boolean {
		return parent.exports !== undefined && parent.exports.has(symbol.getEscapedName() as ts.__String);
	}

	private static escapeRegExp: RegExp = new RegExp('\\.', 'g');
	public getExportSymbolName(symbol: ts.Symbol): string {
		let escapedName = symbol.getEscapedName() as string;
		if (escapedName.charAt(0) === '\"' || escapedName.charAt(0) === '\'') {
			escapedName = escapedName.substr(1, escapedName.length - 2);
		}
		// We use `.`as a path separator so escape `.` into `..`
		escapedName = escapedName.replace(Symbols.escapeRegExp, '..');
		return escapedName;
	}

	public needsIndirectExportCheck(symbol: ts.Symbol): boolean {
		const flags = ts.SymbolFlags.Property | ts.SymbolFlags.Function | ts.SymbolFlags.Method  | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface | ts.SymbolFlags.Class;
		return (symbol.getFlags() & flags) !== 0 || Symbols.isVariableDeclaration(symbol) ||
			(symbol.name === ts.InternalSymbolName.ExportEquals && (symbol.getFlags() & ts.SymbolFlags.Assignment) !== 0);
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

	public storeSymbolInitializationData(symbol: ts.Symbol, visibility: SymbolDataVisibility): void {
		const key = this.getSymbolId(symbol);
		this.symbolInitializationData.set(key, visibility);
	}

	public getSymbolInitializationData(symbol: ts.Symbol): [string | undefined, ModuleSystemKind, SymbolDataVisibility, boolean] {
		const [exportPath, moduleSystem, ] = this.getCachedSymbolInformation(symbol);
		const visibility = this.getVisibility(symbol, exportPath);
		return [exportPath === null ? undefined : exportPath, moduleSystem, visibility, !Symbols.isInternal(symbol)];
	}

	private getVisibility(symbol: ts.Symbol, exportPath: string | undefined | null): SymbolDataVisibility {
		const id = this.getSymbolId(symbol);
		const initVisibility = this.symbolInitializationData.get(id);
		if (initVisibility !== undefined) {
			this.symbolInitializationData.delete(id);
		}

		// The symbol is exported.
		if (exportPath === null || exportPath !== undefined) {
			return SymbolDataVisibility.exported;
		}
		if (Symbols.isTransient(symbol)) {
			return SymbolDataVisibility.transient;
		}

		return initVisibility ?? SymbolDataVisibility.unknown;
	}
}


interface FactoryResult {
	readonly symbolData: SymbolData;
	readonly exportParts?: string | string[];
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
		return this.symbols.getDeclarationSourceFiles(symbol);
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

	public abstract create(projectId: ProjectId, symbol: ts.Symbol, symbolId: SymbolId, declarationSourceFiles: ts.SourceFile[] | undefined, projectDataManager: ProjectDataManager, next: SymbolData | undefined): FactoryResult;
}

class StandardSymbolDataFactory extends SymbolDataFactory {

	constructor(typeChecker: ts.TypeChecker, symbols: Symbols, resolverContext: FactoryContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}

	public create(projectId: ProjectId, symbol: ts.Symbol, symbolId: SymbolId, declarationSourceFiles: ts.SourceFile[] | undefined, _projectDataManager: ProjectDataManager, next: SymbolData | undefined): FactoryResult {
		const [exportPath, moduleSystem, visibility, isNamed] = this.symbols.getSymbolInitializationData(symbol);
		return {
			symbolData: new StandardSymbolData(this.symbolDataContext, projectId, symbolId, moduleSystem, visibility, isNamed, next),
			exportParts: exportPath, moduleSystem,
			validateVisibilityOn: declarationSourceFiles
		};
	}
}

class AliasFactory extends SymbolDataFactory {

	constructor(typeChecker: ts.TypeChecker, symbols: Symbols, resolverContext: FactoryContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}

	public create(projectId: ProjectId, symbol: ts.Symbol, symbolId: SymbolId, declarationSourceFiles: ts.SourceFile[] | undefined, _projectDataManager: ProjectDataManager, next: SymbolData | undefined): FactoryResult {
		const [exportPath, moduleSystem, visibility, isNamed] = this.symbols.getSymbolInitializationData(symbol);
		const aliased = this.typeChecker.getAliasedSymbol(symbol);
		let symbolData: SymbolData | undefined;
		if (aliased !== undefined) {
			const renames = this.symbols.getExportSymbolName(symbol) !== this.symbols.getExportSymbolName(aliased);
			const aliasedSymbolData = this.factoryContext.getOrCreateSymbolData(aliased);
			if (aliasedSymbolData !== undefined) {
				symbolData = new AliasSymbolData(this.symbolDataContext, projectId, symbolId, aliasedSymbolData, moduleSystem, visibility, isNamed, renames, next);
			}
		}
		if (symbolData === undefined) {
			symbolData = new StandardSymbolData(this.symbolDataContext, projectId, symbolId, moduleSystem, visibility, isNamed, next);
		}
		return {
			symbolData,
			moduleSystem, exportParts: exportPath,
			validateVisibilityOn: declarationSourceFiles,
		};
	}
}

class MethodFactory extends SymbolDataFactory {

	constructor(typeChecker: ts.TypeChecker, symbols: Symbols, resolverContext: FactoryContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}

	public create(projectId: ProjectId, symbol: ts.Symbol, symbolId: SymbolId, declarationSourceFiles: ts.SourceFile[] | undefined, projectDataManager: ProjectDataManager, next: SymbolData | undefined): FactoryResult {
		if (declarationSourceFiles === undefined || declarationSourceFiles.length === 0) {
			throw new Error(`Need to understand how a method symbol can exist without a source file`);
		}

		const documentData = this.symbolDataContext.getDocumentData(declarationSourceFiles[0].fileName);
		const shard = documentData !== undefined ? documentData.document : projectDataManager.getProjectData().project;

		const [exportPath, moduleSystem, visibility, isNamed] = this.symbols.getSymbolInitializationData(symbol);
		const container = tss.Symbol.getParent(symbol);
		if (container === undefined) {
			return { symbolData: new MethodSymbolData(this.symbolDataContext, projectId, symbolId, shard, undefined, moduleSystem, visibility, isNamed, next), exportParts: exportPath, moduleSystem, validateVisibilityOn: declarationSourceFiles };
		}
		const mostAbstractMembers = this.symbols.findRootMembers(container, symbol.getName());
		// No abstract members found
		if (mostAbstractMembers === undefined || mostAbstractMembers.length === 0) {
			return { symbolData: new MethodSymbolData(this.symbolDataContext, projectId, symbolId, shard, undefined, moduleSystem, visibility, isNamed, next), exportParts: exportPath, moduleSystem, validateVisibilityOn: declarationSourceFiles };
		}
		// It is the symbol itself
		if (mostAbstractMembers.length === 1 && mostAbstractMembers[0] === symbol) {
			return { symbolData: new MethodSymbolData(this.symbolDataContext, projectId, symbolId, shard, undefined, moduleSystem, visibility, isNamed, next), exportParts: exportPath, moduleSystem, validateVisibilityOn: declarationSourceFiles };
		}
		const mostAbstractSymbolData = mostAbstractMembers.map(member => this.factoryContext.getOrCreateSymbolData(member));
		return { symbolData: new MethodSymbolData(this.symbolDataContext, projectId, symbolId, shard, mostAbstractSymbolData, moduleSystem, visibility, isNamed, next), exportParts: exportPath, moduleSystem, validateVisibilityOn: declarationSourceFiles };
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

	public create(projectId: ProjectId, symbol: ts.Symbol, symbolId: SymbolId, _declarationSourceFiles: ts.SourceFile[] | undefined, projectDataManager: ProjectDataManager, next: SymbolData | undefined): FactoryResult {
		const [, moduleSystem, visibility, isNamed] = this.symbols.getSymbolInitializationData(symbol);
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
				const exportPath: string | string[] = monikerIds.size === 1
					? monikerIds.values().next().value
					: Array.from(monikerIds).sort();
				return {
					symbolData: new SymbolDataWithRoots(this.symbolDataContext, projectId, symbolId, shard, symbolDataItems, moduleSystem, visibility, isNamed, next),
					moduleSystem: ModuleSystemKind.global,
					exportParts: exportPath
				};
			} else {
				return {
					symbolData: new SymbolDataWithRoots(this.symbolDataContext, projectId, symbolId, shard, symbolDataItems, moduleSystem, visibility, isNamed, next),
				};
			}
		} else {
			const [exportPath, moduleSystem] = this.symbols.getSymbolInitializationData(symbol);
			return {
				symbolData: new SymbolDataWithRoots(this.symbolDataContext, projectId, symbolId, shard, symbolDataItems, moduleSystem, visibility, isNamed, next),
				moduleSystem, exportParts: exportPath
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

	public create(projectId: ProjectId, symbol: ts.Symbol, symbolId: SymbolId, _declarationSourceFiles: ts.SourceFile[] | undefined, _projectDataManager: ProjectDataManager, next: SymbolData | undefined): FactoryResult {
		const [exportPath, moduleSystem, visibility, isNamed] = this.symbols.getSymbolInitializationData(symbol);
		return { symbolData: new TransientSymbolData(this.symbolDataContext, projectId, symbolId, moduleSystem, visibility, isNamed, next), moduleSystem, exportParts: exportPath, validateVisibilityOn: undefined };
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
	workspaceRoot: string;
	projectName: string;
	tsConfigFile: string | undefined;
	packageJsonFile: string | undefined;
	stdout: boolean;
	dataMode: DataMode;
	reporter: Reporter;
}

enum ParseMode {
	referenced = 1,
	full = 2
}

interface ProjectDataManagerContext extends EmitterContext {
	workspaceRoot: string;
}

abstract class ProjectDataManager {

	public readonly id: ProjectId;
	private startTime: number | undefined;

	protected readonly context: ProjectDataManagerContext;
	private readonly projectData: ProjectData;
	private readonly reporter: Reporter;

	private documentStats: number;
	private readonly documentDataItems: DocumentData[];
	private symbolStats: number;
	// We only need to keep public symbol data. Private symbol data are cleared when the
	// corresponding node is processed.
	private readonly managedSymbolDataItems: SymbolData[];

	public constructor(id: ProjectId, context: ProjectDataManagerContext, project: Project, reporter: Reporter) {
		this.id = id;
		this.context = context;
		this.projectData = new ProjectData(context, project);
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

	public getDocuments(): Set<Document> {
		const result = new Set<Document>();
		for (const data of this.documentDataItems) {
			// The documents are used to end partitions in lower level
			// projects. So flush the ranges so that we can use them
			// in item edges.
			if (!data.isClosed) {
				data.flushRanges();
			}
			result.add(data.document);
		}
		return result;
	}

	public begin(): void {
		this.startTime = Date.now();
		this.projectData.begin();
	}

	public getProjectData(): ProjectData {
		return this.projectData;
	}

	public createDocumentData(_fileName: string, document: Document, moduleSystem: ModuleSystemKind, monikerPath: string | undefined, external: boolean, next: DocumentData | undefined): DocumentData {
		const result = new DocumentData(this.id, this.context, document, moduleSystem, monikerPath, external, next);
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

	public endPartitions(documents: Set<Document>): void {
		for (const symbolData of this.managedSymbolDataItems) {
			symbolData.endPartitions(documents);
		}
	}

	public abstract end(): void;

	protected doEnd(documents: Set<Document> | undefined): void {
		for (const data of this.documentDataItems) {
			if (!data.isClosed) {
				data.flushRanges();
			}
		}
		for (const symbolData of this.managedSymbolDataItems) {
			if (documents === undefined) {
				symbolData.end();
			} else {
				symbolData.endPartitions(documents);
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
		if (this.projectData.project.resource !== undefined) {
			const uri = this.projectData.project.resource;
			const root = URI.file(this.context.workspaceRoot).toString(true);
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

	public constructor(id: ProjectId, context: ProjectDataManagerContext, project: Project, reporter: Reporter) {
		super(id, context, project, reporter);
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

class MachineProjectDataManager extends LazyProjectDataManager {

	public constructor(id: ProjectId, context: ProjectDataManagerContext, project: Project, reporter: Reporter) {
		super(id, context, project, reporter);
	}

	protected getName(): string {
		return 'Machine default libraries';
	}
}


class DefaultLibsProjectDataManager extends LazyProjectDataManager {

	public constructor(id: ProjectId, context: ProjectDataManagerContext, project: Project, reporter: Reporter) {
		super(id, context, project, reporter);
	}

	protected getName(): string {
		return 'TypeScript default libraries';
	}
}

class WorkspaceProjectDataManager extends LazyProjectDataManager {

	private readonly workspaceRoot: string;

	public constructor(id: ProjectId, context: ProjectDataManagerContext, project: Project, workspaceRoot: string, reporter: Reporter) {
		super(id, context, project, reporter);
		this.workspaceRoot = workspaceRoot;
	}

	public handles(sourceFile: ts.SourceFile): boolean {
		const fileName = sourceFile.fileName;
		return paths.isParent(this.workspaceRoot, fileName);
	}

	protected getName(): string {
		return `Workspace libraries for ${this.workspaceRoot}`;
	}
}

class TSConfigProjectDataManager extends ProjectDataManager {

	private readonly sourceRoot: string;
	private readonly projectFiles: Set<string>;
	private readonly managedDocuments: Set<Document>;

	public constructor(id: ProjectId, context: ProjectDataManagerContext, project: Project, sourceRoot: string, projectFiles: ReadonlyArray<string> | undefined, reporter: Reporter) {
		super(id, context, project, reporter);
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
	workspaceRoot: string;
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
	private readonly exportMonikers: ExportMonikers | undefined;
	private readonly importMonikers: ImportMonikers;

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

	constructor(context: TSProjectContext, languageService: ts.LanguageService, importMonikers: ImportMonikers, exportMonikers: ExportMonikers | undefined, references: ProjectInfo[], options: Options, symbolDataContext: SymbolDataContext) {
		this.id = ProjectId.next();
		this.context = context;
		this.languageService = languageService;
		this.importMonikers = importMonikers;
		this.exportMonikers = exportMonikers;
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
			workspaceRoot: options.workspaceRoot,
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

	public getSymbolId(symbol: ts.Symbol): SymbolId {
		return this.symbols.getSymbolId(symbol);
	}

	public getExportSymbolName(symbol: ts.Symbol): string {
		return this.symbols.getExportSymbolName(symbol);
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
			if (program.isSourceFileFromExternalLibrary(sourceFile) || program.isSourceFileDefaultLibrary(sourceFile)) {
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
		return this.symbols.getSymbolAtLocation(node);
	}

	public getTypeAtLocation(node: ts.Node): ts.Type {
		return this.symbols.getTypeAtLocation(node);
	}

	public getTypeOfSymbol(symbol: ts.Symbol, location?: ts.Node): ts.Type {
		return this.symbols.getTypeOfSymbol(symbol, location);
	}

	public getBaseTypes(type: ts.Type): ts.Type[] | undefined {
		return this.symbols.types.getBaseTypes(type);
	}

	public getExtendsTypes(type: ts.Type): ts.Type[] | undefined {
		return this.symbols.types.getExtendsTypes(type);
	}

	public getAliasedSymbol(symbol: ts.Symbol): ts.Symbol {
		return this.typeChecker.getAliasedSymbol(symbol);
	}

	public isSourceFileDefaultLibrary(sourceFile: ts.SourceFile): boolean {
		return this.getProgram().isSourceFileDefaultLibrary(sourceFile);
	}

	public isSourceFileFromExternalLibrary(sourceFile: ts.SourceFile): boolean {
		return this.getProgram().isSourceFileFromExternalLibrary(sourceFile);
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
		const workspaceRoot = this.config.workspaceRoot;
		const sourceRoot = this.config.sourceRoot;
		const outDir = this.config.outDir;
		const dependentOutDirs = this.config.dependentOutDirs;

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

		const isFromWorkspaceRootFolder = (sourceFile: ts.SourceFile): boolean => {
			return paths.isParent(workspaceRoot, sourceFile.fileName);
		};

		const document = this.vertex.document(sourceFile.fileName, sourceFile.text);
		const fileName = sourceFile.fileName;

		let monikerPath: string | undefined;
		let external: boolean = false;
		if (this.isSourceFileFromExternalLibrary(sourceFile)) {
			external = true;
			monikerPath = tss.computeMonikerPath(workspaceRoot, fileName);
		} else if (isFromProjectSources(sourceFile)) {
			monikerPath = tss.computeMonikerPath(workspaceRoot, tss.toOutLocation(fileName, sourceRoot, outDir));
		} else if (isFromDependentProject(sourceFile)) {
			external = true;
			monikerPath = tss.computeMonikerPath(workspaceRoot, fileName);
		} else if (isFromWorkspaceRootFolder(sourceFile)) {
			external = sourceFile.isDeclarationFile;
			monikerPath = tss.computeMonikerPath(workspaceRoot, fileName);
		}

		const symbol = this.getSymbolAtLocation(sourceFile);
		return [manager.createDocumentData(fileName, document, symbol !== undefined ? ModuleSystemKind.module : ModuleSystemKind.global, monikerPath, external, next), symbol];
	}

	public createSymbolData(manager: ProjectDataManager, created: (data: SymbolData) => void, symbol: ts.Symbol, next: SymbolData | undefined): { symbolData: SymbolData; validateVisibilityOn?: ts.SourceFile[] } {
		const symbolId: SymbolId = tss.Symbol.createKey(this.typeChecker, symbol);
		const factory = this.getFactory(symbol);
		const declarations: ts.Node[] | undefined = factory.getDeclarationNodes(symbol);
		const declarationSourceFiles: ts.SourceFile[] | undefined = factory.getDeclarationSourceFiles(symbol);
		// Make sure all referenced document data for the source files containing declarations exist
		if (declarationSourceFiles !== undefined && !Symbols.mayBeSourceFile(symbol)) {
			for (const sourceFile of declarationSourceFiles) {
				this.context.getOrCreateDocumentData(sourceFile);
			}
		}

		const result = manager.createSymbolData(symbolId, (projectDataManager) => {
			const result = factory.create(projectDataManager.id, symbol, symbolId, declarationSourceFiles, projectDataManager, next);
			created(result.symbolData);
			return result;
		});
		const { symbolData, moduleSystem, exportParts, validateVisibilityOn } = result;
		const [fileParts, external] = this.getMonikerFileParts(declarationSourceFiles);
		const monikerIdentifer = this.createMonikerIdentifier(fileParts, exportParts, Symbols.isSourceFile(symbol), moduleSystem);


		if (monikerIdentifer === undefined) {
			symbolData.addMoniker(symbolId, MonikerKind.local);
		} else {
			if (external === true) {
				const tscMoniker = symbolData.addMoniker(monikerIdentifer, MonikerKind.import);
				// If it comes from an external package from node_modules then the symbol can only
				// have on declaration file. Merging with external modules is not possible.
				if (declarationSourceFiles !== undefined && declarationSourceFiles.length === 1) {
					const sourceFile = declarationSourceFiles[0];
					const packageName = tss.Program.sourceFileToPackageName(this.getProgram(), sourceFile);
					if (packageName !== undefined && typeof fileParts === 'string' && exportParts !== undefined) {
						this.importMonikers.attachMoniker(tscMoniker, sourceFile.fileName, packageName, fileParts, exportParts);
					}
				}
			} else {
				const tscMoniker = symbolData.addMoniker(monikerIdentifer, MonikerKind.export);
				if (this.exportMonikers !== undefined && typeof fileParts === 'string' && exportParts !== undefined) {
					this.exportMonikers.attachMoniker(tscMoniker, fileParts, exportParts);
				}
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
				symbolData.addDefinition(documentData.document, definition);
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
			} else {
				symbolData.recordDefinitionInfo(tss.createDefinitionInfo(sourceFile, declaration));
			}
		}

		if (symbolData.isExported() && this.symbols.needsIndirectExportCheck(symbol)) {
			const moniker = symbolData.getMostUniqueMoniker();
			if (moniker !== undefined && moniker.scheme === TscMoniker.scheme) {
				const tscMoniker = TscMoniker.parse(moniker.identifier);
				const type = this.getTypeOfSymbol(symbol);
				const result  = this.computeIndirectExports(type || symbol, tscMoniker.name, symbolData.moduleSystem, symbol !== type.getSymbol());
				if (result.size > 0) {
					this.emitAttachedMonikers(tscMoniker.path, result);
				}
			}
		}

		return { symbolData, validateVisibilityOn };
	}

	private getMonikerFileParts(sourceFiles: ts.SourceFile[] | undefined): [string | string[] | undefined, boolean | undefined] {
		const documentDataItems: DocumentData[] | undefined = sourceFiles !== undefined
			? sourceFiles.map((sourceFile) => this.context.getOrCreateDocumentData(sourceFile))
			: undefined;

		const monikerFilePaths: Set<string> = new Set();
		let external: boolean | undefined;
		if (documentDataItems !== undefined) {
			for (const data of documentDataItems) {
				if (data.monikerPath !== undefined) {
					monikerFilePaths.add(data.monikerPath);
				}
				if (external === undefined) {
					external = data.external;
				} else {
					external = external && data.external;
				}
			}
		}
		const monikerFilePath: string | string[] |undefined = monikerFilePaths.size === 0
			? undefined
			: monikerFilePaths.size === 1
				? monikerFilePaths.values().next().value
				: Array.from(monikerFilePaths.values()).sort();

		return [monikerFilePath, external];
	}

	private createMonikerIdentifier(fileParts: string | string[] | undefined, exportParts: string | string[] | undefined, isSourceFile: boolean, moduleSystem: ModuleSystemKind | undefined): string | undefined {
		const filePath: string | undefined = fileParts === undefined || typeof fileParts === 'string'
			? fileParts
			: `[${fileParts.join(',')}]`;
		const exportPath: string | undefined = exportParts === undefined || typeof exportParts === 'string'
			? exportParts
			: `[${exportParts.join(',')}]`;

		if (isSourceFile && filePath !== undefined) {
			return tss.createMonikerIdentifier(filePath, undefined);
		}
		if (exportPath !== undefined) {
			if (moduleSystem === undefined || moduleSystem === ModuleSystemKind.global) {
				return tss.createMonikerIdentifier(undefined, exportPath);
			}
			if (filePath !== undefined) {
				return tss.createMonikerIdentifier(filePath, exportPath);
			}
		}
		return undefined;
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

	private computeIndirectExports(start: ts.Symbol | ts.Type, exportName: string, moduleSystem: ModuleSystemKind, walkSymbolFromTopLevelType: boolean): Map<SymbolData, string> {
		const walker = new IndirectExportWalker(this.context, this.symbols, undefined, walkSymbolFromTopLevelType, false);
		return walker.walk(start, moduleSystem, exportName);
	}

	public exportSymbol(symbol: ts.Symbol, monikerPath: string, newName: string | undefined, locationNode: ts.Node | undefined): void {
		const walker = new ExportSymbolWalker(this.context, this.symbols, locationNode, true);
		const result = walker.walk(symbol, newName ?? symbol.escapedName as string);
		this.emitAttachedMonikers(monikerPath, result);
	}

	private emitAttachedMonikers(monikerPath: string | undefined, exports: Map<SymbolData, string>): void {
		for (const entry of exports) {
			const symbolData = entry[0];
			const identifier = tss.createMonikerIdentifier(monikerPath, entry[1]);
			const moniker = symbolData.getPrimaryMoniker() === undefined
				? symbolData.addMoniker(identifier, MonikerKind.export)
				: symbolData.attachMoniker(identifier, UniquenessLevel.workspace, MonikerKind.export);
			if (this.exportMonikers !== undefined && monikerPath !== undefined) {
				this.exportMonikers.attachMoniker(moniker, monikerPath, entry[1]);
			}
		}
	}
}

export enum DataMode {
	free = 1,
	keep = 2
}

export class DataManager implements SymbolDataContext, ProjectDataManagerContext {

	private static readonly MachineId: string = 'bc450df0-741c-4ee7-9e0e-eddd95f8f314';
	private static readonly DefaultLibsId: string = '5779b280-596f-4b5d-90d8-b87441d7afa0';

	private readonly context: EmitterContext;
	private readonly reporter: Reporter;
	private readonly dataMode: DataMode;

	private readonly workspacePDM: WorkspaceProjectDataManager;
	private readonly machinePDM: MachineProjectDataManager;
	private readonly defaultLibsPDM: DefaultLibsProjectDataManager;

	private currentTSProject: TSProject | undefined;
	private currentPDM: TSConfigProjectDataManager | undefined;

	private readonly documentDataItems: Map<string, DocumentData>;
	private readonly symbolDataItems: Map<string, SymbolData>;
	private readonly clearedSymbolDataItems: Map<string, ProjectId[]>;
	private readonly partitionLifeCycle: Map<Id /* Document | Project */, SymbolData[]>;
	private readonly validateVisibilityCounter: Map<string, { projectDataManager: ProjectDataManager; counter: number }>;
	private readonly validateVisibilityOn: Map<string, SymbolData[]>;

	public readonly workspaceRoot: string;
	public readonly vertex: VertexBuilder;
	public readonly edge: EdgeBuilder;

	public constructor(context: EmitterContext, workspaceRoot: string, reporter: Reporter, dataMode: DataMode) {
		this.context = context;
		this.reporter = reporter;
		this.dataMode = dataMode;
		this.documentDataItems = new Map();
		this.symbolDataItems = new Map();
		this.clearedSymbolDataItems = new Map();
		this.partitionLifeCycle = new Map();
		this.validateVisibilityCounter = new Map();
		this.validateVisibilityOn = new Map();

		this.workspaceRoot = workspaceRoot;
		this.vertex = this.context.vertex;
		this.edge = this.context.edge;

		this.workspacePDM = new WorkspaceProjectDataManager(ProjectId.next(), this, this.context.vertex.project(workspaceRoot), workspaceRoot, reporter);
		this.machinePDM = new MachineProjectDataManager(ProjectId.next(), this, this.context.vertex.project(DataManager.MachineId), reporter);
		this.defaultLibsPDM = new DefaultLibsProjectDataManager(ProjectId.next(), this, this.context.vertex.project(DataManager.DefaultLibsId), reporter);
	}

	public emit(element: Vertex | Edge): void {
		this.context.emit(element);
	}

	public begin(): void {
		this.defaultLibsPDM.begin();
		this.machinePDM.begin();
		this.workspacePDM.begin();
	}

	public beginProject(tsProject: TSProject, project: Project): void {
		if (this.currentPDM !== undefined) {
			throw new Error(`There is already a current program data manager set`);
		}
		this.currentTSProject = tsProject;
		this.currentPDM = new TSConfigProjectDataManager(tsProject.id, this, project, tsProject.getConfig().sourceRoot, tsProject.getSourceFilesToIndexFileNames(), this.reporter);
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
		const managers: ProjectDataManager[] = [this.workspacePDM, this.machinePDM, this.defaultLibsPDM];
		for (let i = 0; i < managers.length; i++) {
			const manager = managers[i];
			const documents = manager.getDocuments();
			for (let y = i + 1; y < managers.length; y++) {
				managers[y].endPartitions(documents);
			}
			manager.end();
		}
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
			this.getOrCreateSymbolData(symbol);
		}
		return result;
	}

	private getProjectDataManager(sourceFile: ts.SourceFile): ProjectDataManager {
		if (this.currentTSProject !== undefined && this.currentTSProject.isSourceFileDefaultLibrary(sourceFile)) {
			return this.defaultLibsPDM;
		} else if (this.currentPDM !== undefined && this.currentPDM.handles(sourceFile)) {
			return this.currentPDM;
		} else if (this.workspacePDM.handles(sourceFile)) {
			return this.workspacePDM;
		} else {
			return this.machinePDM;
		}
	}

	public documentProcessed(sourceFile: ts.SourceFile): void {
		const fileName = sourceFile.fileName;
		const data = this.getDocumentData(sourceFile);
		if (data === undefined) {
			throw new Error(`No document data for file ${fileName}`);
		}
		data.flushRanges();
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
					symbolData.endPartition(data.document);
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
		const symbolData = this.getOrCreateSymbolData(symbol);
		// Don't collect references for unnamed symbols since we can't search for them.
		// We might add them if we see a use case for collecting them.
		if (!symbolData.isNamed || symbolData.hasDefinitionInfo(sourceFile, location)) {
			return;
		}

		const reference = this.vertex.range(Converter.rangeFromNode(sourceFile, location), { type: RangeTagTypes.reference, text: location.getText() });
		documentData.addRange(reference);
		symbolData.addReference(documentData.document, reference, ItemEdgeProperties.references);
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

	public getOrCreateSymbolData(symbol: ts.Symbol): SymbolData {
		let symbolData = this.getSymbolData(symbol);
		if (symbolData !== undefined) {
			return symbolData;
		}
		this.assertTSProject(this.currentTSProject);
		const symbolId = this.currentTSProject.getSymbolId(symbol);
		const factory = this.currentTSProject.getFactory(symbol);
		const sourceFiles = factory.getDeclarationSourceFiles(symbol);
		const useGlobalProjectDataManager = factory.useGlobalProjectDataManager(symbol);
		let manager: ProjectDataManager;
		if (useGlobalProjectDataManager || sourceFiles === undefined || sourceFiles.length === 0) {
			manager = this.machinePDM;
		} else {
			manager = this.getProjectDataManager(sourceFiles[0]);
			for (let i = 1; i < sourceFiles.length; i++) {
				if (manager !== this.getProjectDataManager(sourceFiles[i])) {
					manager = this.machinePDM;
					break;
				}
			}
		}
		const next = this.symbolDataItems.get(symbolId);
		const result = this.currentTSProject.createSymbolData(manager, (symbolData) => {
			this.symbolDataItems.set(symbolData.symbolId, symbolData);
			symbolData.begin();
		}, symbol, next);

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
		return id === this.defaultLibsPDM.id || id === this.machinePDM.id || id === this.workspacePDM.id;
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
	private symbolContainer: RangeBasedDocumentSymbol[];
	private recordDocumentSymbol: boolean[];
	private dataManager: DataManager;

	constructor(private emitter: EmitterContext, private languageService: ts.LanguageService, dataManager: DataManager, importMonikers: ImportMonikers, exportMonikers: ExportMonikers | undefined, dependsOn: ProjectInfo[], private options: Options) {
		this.symbolContainer = [];
		this.recordDocumentSymbol = [];
		this.project = this.vertex.project(options.projectName);
		this.project.resource = options.tsConfigFile !== undefined ? URI.file(options.tsConfigFile).toString(true) : undefined;
		this.dataManager = dataManager;
		this.tsProject = new TSProject(this.dataManager, languageService, importMonikers, exportMonikers, dependsOn, options, this.dataManager);

		this.dataManager.beginProject(this.tsProject, this.project);
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
			case ts.SyntaxKind.Constructor:
				this.doVisit(this.visitConstructor, this.endVisitConstructor, node as ts.ConstructorDeclaration);
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
			case ts.SyntaxKind.ExpressionStatement:
				this.doVisit(this.visitExpressionStatement, this.endVisitExpressionStatement, node as ts.ExpressionStatement);
				break;
			case ts.SyntaxKind.VariableStatement:
				this.doVisit(this.visitGeneric, this.endVisitGeneric, node as ts.VariableStatement);
				break;
			case ts.SyntaxKind.TypeAliasDeclaration:
				this.doVisit(this.visitGeneric, this.endVisitGeneric, node as ts.TypeAliasDeclaration);
				break;
			case ts.SyntaxKind.SetAccessor:
				this.doVisit(this.visitGeneric, this.endVisitGeneric, node as ts.SetAccessorDeclaration);
				break;
			case ts.SyntaxKind.GetAccessor:
				this.doVisit(this.visitGeneric, this.endVisitGeneric, node as ts.GetAccessorDeclaration);
				break;
			case ts.SyntaxKind.ArrayType:
				this.doVisit(this.visitArrayType, this.endVisitArrayType, node as ts.ArrayTypeNode);
				break;
			case ts.SyntaxKind.Identifier:
				this.visitIdentifier(node as ts.Identifier);
				break;
			case ts.SyntaxKind.StringLiteral:
				this.visitStringLiteral(node as ts.StringLiteral);
				break;
			case ts.SyntaxKind.ComputedPropertyName:
				this.visitComputedPropertyName(node as ts.ComputedPropertyName);
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
		if (this.isFullContentIgnored(sourceFile)) {
			return false;
		}
		this.options.reporter.reportProgress(1);

		this.currentSourceFile = sourceFile;
		const documentData = this.dataManager.getOrCreateDocumentData(sourceFile);
		this._currentDocumentData = documentData;
		this.symbolContainer.push({ id: documentData.document.id, children: [] });
		this.recordDocumentSymbol.push(true);
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
		// const [symbol, symbolData, monikerParts] = this.getSymbolAndMonikerPartsIfExported(node);
		// if (symbol === undefined || symbolData === undefined || monikerParts === undefined) {
		// 	return;
		// }

		// const type = this.tsProject.getTypeOfSymbol(symbol, node);

		// // We don't need t traverse the class or interface itself. Only the parents.
		// const bases = this.tsProject.getBaseTypes(type);
		// if (bases !== undefined) {
		// 	for (const type of bases) {
		// 		this.emitAttachedMonikers(monikerParts.path, this.tsProject.computeAdditionalExportPaths(node.getSourceFile(), type, monikerParts.name, symbolData.moduleSystem));
		// 	}
		// }
		// const extendz = this.tsProject.getExtendsTypes(type);
		// if (extendz !== undefined) {
		// 	for (const type of extendz) {
		// 		this.emitAttachedMonikers(monikerParts.path, this.tsProject.computeAdditionalExportPaths(node.getSourceFile(), type, monikerParts.name, symbolData.moduleSystem));
		// 	}
		// }

		// // Interface can be used to declare function or constructor signatures.
		// if (ts.isInterfaceDeclaration(node)) {
		// 	const type = this.tsProject.getTypeOfSymbol(symbol, node.name);
		// 	if (tss.Type.hasCallSignature(type) || tss.Type.hasConstructSignatures(type)) {
		// 		this.emitAttachedMonikers(
		// 			monikerParts.path,
		// 			this.tsProject.computeAdditionalExportPaths(node.getSourceFile(), type, monikerParts.name, symbolData.moduleSystem)
		// 		);
		// 	}
		// } else if (ts.isClassDeclaration(node)) {
		// 	const type = this.tsProject.getTypeOfSymbol(symbol, node);
		// 	if (tss.Type.hasConstructSignatures(type)) {
		// 		this.emitAttachedMonikers(
		// 			monikerParts.path,
		// 			this.tsProject.computeAdditionalExportPaths(node.getSourceFile(), type, monikerParts.name, symbolData.moduleSystem)
		// 		);
		// 	}
		// }
	}

	private visitConstructor(node: ts.ConstructorDeclaration): boolean {
		// Constructors have no identifier so we need to handle the symbol here.
		this.handleSymbol(this.tsProject.getSymbolAtLocation(node), node);
		return true;
	}

	private endVisitConstructor(_node: ts.ConstructorDeclaration): void {
	}

	private visitMethodDeclaration(node: ts.MethodDeclaration): boolean {
		this.visitDeclaration(node, true);
		return true;
	}

	private endVisitMethodDeclaration(node: ts.MethodDeclaration): void {
		this.endVisitDeclaration(node);
	}

	private visitMethodSignature(node: ts.MethodSignature): boolean {
		this.visitDeclaration(node, true);
		return true;
	}

	private endVisitMethodSignature(node: ts.MethodSignature): void {
		this.endVisitDeclaration(node);
	}

	private visitFunctionDeclaration(node: ts.FunctionDeclaration): boolean {
		this.visitDeclaration(node, true);
		return true;
	}

	private endVisitFunctionDeclaration(node: ts.FunctionDeclaration): void {
		this.endVisitDeclaration(node);
	}

	private visitPropertyDeclaration(node: ts.PropertyDeclaration): boolean {
		this.visitDeclaration(node, false);
		return true;
	}

	private endVisitPropertyDeclaration(node: ts.PropertyDeclaration): void {
		this.endVisitDeclaration(node);
	}

	private visitPropertySignature(node: ts.PropertySignature): boolean {
		this.visitDeclaration(node, false);
		return true;
	}

	private endVisitPropertySignature(node: ts.PropertySignature): void {
		this.endVisitDeclaration(node);
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
		this.handleSymbol(this.tsProject.getSymbolAtLocation(node), node);
		return true;
	}

	private endVisitExportAssignment(node: ts.ExportAssignment): void {
		// export = foo;
		// export default foo;
		const symbol = this.tsProject.getSymbolAtLocation(node);
		if (symbol === undefined) {
			return;
		}
		// Make sure we have a symbol data;
		this.dataManager.getOrCreateSymbolData(symbol);
		const monikerPath = this.currentDocumentData.monikerPath;
		if (monikerPath === undefined) {
			return;
		}
		const aliasedSymbol = this.tsProject.getSymbolAtLocation(node.expression);
		if (aliasedSymbol === undefined) {
			return;
		}
		const aliasedSymbolData = this.dataManager.getOrCreateSymbolData(aliasedSymbol);
		if (aliasedSymbolData === undefined) {
			return;
		}
		aliasedSymbolData.changeVisibility(SymbolDataVisibility.indirectExported);
		this.tsProject.exportSymbol(aliasedSymbol, monikerPath, this.tsProject.getExportSymbolName(symbol), this.currentSourceFile);
	}

	private visitExportDeclaration(_node: ts.ExportDeclaration): boolean {
		return true;
	}

	private endVisitExportDeclaration(node: ts.ExportDeclaration): void {
		// `export { foo }` ==> ExportDeclaration
		// `export { _foo as foo }` ==> ExportDeclaration
		if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
			for (const element of node.exportClause.elements) {
				const symbol = this.tsProject.getSymbolAtLocation(element.name);
				if (symbol === undefined) {
					continue;
				}
				const monikerPath = this.currentDocumentData.monikerPath;
				if (monikerPath === undefined) {
					return;
				}
				// Make sure we have a symbol data;
				this.dataManager.getOrCreateSymbolData(symbol);
				const aliasedSymbol = Symbols.isAliasSymbol(symbol)
					? this.tsProject.getAliasedSymbol(symbol)
					: element.propertyName !== undefined
						? this.tsProject.getSymbolAtLocation(element.propertyName)
						: undefined;
				if (aliasedSymbol === undefined) {
					continue;
				}
				const aliasedSymbolData = this.dataManager.getOrCreateSymbolData(aliasedSymbol);
				if (aliasedSymbolData === undefined) {
					return;
				}
				aliasedSymbolData.changeVisibility(SymbolDataVisibility.indirectExported);
				this.tsProject.exportSymbol(aliasedSymbol, monikerPath, this.tsProject.getExportSymbolName(symbol), this.currentSourceFile);
			}
		} else if (node.moduleSpecifier !== undefined) {
			const symbol = this.tsProject.getSymbolAtLocation(node);
			if (symbol === undefined || !Symbols.isExportStar(symbol)) {
				return;
			}
			const monikerPath = this.currentDocumentData.monikerPath;
			if (monikerPath === undefined) {
				return;
			}
			this.dataManager.getOrCreateSymbolData(symbol);
			const aliasedSymbol = this.tsProject.getSymbolAtLocation(node.moduleSpecifier);
			if (aliasedSymbol === undefined || !Symbols.isSourceFile(aliasedSymbol)) {
				return;
			}
			this.dataManager.getOrCreateSymbolData(aliasedSymbol);
			this.tsProject.exportSymbol(aliasedSymbol, monikerPath, '', this.currentSourceFile);
		}
	}

	private visitExpressionStatement(_node: ts.ExpressionStatement): boolean {
		return true;
	}

	private endVisitExpressionStatement(node: ts.ExpressionStatement): void {
		// we only need to handle `module.exports = `
		if (!ts.isSourceFile(node.parent) || !ts.isBinaryExpression(node.expression) || !ts.isPropertyAccessExpression(node.expression.left)) {
			return;
		}
		const left = node.expression.left;
		if (!ts.isIdentifier(left.expression) || left.expression.escapedText !== 'module' || left.name.escapedText !== 'exports') {
			return;
		}

		// We do have module.exports =
		const symbol = this.tsProject.getSymbolAtLocation(node.expression);
		if (symbol === undefined) {
			return;
		}
		// Make sure we have a symbol data;
		this.dataManager.getOrCreateSymbolData(symbol);
		const monikerPath = this.currentDocumentData.monikerPath;
		if (monikerPath === undefined) {
			return;
		}
		const aliasedSymbol = this.tsProject.getSymbolAtLocation(node.expression.right);
		if (aliasedSymbol === undefined) {
			return;
		}
		const aliasedSymbolData = this.dataManager.getOrCreateSymbolData(aliasedSymbol);
		if (aliasedSymbolData === undefined) {
			return;
		}
		aliasedSymbolData.changeVisibility(SymbolDataVisibility.indirectExported);
		this.tsProject.exportSymbol(aliasedSymbol, monikerPath, this.tsProject.getExportSymbolName(symbol), this.currentSourceFile);
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

	private visitComputedPropertyName(node: ts.ComputedPropertyName): void {
		this.handleSymbol(this.tsProject.getSymbolAtLocation(node), node);
	}

	private visitGeneric(_node: ts.Node): boolean {
		return true;
	}

	private endVisitGeneric(_node: ts.Node): void {
	}

	private addDocumentSymbol(node: tss.Node.Declaration): boolean {
		const rangeNode = node.name !== undefined ? node.name : node;
		const symbol = this.tsProject.getSymbolAtLocation(rangeNode);
		const declarations = symbol !== undefined ? symbol.getDeclarations() : undefined;
		if (symbol === undefined || declarations === undefined || declarations.length === 0) {
			return false;
		}
		const sourceFile = this.currentSourceFile!;
		const symbolData = this.dataManager.getOrCreateSymbolData(symbol);
		const definition = symbolData.findDefinition(this.currentDocumentData.document, Converter.rangeFromNode(sourceFile, rangeNode));
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

export function lsif(emitter: EmitterContext, languageService: ts.LanguageService, dataManager: DataManager, importMonikers: ImportMonikers, exportMonikers: ExportMonikers | undefined, dependsOn: ProjectInfo[], options: Options): ProjectInfo | number {
	let visitor = new Visitor(emitter, languageService, dataManager, importMonikers, exportMonikers, dependsOn, options);
	let result = visitor.visitProgram();
	visitor.endVisitProgram();
	return result;
}
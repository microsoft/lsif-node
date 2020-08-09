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
	Range, EventKind, TypeDefinitionResult, Moniker, VertexLabels, UniquenessLevel, EventScope
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

	export function asHover(this: void, file: ts.SourceFile, value: ts.QuickInfo): lsp.Hover {
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

export interface EmitterContext {
	vertex: VertexBuilder;
	edge: EdgeBuilder;
	emit(element: Vertex | Edge): void;
}

interface SymbolDataContext extends EmitterContext {
	getDocumentData(fileName: string): DocumentData | undefined;
	managePartitionLifeCycle(fileName: string, symbolData: SymbolData): void;
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

	public constructor(emitter: EmitterContext, private group: Group | undefined, public project: Project) {
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

	private _isClosed: boolean;
	private ranges: Range[];
	private diagnostics: lsp.Diagnostic[];
	private foldingRanges: lsp.FoldingRange[];
	private documentSymbols: RangeBasedDocumentSymbol[];

	public constructor(emitter: EmitterContext, public document: Document, public moduleSystem: ModuleSystemKind, public monikerFilePath: string | undefined, public external: boolean) {
		super(emitter);
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

enum SymbolDataVisibility {
	unknown = 1,
	internal = 2,
	exported = 3,
	aliasExported = 4
}

abstract class SymbolData extends LSIFData<SymbolDataContext> {

	private declarationInfo: tss.DefinitionInfo | tss.DefinitionInfo[] | undefined;

	protected resultSet: ResultSet;
	protected moniker: Moniker | undefined;

	public constructor(context: SymbolDataContext, private id: SymbolId, private visibility: SymbolDataVisibility) {
		super(context);
		this.resultSet = this.vertex.resultSet();
	}

	public getId(): string {
		return this.id;
	}

	public getVisibility(): SymbolDataVisibility {
		return this.visibility;
	}

	public changeVisibility(value: SymbolDataVisibility.aliasExported | SymbolDataVisibility.internal): void {
		if (value === SymbolDataVisibility.aliasExported && this.visibility !== SymbolDataVisibility.unknown && this.visibility !== SymbolDataVisibility.aliasExported) {
			throw new Error(`Can't upgrade symbol data visibilitt from ${this.visibility} to ${value}`);
		}
		if (value === SymbolDataVisibility.internal && this.visibility !== SymbolDataVisibility.internal && this.visibility !== SymbolDataVisibility.unknown) {
			throw new Error(`Can't upgrade symbol data visibilitt from ${this.visibility} to ${value}`);
		}
		this.visibility = value;
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
		const unique: UniquenessLevel = kind === MonikerKind.local ? UniquenessLevel.document : UniquenessLevel.group;
		const moniker = this.vertex.moniker('tsc', identifier, unique, kind);
		this.emit(moniker);
		this.emit(this.edge.moniker(this.resultSet, moniker));
		this.moniker = moniker;
	}

	public getMoniker(): Moniker | undefined {
		return this.moniker;
	}

	public abstract getOrCreateDefinitionResult(): DefinitionResult;

	public abstract addDefinition(sourceFile: string, definition: DefinitionRange): void;
	public abstract findDefinition(sourceFile: string, range: lsp.Range): DefinitionRange | undefined;

	public abstract getOrCreateReferenceResult(): ReferenceResult;

	public abstract addReference(sourceFile: string, reference: Range, property: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void;
	public abstract addReference(sourceFile: string, reference: ReferenceResult): void;

	public abstract getOrCreateTypeDefintionResult(): TypeDefinitionResult;

	public abstract addTypeDefinition(sourceFile: string, definition: DefinitionRange): void;

	public abstract getOrCreatePartition(sourceFile: string | undefined): SymbolDataPartition;

	public abstract endPartition(fileName: string): void;

	public abstract endPartitions(sourceFiles: Set<string>): void;

	public abstract end(forceSingle?: boolean): void;
}

class StandardSymbolData extends SymbolData {

	private definitionResult: DefinitionResult | undefined;
	private referenceResult: ReferenceResult | undefined;
	private typeDefinitionResult: TypeDefinitionResult | undefined;

	private partitions: Map<string /* sourceFile */, SymbolDataPartition | null> | null | undefined;

	public constructor(context: SymbolDataContext, id: SymbolId, visibility: SymbolDataVisibility) {
		super(context, id, visibility);
	}

	public addDefinition(sourceFile: string, definition: DefinitionRange, recordAsReference: boolean = true): void {
		this.emit(this.edge.next(definition, this.resultSet));
		this.getOrCreatePartition(sourceFile).addDefinition(definition, recordAsReference);
	}

	public findDefinition(sourceFile: string, range: lsp.Range): DefinitionRange | undefined {
		if (this.partitions === undefined) {
			return undefined;
		}
		if (this.partitions === null) {
			throw new Error(`The symbol data has already been cleared`);
		}
		let partition = this.partitions.get(sourceFile);
		if (partition === null) {
			throw new Error(`The partition for source file ${sourceFile} got already cleared.`);
		}
		if (partition === undefined) {
			return undefined;
		}
		return partition.findDefinition(range);
	}

	public addReference(sourceFile: string, reference: Range, property: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void;
	public addReference(sourceFile: string, reference: ReferenceResult): void;
	public addReference(sourceFile: string, reference: Moniker): void;
	public addReference(sourceFile: string, reference: Range | ReferenceResult | Moniker, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		if (reference.label === VertexLabels.range) {
			this.emit(this.edge.next(reference, this.resultSet));
		}
		this.getOrCreatePartition(sourceFile).addReference(reference as any, property as any);
	}

	public addTypeDefinition(sourceFile: string, definition: DefinitionRange): void {
		this.getOrCreatePartition(sourceFile).addTypeDefinition(definition);
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

	public getOrCreateTypeDefintionResult(): TypeDefinitionResult {
		if (this.typeDefinitionResult === undefined) {
			this.typeDefinitionResult = this.vertex.typeDefinitionResult();
			this.emit(this.typeDefinitionResult);
			this.emit(this.edge.typeDefinition(this.resultSet, this.typeDefinitionResult));
		}
		return this.typeDefinitionResult;
	}

	public getOrCreatePartition(sourceFile: string): SymbolDataPartition {
		if (this.partitions === null) {
			throw new Error (`Partition for symbol ${this.getId()} have already been cleared`);
		}
		if (this.partitions === undefined) {
			this.partitions = new Map();
		}
		let result = this.partitions.get(sourceFile);
		if (result === null) {
			throw new Error (`Partition for file ${sourceFile} has already been cleared.`);
		}
		if (result === undefined) {
			let documentData = this.context.getDocumentData(sourceFile);
			if (documentData === undefined) {
				throw new Error(`No document data for ${sourceFile}`);
			}
			result = new SymbolDataPartition(this.context, this, documentData.document);
			// If we have a scope the symbol data will be removed when node processed
			// is called. So we don't need to manage partitions.
			if (this.getVisibility() !== SymbolDataVisibility.internal) {
				this.context.managePartitionLifeCycle(sourceFile, this);
			}
			result.begin();
			this.partitions.set(sourceFile, result);
		}
		return result;
	}

	public endPartition(fileName: string): void {
		if (this.partitions === undefined) {
			throw new Error(`Symbol data doesn't manage a partition for ${fileName}`);
		}
		if (this.partitions === null) {
			throw new Error (`Partition for symbol ${this.getId()} has already been cleared`);
		}
		const partition = this.partitions.get(fileName);
		if (partition === null) {
			throw new Error (`Partition for file ${fileName} has already been cleared.`);
		}
		if (partition === undefined) {
			throw new Error(`Symbol data doesn't manage a partition for ${fileName}`);
		}
		partition.end();
		this.partitions.set(fileName, null);
	}

	public endPartitions(fileNames: Set<string>): void {
		if (this.partitions === null || this.partitions === undefined) {
			return;
		}
		const toClear: string[] = [];
		for (const entry of this.partitions) {
			if (entry[1] !== null && fileNames.has(entry[0])) {
				entry[1].end();
				toClear.push(entry[0]);
			}
		}
		for (const fileName of toClear) {
			this.partitions.set(fileName, null);
		}
	}

	public end(forceSingle: boolean = false): void {
		if (this.partitions === undefined) {
			return;
		}
		if (this.partitions === null) {
			throw new Error (`Partitions for symbol ${this.getId()} have already been cleared`);
		}
		if (forceSingle && this.partitions.size > 1) {
			throw new Error(`Symbol data has more than one partition.`);
		}
		for (let entry of this.partitions.entries()) {
			if (entry[1] !== null) {
				entry[1].end();
			}
		}
		this.partitions = null;
	}
}

class AliasSymbolData extends StandardSymbolData {

	constructor(context: SymbolDataContext, id: string, private aliased: SymbolData, visibility: SymbolDataVisibility, private renames: boolean) {
		super(context, id, visibility);
	}

	public begin(): void {
		super.begin();
		this.emit(this.edge.next(this.resultSet, this.aliased.getResultSet()));
	}

	public addDefinition(sourceFile: string, definition: DefinitionRange): void {
		if (this.renames) {
			super.addDefinition(sourceFile, definition, false);
		} else {
			this.emit(this.edge.next(definition, this.resultSet));
			this.aliased.getOrCreatePartition(sourceFile).addReference(definition, ItemEdgeProperties.references);
		}
	}

	public findDefinition(sourceFile: string, range: lsp.Range): DefinitionRange | undefined {
		if (this.renames) {
			return super.findDefinition(sourceFile, range);
		} else {
			return this.aliased.findDefinition(sourceFile, range);
		}
	}

	public addReference(sourceFile: string, reference: Range | ReferenceResult | Moniker, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		if (reference.label === 'range') {
			this.emit(this.edge.next(reference, this.resultSet));
		}
		this.aliased.getOrCreatePartition(sourceFile).addReference(reference as any, property as any);
	}

	public getOrCreateReferenceResult(): ReferenceResult {
		throw new Error(`Shouldn't be called`);
	}
}

class MethodSymbolData extends StandardSymbolData {

	private sourceFiles: string[] | undefined;
	private rootSymbolData: SymbolData[] | undefined;

	constructor(context: SymbolDataContext, id: string, sourceFiles: string[], rootSymbolData: SymbolData[] | undefined, visibility: SymbolDataVisibility) {
		super(context, id, visibility);
		this.sourceFiles = sourceFiles;
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
		const sourceFile = this.sourceFiles![0];
		if (this.rootSymbolData !== undefined) {
			for (let root of this.rootSymbolData) {
				super.addReference(sourceFile, root.getOrCreateReferenceResult());
				const moniker = root.getMoniker();
				if (moniker !== undefined && moniker.scheme !== 'local') {
					super.addReference(sourceFile, moniker);
				}
			}
		}
		this.sourceFiles = undefined;
	}

	public addDefinition(sourceFile: string, definition: DefinitionRange): void {
		super.addDefinition(sourceFile, definition, this.rootSymbolData === undefined);
		if (this.rootSymbolData !== undefined) {
			for (let base of this.rootSymbolData) {
				base.getOrCreatePartition(sourceFile).addReference(definition, ItemEdgeProperties.definitions);
			}
		}
	}

	public addReference(sourceFile: string, reference: Range | ReferenceResult | Moniker, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		if (this.rootSymbolData !== undefined) {
			if (reference.label === 'range') {
				this.emit(this.edge.next(reference, this.resultSet));
			}
			for (let root of this.rootSymbolData) {
				root.getOrCreatePartition(sourceFile).addReference(reference as any, property as any);
			}
		} else {
			super.addReference(sourceFile, reference as any, property as any);
		}
	}
}

class UnionOrIntersectionSymbolData extends StandardSymbolData {

	private sourceFiles: string[] | undefined;
	private elements: SymbolData[];
	private transientPartition: SymbolDataPartition | undefined;
	private shard: Project | Document;

	constructor(context: SymbolDataContext, id: string, sourceFiles: string[] | undefined, elements: SymbolData[], shard: Project | Document) {
		super(context, id, SymbolDataVisibility.exported);
		this.elements = elements;
		this.sourceFiles = sourceFiles;
		this.shard = shard;
	}

	public begin(): void {
		super.begin();
		const sourceFile = this.sourceFiles !== undefined ? this.sourceFiles[0] : undefined;
		for (let element of this.elements) {
			const moniker = element.getMoniker();
			// We take the first source file to cluster this. We might want to find a source
			// file that has already changed to make the diff minimal.
			if (sourceFile) {
				super.addReference(sourceFile, element.getOrCreateReferenceResult());
				if (moniker !== undefined && moniker.scheme !== 'local') {
					super.addReference(sourceFile, moniker);
				}
			} else {
				if (this.transientPartition === undefined) {
					this.transientPartition = new SymbolDataPartition(this.context, this, this.shard);
				}
				this.transientPartition.addReference(element.getOrCreateReferenceResult());
				if (moniker !== undefined && moniker.scheme !== 'local') {
					this.transientPartition.addReference(moniker);
				}
			}
		}
		this.sourceFiles = undefined;
	}

	public recordDefinitionInfo(info: tss.DefinitionInfo): void {
	}

	public addDefinition(sourceFile: string, definition: DefinitionRange): void {
		// We don't do anoything for definitions since they a transient anyways.
	}

	public addReference(sourceFile: string, reference: Range | ReferenceResult | Moniker, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		if (reference.label === 'range') {
			this.emit(this.edge.next(reference, this.resultSet));
		}
		for (let element of this.elements) {
			element.getOrCreatePartition(sourceFile).addReference(reference as any, property as any);
		}
	}

	public end(forceSingle: boolean): void {
		if (this.transientPartition !== undefined) {
			this.transientPartition.end();
		}
		super.end(forceSingle);
	}
}

class TransientSymbolData extends StandardSymbolData {

	constructor(context: SymbolDataContext, id: string) {
		super(context, id, SymbolDataVisibility.exported);
	}

	public begin(): void {
		super.begin();
	}

	public recordDefinitionInfo(info: tss.DefinitionInfo): void {
	}

	public addDefinition(sourceFile: string, definition: DefinitionRange): void {
		// We don't do anoything for definitions since they a transient anyways.
	}

	public addReference(sourceFile: string, reference: Range | ReferenceResult | Moniker, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		super.addReference(sourceFile, reference as any, property as any);
	}
}

class SymbolDataPartition extends LSIFData<EmitterContext> {

	private static EMPTY_ARRAY = Object.freeze([]) as unknown as any[];
	private static EMPTY_MAP= Object.freeze(new Map()) as unknown as Map<any, any>;

	private definitionRanges: DefinitionRange[];
	private typeDefinitionRanges: DefinitionRange[];

	private referenceRanges: Map<ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references, Range[]>;
	private referenceResults: ReferenceResult[];
	private referenceCascades: Moniker[];

	public constructor(context: EmitterContext, private symbolData: SymbolData, private shard: Document | Project) {
		super(context);
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
			let definitionResult = this.symbolData.getOrCreateDefinitionResult();
			this.emit(this.edge.item(definitionResult, this.definitionRanges, this.shard));
		}
		if (this.typeDefinitionRanges !== SymbolDataPartition.EMPTY_ARRAY) {
			const typeDefinitionResult = this.symbolData.getOrCreateTypeDefintionResult();
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

enum ModuleSystemKind {
	module = 1,
	global = 2
}

interface SymbolAlias {
	/**
	 * The alias symbol. For example the symbol representing `default` in
	 * a statement like `export default product` or the symbol representing
	 * `MyTypeName` in a type declarartion statement like `type MyTypeName = { x: number }`
	 */
	alias: ts.Symbol;
	name: string;
}

class Symbols {

	private static topLevelPaths: Map<number, number[]> = new Map([
		[ts.SyntaxKind.VariableDeclaration, [ts.SyntaxKind.VariableDeclarationList, ts.SyntaxKind.VariableStatement, ts.SyntaxKind.SourceFile]]
	]);

	private readonly baseSymbolCache: LRUCache<string, ts.Symbol[]>;
	private readonly baseMemberCache: LRUCache<string, LRUCache<string, ts.Symbol[]>>;
	private readonly exportPathCache: LRUCache<ts.Symbol, string | null>;

	private readonly symbolAliases: Map<string, SymbolAlias>;
	private readonly sourceFilesContainingAmbientDeclarations: Set<string>;

	constructor(private program: ts.Program, private typeChecker: ts.TypeChecker) {
		this.baseSymbolCache = new LRUCache(2048);
		this.baseMemberCache = new LRUCache(2048);
		this.exportPathCache = new LRUCache(2048);

		this.symbolAliases = new Map();
		this.sourceFilesContainingAmbientDeclarations = new Set();

		const ambientModules = this.typeChecker.getAmbientModules();
		for (let module of ambientModules) {
			const declarations = module.getDeclarations();
			if (declarations !== undefined) {
				for (let declarartion of declarations) {
					const sourceFile = declarartion.getSourceFile();
					this.sourceFilesContainingAmbientDeclarations.add(sourceFile.fileName);
				}
			}
		}
		// Reference program
		this.program;
	}

	public computeAliasExportPaths(context: { getOrCreateSymbolData(symbol: ts.Symbol): SymbolData; getSymbolData(symbolId: SymbolId): SymbolData | undefined; }, sourceFile: ts.SourceFile, symbol: ts.Symbol, exportName: string): [SymbolData, string][] {
		const result: [SymbolData, string][] = [];
		const seen: Set<string> = new Set();

		const processExports = (symbol: ts.Symbol, exportName: string): void => {

			const processChild = (child: ts.Symbol, parentPath: string): void => {
				const symbolData = context.getOrCreateSymbolData(child);
				if (seen.has(symbolData.getId())) {
					return;
				}
				seen.add(symbolData.getId());
				const exportName = `${parentPath}.${this.getExportSymbolName(child)}`;
				result.push([symbolData, exportName]);
				processExports(child, exportName);
			};

			const symbolKey = tss.createSymbolKey(this.typeChecker, symbol);

			const symbolData = context.getSymbolData(symbolKey);
			if (symbolData !== undefined && symbolData.getVisibility() !== SymbolDataVisibility.exported) {
				symbolData.changeVisibility(SymbolDataVisibility.aliasExported);
			}
			const type = tss.isTypeAlias(symbol)
				? this.typeChecker.getDeclaredTypeOfSymbol(symbol)
				: this.typeChecker.getTypeOfSymbolAtLocation(symbol, symbol.declarations !== undefined ? symbol.declarations[0] : sourceFile);
			const typeSymbol = type.getSymbol();

			if (typeSymbol !== undefined) {
				const typeSymbolData = context.getOrCreateSymbolData(typeSymbol);
				if (!seen.has(typeSymbolData.getId())) {
					seen.add(typeSymbolData.getId());
					if (typeSymbolData.getVisibility() !== SymbolDataVisibility.exported) {
						typeSymbolData.changeVisibility(SymbolDataVisibility.aliasExported);
						typeSymbol.exports?.forEach(symbol => processChild(symbol, exportName));
						typeSymbol.members?.forEach(symbol => processChild(symbol, exportName));
					}
				}
			}
			if (symbol !== typeSymbol) {
				if (!seen.has(symbolKey)) {
					seen.add(symbolKey);
					symbol.exports?.forEach(symbol => processChild(symbol, exportName));
					symbol.members?.forEach(symbol => processChild(symbol, exportName));
				}
			}
		};
		processExports(symbol, exportName);
		return result;
	}

	public _recordAliasExportPaths(sourceFile: ts.SourceFile): void {
		const sourceFileSymbol = this.typeChecker.getSymbolAtLocation(sourceFile);
		if (sourceFileSymbol === undefined) {
			return;
		}
		let index: number = 1;
		const processSymbol = (alias: ts.Symbol, symbol: ts.Symbol, exportName: string, renames: boolean): void => {
		};

		for (const node of sourceFile.statements) {
			if (ts.isExportAssignment(node)) {
				// `export = foo` or an `export default foo` declaration ==> ExportAssignment
				const exportSymbol = this.typeChecker.getSymbolAtLocation(node) || tss.getSymbolFromNode(node);
				const localSymbol = node.expression !== undefined
					? this.typeChecker.getSymbolAtLocation(node.expression) || tss.getSymbolFromNode(node.expression)
					: undefined;
				if (exportSymbol !== undefined && localSymbol !== undefined) {
					const name = ts.isIdentifier(node.expression) ? node.expression.getText() : `${index++}_export`;
					processSymbol(exportSymbol, localSymbol, name, false);
				}
			} else if (ts.isExportDeclaration(node)) {
				// `export { foo }` ==> ExportDeclaration
				// `export { _foo as foo }` ==> ExportDeclaration
				if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
					for (const element of node.exportClause.elements) {
						const exportSymbol = this.typeChecker.getSymbolAtLocation(element.name);
						if (exportSymbol === undefined) {
							continue;
						}
						const name = element.name.getText();
						const renames = element.propertyName !== undefined && element.propertyName.getText() !== name;
						const localSymbol = tss.isAliasSymbol(exportSymbol)
							? this.typeChecker.getAliasedSymbol(exportSymbol)
							: element.propertyName !== undefined
								? this.typeChecker.getSymbolAtLocation(element.propertyName)
								: undefined;
						if (localSymbol !== undefined) {
							processSymbol(exportSymbol, localSymbol, name, renames);
						}
					}
				}
			}
		}

		// things we need to capture to have correct exports
		// `export =` or an `export default` declaration ==> ExportAssignment
		// `exports.bar = function foo() { ... }` ==> ExpressionStatement
		// `export { root }` ==> ExportDeclaration
		// `export { _root as root }` ==> ExportDeclaration
	}

	public storeSymbolAlias(symbol: ts.Symbol, typeAlias: SymbolAlias): void {
		const key = tss.createSymbolKey(this.typeChecker, symbol);
		this.symbolAliases.set(key, typeAlias);
	}

	public hasSymbolAlias(symbol: ts.Symbol): boolean {
		const key = tss.createSymbolKey(this.typeChecker, symbol);
		return this.symbolAliases.has(key);
	}

	public deleteSymbolAlias(symbol: ts.Symbol): void {
		const key = tss.createSymbolKey(this.typeChecker, symbol);
		this.symbolAliases.delete(key);
	}

	private isExported(parent: ts.Symbol, symbol: ts.Symbol): boolean {
		return parent.exports !== undefined && parent.exports.has(symbol.getName() as ts.__String);
	}

	public getBaseSymbols(symbol: ts.Symbol): ts.Symbol[] | undefined {
		const key = tss.createSymbolKey(this.typeChecker, symbol);
		let result = this.baseSymbolCache.get(key);
		if (result !== undefined) {
			return result;
		}
		if (tss.isTypeLiteral(symbol)) {
			// ToDo@dirk: compute base symbols for type literals.
			return undefined;
		} else if (tss.isInterface(symbol)) {
			result = this.computeBaseSymbolsForInterface(symbol);
		} else if (tss.isClass(symbol)) {
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
		const key = tss.createSymbolKey(this.typeChecker, symbol);
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
						baseResult.set(tss.createSymbolKey(this.typeChecker, symbol), symbol);
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

	public getExportPath(symbol: ts.Symbol, kind: ModuleSystemKind | undefined): string | undefined {
		let result = this.exportPathCache.get(symbol);
		if (result !== undefined) {
			return result === null ? undefined : result;
		}
		const symbolKey = tss.createSymbolKey(this.typeChecker, symbol);
		if (tss.isSourceFile(symbol) && kind === ModuleSystemKind.module) {
			this.exportPathCache.set(symbol, '');
			return '';
		}
		const parent = tss.getSymbolParent(symbol);
		const name = this.getExportSymbolName(symbol);
		if (parent === undefined) {
			// In a global module system symbol inside other namespace don't have a parent
			// if the symbol is not exported. So we need to check if the symbol is a top
			// level symbol
			if (kind === ModuleSystemKind.global && this.isTopLevelSymbol(symbol)) {
				this.exportPathCache.set(symbol, name);
				return name;
			}
			const typeAlias = this.symbolAliases.get(symbolKey);
			if (typeAlias !== undefined && this.getExportPath(typeAlias.alias, kind) !== undefined) {
				this.exportPathCache.set(symbol, typeAlias.name);
				return typeAlias.name;
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
				if (tss.isInterface(parent) || tss.isClass(parent) || tss.isTypeLiteral(parent)) {
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

	public getExportSymbolName(symbol: ts.Symbol): string {
		const name = symbol.getName();
		if (name.charAt(0) === '\"' || name.charAt(0) === '\'') {
			return name.substr(1, name.length - 2);
		}
		// export default foo && export = foo
		if (tss.isAliasSymbol(symbol) && (name === 'default' || name === 'export=')) {
			const declarations = symbol.getDeclarations();
			if (declarations !== undefined && declarations.length === 1) {
				const declaration = declarations[0];
				if (ts.isExportAssignment(declaration)) {
					return declaration.expression.getText();
				}
			}
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
			const path: number[] | undefined = Symbols.topLevelPaths.get(declaration.kind);
			if (path === undefined) {
				result = result || ts.isSourceFile(declaration.parent);
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
	readonly disposeOn?: ts.Node;
}

interface FactoryContext {
	// Todo@dirkb need to think about using root files instead.
	isFullContentIgnored(sourceFile: ts.SourceFile): boolean;
	getSymbolData(id: SymbolId): SymbolData | undefined;
	getOrCreateSymbolData(symbol: ts.Symbol): SymbolData;
}


abstract class SymbolDataFactory {

	constructor(protected typeChecker: ts.TypeChecker, protected symbols: Symbols, protected factoryContext: FactoryContext, protected symbolDataContext: SymbolDataContext) {
	}

	public forwardSymbolInformation(symbol: ts.Symbol): void {
	}

	public clearForwardSymbolInformation(symbol: ts.Symbol): void {
	}

	public getDeclarationNodes(symbol: ts.Symbol): ts.Node[] | undefined {
		return symbol.getDeclarations();
	}

	public getSourceFiles(symbol: ts.Symbol): ts.SourceFile[]  | undefined {
		let sourceFiles = tss.getUniqueSourceFiles(symbol.getDeclarations());
		if (sourceFiles.size === 0) {
			return [];
		}
		return Array.from(sourceFiles.values());
	}

	public getIdentifierInformation(symbol: ts.Symbol, declaration: ts.Node): [ts.Node, string] | [undefined, undefined] {
		if (tss.isNamedDeclaration(declaration)) {
			let name = declaration.name;
			return [name, name.getText()];
		}
		if (tss.isValueModule(symbol) && ts.isSourceFile(declaration)) {
			return [declaration, ''];
		}
		return [undefined, undefined];
	}

	private getModuleSystemKind(sourceFiles: ts.SourceFile[]): ModuleSystemKind | undefined {
		if (sourceFiles.length === 0) {
			return undefined;
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
		return undefined;
	}

	private getDisposeOnNode(declaration: ts.Node): ts.Node {
		let result = declaration.parent;
		while (result !== undefined && !tss.EmitBoundaries.has(result.kind)) {
			result = result.parent;
		}
		return result;
	}

	private getVisibilityAndDisposeNode(sourceFiles: ts.SourceFile[] | undefined, symbol: ts.Symbol, exportPath: string | undefined, moduleSystem: ModuleSystemKind | undefined, parseMode: ParseMode): [SymbolDataVisibility, ts.Node | undefined] {
		// The symbol is exported.
		if (exportPath !== undefined) {
			return [SymbolDataVisibility.exported, undefined];
		}
		// The module system is global. Since we don't have an export path the symbol in internal.
		// Global modules have no export statements hence the symbol can't be exported over an
		// alias
		const hasSourceFile = sourceFiles !== undefined && sourceFiles.length === 1;
		if (moduleSystem === ModuleSystemKind.global) {
			return [SymbolDataVisibility.internal, hasSourceFile ? this.getDisposeOnNode(symbol.declarations[0]) : undefined];
		}
		let visibility: SymbolDataVisibility = SymbolDataVisibility.unknown;
		if (tss.isFunctionScopedVariable(symbol) && hasSourceFile) {
			visibility = SymbolDataVisibility.internal;
		}
		if (visibility === SymbolDataVisibility.unknown || parseMode === ParseMode.referenced || !hasSourceFile) {
			return [visibility, undefined];
		}
		return [visibility, this.getDisposeOnNode(symbol.declarations[0])];
	}

	protected getExportData(sourceFiles: ts.SourceFile[] | undefined, symbol: ts.Symbol, parseMode: ParseMode): [ModuleSystemKind | undefined, string | undefined, SymbolDataVisibility, ts.Node | undefined] {
		const moduleSystem = sourceFiles !== undefined ? this.getModuleSystemKind(sourceFiles) : undefined;
		const exportPath = this.symbols.getExportPath(symbol, moduleSystem);
		const [visibility, disposeOn] = this.getVisibilityAndDisposeNode(sourceFiles, symbol, exportPath, moduleSystem, parseMode);
		return [moduleSystem, exportPath, visibility, disposeOn];
	}

	public abstract create(sourceFiles: ts.SourceFile[] | undefined, symbol: ts.Symbol, id: SymbolId, projectDataManager: ProjectDataManager): FactoryResult;
}

class StandardSymbolDataFactory extends SymbolDataFactory {

	constructor(typeChecker: ts.TypeChecker, protected symbols: Symbols, resolverContext: FactoryContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}

	public create(sourceFiles: ts.SourceFile[] | undefined, symbol: ts.Symbol, id: SymbolId, projectDataManager: ProjectDataManager): FactoryResult {
		const [moduleSystem, exportPath, visibility, disposeOn] = this.getExportData(sourceFiles, symbol, projectDataManager.getParseMode());
		return {
			symbolData: new StandardSymbolData(this.symbolDataContext, id, visibility),
			exportPath, moduleSystem, disposeOn,
			validateVisibilityOn: sourceFiles
		};
	}
}

class AliasFactory extends SymbolDataFactory {

	constructor(typeChecker: ts.TypeChecker, protected symbols: Symbols, resolverContext: FactoryContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}

	public create(sourceFiles: ts.SourceFile[] | undefined, symbol: ts.Symbol, id: SymbolId, projectDataManager: ProjectDataManager): FactoryResult {
		const parseMode = projectDataManager.getParseMode();
		const [moduleSystem, exportPath, visibility, disposeOn] = this.getExportData(sourceFiles, symbol, parseMode);
		const aliased = this.typeChecker.getAliasedSymbol(symbol);
		let symbolData: SymbolData | undefined;
		if (aliased !== undefined) {
			const renames = this.symbols.getExportSymbolName(symbol) !== this.symbols.getExportSymbolName(aliased);
			const aliasedSymbolData = this.factoryContext.getOrCreateSymbolData(aliased);
			if (aliasedSymbolData !== undefined) {
				symbolData = new AliasSymbolData(this.symbolDataContext, id, aliasedSymbolData, visibility, renames);
			}
		}
		if (symbolData === undefined) {
			symbolData = new StandardSymbolData(this.symbolDataContext, id, visibility);
		}
		return {
			symbolData,
			moduleSystem, exportPath,
			disposeOn,
			validateVisibilityOn: sourceFiles,
		};
	}
}

class MethodFactory extends SymbolDataFactory {

	constructor(typeChecker: ts.TypeChecker, protected symbols: Symbols, resolverContext: FactoryContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}

	public create(sourceFiles: ts.SourceFile[] | undefined, symbol: ts.Symbol, id: SymbolId, projectDataManager: ProjectDataManager): FactoryResult {
		if (sourceFiles === undefined) {
			throw new Error(`Need to understand how a method symbol can exist without a source file`);
		}
		// console.log(`MethodResolver#resolve for symbol ${id} | ${symbol.getName()}`);
		const parseMode = projectDataManager.getParseMode();
		const [moduleSystem, exportPath, visibility, disposeOn] = this.getExportData(sourceFiles, symbol, parseMode);
		const container = tss.getSymbolParent(symbol);
		const fileNames = sourceFiles.map(sf => sf.fileName);
		if (container === undefined) {
			return { symbolData: new MethodSymbolData(this.symbolDataContext, id, fileNames, undefined, visibility), exportPath, moduleSystem, disposeOn, validateVisibilityOn: sourceFiles };
		}
		const mostAbstractMembers = this.symbols.findRootMembers(container, symbol.getName());
		// No abstract membes found
		if (mostAbstractMembers === undefined || mostAbstractMembers.length === 0) {
			return { symbolData: new MethodSymbolData(this.symbolDataContext, id, fileNames, undefined, visibility), exportPath, moduleSystem, disposeOn, validateVisibilityOn: sourceFiles };
		}
		// It is the symbol itself
		if (mostAbstractMembers.length === 1 && mostAbstractMembers[0] === symbol) {
			return { symbolData: new MethodSymbolData(this.symbolDataContext, id, fileNames, undefined, visibility), exportPath, moduleSystem, disposeOn, validateVisibilityOn: sourceFiles };
		}
		const mostAbstractSymbolData = mostAbstractMembers.map(member => this.factoryContext.getOrCreateSymbolData(member));
		return { symbolData: new MethodSymbolData(this.symbolDataContext, id, fileNames, mostAbstractSymbolData, visibility), exportPath, moduleSystem, disposeOn, validateVisibilityOn: sourceFiles };
	}
}

class UnionOrIntersectionFactory extends SymbolDataFactory {

	constructor(typeChecker: ts.TypeChecker, protected symbols: Symbols, resolverContext: FactoryContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}

	public getDeclarationNodes(symbol: ts.Symbol): ts.Node[] | undefined {
		if (tss.isTransient(symbol)) {
			return undefined;
		}
		return super.getDeclarationNodes(symbol);
	}

	public getSourceFiles(symbol: ts.Symbol): ts.SourceFile[] | undefined {
		if (tss.isTransient(symbol)) {
			return undefined;
		}
		return super.getSourceFiles(symbol);
	}

	public create(sourceFiles: ts.SourceFile[] | undefined, symbol: ts.Symbol, id: SymbolId, projectDataManager: ProjectDataManager): FactoryResult {
		const parseMode = projectDataManager.getParseMode();
		const shard = projectDataManager.getProjectData().project;
		const fileNames = sourceFiles !== undefined ? sourceFiles.map(sf => sf.fileName) : undefined;
		const composites = tss.getCompositeLeafSymbols(this.typeChecker, symbol);
		if (composites !== undefined) {
			const datas: SymbolData[] = [];
			for (const symbol of composites) {
				datas.push(this.factoryContext.getOrCreateSymbolData(symbol));
			}
			if (tss.isTransient(symbol)) {
				// For the moniker we need to find out the ands and ors. Not sure how to do this.
				let monikerIds: string[] = [];
				for (const symbolData of datas) {
					const moniker = symbolData.getMoniker();
					if (moniker === undefined) {
						monikerIds = [];
						break;
					} else {
						monikerIds.push(moniker.identifier);
					}
				}
				if (monikerIds.length > 0) {
					return {
						symbolData: new UnionOrIntersectionSymbolData(this.symbolDataContext, id, fileNames, datas, shard),
						moduleSystem: ModuleSystemKind.global,
						exportPath: `[${monikerIds.sort().join(',')}]`
					};
				} else {
					return {
						symbolData: new UnionOrIntersectionSymbolData(this.symbolDataContext, id, fileNames, datas, shard),
					};
				}
			} else {
				const [moduleSystem, exportPath] = this.getExportData(sourceFiles, symbol, parseMode);
				return {
					symbolData: new UnionOrIntersectionSymbolData(this.symbolDataContext, id, fileNames, datas, shard),
					moduleSystem, exportPath
				};
			}
		} else {
			const [moduleSystem, exportPath, visibility, disposeOn] = this.getExportData(sourceFiles, symbol, parseMode);
			return { symbolData: new StandardSymbolData(this.symbolDataContext, id, visibility), moduleSystem, exportPath, disposeOn, validateVisibilityOn: sourceFiles };
		}
	}

	public getIdentifierInformation(symbol: ts.Symbol, declaration: ts.Node): [ts.Node, string] | [undefined, undefined] {
		if (tss.isTransient(symbol)) {
			return [undefined, undefined];
		}
		return [declaration, declaration.getText()];
	}
}

class TransientFactory extends SymbolDataFactory {

	constructor(typeChecker: ts.TypeChecker, protected symbols: Symbols, resolverContext: FactoryContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}

	public getDeclarationNodes(symbol: ts.Symbol): ts.Node[] | undefined {
		return undefined;
	}

	public getSourceFiles(symbol: ts.Symbol): ts.SourceFile[] | undefined {
		return undefined;
	}

	public create(sourceFiles: ts.SourceFile[] | undefined, symbol: ts.Symbol, id: SymbolId): FactoryResult {
		return { symbolData: new TransientSymbolData(this.symbolDataContext, id) };
	}
}

interface TypeLiteralCallback {
	(index: number, typeAlias: ts.Symbol, literalType: ts.Symbol): number;
}

class TypeAliasResolver extends StandardSymbolDataFactory {
	constructor(typeChecker: ts.TypeChecker, protected symbols: Symbols, resolverContext: FactoryContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}

	public forwardSymbolInformation(symbol: ts.Symbol): void {
		this.visitSymbol(symbol, (index: number, typeAlias: ts.Symbol, literalType: ts.Symbol) => {
			// T1 & (T2 | T3) will be expanded into T1 & T2 | T1 & T3. So check if we have already seens
			// a literal to ensure we are always using the first one
			if (this.symbols.hasSymbolAlias(literalType)) {
				return index;
			}
			// We put the number into the front since it is not a valid
			// identifier. So it can't be in code.
			const name = `${index++}_${typeAlias.getName()}`;
			this.symbols.storeSymbolAlias(literalType, { alias: typeAlias, name });
			return index;
		});
	}

	public clearForwardSymbolInformation(symbol: ts.Symbol): void {
		this.visitSymbol(symbol, (index: number, typeAlias: ts.Symbol, literalType: ts.Symbol) => {
			this.symbols.deleteSymbolAlias(literalType);
			return index;
		});
	}

	private visitSymbol(symbol: ts.Symbol, cb: TypeLiteralCallback) {
		const type = this.typeChecker.getDeclaredTypeOfSymbol(symbol);
		if (type === undefined) {
			return;
		}
		this.visitType(symbol, type, 0, cb);
	}

	private visitType(typeAlias: ts.Symbol, type: ts.Type, index: number, cb: TypeLiteralCallback): number {
		if (tss.isTypeLiteral(type.symbol)) {
			return cb(index, typeAlias, type.symbol);
		}
		if (type.isUnionOrIntersection()) {
			if (type.types.length > 0) {
				for (let item of type.types) {
					index = this.visitType(typeAlias, item, index, cb);
				}
			}
		}
		return index;
	}
}

export interface Options {
	group: Group;
	projectRoot: string;
	projectName: string;
	tsConfigFile: string | undefined;
	stdout: boolean;
}

enum ParseMode {
	referenced = 1,
	full = 2
}

abstract class ProjectDataManager {

	protected readonly emitter: EmitterContext;
	private readonly projectData: ProjectData;
	private readonly emitStats: boolean;

	private documentStats: number;
	private readonly documentDatas: DocumentData[];
	private symbolStats: number;
	// We only need to keep public symbol datas. Private symbol datas are cleared when the
	// corresponding node is processed.
	private readonly managedSymbolDatas: SymbolData[];

	public constructor(emitter: EmitterContext, group: Group, project: Project, emitStats: boolean = false) {
		this.emitter = emitter;
		this.projectData = new ProjectData(emitter, group, project);
		this.emitStats = emitStats;
		this.documentStats = 0;
		this.documentDatas = [];
		this.symbolStats = 0;
		this.managedSymbolDatas = [];
	}

	public abstract getParseMode(): ParseMode;

	public updateSymbolDataManagement(symbolData: SymbolData): void {
		const visibility = symbolData.getVisibility();
		if (visibility === SymbolDataVisibility.exported || visibility === SymbolDataVisibility.aliasExported) {
			this.managedSymbolDatas.push(symbolData);
		}
	}

	public begin(): void {
		this.projectData.begin();
	}

	public getProjectData(): ProjectData {
		return this.projectData;
	}

	public createDocumentData(fileName: string, document: Document, moduleSystem: ModuleSystemKind, monikerPath: string | undefined, external: boolean): DocumentData {
		const result = new DocumentData(this.emitter, document, moduleSystem, monikerPath, external);
		result.begin();
		this.projectData.addDocument(document);
		this.documentStats++;
		this.documentDatas.push(result);
		return result;
	}

	public createSymbolData(symbolId: SymbolId, create: (projectDataManager: ProjectDataManager) => FactoryResult): FactoryResult {
		const result = create(this);
		if (result.disposeOn === undefined && result.symbolData.getVisibility() !== SymbolDataVisibility.unknown) {
			this.managedSymbolDatas.push(result.symbolData);
		}
		this.symbolStats++;
		return result;
	}

	public abstract end(): void;

	protected doEnd(fileNames: Set<string> | undefined): void {
		for (const symbolData of this.managedSymbolDatas) {
			if (fileNames === undefined) {
				symbolData.end();
			} else {
				symbolData.endPartitions(fileNames);
			}
		}
		for (const data of this.documentDatas) {
			data.close();
		}
		this.projectData.end();
		if (this.emitStats) {
			console.log('');
			console.log(`Processed ${this.symbolStats} symbols in ${this.documentStats} files for project ${this.getName()}`);
		}
	}

	protected getName(): string {
		return this.projectData.project.name;
	}
}

enum LazyProectDataManagerState {
	start = 1,
	beginCalled = 2,
	beginExecuted = 3,
	endCalled = 4
}

class LazyProjectDataManager extends ProjectDataManager {

	private state: LazyProectDataManagerState;

	public constructor(emitter: EmitterContext, group: Group, project: Project, emitStats: boolean = false) {
		super(emitter, group, project, emitStats);
		this.state = LazyProectDataManagerState.start;
	}

	public getParseMode(): ParseMode {
		return ParseMode.referenced;
	}

	public begin(): void {
		this.state = LazyProectDataManagerState.beginCalled;
	}

	private executeBegin(): void {
		super.begin();
		this.state = LazyProectDataManagerState.beginExecuted;
	}

	private checkState(): void {
		if (this.state !== LazyProectDataManagerState.beginExecuted) {
			throw new Error(`Project data manager has wrong state ${this.state}`);
		}
	}

	public end(): void {
		if (this.state === LazyProectDataManagerState.beginExecuted) {
			super.doEnd(undefined);
		}
		this.state = LazyProectDataManagerState.endCalled;
	}

	public getProjectData(): ProjectData {
		if (this.state === LazyProectDataManagerState.beginCalled) {
			this.executeBegin();
		}
		this.checkState();
		return super.getProjectData();
	}

	public createDocumentData(fileName: string, document: Document, moduleSystem: ModuleSystemKind, monikerPath: string | undefined, external: boolean): DocumentData {
		if (this.state === LazyProectDataManagerState.beginCalled) {
			this.executeBegin();
		}
		this.checkState();
		return super.createDocumentData(fileName, document, moduleSystem, monikerPath, external);
	}

	public createSymbolData(symbolId: SymbolId, create: (projectDataManager: ProjectDataManager) => FactoryResult): FactoryResult {
		if (this.state === LazyProectDataManagerState.beginCalled) {
			this.executeBegin();
		}
		this.checkState();
		return super.createSymbolData(symbolId, create);
	}
}

class GlobalProjectDataManager extends LazyProjectDataManager {

	public constructor(emitter: EmitterContext, group: Group, project: Project, emitStats: boolean = false) {
		super(emitter, group, project, emitStats);
	}

	protected getName(): string {
		return 'Global libraries';
	}
}


class DefaultLibsProjectDataManager extends LazyProjectDataManager {

	public constructor(emitter: EmitterContext, group: Group, project: Project, emitStats: boolean = false) {
		super(emitter, group, project, emitStats);
	}

	protected getName(): string {
		return 'TypeScript default libraries';
	}
}

class GroupProjectDataManager extends LazyProjectDataManager {

	private readonly groupName: string;
	private readonly groupRoot: string;

	public constructor(emitter: EmitterContext, group: Group, project: Project, groupRoot: string, emitStats: boolean = false) {
		super(emitter, group, project, emitStats);
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

	private readonly projectRoot: string;
	private readonly rootFiles: Set<string>;
	private readonly managedFiles: Set<string>;

	public constructor(emitter: EmitterContext, group: Group, project: Project, projectRoot: string, rootFiles: ReadonlyArray<string> | undefined, emitStats: boolean = false) {
		super(emitter, group, project, emitStats);
		this.projectRoot = projectRoot;
		this.rootFiles = new Set(rootFiles);
		this.managedFiles = new Set();
	}

	public getParseMode(): ParseMode {
		return ParseMode.full;
	}

	public handles(sourceFile: ts.SourceFile): boolean {
		const fileName = sourceFile.fileName;
		return this.rootFiles.has(fileName) || paths.isParent(this.projectRoot, fileName);
	}

	public createDocumentData(fileName: string, document: Document, moduleSystem: ModuleSystemKind, monikerPath: string | undefined, external: boolean): DocumentData {
		this.managedFiles.add(fileName);
		return super.createDocumentData(fileName, document, moduleSystem, monikerPath, external);
	}

	public end(): void {
		this.doEnd(this.managedFiles);
	}
}

interface DataManagerResult {
	readonly symbolData: SymbolData;
	readonly exportPath?: string;
	readonly moduleSystem?: ModuleSystemKind;
}

export class DataManager implements SymbolDataContext {

	private static readonly GlobalId: string = 'bc450df0-741c-4ee7-9e0e-eddd95f8f314';
	private static readonly DefaultLibsId: string = '5779b280-596f-4b5d-90d8-b87441d7afa0';

	private readonly context: EmitterContext;
	private readonly group: Group;
	private readonly reportStats: boolean;

	private readonly globalPDM: GlobalProjectDataManager;
	private readonly defaultLibsPDM: DefaultLibsProjectDataManager;
	private readonly groupPDM: GroupProjectDataManager;
	private currentPDM: TSConfigProjectDataManager | undefined;
	private currentProgram: ts.Program | undefined;

	private readonly documentDatas: Map<string, DocumentData>;
	private readonly symbolDatas: Map<string, SymbolData | null>;
	private readonly partitionLifeCycle: Map<string, SymbolData[]>;
	private readonly disposeOnNode: Map<ts.Node, SymbolData[]>;
	private readonly validateVisibilityCounter: Map<string, { projectDataManager: ProjectDataManager; counter: number }>;
	private readonly validateVisibilityOn: Map<string, SymbolData[]>

	public constructor(context: EmitterContext, group: Group, groupRoot: string, reportStats: boolean) {
		this.context = context;
		this.group = group;
		this.reportStats = reportStats;
		this.documentDatas = new Map();
		this.symbolDatas = new Map();
		this.disposeOnNode = new Map();
		this.partitionLifeCycle = new Map();
		this.validateVisibilityCounter = new Map();
		this.validateVisibilityOn = new Map();

		this.globalPDM = new GlobalProjectDataManager(this, this.group, this.context.vertex.project(DataManager.GlobalId), reportStats);
		this.defaultLibsPDM = new DefaultLibsProjectDataManager(this, this.group, this.context.vertex.project(DataManager.DefaultLibsId), reportStats);
		this.groupPDM = new GroupProjectDataManager(this, this.group, this.context.vertex.project(group.name), groupRoot, reportStats);
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

	public beginProject(program: ts.Program, project: Project, projectRoot: string): void {
		if (this.currentPDM !== undefined) {
			throw new Error(`There is already a current program data manager set`);
		}
		this.currentProgram = program;
		this.currentPDM = new TSConfigProjectDataManager(this, this.group, project, projectRoot, program.getRootFileNames(), this.reportStats);
		this.currentPDM.begin();
	}

	public getProjectData(): ProjectData {
		if (this.currentPDM === undefined) {
			throw new Error(`No current project`);
		}
		return this.currentPDM.getProjectData();
	}

	public endProject(program: ts.Program): void {
		if (this.currentProgram !== program || this.currentPDM === undefined) {
			throw new Error(`Current project is not the one to end`);
		}
		this.currentPDM.end();
		this.currentPDM = undefined;
		this.currentProgram = undefined;
	}

	public end(): void {
		this.globalPDM.end();
		this.defaultLibsPDM.end();
		this.groupPDM.end();
	}

	public getDocumentData(fileName: string): DocumentData | undefined {
		return this.documentDatas.get(fileName);
	}

	public getOrCreateDocumentData(sourceFile: ts.SourceFile, document: Document, moduleSystem: ModuleSystemKind, monikerPath: string | undefined, external: boolean): DocumentData {
		const fileName = sourceFile.fileName;
		let result = this.getDocumentData(fileName);
		if (result !== undefined) {
			return result;
		}

		const manager: ProjectDataManager = this.getProjectDataManager(sourceFile);
		result = manager.createDocumentData(fileName, document, moduleSystem, monikerPath, external);
		(result as any).sf = sourceFile;
		this.documentDatas.set(fileName, result);
		return result;
	}

	private getProjectDataManager(sourceFile: ts.SourceFile): ProjectDataManager {
		if (this.currentProgram !== undefined && tss.Program.isSourceFileDefaultLibrary(this.currentProgram, sourceFile)) {
			return this.defaultLibsPDM;
		} else if (this.currentPDM !== undefined && this.currentPDM.handles(sourceFile)) {
			return this.currentPDM;
		} else if (this.groupPDM.handles(sourceFile)) {
			return this.groupPDM;
		} else {
			return this.globalPDM;
		}
	}

	public documemntProcessed(fileName: string): void {
		let data = this.getDocumentData(fileName);
		if (data === undefined) {
			throw new Error(`No document data for file ${fileName}`);
		}
		const handledSymbolData: Set<string> = new Set();
		const validateVisibilityOn = this.validateVisibilityOn.get(fileName);
		this.validateVisibilityOn.delete(fileName);
		if (validateVisibilityOn !== undefined) {
			for (const symbolData of validateVisibilityOn) {
				const symbolId = symbolData.getId();
				const visibility = symbolData.getVisibility();
				const counter = this.validateVisibilityCounter.get(symbolId);
				if (counter !== undefined) {
					if (visibility === SymbolDataVisibility.exported || visibility === SymbolDataVisibility.aliasExported) {
						counter.projectDataManager.updateSymbolDataManagement(symbolData);
						this.validateVisibilityCounter.delete(symbolId);
					} else if (counter.counter === 1) {
						if (visibility === SymbolDataVisibility.unknown || visibility === SymbolDataVisibility.internal) {
							handledSymbolData.add(symbolId);
							symbolData.end();
							this.symbolDatas.set(symbolId, null);
						}
						this.validateVisibilityCounter.delete(symbolId);
					} else {
						counter.counter--;
					}
				}
			}
		}
		const datas = this.partitionLifeCycle.get(fileName);
		if (datas !== undefined) {
			for (const symbolData of datas) {
				if (!handledSymbolData.has(symbolData.getId())) {
					symbolData.endPartition(fileName);
				}
			}
		}
		data.end();
		data.close();
	}

	public getSymbolData(symbolId: SymbolId): SymbolData | undefined {
		let result = this.symbolDatas.get(symbolId);
		if (result === null) {
			throw new Error(`There was already a managed symbol data for id: ${symbolId}`);
		}
		return result;
	}

	public getOrCreateSymbolData(symbolId: SymbolId, sourceFiles: ts.SourceFile[] | undefined, create: (projectDataManager: ProjectDataManager) => FactoryResult): DataManagerResult {
		let symbolData = this.getSymbolData(symbolId);
		if (symbolData !== undefined) {
			return { symbolData };
		}
		let manager: ProjectDataManager;
		if (sourceFiles === undefined || sourceFiles.length === 0) {
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

		const result = manager.createSymbolData(symbolId, create);
		symbolData = result.symbolData;
		if (result.disposeOn !== undefined) {
			let datas = this.disposeOnNode.get(result.disposeOn);
			if (datas === undefined) {
				datas = [];
				this.disposeOnNode.set(result.disposeOn, datas);
			}
			datas.push(symbolData);
		}
		if (manager.getParseMode() === ParseMode.full && symbolData.getVisibility() === SymbolDataVisibility.unknown && result.validateVisibilityOn !== undefined && result.validateVisibilityOn.length > 0) {
			const counter = result.validateVisibilityOn.length;
			this.validateVisibilityCounter.set(symbolData.getId(), { counter, projectDataManager: manager });
			for (const sourceFile of result.validateVisibilityOn) {
				let datas = this.validateVisibilityOn.get(sourceFile.fileName);
				if (datas === undefined) {
					datas = [];
					this.validateVisibilityOn.set(sourceFile.fileName, datas);
				}
				datas.push(symbolData);
			}
		}

		this.symbolDatas.set(symbolData.getId(), symbolData);
		symbolData.begin();
		return result;
	}

	public managePartitionLifeCycle(fileName: string, symbolData: SymbolData): void {
		let datas = this.partitionLifeCycle.get(fileName);
		if (datas === undefined) {
			datas = [];
			this.partitionLifeCycle.set(fileName, datas);
		}
		datas.push(symbolData);
	}

	public nodeProcessed(node: ts.Node): void {
		let datas = this.disposeOnNode.get(node);
		if (datas !== undefined) {
			for (let symbolData of datas) {
				symbolData.end(true);
				this.symbolDatas.set(symbolData.getId(), null);
			}
			this.disposeOnNode.delete(node);
		}
	}
}

export interface ProjectInfo {
	rootDir: string;
	outDir: string;
}

export class SimpleSymbolChainCache implements ts.SymbolChainCache {

	public lookup(key: ts.SymbolChainCacheKey): ts.Symbol[] {
		return [key.symbol];
	}
	public cache(key: ts.SymbolChainCacheKey, value: ts.Symbol[]): void {
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
		let symbolKey = tss.createSymbolKey(this.typeChecker, key.symbol);
		let declaration = key.enclosingDeclaration ? `${key.enclosingDeclaration.pos}|${key.enclosingDeclaration.end}` : '';
		return `${symbolKey}|${declaration}|${key.flags}|${key.meaning}|${!!key.yieldModuleSymbol}`;
	}
}

class Visitor implements FactoryContext {

	private program: ts.Program;
	private typeChecker: ts.TypeChecker;

	private project: Project;
	private projectRoot: string;
	private sourceRoot: string;
	private outDir: string;
	private dependentOutDirs: string[];
	private currentSourceFile: ts.SourceFile | undefined;
	private _currentDocumentData: DocumentData | undefined;
	private symbols: Symbols;
	private disposables: Map<string, Disposable[]>;
	private symbolContainer: RangeBasedDocumentSymbol[];
	private recordDocumentSymbol: boolean[];
	private dataManager: DataManager;
	private symbolDataFactories: {
		standard: StandardSymbolDataFactory;
		alias: AliasFactory;
		method: MethodFactory;
		unionOrIntersection: UnionOrIntersectionFactory;
		transient: TransientFactory;
		typeAlias: TypeAliasResolver;
	};

	constructor(private emitter: EmitterContext, private languageService: ts.LanguageService, dataManager: DataManager, dependsOn: ProjectInfo[], private options: Options) {
		this.program = languageService.getProgram()!;
		this.typeChecker = this.program.getTypeChecker();
		this.symbolContainer = [];
		this.recordDocumentSymbol = [];
		this.dependentOutDirs = [];
		for (let info of dependsOn) {
			this.dependentOutDirs.push(info.outDir);
		}
		this.dependentOutDirs.sort((a, b) => {
			return b.length - a.length;
		});
		this.projectRoot = options.projectRoot;
		this.project = this.vertex.project(options.projectName);
		const configLocation = options.tsConfigFile !== undefined ? path.dirname(options.tsConfigFile) : undefined;
		let compilerOptions = this.program.getCompilerOptions();
		if (compilerOptions.rootDir !== undefined) {
			this.sourceRoot = tss.makeAbsolute(compilerOptions.rootDir, configLocation);
		} else if (compilerOptions.baseUrl !== undefined) {
			this.sourceRoot = tss.makeAbsolute(compilerOptions.baseUrl, configLocation);
		} else {
			this.sourceRoot = tss.normalizePath(tss.Program.getCommonSourceDirectory(this.program));
		}
		if (compilerOptions.outDir !== undefined) {
			this.outDir = tss.makeAbsolute(compilerOptions.outDir, configLocation);
		} else {
			this.outDir = this.sourceRoot;
		}
		this.dataManager = dataManager;
		this.symbols = new Symbols(this.program, this.typeChecker);
		this.dataManager.beginProject(this.program, this.project, configLocation || process.cwd());
		this.disposables = new Map();
		this.symbolDataFactories = {
			standard: new StandardSymbolDataFactory(this.typeChecker, this.symbols, this, this.dataManager),
			alias: new AliasFactory(this.typeChecker, this.symbols, this, this.dataManager),
			method: new MethodFactory(this.typeChecker, this.symbols, this, this.dataManager),
			unionOrIntersection: new UnionOrIntersectionFactory(this.typeChecker, this.symbols, this, this.dataManager),
			transient: new TransientFactory(this.typeChecker, this.symbols, this, this.dataManager),
			typeAlias: new TypeAliasResolver(this.typeChecker, this.symbols, this, this.dataManager)
		};
	}

	public visitProgram(): ProjectInfo {
		let sourceFiles = this.program.getSourceFiles();
		if (sourceFiles.length > 256) {
			this.typeChecker.setSymbolChainCache(new SimpleSymbolChainCache());
		}
		for (let rootFile of this.program.getRootFileNames()) {
			const sourceFile = this.program.getSourceFile(rootFile);
			if (sourceFile !== undefined) {
				this.visit(sourceFile);
			}
		}
		return {
			rootDir: this.sourceRoot,
			outDir: this.outDir
		};
	}

	public endVisitProgram(): void {
		this.dataManager.endProject(this.program);
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
		this.dataManager.nodeProcessed(node);
		endVisit.call(this, node);
	}

	private visitSourceFile(sourceFile: ts.SourceFile): boolean {
		let disposables: Disposable[] = [];
		if (this.isFullContentIgnored(sourceFile)) {
			return false;
		}
		if (!this.options.stdout) {
			process.stdout.write('.');
		}

		this.currentSourceFile = sourceFile;
		let documentData = this.getOrCreateDocumentData(sourceFile);
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

		let documentData = this.currentDocumentData;
		// Diagnostics
		let diagnostics: lsp.Diagnostic[] = [];
		let syntactic = this.program.getSyntacticDiagnostics(sourceFile);
		for (let element of syntactic) {
			diagnostics.push(Converter.asDiagnostic(element));
		}
		let semantic = this.program.getSemanticDiagnostics(sourceFile);
		for (let element of semantic) {
			if (element.file !== undefined && element.start !== undefined && element.length !== undefined) {
				diagnostics.push(Converter.asDiagnostic(element as ts.DiagnosticWithLocation));
			}
		}
		if (diagnostics.length > 0) {
			documentData.addDiagnostics(diagnostics);
		}

		// Folding ranges
		let spans = this.languageService.getOutliningSpans(sourceFile as any);
		if (ts.textSpanEnd.length > 0) {
			let foldingRanges: lsp.FoldingRange[] = [];
			for (let span of spans) {
				foldingRanges.push(Converter.asFoldingRange(sourceFile,span));
			}
			if (foldingRanges.length > 0) {
				documentData.addFoldingRanges(foldingRanges);
			}
		}

		// Document symbols.
		let values = (this.symbolContainer.pop() as RangeBasedDocumentSymbol).children;
		if (values !== undefined && values.length > 0) {
			documentData.addDocumentSymbols(values);
		}
		this.recordDocumentSymbol.pop();

		this.currentSourceFile = undefined;
		this._currentDocumentData = undefined;
		this.dataManager.documemntProcessed(sourceFile.fileName);
		for (let disposable of this.disposables.get(sourceFile.fileName)!) {
			disposable();
		}
		this.disposables.delete(sourceFile.fileName);
		if (this.symbolContainer.length !== 0) {
			throw new Error(`Unbalanced begin / end calls`);
		}
	}

	public isFullContentIgnored(sourceFile: ts.SourceFile): boolean {
		return tss.Program.isSourceFileDefaultLibrary(this.program, sourceFile) ||
			tss.Program.isSourceFileFromExternalLibrary(this.program, sourceFile);
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

	private visitClassExpression(node: ts.ClassExpression): boolean {
		return true;
	}

	private endVisitClassExpression(node: ts.ClassExpression): void {
	}

	private visitDeclaration(node: tss.Declaration, isContainer: boolean): void {
		let recordDocumentSymbol: boolean = this.currentRecordDocumentSymbol && isContainer;
		let didRecord: boolean = recordDocumentSymbol;
		if (recordDocumentSymbol) {
			didRecord = this.addDocumentSymbol(node);
		}
		this.recordDocumentSymbol.push(didRecord);
		return;
	}

	private endVisitDeclaration(node: tss.Declaration): void {
		let didRecord = this.recordDocumentSymbol.pop();
		if (didRecord) {
			this.symbolContainer.pop();
		}
	}

	private addDocumentSymbol(node: tss.Declaration): boolean {
		let rangeNode = node.name !== undefined ? node.name : node;
		let symbol = this.program.getTypeChecker().getSymbolAtLocation(rangeNode);
		let declarations = symbol !== undefined ? symbol.getDeclarations() : undefined;
		if (symbol === undefined || declarations === undefined || declarations.length === 0) {
			return false;
		}
		let symbolData = this.getOrCreateSymbolData(symbol);
		if (symbolData === undefined) {
			return false;
		}
		let sourceFile = this.currentSourceFile!;
		let definition = symbolData.findDefinition(sourceFile.fileName, Converter.rangeFromNode(sourceFile, rangeNode));
		if (definition === undefined) {
			return false;
		}
		let currentContainer = this.symbolContainer[this.symbolContainer.length - 1];
		let child: RangeBasedDocumentSymbol = { id: definition.id };
		if (currentContainer.children === undefined) {
			currentContainer.children = [ child ];
		} else {
			currentContainer.children.push(child);
		}
		this.symbolContainer.push(child);
		return true;
	}

	private visitExportAssignment(node: ts.ExportAssignment): boolean {
		// Todo@dbaeumer TS compiler doesn't return symbol for export assignment.
		const symbol = this.typeChecker.getSymbolAtLocation(node) || tss.getSymbolFromNode(node);
		if (symbol === undefined) {
			return false;
		}
		// Handle the export assignment.
		this.handleSymbol(symbol, node);
		const symbolData = this.getSymbolData(tss.createSymbolKey(this.typeChecker, symbol));
		if (symbolData === undefined) {
			return false;
		}
		const moniker = symbolData.getMoniker();
		if (moniker === undefined || moniker.unique === UniquenessLevel.document) {
			return false;
		}

		const monikerParts = TscMoniker.parse(moniker.identifier);
		const aliasedSymbol = this.typeChecker.getSymbolAtLocation(node.expression) || tss.getSymbolFromNode(node.expression);
		this.handleSymbol(aliasedSymbol, node.expression);
		if (aliasedSymbol !== undefined && monikerParts.path !== undefined) {
			const name = node.expression.getText();
			const sourceFile = node.getSourceFile();
			const aliasExports = this.symbols.computeAliasExportPaths(this, sourceFile, aliasedSymbol, name);
			for (const aliasExport of aliasExports) {
				const resultSet = this.vertex.resultSet();
				this.emit(resultSet);
				this.emit(this.edge.next(resultSet, aliasExport[0].getResultSet()));
				const moniker = this.vertex.moniker('tsc', tss.createMonikerIdentifier(monikerParts.path, aliasExport[1]), UniquenessLevel.group, MonikerKind.export);
				this.emit(moniker);
				this.emit(this.edge.moniker(resultSet, moniker));
			}
		}
		return false;
	}

	private endVisitExportAssignment(node: ts.ExportAssignment): void {
		// Do nothing;
	}

	private visitExportDeclaration(node: ts.ExportDeclaration): boolean {
		// `export { foo }` ==> ExportDeclaration
		// `export { _foo as foo }` ==> ExportDeclaration
		if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
			for (const element of node.exportClause.elements) {
				const symbol = this.typeChecker.getSymbolAtLocation(element.name);
				if (symbol === undefined) {
					continue;
				}
				this.handleSymbol(symbol, element.name);
				const symbolData = this.getSymbolData(tss.createSymbolKey(this.typeChecker, symbol));
				if (symbolData === undefined) {
					return false;
				}
				const moniker = symbolData.getMoniker();
				if (moniker === undefined || moniker.unique === UniquenessLevel.document) {
					continue;
				}
				const monikerParts = TscMoniker.parse(moniker.identifier);
				const aliasedSymbol = tss.isAliasSymbol(symbol)
					? this.typeChecker.getAliasedSymbol(symbol)
					: element.propertyName !== undefined
						? this.typeChecker.getSymbolAtLocation(element.propertyName)
						: undefined;
				if (element.propertyName !== undefined) {
					this.handleSymbol(aliasedSymbol, element.propertyName);
				}
				if (aliasedSymbol !== undefined && monikerParts.path !== undefined) {
					const name = element.propertyName?.getText() || element.name.getText();
					const sourceFile = node.getSourceFile();
					const aliasExports = this.symbols.computeAliasExportPaths(this, sourceFile, aliasedSymbol, name);
					for (const aliasExport of aliasExports) {
						const resultSet = this.vertex.resultSet();
						this.emit(resultSet);
						this.emit(this.edge.next(resultSet, aliasExport[0].getResultSet()));
						const moniker = this.vertex.moniker('tsc', tss.createMonikerIdentifier(monikerParts.path, aliasExport[1]), UniquenessLevel.group, MonikerKind.export);
						this.emit(moniker);
						this.emit(this.edge.moniker(resultSet, moniker));
					}
				}
			}
		}
		return false;
	}

	private endVisitExportDeclaration(node: ts.ExportDeclaration): void {

	}

	private visitIdentifier(node: ts.Identifier): void {
		this.handleSymbol(this.typeChecker.getSymbolAtLocation(node), node);
	}

	private visitStringLiteral(node: ts.StringLiteral): void {
		this.handleSymbol(this.typeChecker.getSymbolAtLocation(node), node);
	}

	private handleSymbol(symbol: ts.Symbol | undefined, location: ts.Node): void {
		if (symbol === undefined) {
			return;
		}
		let symbolData = this.getOrCreateSymbolData(symbol);
		if (symbolData === undefined) {
			return;
		}
		let sourceFile = this.currentSourceFile!;
		if (symbolData.hasDefinitionInfo(tss.createDefinitionInfo(sourceFile, location))) {
			return;
		}

		let reference = this.vertex.range(Converter.rangeFromNode(sourceFile, location), { type: RangeTagTypes.reference, text: location.getText() });
		this.currentDocumentData.addRange(reference);
		symbolData.addReference(sourceFile.fileName, reference, ItemEdgeProperties.references);
	}

	private visitGeneric(node: ts.Node): boolean {
		return true;
	}

	private endVisitGeneric(node: ts.Node): void {
		let symbol = this.typeChecker.getSymbolAtLocation(node) || tss.getSymbolFromNode(node);
		if (symbol === undefined) {
			return;
		}
		let id = tss.createSymbolKey(this.typeChecker, symbol);
		let symbolData = this.dataManager.getSymbolData(id);
		if (symbolData !== undefined) {
			this.getFactory(symbol).clearForwardSymbolInformation(symbol);
			// Todo@dbaeumer thinks about whether we should add a reference here.
			return;
		}
		symbolData = this.getOrCreateSymbolData(symbol);
		if (symbolData === undefined) {
			return;
		}
		let sourceFile = this.currentSourceFile!;
		if (symbolData.hasDefinitionInfo(tss.createDefinitionInfo(sourceFile, node))) {
			return;
		}

		let reference = this.vertex.range(Converter.rangeFromNode(sourceFile, node), { type: RangeTagTypes.reference, text: node.getText() });
		this.currentDocumentData.addRange(reference);
		symbolData.addReference(sourceFile.fileName, reference, ItemEdgeProperties.references);
		return;
	}

	public getDefinitionAtPosition(sourceFile: ts.SourceFile, node: ts.Identifier): ReadonlyArray<ts.DefinitionInfo> | undefined {
		return this.languageService.getDefinitionAtPosition(sourceFile.fileName, node.getStart(sourceFile));
	}

	public getTypeDefinitionAtPosition(sourceFile: ts.SourceFile, node: ts.Identifier): ReadonlyArray<ts.DefinitionInfo> | undefined {
		return this.languageService.getTypeDefinitionAtPosition(sourceFile.fileName, node.getStart(sourceFile));
	}

	public getOrCreateDocumentData(sourceFile: ts.SourceFile): DocumentData {
		const isFromExternalLibrary = (sourceFile: ts.SourceFile): boolean => {
			return tss.Program.isSourceFileFromExternalLibrary(this.program, sourceFile);
		};

		const isFromProjectSources = (sourceFile: ts.SourceFile): boolean => {
			const fileName = sourceFile.fileName;
			return !sourceFile.isDeclarationFile || paths.isParent(this.sourceRoot, fileName);
		};

		const isFromDependentProject = (sourceFile: ts.SourceFile): boolean => {
			if (!sourceFile.isDeclarationFile) {
				return false;
			}
			const fileName = sourceFile.fileName;
			for (let outDir of this.dependentOutDirs) {
				if (fileName.startsWith(outDir)) {
					return true;
				}
			}
			return false;
		};

		const isFromProjectRoot = (sourceFile: ts.SourceFile): boolean => {
			return paths.isParent(this.projectRoot, sourceFile.fileName);
		};

		let result = this.dataManager.getDocumentData(sourceFile.fileName);
		if (result !== undefined) {
			return result;
		}

		const document = this.vertex.document(sourceFile.fileName, sourceFile.text);
		const fileName = sourceFile.fileName;

		let monikerPath: string | undefined;
		let external: boolean = false;
		if (isFromExternalLibrary(sourceFile)) {
			external = true;
			monikerPath = tss.computeMonikerPath(this.projectRoot, fileName);
		} else if (isFromProjectSources(sourceFile)) {
			monikerPath = tss.computeMonikerPath(this.projectRoot, tss.toOutLocation(fileName, this.sourceRoot, this.outDir));
		} else if (isFromDependentProject(sourceFile)) {
			external = true;
			monikerPath = tss.computeMonikerPath(this.projectRoot, fileName);
		} else if (isFromProjectRoot(sourceFile)) {
			external = sourceFile.isDeclarationFile;
			monikerPath = tss.computeMonikerPath(this.projectRoot, fileName);
		}

		const symbol = this.typeChecker.getSymbolAtLocation(sourceFile);
		result = this.dataManager.getOrCreateDocumentData(sourceFile, document, symbol !== undefined ? ModuleSystemKind.module : ModuleSystemKind.global, monikerPath, external);

		// In TS source files have symbols and can be referenced in import statements with * imports.
		// So even if we don't parse the source file we need to create a symbol data so that when
		// referenced we have the data.
		if (symbol !== undefined) {
			this.getOrCreateSymbolData(symbol);
		}
		return result;
	}

	// private hoverCalls: number = 0;
	// private hoverTotal: number = 0;

	public getSymbolData(symbolId: SymbolId): SymbolData | undefined {
		return this.dataManager.getSymbolData(symbolId);
	}

	public getOrCreateSymbolData(symbol: ts.Symbol): SymbolData {
		const id: SymbolId = tss.createSymbolKey(this.typeChecker, symbol);
		let result = this.dataManager.getSymbolData(id);
		if (result !== undefined) {
			return result;
		}
		const resolver = this.getFactory(symbol);
		resolver.forwardSymbolInformation(symbol);
		const declarations: ts.Node[] | undefined = resolver.getDeclarationNodes(symbol);
		const sourceFiles: ts.SourceFile[] | undefined = resolver.getSourceFiles(symbol);

		const { symbolData, exportPath, moduleSystem } = this.dataManager.getOrCreateSymbolData(id, sourceFiles, (projectDataManager) => {
			return resolver.create(sourceFiles, symbol, id, projectDataManager);
		});
		result = symbolData;

		const [monikerIdentifer, external] = this.getMonikerIdentifier(sourceFiles, tss.isSourceFile(symbol), moduleSystem, exportPath);

		if (monikerIdentifer === undefined) {
			result.addMoniker(id, MonikerKind.local);
		} else {
			if (external === true) {
				result.addMoniker(monikerIdentifer, MonikerKind.import);
			} else {
				result.addMoniker(monikerIdentifer, MonikerKind.export);
			}
		}

		if (declarations === undefined || declarations.length === 0) {
			return result;
		}

		let hover: lsp.Hover | undefined;
		for (let declaration of declarations) {
			const sourceFile = declaration.getSourceFile();
			const [identifierNode, identifierText] = resolver.getIdentifierInformation(symbol, declaration);
			if (identifierNode !== undefined && identifierText !== undefined) {
				const documentData = this.getOrCreateDocumentData(sourceFile);
				const range = ts.isSourceFile(declaration) ? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } : Converter.rangeFromNode(sourceFile, identifierNode);
				const definition = this.vertex.range(range, {
					type: RangeTagTypes.definition,
					text: identifierText,
					kind: Converter.asSymbolKind(declaration),
					fullRange: Converter.rangeFromNode(sourceFile, declaration),
				});
				documentData.addRange(definition);
				result.addDefinition(sourceFile.fileName, definition);
				result.recordDefinitionInfo(tss.createDefinitionInfo(sourceFile, identifierNode));
				if (hover === undefined && tss.isNamedDeclaration(declaration)) {
					// let start = Date.now();
					hover = this.getHover(declaration.name, sourceFile);
					// this.hoverCalls++;
					// let diff = Date.now() - start;
					// this.hoverTotal += diff;
					// if (diff > 100) {
					// 	console.log(`Computing hover took ${diff} ms for symbol ${id} | ${symbol.getName()} | ${this.hoverCalls} | ${this.hoverTotal}`)
					// }
					if (hover) {
						result.addHover(hover);
					} else {
						// console.log(`Hover returned undefined for $symbol ${id} | ${symbol.getName()}`);
					}
				}
			}
		}
		// if (tss.isBlockScopedVariable(symbol)) {
		// 	let type = this.typeChecker.getDeclaredTypeOfSymbol(symbol);
		// 	if (type.symbol) {
		// 		let typeSymbolData = this.getOrCreateSymbolData(type.symbol);
		// 		let result: TypeDefinitionResult | undefined;
		// 		if (Array.isArray(typeSymbolData.declarations)) {
		// 			result = this.context.vertex.typeDefinitionResult(typeSymbolData.declarations.map(declaration => declaration.id));
		// 		} else if (typeSymbolData.declarations !== undefined) {
		// 			result = this.context.vertex.typeDefinitionResult([typeSymbolData.declarations.id]);
		// 		}
		// 		if (result !== undefined) {
		// 			this.context.emit(result);
		// 			this.context.emit(this.context.edge.typeDefinition(this.resultSet, result));
		// 		}
		// 	}
		// }
		return result;
	}

	private getMonikerIdentifier(sourceFiles: ts.SourceFile[] | undefined, isSourceFile: boolean, moduleSystem: ModuleSystemKind | undefined, exportPath: string | undefined): [string | undefined, boolean | undefined] {
		const documentDatas: DocumentData[] | undefined = sourceFiles !== undefined
			? sourceFiles.map((sourceFile) => this.getOrCreateDocumentData(sourceFile))
			: undefined;

		let monikerIdentifer: string | undefined;
		const monikerFilePaths: Set<string> = new Set();
		let external: boolean | undefined;
		if (documentDatas !== undefined) {
			for (const data of documentDatas) {
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

	private getFactory(symbol: ts.Symbol): SymbolDataFactory {
		if (tss.isTransient(symbol)) {
			if (tss.isComposite(this.typeChecker, symbol)) {
				return this.symbolDataFactories.unionOrIntersection;
			} else {
				// Problem: Symbols that come from the lib*.d.ts files are marked transient
				// as well. Check if the symbol has some other meaningful flags
				if ((symbol.getFlags() & ~ts.SymbolFlags.Transient) !== 0) {
					return this.symbolDataFactories.standard;
				} else {
					return this.symbolDataFactories.transient;
				}
			}
		}
		if (tss.isTypeAlias(symbol)) {
			return this.symbolDataFactories.typeAlias;
		}
		if (tss.isAliasSymbol(symbol)) {
			return this.symbolDataFactories.alias;
		}
		if (tss.isMethodSymbol(symbol)) {
			return this.symbolDataFactories.method;
		}
		return this.symbolDataFactories.standard;
	}

	public getHover(node: ts.DeclarationName, sourceFile?: ts.SourceFile): lsp.Hover | undefined {
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
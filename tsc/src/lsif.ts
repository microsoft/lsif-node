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

import { VertexBuilder, EdgeBuilder, Builder } from './graph';

import { Emitter } from './emitters/emitter';
import { LRUCache } from './utils/linkedMap';

import * as paths from './utils/paths';

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

interface EmitContext {
	vertex: VertexBuilder;
	edge: EdgeBuilder;
	emit(element: Vertex | Edge): void;
}

interface SymbolDataContext extends EmitContext {
	getDocumentData(fileName: string): DocumentData | undefined;
	getOrCreateSymbolData(symbolId: SymbolId, create: () => SymbolData): SymbolData;
	manageLifeCycle(node: ts.Node, symbolData: SymbolData): void;
}

abstract class LSIFData {
	protected constructor(protected context: SymbolDataContext) {
	}

	public abstract begin(): void;

	public abstract end(): void;

	protected emit(value: Vertex | Edge): void {
		this.context.emit(value);
	}

	protected get vertex(): VertexBuilder {
		return this.context.vertex;
	}

	protected get edge(): EdgeBuilder {
		return this.context.edge;
	}
}

class ProjectData extends LSIFData {

	private documents: Document[];
	private diagnostics: lsp.Diagnostic[];

	public constructor(context: SymbolDataContext, private group: Group | undefined, private project: Project) {
		super(context);
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

class DocumentData extends LSIFData {

	private ranges: Range[];
	private diagnostics: lsp.Diagnostic[] | undefined;
	private foldingRanges: lsp.FoldingRange[] | undefined;
	private documentSymbols: RangeBasedDocumentSymbol[] | undefined;

	public constructor(context: SymbolDataContext, public document: Document, public monikerPath: string | undefined, public external: boolean) {
		super(context);
		this.ranges = [];
	}

	public begin(): void {
		this.emit(this.document);
		this.emit(this.vertex.event(EventScope.document, EventKind.begin, this.document));
	}

	public addRange(range: Range): void {
		this.emit(range);
		this.ranges.push(range);
	}

	public addDiagnostics(diagnostics: lsp.Diagnostic[]): void {
		this.diagnostics = diagnostics;
	}

	public addFoldingRanges(foldingRanges: lsp.FoldingRange[]): void {
		this.foldingRanges = foldingRanges;
	}

	public addDocumentSymbols(documentSymbols: RangeBasedDocumentSymbol[]): void {
		this.documentSymbols = documentSymbols;
	}

	public end(): void {
		if (this.ranges.length >= 0) {
			this.emit(this.edge.contains(this.document, this.ranges));
		}
		if (this.diagnostics !== undefined) {
			let dr = this.vertex.diagnosticResult(this.diagnostics);
			this.emit(dr);
			this.emit(this.edge.diagnostic(this.document, dr));
		}
		if (this.foldingRanges !== undefined) {
			const fr = this.vertex.foldingRangeResult(this.foldingRanges);
			this.emit(fr);
			this.emit(this.edge.foldingRange(this.document, fr));
		}
		if (this.documentSymbols !== undefined) {
			const ds = this.vertex.documentSymbolResult(this.documentSymbols);
			this.emit(ds);
			this.emit(this.edge.documentSymbols(this.document, ds));
		}
		this.emit(this.vertex.event(EventScope.document, EventKind.end, this.document));
	}
}

abstract class SymbolData extends LSIFData {

	private declarationInfo: tss.DefinitionInfo | tss.DefinitionInfo[] | undefined;

	protected resultSet: ResultSet;
	protected moniker: Moniker | undefined;

	public constructor(context: SymbolDataContext, private id: SymbolId) {
		super(context);
		this.resultSet = this.vertex.resultSet();
	}

	public getId(): string {
		return this.id;
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

	public abstract addDefinition(sourceFile: ts.SourceFile, definition: DefinitionRange): void;
	public abstract findDefinition(sourceFile: ts.SourceFile, range: lsp.Range): DefinitionRange | undefined;

	public abstract getOrCreateReferenceResult(): ReferenceResult;

	public abstract addReference(sourceFile: ts.SourceFile, reference: Range, property: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void;
	public abstract addReference(sourceFile: ts.SourceFile, reference: ReferenceResult): void;

	public abstract getOrCreateTypeDefintionResult(): TypeDefinitionResult;

	public abstract addTypeDefinition(sourceFile: ts.SourceFile, definition: DefinitionRange): void;

	public abstract getOrCreatePartition(sourceFile: ts.SourceFile): SymbolDataPartition;

	public abstract nodeProcessed(node: ts.Node): boolean;
}

class StandardSymbolData extends SymbolData {

	private definitionResult: DefinitionResult | undefined;
	private referenceResult: ReferenceResult | undefined;
	private typeDefinitionResult: TypeDefinitionResult | undefined;

	private partitions: Map<string /* filename */, SymbolDataPartition | null> | null | undefined;

	public constructor(context: SymbolDataContext, id: SymbolId, private scope: ts.Node | undefined = undefined) {
		super(context, id);
	}

	public addDefinition(sourceFile: ts.SourceFile, definition: DefinitionRange, recordAsReference: boolean = true): void {
		this.emit(this.edge.next(definition, this.resultSet));
		this.getOrCreatePartition(sourceFile).addDefinition(definition, recordAsReference);
	}

	public findDefinition(sourceFile: ts.SourceFile, range: lsp.Range): DefinitionRange | undefined {
		if (this.partitions === undefined) {
			return undefined;
		}
		if (this.partitions === null) {
			throw new Error(`The symbol data has already been cleared`);
		}
		let partition = this.partitions.get(sourceFile.fileName);
		if (partition === null) {
			throw new Error(`The partition for source file ${sourceFile.fileName}`);
		}
		if (partition === undefined) {
			return undefined;
		}
		return partition.findDefinition(range);
	}

	public addReference(sourceFile: ts.SourceFile, reference: Range, property: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void;
	public addReference(sourceFile: ts.SourceFile, reference: ReferenceResult): void;
	public addReference(sourceFile: ts.SourceFile, reference: Moniker): void;
	public addReference(sourceFile: ts.SourceFile, reference: Range | ReferenceResult | Moniker, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		if (reference.label === VertexLabels.range) {
			this.emit(this.edge.next(reference, this.resultSet));
		}
		this.getOrCreatePartition(sourceFile).addReference(reference as any, property as any);
	}

	public addTypeDefinition(sourceFile: ts.SourceFile, definition: DefinitionRange): void {
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

	public getOrCreatePartition(sourceFile: ts.SourceFile): SymbolDataPartition {
		let fileName = sourceFile.fileName;
		if (this.partitions === null) {
			throw new Error (`Partition for symbol ${this.getId()} have already been cleared`);
		}
		if (this.partitions === undefined) {
			this.partitions = new Map();
		}
		let result = this.partitions.get(fileName);
		if (result === null) {
			throw new Error (`Partition for file ${fileName} has already been cleared.`);
		}
		if (result === undefined) {
			let documentData = this.context.getDocumentData(fileName);
			if (documentData === undefined) {
				throw new Error(`No document data for ${fileName}`);
			}
			result = new SymbolDataPartition(this.context, this, documentData.document);
			this.context.manageLifeCycle(sourceFile, this);
			result.begin();
			this.partitions.set(fileName, result);
		}
		return result;
	}

	public nodeProcessed(node: ts.Node): boolean {
		if (this.partitions === undefined) {
			return true;
		}
		if (this.partitions === null) {
			throw new Error (`Partition for symbol ${this.getId()} have already been cleared`);
		}
		if (node === this.scope) {
			if (this.partitions.size !== 1) {
				throw new Error(`Local Symbol data has more than one partition.`);
			}
			let parition = this.partitions.values().next().value;
			if (parition !== null) {
				parition.end();
			}
			this.partitions = null;
			return true;
		} else if (ts.isSourceFile(node)) {
			let fileName = node.fileName;
			let partition = this.partitions.get(fileName);
			if (partition === null) {
				throw new Error (`Partition for file ${fileName} has already been cleared.`);
			}
			if (partition === undefined) {
				throw new Error(`Symbol data doesn't manage a partition for ${fileName}`);
			}
			partition.end();
			this.partitions.set(fileName, null);
			return false;
		} else {
			throw new Error(`Node is neither a source file nor does it match the scope`);
		}
	}

	public end(): void {
		if (this.partitions === undefined) {
			return;
		}
		if (this.partitions === null) {
			throw new Error (`Partition for symbol ${this.getId()} have already been cleared`);
		}
		for (let entry of this.partitions.entries()) {
			if (entry[1] !== null) {
				entry[1].end();
				this.partitions.set(entry[0], null);
			}
		}
	}
}

class AliasedSymbolData extends StandardSymbolData {

	constructor(context: SymbolDataContext, id: string, private aliased: SymbolData, scope: ts.Node | undefined = undefined, private rename: boolean = false) {
		super(context, id, scope);
	}

	public begin(): void {
		super.begin();
		this.emit(this.edge.next(this.resultSet, this.aliased.getResultSet()));
	}

	public addDefinition(sourceFile: ts.SourceFile, definition: DefinitionRange): void {
		if (this.rename) {
			super.addDefinition(sourceFile, definition, false);
		} else {
			this.emit(this.edge.next(definition, this.resultSet));
			this.aliased.getOrCreatePartition(sourceFile).addReference(definition, ItemEdgeProperties.references);
		}
	}

	public findDefinition(sourceFile: ts.SourceFile, range: lsp.Range): DefinitionRange | undefined {
		if (this.rename) {
			return super.findDefinition(sourceFile, range);
		} else {
			return this.aliased.findDefinition(sourceFile, range);
		}
	}

	public addReference(sourceFile: ts.SourceFile, reference: Range | ReferenceResult | Moniker, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
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

	private sourceFile: ts.SourceFile | undefined;
	private rootSymbolData: SymbolData[] | undefined;

	constructor(context: SymbolDataContext, id: string, sourceFile: ts.SourceFile, rootSymbolData: SymbolData[] | undefined, scope: ts.Node | undefined = undefined) {
		super(context, id, scope);
		this.sourceFile = sourceFile;
		if (rootSymbolData !== undefined && rootSymbolData.length === 0) {
			this.rootSymbolData = undefined;
		} else {
			this.rootSymbolData = rootSymbolData;
		}
	}

	public begin(): void {
		super.begin();
		if (this.rootSymbolData !== undefined) {
			for (let root of this.rootSymbolData) {
				// We take the first source file to cluster this. We might want to find a source
				// file that has already changed to make the diff minimal.
				super.addReference(this.sourceFile!, root.getOrCreateReferenceResult());
				const moniker = root.getMoniker();
				if (moniker !== undefined && moniker.scheme !== 'local') {
					super.addReference(this.sourceFile!, moniker);
				}
			}
		}
		this.sourceFile = undefined;
	}

	public addDefinition(sourceFile: ts.SourceFile, definition: DefinitionRange): void {
		super.addDefinition(sourceFile, definition, this.rootSymbolData === undefined);
		if (this.rootSymbolData !== undefined) {
			for (let base of this.rootSymbolData) {
				base.getOrCreatePartition(sourceFile).addReference(definition, ItemEdgeProperties.definitions);
			}
		}
	}

	public addReference(sourceFile: ts.SourceFile, reference: Range | ReferenceResult | Moniker, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
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

	private sourceFile: ts.SourceFile | undefined;
	private elements: SymbolData[];

	constructor(context: SymbolDataContext, id: string, sourceFile: ts.SourceFile, elements: SymbolData[]) {
		super(context, id, undefined);
		this.elements = elements;
		this.sourceFile = sourceFile;
	}

	public begin(): void {
		super.begin();
		for (let element of this.elements) {
			// We take the first source file to cluster this. We might want to find a source
			// file that has already changed to make the diff minimal.
			super.addReference(this.sourceFile!, element.getOrCreateReferenceResult());
		}
		this.sourceFile = undefined;
	}

	public recordDefinitionInfo(info: tss.DefinitionInfo): void {
	}

	public addDefinition(sourceFile: ts.SourceFile, definition: DefinitionRange): void {
		// We don't do anoything for definitions since they a transient anyways.
	}

	public addReference(sourceFile: ts.SourceFile, reference: Range | ReferenceResult | Moniker, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		if (reference.label === 'range') {
			this.emit(this.edge.next(reference, this.resultSet));
		}
		for (let element of this.elements) {
			element.getOrCreatePartition(sourceFile).addReference(reference as any, property as any);
		}
	}
}

class TransientSymbolData extends StandardSymbolData {

	constructor(context: SymbolDataContext, id: string) {
		super(context, id, undefined);
	}

	public begin(): void {
		super.begin();
	}

	public recordDefinitionInfo(info: tss.DefinitionInfo): void {
	}

	public addDefinition(sourceFile: ts.SourceFile, definition: DefinitionRange): void {
		// We don't do anoything for definitions since they a transient anyways.
	}

	public addReference(sourceFile: ts.SourceFile, reference: Range | ReferenceResult | Moniker, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		super.addReference(sourceFile, reference as any, property as any);
	}
}

class SymbolDataPartition extends LSIFData {

	private static EMPTY_ARRAY = Object.freeze([]) as unknown as any[];
	private static EMPTY_MAP= Object.freeze(new Map()) as unknown as Map<any, any>;

	private definitionRanges: DefinitionRange[];
	private typeDefinitionRanges: DefinitionRange[];

	private referenceRanges: Map<ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references, Range[]>;
	private referenceResults: ReferenceResult[];
	private referenceCascades: Moniker[];

	public constructor(context: SymbolDataContext, private symbolData: SymbolData, private document: Document) {
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
			this.emit(this.edge.item(definitionResult, this.definitionRanges, this.document));
		}
		if (this.typeDefinitionRanges !== SymbolDataPartition.EMPTY_ARRAY) {
			const typeDefinitionResult = this.symbolData.getOrCreateTypeDefintionResult();
			this.emit(this.edge.item(typeDefinitionResult, this.typeDefinitionRanges, this.document));
		}
		if (this.referenceRanges !== SymbolDataPartition.EMPTY_MAP) {
			const referenceResult = this.symbolData.getOrCreateReferenceResult();
			for (const property of this.referenceRanges.keys()) {
				const values = this.referenceRanges.get(property)!;
				this.emit(this.edge.item(referenceResult, values, this.document, property));
			}
		}
		if (this.referenceResults !== SymbolDataPartition.EMPTY_ARRAY) {
			const referenceResult = this.symbolData.getOrCreateReferenceResult();
			this.emit(this.edge.item(referenceResult, this.referenceResults, this.document));
		}
		if (this.referenceCascades !== SymbolDataPartition.EMPTY_ARRAY) {
			const referenceResult = this.symbolData.getOrCreateReferenceResult();
			this.emit(this.edge.item(referenceResult, this.referenceCascades, this.document));
		}
	}
}

enum SourceFileKind {
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

	private baseSymbolCache: LRUCache<string, ts.Symbol[]>;
	private baseMemberCache: LRUCache<string, LRUCache<string, ts.Symbol[]>>;
	private exportedPaths: LRUCache<ts.Symbol, string | null>;
	private symbolAliases: Map<string, SymbolAlias>;
	private parents: Map<string, ts.Symbol>;
	private exports: Map<string, Set<string>>;
	private sourceFilesContainingAmbientDeclarations: Set<string>;

	constructor(private program: ts.Program, private typeChecker: ts.TypeChecker) {
		this.baseSymbolCache = new LRUCache(2048);
		this.baseMemberCache = new LRUCache(2048);
		this.exportedPaths = new LRUCache(2048);
		this.symbolAliases = new Map();
		this.parents = new Map();
		this.exports = new Map();
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

	public addParent(symbol: ts.Symbol, parent: ts.Symbol): Disposable {
		const key = tss.createSymbolKey(this.typeChecker, symbol);
		this.parents.set(key, parent);
		return () => {
			this.parents.delete(key);
		};
	}

	private getParent(symbol: ts.Symbol): ts.Symbol | undefined {
		let result = tss.getSymbolParent(symbol);
		if (result !== undefined) {
			return result;
		}
		return this.parents.get(tss.createSymbolKey(this.typeChecker, symbol));
	}

	public addExport(parent: ts.Symbol, symbol: ts.Symbol): Disposable {
		const parentKey = tss.createSymbolKey(this.typeChecker, parent);
		const symbolKey = tss.createSymbolKey(this.typeChecker, symbol);
		let values = this.exports.get(parentKey);
		if (values === undefined) {
			values = new Set();
			this.exports.set(parentKey, values);
		}
		values.add(symbolKey);
		return () => {
			let values = this.exports.get(parentKey);
			if (values === undefined) {
				return;
			}
			values.delete(symbolKey);
			if (values.size === 0) {
				this.exports.delete(parentKey);
			}
		};
	}

	private isExported(parent: ts.Symbol, symbol: ts.Symbol): boolean {
		if (parent.exports !== undefined && parent.exports.has(symbol.getName() as ts.__String)) {
			return true;
		}
		let exports = this.exports.get(tss.createSymbolKey(this.typeChecker, parent));
		return exports !== undefined && exports.has(tss.createSymbolKey(this.typeChecker, symbol));
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

	public getExportPath(symbol: ts.Symbol, kind: SourceFileKind | undefined): string | undefined {
		let result = this.exportedPaths.get(symbol);
		if (result !== undefined) {
			return result === null ? undefined : result;
		}
		if (tss.isSourceFile(symbol)) {
			this.exportedPaths.set(symbol, '');
			return '';
		}
		const parent = this.getParent(symbol);
		let name = symbol.getName();
		// TS support module declations with string. E.g. declare module "fs" {...}
		// However the identifier is fs.
		if (name.charAt(0) === '\"' || name.charAt(0) === '\'') {
			name = name.substr(1, name.length - 2);
		}
		if (parent === undefined) {
			if (tss.isValueModule(symbol) || kind === SourceFileKind.global) {
				this.exportedPaths.set(symbol, name);
				return name;
			}
			const typeAlias = this.symbolAliases.get(tss.createSymbolKey(this.typeChecker, symbol));
			if (typeAlias !== undefined && this.getExportPath(typeAlias.alias, kind) !== undefined) {
				this.exportedPaths.set(symbol, typeAlias.name);
				return typeAlias.name;
			}
			this.exportedPaths.set(symbol, null);
			return undefined;
		} else {
			const parentValue = this.getExportPath(parent, kind);
			// The parent is not exported so any member isn't either
			if (parentValue === undefined) {
				this.exportedPaths.set(symbol, null);
				return undefined;
			} else {
				if (tss.isInterface(parent) || tss.isClass(parent) || tss.isTypeLiteral(parent)) {
					result = `${parentValue}.${name}`;
					this.exportedPaths.set(symbol, result);
					return result;
				} else if (this.isExported(parent, symbol)) {
					result = parentValue.length > 0 ? `${parentValue}.${name}` : name;
					this.exportedPaths.set(symbol, result);
					return result;
				} else {
					this.exportedPaths.set(symbol, null);
					return undefined;
				}
			}
		}

	}

	public getSourceFileKind(sourceFiles: ts.SourceFile[]): SourceFileKind | undefined {
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
			return SourceFileKind.module;
		}
		if (globalCount === numberOfFiles) {
			return SourceFileKind.global;
		}
		return undefined;
	}
}

interface ResolverContext {
	getOrCreateSymbolData(symbol: ts.Symbol, location?: ts.Node): SymbolData;
}

abstract class SymbolDataResolver {

	constructor(protected typeChecker: ts.TypeChecker, protected symbols: Symbols, protected resolverContext: ResolverContext, protected symbolDataContext: SymbolDataContext) {
	}

	public abstract requiresSourceFile: boolean;

	public forwardSymbolInformation(symbol: ts.Symbol): void {
	}

	public clearForwardSymbolInformation(symbol: ts.Symbol): void {
	}

	public getDeclarationNodes(symbol: ts.Symbol, location?: ts.Node): ts.Node[] | undefined {
		return symbol.getDeclarations();
	}

	public getSourceFiles(symbol: ts.Symbol, location?: ts.Node): ts.SourceFile[] {
		let sourceFiles = tss.getUniqueSourceFiles(symbol.getDeclarations());
		if (sourceFiles.size === 0) {
			return [];
		}
		return Array.from(sourceFiles.values());
	}

	public getPartitionScope(sourceFiles: ts.SourceFile[]): ts.SourceFile {
		if (sourceFiles.length === 0) {
			throw new Error(`No soure file selection provided`);
		}
		return sourceFiles[0];
	}

	public getIdentifierInformation(sourceFile: ts.SourceFile, symbol: ts.Symbol, declaration: ts.Node): [ts.Node, string] | [undefined, undefined] {
		if (tss.isNamedDeclaration(declaration)) {
			let name = declaration.name;
			return [name, name.getText()];
		}
		if (tss.isValueModule(symbol) && ts.isSourceFile(declaration)) {
			return [declaration, ''];
		}
		return [undefined, undefined];
	}

	public abstract resolve(sourceFile: ts.SourceFile | undefined, id: SymbolId, symbol: ts.Symbol, location?: ts.Node, scope?: ts.Node): SymbolData;
}

class StandardResolver extends SymbolDataResolver {

	constructor(typeChecker: ts.TypeChecker, protected symbols: Symbols, resolverContext: ResolverContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}

	public get requiresSourceFile(): boolean {
		return false;
	}

	public resolve(sourceFile: ts.SourceFile | undefined, id: SymbolId, symbol: ts.Symbol, location?: ts.Node, scope?: ts.Node): SymbolData {
		return new StandardSymbolData(this.symbolDataContext, id, scope);
	}
}

class AliasResolver extends SymbolDataResolver {

	constructor(typeChecker: ts.TypeChecker, protected symbols: Symbols, resolverContext: ResolverContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}

	public get requiresSourceFile(): boolean {
		return false;
	}

	public resolve(sourceFile: ts.SourceFile | undefined, id: SymbolId, symbol: ts.Symbol, location?: ts.Node, scope?: ts.Node): SymbolData {
		let aliased = this.typeChecker.getAliasedSymbol(symbol);
		if (aliased !== undefined) {
			let aliasedSymbolData = this.resolverContext.getOrCreateSymbolData(aliased);
			if (aliasedSymbolData !== undefined) {
				return new AliasedSymbolData(this.symbolDataContext, id, aliasedSymbolData, scope, symbol.getName() !== aliased.getName());
			}
		}
		return new StandardSymbolData(this.symbolDataContext, id);
	}
}

class MethodResolver extends SymbolDataResolver {

	constructor(typeChecker: ts.TypeChecker, protected symbols: Symbols, resolverContext: ResolverContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}

	public get requiresSourceFile(): boolean {
		return true;
	}

	public resolve(sourceFile: ts.SourceFile, id: SymbolId, symbol: ts.Symbol, location?: ts.Node, scope?: ts.Node): SymbolData {
		// console.log(`MethodResolver#resolve for symbol ${id} | ${symbol.getName()}`);
		let container = tss.getSymbolParent(symbol);
		if (container === undefined) {
			return new MethodSymbolData(this.symbolDataContext, id, sourceFile, undefined, scope);
		}
		let mostAbstractMembers = this.symbols.findRootMembers(container, symbol.getName());
		// No abstract membes found
		if (mostAbstractMembers === undefined || mostAbstractMembers.length === 0) {
			return new MethodSymbolData(this.symbolDataContext, id, sourceFile, undefined, scope);
		}
		// It is the symbol itself
		if (mostAbstractMembers.length === 1 && mostAbstractMembers[0] === symbol) {
			return new MethodSymbolData(this.symbolDataContext, id, sourceFile, undefined, scope);
		}
		let mostAbstractSymbolData = mostAbstractMembers.map(member => this.resolverContext.getOrCreateSymbolData(member));
		return new MethodSymbolData(this.symbolDataContext, id, sourceFile, mostAbstractSymbolData, scope);
	}
}

class UnionOrIntersectionResolver extends SymbolDataResolver {

	constructor(typeChecker: ts.TypeChecker, protected symbols: Symbols, resolverContext: ResolverContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}

	public get requiresSourceFile(): boolean {
		return true;
	}

	public getDeclarationNodes(symbol: ts.Symbol, location?: ts.Node): ts.Node[] | undefined {
		if (location === undefined) {
			throw new Error(`Union or intersection resolver requires a location`);
		}
		return [location];
	}

	public getSourceFiles(symbol: ts.Symbol, location?: ts.Node): ts.SourceFile[] {
		if (location === undefined) {
			throw new Error(`Union or intersection resolver requires a location`);
		}
		return [location.getSourceFile()];
	}

	public resolve(sourceFile: ts.SourceFile, id: SymbolId, symbol: ts.Symbol, location?: ts.Node, scope?: ts.Node): SymbolData {
		const composites = tss.getCompositeSymbols(this.typeChecker, symbol, location);
		if (composites !== undefined) {
			const datas: SymbolData[] = [];
			for (let symbol of composites) {
				datas.push(this.resolverContext.getOrCreateSymbolData(symbol));
			}
			return new UnionOrIntersectionSymbolData(this.symbolDataContext, id, sourceFile, datas);
		} else {
			return new StandardSymbolData(this.symbolDataContext, id, undefined);
		}
		// We have something like x: { prop: number} | { prop: string };
		throw new Error(`Union or intersection resolver requires a location`);
	}

	public getIdentifierInformation(sourceFile: ts.SourceFile, symbol: ts.Symbol, declaration: ts.Node): [ts.Node, string] | [undefined, undefined] {
		return [declaration, declaration.getText()];
	}
}

class TransientResolver extends SymbolDataResolver {

	constructor(typeChecker: ts.TypeChecker, protected symbols: Symbols, resolverContext: ResolverContext, symbolDataContext: SymbolDataContext) {
		super(typeChecker, symbols, resolverContext, symbolDataContext);
	}

	public get requiresSourceFile(): boolean {
		return false;
	}

	public getDeclarationNodes(symbol: ts.Symbol, location?: ts.Node): ts.Node[] | undefined {
		if (location === undefined) {
			throw new Error(`TransientResolver requires a location`);
		}
		return [location];
	}

	public getSourceFiles(symbol: ts.Symbol, location?: ts.Node): ts.SourceFile[] {
		if (location === undefined) {
			throw new Error(`TransientResolver requires a location`);
		}
		return [location.getSourceFile()];
	}

	public resolve(sourceFile: ts.SourceFile, id: SymbolId, symbol: ts.Symbol, location?: ts.Node, scope?: ts.Node): SymbolData {
		if (location === undefined) {
			throw new Error(`TransientResolver resolver requires a location`);
		}
		return new TransientSymbolData(this.symbolDataContext, id);
	}
}

interface TypeLiteralCallback {
	(index: number, typeAlias: ts.Symbol, literalType: ts.Symbol): number;
}

class TypeAliasResolver extends StandardResolver {
	constructor(typeChecker: ts.TypeChecker, protected symbols: Symbols, resolverContext: ResolverContext, symbolDataContext: SymbolDataContext) {
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

export class DataManager implements SymbolDataContext {

	private projectData: ProjectData;
	private documentStats: number;
	private documentDatas: Map<string, DocumentData | null>;
	private symbolStats: number;
	private symbolDatas: Map<string, SymbolData | null>;
	private clearOnNode: Map<ts.Node, SymbolData[]>;

	public constructor(private context: EmitContext, group: Group | undefined, project: Project, private options: Options) {
		this.projectData = new ProjectData(this, group, project);
		this.projectData.begin();
		this.documentStats = 0;
		this.symbolStats = 0;
		this.documentDatas = new Map();
		this.symbolDatas = new Map();
		this.clearOnNode = new Map();
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

	public getProjectData(): ProjectData {
		return this.projectData;
	}

	public projectProcessed(): void {
		for (let entry of this.symbolDatas.entries()) {
			if (entry[1]) {
				entry[1].end();
				this.symbolDatas.set(entry[0], null);
			}
		}
		for (let entry of this.documentDatas.entries()) {
			if (entry[1]) {
				entry[1].end();
			}
		}
		this.projectData.end();
		if (!this.options.stdout) {
			console.log('');
			console.log(`Processed ${this.symbolStats} symbols in ${this.documentStats} files`);
		}
	}

	public getDocumentData(fileName: string): DocumentData | undefined {
		let result = this.documentDatas.get(fileName);
		if (result === null) {
			throw new Error(`There was already a managed document data for file: ${fileName}`);
		}
		return result;
	}

	public getOrCreateDocumentData(fileName: string, document: Document, monikerPath: string | undefined, external: boolean): DocumentData {
		let result = this.getDocumentData(fileName);
		if (result === undefined) {
			result = new DocumentData(this, document, monikerPath, external);
			this.documentDatas.set(fileName, result);
			result.begin();
			this.projectData.addDocument(document);
			this.documentStats++;
		}
		return result;
	}

	public documemntProcessed(fileName: string): void {
		let data = this.getDocumentData(fileName);
		if (data === undefined) {
			throw new Error(`No document data for file ${fileName}`);
		}
		data.end();
		this.documentDatas.set(fileName, null);
	}

	public getSymbolData(symbolId: SymbolId): SymbolData | undefined {
		let result = this.symbolDatas.get(symbolId);
		if (result === null) {
			throw new Error(`There was already a managed symbol data for id: ${symbolId}`);
		}
		return result;
	}

	public getOrCreateSymbolData(symbolId: SymbolId, create: () => SymbolData): SymbolData {
		let result = this.getSymbolData(symbolId);
		if (result === undefined) {
			result = create();
			this.symbolDatas.set(result.getId(), result);
			result.begin();
			this.symbolStats++;
		}
		return result;
	}

	public manageLifeCycle(node: ts.Node, symbolData: SymbolData): void {
		let datas = this.clearOnNode.get(node);
		if (datas === undefined) {
			datas = [];
			this.clearOnNode.set(node, datas);
		}
		datas.push(symbolData);
	}

	public nodeProcessed(node: ts.Node): void {
		let datas = this.clearOnNode.get(node);
		if (datas !== undefined) {
			for (let symbolData of datas) {
				if (symbolData.nodeProcessed(node)) {
					this.symbolDatas.delete(symbolData.getId());
				}
			}
			this.clearOnNode.delete(node);
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

class Visitor implements ResolverContext {

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
	private symbolDataResolvers: {
		standard: StandardResolver;
		alias: AliasResolver;
		method: MethodResolver;
		unionOrIntersection: UnionOrIntersectionResolver;
		transient: TransientResolver;
		typeAlias: TypeAliasResolver;
	};

	constructor(private emitter: Emitter, private builder: Builder, private languageService: ts.LanguageService, dependsOn: ProjectInfo[], private options: Options) {
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
		this.dataManager = new DataManager(this, this.options.group, this.project, options);
		this.symbols = new Symbols(this.program, this.typeChecker);
		this.disposables = new Map();
		this.symbolDataResolvers = {
			standard: new StandardResolver(this.typeChecker, this.symbols, this, this.dataManager),
			alias: new AliasResolver(this.typeChecker, this.symbols, this, this.dataManager),
			method: new MethodResolver(this.typeChecker, this.symbols, this, this.dataManager),
			unionOrIntersection: new UnionOrIntersectionResolver(this.typeChecker, this.symbols, this, this.dataManager),
			transient: new TransientResolver(this.typeChecker, this.symbols, this, this.dataManager),
			typeAlias: new TypeAliasResolver(this.typeChecker, this.symbols, this, this.dataManager)
		};
	}

	public visitProgram(): ProjectInfo {
		let sourceFiles = this.program.getSourceFiles();
		if (sourceFiles.length > 256) {
			this.typeChecker.setSymbolChainCache(new SimpleSymbolChainCache());
		}
		for (let sourceFile of sourceFiles) {
			this.visit(sourceFile);
		}
		return {
			rootDir: this.sourceRoot,
			outDir: this.outDir
		};
	}

	public endVisitProgram(): void {
		this.dataManager.projectProcessed();
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

		// things we need to capture to have correct exports
		// `export =` or an `export default` declaration ==> ExportAssignment
		// `exports.bar = function foo() { ... }` ==> ExpressionStatement
		// `export { root }` ==> ExportDeclaration
		// `export { _root as root }` ==> ExportDeclaration
		const processSymbol = (disposables: Disposable[], parent: ts.Symbol, symbol: ts.Symbol): void => {
			if (tss.getSymbolParent(symbol) === undefined) {
				disposables.push(this.symbols.addParent(symbol, parent));
			}
			if (parent.exports === undefined || !parent.exports.has(symbol.getName() as ts.__String)) {
				disposables.push(this.symbols.addExport(parent, symbol));
			}
		};
		const exportAssignments: ts.ExportAssignment[] = [];
		const sourceFileSymbol = this.typeChecker.getSymbolAtLocation(sourceFile);
		for (let node of sourceFile.statements) {
			if (ts.isExportAssignment(node)) {
				exportAssignments.push(node);
			} else if (ts.isExportDeclaration(node) && sourceFileSymbol !== undefined) {
				if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
					for (let element of node.exportClause.elements) {
						let exportSymbol = this.typeChecker.getSymbolAtLocation(element.name);
						if (exportSymbol === undefined) {
							continue;
						}
						processSymbol(disposables, sourceFileSymbol, exportSymbol);
						let localSymbol: ts.Symbol | undefined;
						if (element.propertyName !== undefined) {
							localSymbol = this.typeChecker.getSymbolAtLocation(element.propertyName);
						} else if (tss.isAliasSymbol(exportSymbol)) {
							localSymbol = this.typeChecker.getAliasedSymbol(exportSymbol);
						}
						if (localSymbol !== undefined) {
							processSymbol(disposables, sourceFileSymbol, localSymbol);
						}
					}
				}
			}
		}
		if (exportAssignments.length > 0) {
			this.handleExportAssignments(exportAssignments);
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
		let symbolData = this.getOrCreateSymbolData(symbol, rangeNode);
		if (symbolData === undefined) {
			return false;
		}
		let sourceFile = this.currentSourceFile!;
		let definition = symbolData.findDefinition(sourceFile, Converter.rangeFromNode(sourceFile, rangeNode));
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
		this.handleSymbol(this.typeChecker.getSymbolAtLocation(node) || tss.getSymbolFromNode(node), node);
		return true;
	}

	private handleExportAssignments(nodes: ts.ExportAssignment[]): void {
		let index = 0;
		for (let node of nodes) {
			const exportSymbol = this.typeChecker.getSymbolAtLocation(node) || tss.getSymbolFromNode(node);
			const localSymbol = node.expression !== undefined
				? this.typeChecker.getSymbolAtLocation(node.expression)  || tss.getSymbolFromNode(node.expression)
				: undefined;
			if (exportSymbol !== undefined && localSymbol !== undefined) {
				this.symbols.storeSymbolAlias(localSymbol, { alias: exportSymbol, name: `${index}_export`});
			}
		}
	}

	private endVisitExportAssignment(node: ts.ExportAssignment): void {
		// Do nothing;
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
		let symbolData = this.getOrCreateSymbolData(symbol, location);
		if (symbolData === undefined) {
			return;
		}
		let sourceFile = this.currentSourceFile!;
		if (symbolData.hasDefinitionInfo(tss.createDefinitionInfo(sourceFile, location))) {
			return;
		}

		let reference = this.vertex.range(Converter.rangeFromNode(sourceFile, location), { type: RangeTagTypes.reference, text: location.getText() });
		this.currentDocumentData.addRange(reference);
		symbolData.addReference(sourceFile, reference, ItemEdgeProperties.references);
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
			this.getResolver(symbol, node).clearForwardSymbolInformation(symbol);
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
		symbolData.addReference(sourceFile, reference, ItemEdgeProperties.references);
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

		result = this.dataManager.getOrCreateDocumentData(sourceFile.fileName, document, monikerPath, external);

		// In TS source files have symbols and can be referenced in import statements with * imports.
		// So even if we don't parse the source file we need to create a symbol data so that when
		// referenced we have the data.
		let symbol = this.typeChecker.getSymbolAtLocation(sourceFile);
		if (symbol !== undefined) {
			this.getOrCreateSymbolData(symbol, sourceFile);
		}
		return result;
	}

	// private hoverCalls: number = 0;
	// private hoverTotal: number = 0;

	public getOrCreateSymbolData(symbol: ts.Symbol, location?: ts.Node): SymbolData {
		const id: SymbolId = tss.createSymbolKey(this.typeChecker, symbol);
		let result = this.dataManager.getSymbolData(id);
		if (result !== undefined) {
			return result;
		}
		const resolver = this.getResolver(symbol, location);
		resolver.forwardSymbolInformation(symbol);
		const declarations: ts.Node[] | undefined = resolver.getDeclarationNodes(symbol, location);
		const sourceFiles: ts.SourceFile[] = resolver.getSourceFiles(symbol, location);
		const sourceFileKind = this.symbols.getSourceFileKind(sourceFiles);
		const exportPath: string | undefined = this.symbols.getExportPath(symbol, sourceFileKind);
		const scope =  this.resolveEmittingNode(symbol, exportPath !== undefined);
		if (resolver.requiresSourceFile && sourceFiles.length === 0) {
			throw new Error(`Resolver requires source file but no source file can be found.`);
		}
		// Make sure we create all document data before we create the symbol.
		let monikerPath: string | undefined | null;
		let external: boolean = false;
		for (let sourceFile of sourceFiles.values()) {
			let documentData = this.getOrCreateDocumentData(sourceFile);
			if (monikerPath === undefined) {
				monikerPath = documentData.monikerPath;
				external = documentData.external;
			} else if (monikerPath !== documentData.monikerPath) {
				monikerPath = null;
			}
		}
		if (monikerPath === null) {
			monikerPath = undefined;
			external = false;
		}
		result = this.dataManager.getOrCreateSymbolData(id, () => {
			return resolver.requiresSourceFile ? resolver.resolve(resolver.getPartitionScope(sourceFiles), id, symbol, location, scope) : resolver.resolve(undefined, id, symbol, location, scope);
		});
		if (declarations === undefined || declarations.length === 0) {
			return result;
		}
		// The symbol represents a source file
		let monikerIdentifer: string | undefined;
		if (tss.isSourceFile(symbol) && monikerPath !== undefined) {
			monikerIdentifer = tss.createMonikerIdentifier(monikerPath, undefined);
		} else if (exportPath !== undefined) {
			monikerIdentifer = tss.createMonikerIdentifier(sourceFileKind === SourceFileKind.module ? monikerPath : undefined, exportPath);
		}
		if (monikerIdentifer === undefined) {
			result.addMoniker(id, MonikerKind.local);
		} else {
			if (external === true) {
				result.addMoniker(monikerIdentifer, MonikerKind.import);
			} else {
				result.addMoniker(monikerIdentifer, MonikerKind.export);
			}
		}

		let hover: lsp.Hover | undefined;
		for (let declaration of declarations) {
			const sourceFile = declaration.getSourceFile();
			const [identifierNode, identifierText] = resolver.getIdentifierInformation(sourceFile, symbol, declaration);
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
				result.addDefinition(sourceFile, definition);
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

	private resolveEmittingNode(symbol: ts.Symbol, isExported: boolean): ts.Node | undefined {
		// The symbol has a export path so we can't bind this to a node
		// Note that we even treat private class members like this. Reason being
		// is that they can be referenced but it would only be a compile error
		// since JS in fact has not visibility.
		if (isExported) {
			return undefined;
		}
		let declarations = symbol.getDeclarations();
		if (declarations === undefined || declarations.length !== 1) {
			return undefined;
		}
		let declaration = declarations[0];
		if (tss.isValueModule(symbol) && declaration.kind === ts.SyntaxKind.SourceFile) {
			return undefined;
		}
		if (tss.isAliasSymbol(symbol)) {
			let sourceFile = declaration.getSourceFile();
			return this.isFullContentIgnored(sourceFile) ? undefined : sourceFile;
		}
		if (ts.isSourceFile(declaration)) {
			return this.isFullContentIgnored(declaration) ? undefined : declaration;
		}
		let result = declaration.parent;
		while (result !== undefined && !tss.EmitBoundaries.has(result.kind)) {
			result = result.parent;
		}
		if (result !== undefined && this.isFullContentIgnored(result.getSourceFile())) {
			return undefined;
		}
		return result;
	}

	private getResolver(symbol: ts.Symbol, location?: ts.Node): SymbolDataResolver {
		if (location !== undefined && tss.isTransient(symbol)) {
			if (tss.isComposite(this.typeChecker, symbol, location)) {
				return this.symbolDataResolvers.unionOrIntersection;
			} else {
				// Problem: Symbols that come from the lib*.d.ts files are marked transient
				// as well. Check if the symbol has some other meaningful flags
				if ((symbol.getFlags() & ~ts.SymbolFlags.Transient) !== 0) {
					return this.symbolDataResolvers.standard;
				} else {
					return this.symbolDataResolvers.transient;
				}
			}
		}
		if (tss.isTypeAlias(symbol)) {
			return this.symbolDataResolvers.typeAlias;
		}
		if (tss.isAliasSymbol(symbol)) {
			return this.symbolDataResolvers.alias;
		}
		if (tss.isMethodSymbol(symbol)) {
			return this.symbolDataResolvers.method;
		}
		return this.symbolDataResolvers.standard;
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
		return this.builder.vertex;
	}

	public get edge(): EdgeBuilder {
		return this.builder.edge;
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


export function lsif(emitter: Emitter, builder: Builder, languageService: ts.LanguageService, dependsOn: ProjectInfo[], options: Options): ProjectInfo | number {
	let visitor = new Visitor(emitter, builder, languageService, dependsOn, options);
	let result = visitor.visitProgram();
	visitor.endVisitProgram();
	return result;
}
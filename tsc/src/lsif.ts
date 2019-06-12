/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as os from 'os';
// In typescript all paths are /. So use the posix layer only
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

import URI from 'vscode-uri';
import * as ts from 'typescript';

import * as tss from './typescripts';

import {
	lsp, Vertex, Edge, Project, Document, Id, ReferenceResult, RangeTagTypes, ReferenceRange, RangeId, RangeBasedDocumentSymbol,
	ResultSet, DefinitionRange, DefinitionResult, MonikerKind, PackageInformation, ItemEdgeProperties, ImplementationResult, Version,
	Range, EventKind
} from 'lsif-protocol';

import { VertexBuilder, EdgeBuilder, Builder } from './graph';

import { Emitter } from './emitters/emitter';

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
		let start = file.getLineAndCharacterOfPosition(node.getStart(file, includeJsDocComment));
		let end = file.getLineAndCharacterOfPosition(node.getEnd());
		return {
			start: { line: start.line, character: start.character },
			end: { line: end.line, character: end.character }
		}
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
			contents: content,
			range: rangeFromTextSpan(file, value.textSpan)
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

interface EmitContext {
	vertex: VertexBuilder;
	edge: EdgeBuilder;
	emit(element: Vertex | Edge): void;
}

type SymbolId = string;

interface SymbolDataContext extends EmitContext {
	getDocumentData(fileName: string): DocumentData | undefined;
	getOrCreateSymbolData(symbolId: SymbolId, scope?: ts.Node): SymbolData;
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

	public constructor(context: SymbolDataContext, private project: Project) {
		super(context);
		this.documents = [];
		this.diagnostics = [];
	}

	public begin(): void {
		this.emit(this.project);
		this.emit(this.vertex.event(EventKind.begin, this.project));
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
		this.emit(this.vertex.event(EventKind.end, this.project));
	}
}

class DocumentData extends LSIFData {

	private ranges: Range[];
	private diagnostics: lsp.Diagnostic[] | undefined;
	private foldingRanges: lsp.FoldingRange[] | undefined;
	private documentSymbols: RangeBasedDocumentSymbol[] | undefined;

	public constructor(context: SymbolDataContext, public document: Document, public packageInfo?: PackageInformation,
		public monikerKind?: MonikerKind, public monikerPath?: string) {
		super(context);
		this.ranges = [];
	}

	public begin(): void {
		this.emit(this.document);
		this.emit(this.vertex.event(EventKind.begin, this.document));
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
		this.emit(this.vertex.event(EventKind.end, this.document));
	}
}

abstract class SymbolData extends LSIFData {

	protected resultSet: ResultSet;

	public constructor(context: SymbolDataContext, private id: SymbolId) {
		super(context);
		this.resultSet = this.vertex.resultSet();
	}

	public getId(): string {
		return this.id;
	}

	public begin(): void {
		this.emit(this.resultSet);
	}

	public recordDeclarationNode(node: ts.Node): void {
		node.getStart
	}

	public addHover(hover: lsp.Hover) {
		let hr = this.vertex.hoverResult(hover);
		this.emit(hr);
		this.emit(this.edge.hover(this.resultSet, hr));
	}

	public addMoniker(path: string | undefined, prefix: string | undefined, name: string): void {
		let fullName = prefix !== undefined ? `${prefix}.${name}` : name;
		let moniker = this.vertex.moniker(MonikerKind.export, 'tsc', tss.createMonikerIdentifier(path, fullName));
		this.emit(moniker);
		this.emit(this.edge.moniker(this.resultSet, moniker));
	}

	public abstract getOrCreateDefinitionResult(): DefinitionResult;

	public abstract addDefinition(sourceFile: ts.SourceFile, definition: DefinitionRange): void;

	public abstract getOrCreateReferenceResult(): ReferenceResult;

	public abstract addReference(sourceFile: ts.SourceFile, reference: Range, property: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void;
	public abstract addReference(sourceFile: ts.SourceFile, reference: ReferenceResult): void;

	public abstract getOrCreatePartition(sourceFile: ts.SourceFile): SymbolDataPartition;

	public abstract nodeProcessed(node: ts.Node): boolean;
}

class StandardSymbolData extends SymbolData {

	private definitionResult: DefinitionResult | undefined;
	private referenceResult: ReferenceResult | undefined;

	private partitions: Map<string /* filename */, SymbolDataPartition | null> | null;

	public constructor(context: SymbolDataContext, id: SymbolId, private scope: ts.Node | undefined = undefined) {
		super(context, id);
		this.partitions = new Map();
	}

	public addDefinition(sourceFile: ts.SourceFile, definition: DefinitionRange): void {
		this.emit(this.edge.next(definition, this.resultSet));
		this.getOrCreatePartition(sourceFile).addDefinition(definition);
	}

	public addReference(sourceFile: ts.SourceFile, reference: Range | ReferenceResult, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		if (reference.label === 'range') {
			this.emit(this.edge.next(reference, this.resultSet));
		}
		this.getOrCreatePartition(sourceFile).addReference(reference as any, property as any);
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

	public getOrCreatePartition(sourceFile: ts.SourceFile): SymbolDataPartition {
		let fileName = sourceFile.fileName;
		if (this.partitions === null) {
			throw new Error (`Partition for symbol ${this.getId()} have already been cleared`);
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
		if (this.partitions === null) {
			throw new Error (`Partition for symbol ${this.getId()} have already been cleared`);
		}
		if (ts.isSourceFile(node)) {
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
		} else if (node === this.scope) {
			if (this.partitions.size !== 1) {
				throw new Error(`Local Symbol data has more than one partition.`);
			}
			let parition = this.partitions.values().next().value;
			if (parition !== null) {
				parition.end();
			}
			this.partitions = null;
			return true;
		} else {
			throw new Error(`Node is neither a source file nor does it match the scope`);
		}
	}

	public end(): void {
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

class AliasedSymbolData extends SymbolData {

	constructor(context: SymbolDataContext, id: string, private aliased: SymbolData) {
		super(context, id);
	}

	public addDefinition(sourceFile: ts.SourceFile, definition: DefinitionRange): void {
		this.aliased.addDefinition(sourceFile, definition);
	}

	public addReference(sourceFile: ts.SourceFile, reference: Range | ReferenceResult, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		this.aliased.addReference(sourceFile, reference as any, property as any);
	}

	public getOrCreateDefinitionResult(): DefinitionResult {
		return this.aliased.getOrCreateDefinitionResult();
	}

	public getOrCreateReferenceResult(): ReferenceResult {
		return this.aliased.getOrCreateReferenceResult();
	}

	public getOrCreatePartition(sourceFile: ts.SourceFile): SymbolDataPartition {
		return this.aliased.getOrCreatePartition(sourceFile);
	}

	public nodeProcessed(node: ts.Node): boolean {
		return this.aliased.nodeProcessed(node);
	}
}

class SymbolDataPartition extends LSIFData {

	private definitionRanges: Range[] | undefined;

	private referenceRanges: Map<ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references, Range[]> | undefined;
	private referenceResults: ReferenceResult[] | undefined;

	public constructor(context: SymbolDataContext, private symbolData: SymbolData, private document: Document) {
		super(context);
	}

	public begin(): void {
		// Do nothing.
	}

	public addDefinition(value: DefinitionRange): void {
		if (this.definitionRanges === undefined) {
			this.definitionRanges = [];
		}
		this.definitionRanges.push(value);
		this.addReference(value, ItemEdgeProperties.definitions);
	}

	public addReference(value: Range, property: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void;
	public addReference(value: ReferenceResult): void;
	public addReference(value: Range | ReferenceResult, property?: ItemEdgeProperties.declarations | ItemEdgeProperties.definitions | ItemEdgeProperties.references): void {
		if (value.label === 'range' && property !== undefined) {
			if (this.referenceRanges === undefined) {
				this.referenceRanges = new Map();
			}
			let values = this.referenceRanges.get(property);
			if (values === undefined) {
				values = [];
				this.referenceRanges.set(property, values);
			}
			values.push(value);
		} else if (value.label === 'referenceResult') {
			if (this.referenceResults === undefined) {
				this.referenceResults = [];
			}
			this.referenceResults.push(value);
		}
	}

	public end(): void {
		if (this.definitionRanges !== undefined) {
			let definitionResult = this.symbolData.getOrCreateDefinitionResult();
			this.emit(this.edge.item(definitionResult, this.definitionRanges, this.document));
		}
		if (this.referenceRanges !== undefined) {
			let referenceResult = this.symbolData.getOrCreateReferenceResult();
			for (let property of this.referenceRanges.keys()) {
				let values = this.referenceRanges.get(property)!;
				this.emit(this.edge.item(referenceResult, values, this.document, property))
			}
		}
		if (this.referenceResults !== undefined) {
			let referenceResult = this.symbolData.getOrCreateReferenceResult();
			this.emit(this.edge.item(referenceResult, this.referenceResults, this.document));
		}
	}
}

interface ResolverContext extends SymbolDataContext {
	typeChecker: ts.TypeChecker;
}

abstract class SymbolDataResolver {

	constructor(protected context: ResolverContext) {
	}

	public abstract resolve(symbol: ts.Symbol, scope?: ts.Node): SymbolData;

}

class StandardResolver extends SymbolDataResolver {

	constructor(context: ResolverContext) {
		super(context);
	}

	public resolve(symbol: ts.Symbol, scope?: ts.Node): SymbolData {
		let id = tss.createSymbolKey(this.context.typeChecker, symbol);
		return new StandardSymbolData(this.context, id, scope);
	}
}

class TypeAliasResolver extends SymbolDataResolver {

	constructor(context: ResolverContext) {
		super(context);
	}

	public resolve(symbol: ts.Symbol, scope?: ts.Node): SymbolData {
		let id = tss.createSymbolKey(this.context.typeChecker, symbol);
		let aliased = this.context.typeChecker.getAliasedSymbol(symbol);
		if (aliased !== undefined) {
			let aliasedId = tss.createSymbolKey(this.context.typeChecker, aliased);
			this.context.getOrCreateSymbolData(aliasedId, )
			let aliasedSymbolItem = this.get(context, aliased);
			if (aliasedSymbolItem !== undefined) {
				result = new AliasSymbolItem(key, context, symbol, aliasedSymbolItem);
			}
		}
	}
}

export class DataManager implements SymbolDataContext {

	private projectData: ProjectData;
	private documentDatas: Map<string, DocumentData | null>;
	private symbolDatas: Map<string, SymbolData | null>;
	private clearOnNode: Map<ts.Node, SymbolData[]>;

	public constructor(private context: EmitContext, project: Project) {
		this.projectData = new ProjectData(this, project);
		this.projectData.begin();
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

	public projectDone(): void {
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
	}

	public getDocumentData(fileName: string): DocumentData | undefined {
		let result = this.documentDatas.get(fileName);
		if (result === null) {
			throw new Error(`There was already a managed document data for file: ${fileName}`);
		}
		return result;
	}

	public getOrCreateDocumentData(fileName: string, document: Document, packageInfo?: PackageInformation,
		monikerKind?: MonikerKind, monikerPath?: string): DocumentData {
		let result = this.getDocumentData(fileName);
		if (result === undefined) {
			result = new DocumentData(this, document, packageInfo, monikerKind, monikerPath);
			this.documentDatas.set(fileName, result);
			result.begin();
		}
		return result;
	}

	public documentDone(fileName: string): void {
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

	public getOrCreateSymbolData(symbolId: SymbolId, resolver: SymbolDataResolver, scope?: ts.Node): SymbolData {
		let result = this.getSymbolData(symbolId);
		if (result === undefined) {
			result = resolver.resolve() new StandardSymbolData(this, symbolInfo.id, scope);
			this.symbolDatas.set(result.getId(), result);
			result.begin();
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

interface SymbolItemContext extends EmitContext {

	typeChecker: ts.TypeChecker;
	getOrCreateDocumentData(file: ts.SourceFile): DocumentData;
	getOrCreateSymbolData(symbolInfo: SymbolItem, scope?: ts.Node): SymbolData;
	getHover(node: ts.DeclarationName, sourceFile?: ts.SourceFile): lsp.Hover | undefined;
	getDefinitionAtPosition(sourceFile: ts.SourceFile, node: ts.Identifier): ReadonlyArray<ts.DefinitionInfo> | undefined;
	getTypeDefinitionAtPosition(sourceFile: ts.SourceFile, node: ts.Identifier): ReadonlyArray<ts.DefinitionInfo> | undefined;

	isFullContentIgnored(sourceFile: ts.SourceFile): boolean;
	isExported(symbol: ts.Symbol): boolean;
}

abstract class SymbolItem {

	private static all: Map<string, SymbolItem> = new Map();

	private static Unknown = 'unkown';
	private static Undefined = 'undefined';
	private static None = 'none';

	public static get(context: SymbolItemContext, symbol: ts.Symbol): SymbolItem {
		let key = this.createKey(symbol, context.typeChecker);
		let result: SymbolItem | undefined = this.all.get(key);
		if (result === undefined) {
			if (this.isClass(symbol)) {
				result = new ClassSymbolItem(key, context, symbol);
			} else if (this.isInterface(symbol)) {
				result = new InterfaceSymbolItem(key, context, symbol);
			} else if (this.isTypeLiteral(symbol)) {
				result = new TypeLiteralSymbolItem(key, context, symbol);
			} else if (this.isMethodSymbol(symbol)) {
				result = new MethodSymbolItem(key, context, symbol);
			} else if (this.isFunction(symbol)) {
				result = new FunctionSymbolItem(key, context, symbol);
			} else if (this.isAliasSymbol(symbol)) {
				let aliased = context.typeChecker.getAliasedSymbol(symbol);
				if (aliased !== undefined) {
					let aliasedSymbolItem = this.get(context, aliased);
					if (aliasedSymbolItem !== undefined) {
						result = new AliasSymbolItem(key, context, symbol, aliasedSymbolItem);
					}
				}
			}
			if (result === undefined) {
				result = new GenericSymbolItem(key, context, symbol);
			}
			this.all.set(key, result);
			result.initialize();
		}
		return result;
	}

	private static createKey(symbol: ts.Symbol, typeChecker: ts.TypeChecker): string {
		let declarations = symbol.getDeclarations()
		if (declarations === undefined) {
			if (typeChecker.isUnknownSymbol) {
				return SymbolItem.Unknown;
			} else if (typeChecker.isUndefinedSymbol) {
				return SymbolItem.Undefined;
			} else {
				return SymbolItem.None;
			}
		}
		let result: { f: string; s: number; e: number}[] = [];
		for (let declaration of declarations) {
			result.push({
				f: declaration.getSourceFile().fileName,
				s: declaration.getStart(),
				e: declaration.getEnd()
			})
		};
		let hash = crypto.createHash('md5');
		hash.write(JSON.stringify(result, undefined, 0));
		return hash.digest('base64');
	}

	protected static isFunction(symbol: ts.Symbol): boolean {
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

	protected static isMethodSymbol(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Method) !== 0;
	}

	protected static isAliasSymbol(symbol: ts.Symbol): boolean  {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Alias) !== 0;
	}

	protected static isValueModule(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.ValueModule) !== 0;
	}

	protected static isBlockScopedVariable(symbol: ts.Symbol): boolean {
		return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.BlockScopedVariable) !== 0;
	}

	protected static computeMoniker(nodes: ts.Node[]): string | undefined {
		if (nodes.length === 0) {
			return undefined;
		}
		if (nodes.length === 1) {
			return this.doComputeMoniker(nodes[0]);
		}
		let result: Set<string> = new Set<string>();
		for (let node of nodes) {
			let part = SymbolItem.doComputeMoniker(node);
			if (part === undefined) {
				return undefined;
			}
			result.add(part);
		}
		return Array.from(result).join('|');
	}

	private static stopKinds: Set<number> = new Set([ts.SyntaxKind.Block, ts.SyntaxKind.ClassExpression, ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.ArrowFunction]);
	private static doComputeMoniker(node: ts.Node): string | undefined {
		function getName(node: ts.Node): string | undefined {
			let namedDeclaration: ts.NamedDeclaration = node as ts.NamedDeclaration;
			if (namedDeclaration.name !== undefined) {
				return namedDeclaration.name.getText();
			} else {
				return undefined;
			}
		}
		// No monikers for source files.
		if (ts.isSourceFile(node)) {
			return undefined;
		}
		let buffer: string[] = [];
		do {
			if (SymbolItem.stopKinds.has(node.kind)) {
				// No keys for stuff inside a block, ...
				return undefined;
			}
			let name = getName(node);
			if (name !== undefined) {
				buffer.unshift(name);
			} else if (node.kind === ts.SyntaxKind.ClassDeclaration) {
				// We have an anonymous class declaration => no key.
				return undefined;
			} else if (node.kind === ts.SyntaxKind.FunctionDeclaration) {
				// We have an anonymous function declaration => no key.
				return undefined;
			}
		} while ((node = node.parent) !== undefined && !ts.isSourceFile(node))
		return buffer.join('.');
	}

	public static isPrivate(symbol: ts.Symbol): boolean {
		let declarations = symbol.getDeclarations();
		if (declarations) {
			for (let declaration of declarations) {
				let modifierFlags = ts.getCombinedModifierFlags(declaration);
				if ((modifierFlags & ts.ModifierFlags.Private) === 0) {
					return false;
				}
			}
		}
		return true;
	}

	protected static isStatic(symbol: ts.Symbol): boolean {
		let declarations = symbol.getDeclarations();
		if (declarations) {
			for (let declaration of declarations) {
				let modifierFlags = ts.getCombinedModifierFlags(declaration);
				if ((modifierFlags & ts.ModifierFlags.Static) === 0) {
					return false;
				}
			}
		}
		return true;
	}

	private static EmitBoundaries: Set<number> = new Set<number>([
		ts.SyntaxKind.TypeParameter,
		ts.SyntaxKind.Parameter,
		ts.SyntaxKind.PropertyDeclaration,
		ts.SyntaxKind.MethodDeclaration,
		ts.SyntaxKind.Constructor,
		ts.SyntaxKind.GetAccessor,
		ts.SyntaxKind.SetAccessor,
		ts.SyntaxKind.CallSignature,
		ts.SyntaxKind.FunctionExpression,
		ts.SyntaxKind.ArrowFunction,
		ts.SyntaxKind.ClassExpression,
		ts.SyntaxKind.VariableDeclaration,
		ts.SyntaxKind.FunctionDeclaration,
		ts.SyntaxKind.ClassDeclaration,
		ts.SyntaxKind.InterfaceDeclaration,
		ts.SyntaxKind.TypeAliasDeclaration,
		ts.SyntaxKind.EnumDeclaration,
		ts.SyntaxKind.ModuleDeclaration,
		ts.SyntaxKind.SourceFile
	]);

	public declarations: DefinitionRange | DefinitionRange[] | undefined;
	public rangeNodes: ts.Node | ts.Node[] | undefined;
	public _resultSet: ResultSet | undefined;
	public definitionResult: DefinitionResult | undefined;
	public _referenceResult:  ReferenceResult | undefined;
	public _implementationResult: ImplementationResult | undefined;

	protected constructor(public id: string, protected context: SymbolItemContext, public tsSymbol: ts.Symbol) {
	}

	public get resultSet(): ResultSet {
		if (this._resultSet === undefined) {
			throw new Error(`Result set not initialized.`)
		}
		return this._resultSet;
	}

	public get referenceResult(): ReferenceResult {
		if (this._referenceResult === undefined) {
			throw new Error(`Reference result not initialized.`)
		}
		return this._referenceResult;
	}

	protected initialize(): void {
		// this.ensureResultSet();
		let declarations: ts.Declaration[] | undefined = this.tsSymbol.getDeclarations();
		if (declarations !== undefined && declarations.length > 0) {
			// this.ensureReferenceResult();
			// this.ensureImplementationResult();
			this.initializeDeclarations(declarations);
		} else {
			this.initializeNoDeclarartions();
		}
	}

	protected initializeDeclarations(declarations: ts.Declaration[]): void {
		let hover: boolean = false;
		const monikerName = SymbolItem.computeMoniker(declarations);
		let monikers: { definition: DefinitionRange; identifier: string; kind: MonikerKind, packageInfo: PackageInformation | undefined }[] = [];
		for (let declaration of declarations) {
			let sourceFile = declaration.getSourceFile();
			let [range, rangeNode, text] = this.resolveDefinitionRange(sourceFile, declaration);
			if (range !== undefined && rangeNode !== undefined && text !== undefined) {
				let documentData = this.context.getOrCreateDocumentData(sourceFile);
				let symbolData = this.context.getOrCreateSymbolData(this, this.resolveEmittingNode());
				let definition = this.context.vertex.range(Converter.rangeFromNode(sourceFile, rangeNode), {
					type: RangeTagTypes.definition,
					text: text,
					kind: Converter.asSymbolKind(declaration),
					fullRange: Converter.rangeFromNode(sourceFile, declaration),
				});
				documentData.addRange(definition);
				symbolData.addDefinition(sourceFile, definition);
				if (monikerName !== undefined && documentData.monikerPath !== undefined && documentData.monikerKind !== undefined) {
					const mi = tss.createMonikerIdentifier(documentData.monikerPath, monikerName);
					monikers.push({ definition, identifier: mi, kind: documentData.monikerKind, packageInfo: documentData.packageInfo });
				}
				this.storeDefinitionAndRange(definition, rangeNode);
				if (!hover && tss.isNamedDeclaration(declaration)) {
					hover = this.handleHover(sourceFile, declaration.name, symbolData);
				}
			} else {
				// We should log this somewhere to improve the tool.
			}
		}
		if (monikers.length > 0) {
			let last: typeof monikers[0] | undefined;
			let same = true;
			for (let item of monikers) {
				if (last === undefined) {
					last = item;
				} else {
					if (last.identifier !== item.identifier || last.kind !== item.kind || last.packageInfo !== item.packageInfo) {
						same = false;
						break;
					}
				}
			}
			if (same) {
				const item = monikers[0];
				const moniker = this.context.vertex.moniker(item.kind, 'tsc', item.identifier);
				this.context.emit(moniker);
				if (item.packageInfo) {
					this.context.emit(this.context.edge.packageInformation(moniker, item.packageInfo));
				}
				this.context.emit(this.context.edge.moniker(this.resultSet, moniker));
			} else {
				for (let item of monikers) {
					const moniker = this.context.vertex.moniker(item.kind, 'tsc', item.identifier);
					this.context.emit(moniker);
					if (item.packageInfo) {
						this.context.emit(this.context.edge.packageInformation(moniker, item.packageInfo));
					}
					this.context.emit(this.context.edge.moniker(item.definition, moniker));
				}
			}
		}
		// if (SymbolItem.isBlockScopedVariable(this.tsSymbol) && declarations.length === 1) {
		// 	let type = this.context.typeChecker.getTypeOfSymbolAtLocation(this.tsSymbol, declarations[0]);
		// 	if (type.symbol) {
		// 		let typeSymbol = SymbolItem.get(this.context, type.symbol);
		// 		let result: TypeDefinitionResult | undefined;
		// 		if (Array.isArray(typeSymbol.declarations)) {
		// 			result = this.context.vertex.typeDefinitionResult(typeSymbol.declarations.map(declaration => declaration.id));
		// 		} else if (typeSymbol.declarations !== undefined) {
		// 			result = this.context.vertex.typeDefinitionResult([typeSymbol.declarations.id]);
		// 		}
		// 		if (result !== undefined) {
		// 			this.context.emit(result);
		// 			this.context.emit(this.context.edge.typeDefinition(this.resultSet, result));
		// 		}
		// 	}
		// }
	}

	protected initializeNoDeclarartions(): void {
		this.ensureReferenceResult();
		this.emitReferenceResult(this.referenceResult);
		this.definitionResult = this.context.vertex.definitionResult();
		this.context.emit(this.definitionResult);
		this.context.emit(this.context.edge.definition(this.resultSet, this.definitionResult));
	}

	protected resolveEmittingNode(): ts.Node | undefined {
		// The symbol is exported So we can't optimize any emitting.
		if (this.context.isExported(this.tsSymbol)) {
			return undefined;
		}
		let declarations = this.tsSymbol.getDeclarations();
		if (declarations === undefined || declarations.length !== 1) {
			return undefined;
		}
		let declaration = declarations[0];
		if (SymbolItem.isValueModule(this.tsSymbol) && declaration.kind === ts.SyntaxKind.SourceFile) {
			return undefined;
		}

		if (ts.isSourceFile(declaration)) {
			return this.context.isFullContentIgnored(declaration) ? undefined : declaration;
		}
		let result = declaration.parent;
		while (result !== undefined && !SymbolItem.EmitBoundaries.has(result.kind)) {
			result = result.parent;
		}
		if (result !== undefined && this.context.isFullContentIgnored(result.getSourceFile())) {
			return undefined;
		}
		return result;
	}

	protected ensureResultSet(): void {
		if (this._resultSet !== undefined) {
			return;
		}
		this._resultSet = this.context.vertex.resultSet();
		this.context.emit(this.resultSet);
	}

	protected getDefinitionResultValues(): RangeId[] | undefined {
		return [];
	}

	private ensureReferenceResult(): void {
		if (this._referenceResult !== undefined) {
			return;
		}
		this.resolveReferenceResult();
		this.emitReferenceResult(this.referenceResult);
	}

	private resolveReferenceResult(): void {
		let declarations = this.tsSymbol.getDeclarations();
		if (declarations === undefined || declarations.length === 0) {
			this._referenceResult = this.createReferenceResult();
			return;
		}
		this._referenceResult = this.doResolveReferenceResult();
	}

	protected doResolveReferenceResult(): ReferenceResult {
		return this.createReferenceResult();
	}

	protected createReferenceResult(): ReferenceResult {
		return this.context.vertex.referencesResult();
	}

	protected emitReferenceResult(result: ReferenceResult): void {
		this.context.emit(result);
		this.context.emit(this.context.edge.references(this.resultSet, result));
	}

	// private ensureImplementationResult(): void {
	// 	if (this._implementationResult !== undefined) {
	// 		return;
	// 	}
	// 	this.resolveImplementationResult();
	// }

	// private resolveImplementationResult(): void {
	// 	let declarations = this.tsSymbol.getDeclarations();
	// 	if (declarations === undefined || declarations.length === 0) {
	// 		this._implementationResult = this.createImplementationResult();
	// 	}
	// 	this._implementationResult = this.doResolveImplementationResult();
	// }

	protected doResolveImplementationResult(): ImplementationResult {
		return this.createImplementationResult();
	}

	protected createImplementationResult(): ImplementationResult {
		return this.context.vertex.implementationResult();
	}

	protected emitEdgeToForeignReferenceResult(from: ResultSet, to: ReferenceResult): void {
		// let emittingNode: ts.Node | undefined;
		// let edge = this.context.edge.references(from, to);
		// if (ReferenceResult.isStatic(to)) {
		// 	emittingNode = this.context.getEmittingNode(to);
		// }
		// if (emittingNode !== undefined) {
		// 	this.context.emitOnEndVisit(emittingNode, [edge]);
		// } else {
		// 	this.context.emit(edge);
		// }
	}

	protected resolveDefinitionRange(sourceFile: ts.SourceFile, declaration: ts.Declaration): [lsp.Range, ts.Node, string] | [undefined, undefined, undefined] {
		if (tss.isNamedDeclaration(declaration)) {
			let name = declaration.name;
			return [Converter.rangeFromNode(sourceFile, name), name, name.getText()];
		}
		if (SymbolItem.isValueModule(this.tsSymbol) && ts.isSourceFile(declaration)) {

			return [{ start: { line: 0, character: 0}, end: { line: 0, character: 0 } }, declaration, ''];
		}
		return [undefined, undefined, undefined];
	}

	protected handleHover(sourceFile: ts.SourceFile, rangeNode: ts.DeclarationName, symbolData: SymbolData): boolean  {
		let hover = this.context.getHover(rangeNode, sourceFile);
		if (hover !== undefined) {
			symbolData.addHover(hover);
			return true;
		} else {
			return false;
		}
	}

	protected storeDefinitionAndRange(definition: DefinitionRange, rangeNode: ts.Node): void {
		if (Array.isArray(this.declarations)) {
			this.declarations.push(definition);
			(this.rangeNodes as Array<ts.Node>).push(rangeNode);
		} else if (this.declarations !== undefined) {
			this.declarations = [this.declarations, definition];
			this.rangeNodes = [this.rangeNodes as ts.Node, rangeNode];
		} else {
			this.declarations = definition;
			this.rangeNodes = rangeNode!;
		}
	}

	public forEachDeclaration(func: (declaration: DefinitionRange) => void): void {
		if (Array.isArray(this.declarations)) {
			for (let declaration of this.declarations) {
				func(declaration);
			}
		} else if (this.declarations !== undefined) {
			func(this.declarations);
		}
	}

	public addReference(symbolItemCluster: SymbolDataPartition, reference: ReferenceRange): void {
		this.recordReference(symbolItemCluster, reference);
	}

	public hasDeclaration(node: ts.Node): boolean {
		if (Array.isArray(this.rangeNodes)) {
			return this.rangeNodes.indexOf(node) !== -1;
		} else {
			return this.rangeNodes === node;
		}
	}

	public getDeclaration(node: ts.Node): DefinitionRange | undefined {
		if (Array.isArray(this.rangeNodes)) {
			for (let i = 0; i < this.rangeNodes.length; i++) {
				if (this.rangeNodes[i] === node) {
					return (this.declarations as DefinitionRange[])[i];
				}
			}
		} else {
			return this.rangeNodes === node ? this.declarations as DefinitionRange : undefined;
		}
		return undefined;
	}

	public findDeclaration(start: number, end: number): DefinitionRange | undefined {
		if (Array.isArray(this.rangeNodes)) {
			for (let i = 0; i < this.rangeNodes.length; i++) {
				let node = this.rangeNodes[i];
				if (node.getStart() === start && node.getEnd() === end) {
					return (this.declarations as DefinitionRange[])[i];
				}
			}
		} else if (this.rangeNodes !== undefined) {
			if (this.rangeNodes.getStart() === start && this.rangeNodes.getEnd() === end) {
				return this.declarations as DefinitionRange;
			}
		}
		return undefined;
	}

	protected recordDeclaration(symbolItemCluster: SymbolDataPartition, definition: DefinitionRange): void {
		this.context.emit(this.context.edge.next(definition, this.resultSet));
		symbolItemCluster.addDefinition(definition);
		// If this is not an interface, each declaration is an implementation result
		// if (!MemberContainerItem.isInterface(this.tsSymbol) &&
		// 	// If this is a method and the symbol kind is NOT method, then it is not an implementation
		// 	!(MemberContainerItem.isMethodSymbol(this.tsSymbol) && definition.tag.kind !== lsp.SymbolKind.Method) &&
		// 	this._implementationResult
		// ) {
		// 	if(this._implementationResult.result === undefined) {
		// 		this.context.emit(this.context.edge.item(this._implementationResult, definition));
		// 	}
		// 	else {
		// 		this._implementationResult.result.push(definition.id);
		// 	}
		// }
	}

	protected recordReference(symbolItemCluster: SymbolDataPartition, reference: ReferenceRange): void {
		this.context.emit(this.context.edge.next(reference, this.resultSet));
		symbolItemCluster.addReference(reference, ItemEdgeProperties.references);
	}
}

class GenericSymbolItem extends SymbolItem {
	public constructor(id: string, context: SymbolItemContext, tsSymbol: ts.Symbol) {
		super(id, context, tsSymbol);
	}
}

class FunctionSymbolItem extends SymbolItem {
	public constructor(id: string, context: SymbolItemContext, tsSymbol: ts.Symbol) {
		super(id, context, tsSymbol);
	}
}

abstract class MemberContainerItem extends SymbolItem {

	private static EMPTY: ReadonlyArray<MemberContainerItem> = Object.freeze([]);

	private baseSymbols: ReadonlyArray<MemberContainerItem> | undefined;

	public constructor(id: string, context: SymbolItemContext, tsSymbol: ts.Symbol) {
		super(id, context, tsSymbol);
	}

	protected initialize(): void {
		this.ensureBaseSymbol();
		super.initialize();
	}

	private ensureBaseSymbol(): void {
		// Already resolve or not class or interface.
		if (this.baseSymbols !== undefined) {
			return;
		}
		let bases = this.getBaseSymbols();
		if (bases === undefined || bases.length === 0) {
			this.baseSymbols = MemberContainerItem.EMPTY;
			return;
		}
		let baseSymbols: MemberContainerItem[] = [];
		for (let base of bases) {
			let baseSymbol = SymbolItem.get(this.context, base);
			if (!(baseSymbol instanceof MemberContainerItem)) {
				throw new Error(`Base symbol is not a class ${this.tsSymbol.getName()}`);
			}
			baseSymbols.push(baseSymbol);
		}
		this.baseSymbols = baseSymbols;
	}

	protected recordDeclaration(symbolItemCluster: SymbolDataPartition, definition: DefinitionRange): void {
		super.recordDeclaration(symbolItemCluster, definition);

		// If we have base symbols, add our declaration to their implementation results
		// if (this.baseSymbols) {
		// 	this.baseSymbols.forEach(baseSymbol => {
		// 		if (baseSymbol._implementationResult) {
		// 			if(baseSymbol._implementationResult.result === undefined) {
		// 				this.context.emit(this.context.edge.item(baseSymbol._implementationResult, definition));
		// 			}
		// 			else {
		// 				baseSymbol._implementationResult.result.push(definition.id);
		// 			}
		// 		}
		// 	});
		// }
	}

	protected abstract getBaseSymbols(): ts.Symbol[]  | undefined;

	public findBaseMembers(memberName: string): MethodSymbolItem[] | undefined {
		if (this.baseSymbols === undefined) {
			return undefined;
		}
		let result: MethodSymbolItem[] | undefined;
		for (let base of this.baseSymbols) {
			if (!base.tsSymbol.members) {
				continue;
			}
			let method = base.tsSymbol.members.get(memberName as ts.__String);
			if (method !== undefined) {
				if (result === undefined) {
					result = [SymbolItem.get(this.context, method) as MethodSymbolItem];
				} else {
					result.push(SymbolItem.get(this.context, method) as MethodSymbolItem);
				}
			} else {
				let baseResult = base.findBaseMembers(memberName);
				if (baseResult !== undefined) {
					if (result === undefined) {
						result = baseResult;
					} else {
						result.push(...baseResult);
					}
				}
			}
		}
		return result;
	}
}

class TypeLiteralSymbolItem extends MemberContainerItem {
	public constructor(id: string, context: SymbolItemContext, tsSymbol: ts.Symbol) {
		super(id, context, tsSymbol);
	}

	// Type literal symbols have no base symbols
	protected getBaseSymbols(): ts.Symbol[] | undefined {
		return undefined;
	}
}

class InterfaceSymbolItem extends MemberContainerItem {

	public constructor(id: string, context: SymbolItemContext, tsSymbol: ts.Symbol) {
		super(id, context, tsSymbol);
	}

	// Type literal symbols have no base symbols
	protected getBaseSymbols(): ts.Symbol[] | undefined {
		let result: ts.Symbol[] = [];
		let tsType = this.context.typeChecker.getDeclaredTypeOfSymbol(this.tsSymbol);
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
}

/**
 * Classes and interfaces.
 */
class ClassSymbolItem extends MemberContainerItem {

	public constructor(id: string, context: SymbolItemContext, tsSymbol: ts.Symbol) {
		super(id, context, tsSymbol);
	}

	// Type literal symbols have no base symbols
	protected getBaseSymbols(): ts.Symbol[] | undefined {
		let result: ts.Symbol[] = [];
		let declarations = this.tsSymbol.getDeclarations();
		if (declarations === undefined) {
			return undefined;
		}
		let typeChecker = this.context.typeChecker;
		for (let declaration of declarations) {
			if (ts.isClassDeclaration(declaration)) {
				let heritageClauses = declaration.heritageClauses;
				if (heritageClauses) {
					for (let heritageClause of heritageClauses) {
						for (let type of heritageClause.types) {
							let tsType = typeChecker.getTypeAtLocation(type.expression);
							if (tsType !== undefined) {
								let symbol = tsType.getSymbol();
								if (symbol) {
									result.push(symbol);
								}
							}
						}
					}
				}
			}
		}
		return result.length === 0 ? undefined : result;
	}
}

class MethodSymbolItem extends SymbolItem {

	//private baseReferenceResults: ReadonlyArray<ReferenceResult> | undefined;

	public constructor(id: string, context: SymbolItemContext, tsSymbol: ts.Symbol) {
		super(id, context, tsSymbol);
	}

	private findBaseMethods(): MethodSymbolItem[] {
		let classSymbol = this.getMemberContainer();
		if (classSymbol === undefined) {
			return [];
		}
		let methodName = this.tsSymbol.getName();
		let baseMethods = classSymbol.findBaseMembers(methodName);
		if (baseMethods === undefined) {
			return [];
		}
		return baseMethods;
	}

	// protected doResolveReferenceResult(): ReferenceResult {
	// 	if (SymbolItem.isPrivate(this.tsSymbol)) {
	// 		return super.doResolveReferenceResult();
	// 	}
	// 	if (SymbolItem.isStatic(this.tsSymbol)) {
	// 		return super.doResolveReferenceResult();
	// 	}
	// 	// We have a method that could be overridden. So try to find
	// 	// a base method with the same name.
	// 	let baseMethods = this.findBaseMethods();
	// 	if (baseMethods.length === 0) {
	// 		return this.createReferenceResult();
	// 	}
	// 	// We do have base methods. Easy case only one. Then reuse what the
	// 	// base method has
	// 	if (baseMethods.length === 1) {
	// 		let baseMethod = baseMethods[0];
	// 		let referenceResult = baseMethod.referenceResult;
	// 		this.baseReferenceResults = baseMethod.baseReferenceResults;
	// 		this.emitEdgeToForeignReferenceResult(this.resultSet, referenceResult);
	// 		return referenceResult;
	// 	}

	// 	let baseReferenceResults: ReferenceResult[] = [];
	// 	let mergeIds: ReferenceResultId[] = [];
	// 	for (let base of baseMethods) {
	// 		if (base.referenceResult !== undefined) {
	// 			mergeIds.push(base.referenceResult.id);
	// 		}
	// 		if (base.referenceResult !== undefined && base.baseReferenceResults === undefined) {
	// 			baseReferenceResults.push(base.referenceResult);
	// 		} else if (base.baseReferenceResults !== undefined) {
	// 			baseReferenceResults.push(...base.baseReferenceResults);
	// 		}
	// 	}
	// 	this.baseReferenceResults = baseReferenceResults;
	// 	let referenceResult = this.createReferenceResult(mergeIds);
	// 	// The merged ID set is complete. So we can emit it
	// 	this.emitReferenceResult(referenceResult);
	// 	return referenceResult;
	// }

	protected doResolveImplementationResult(): ImplementationResult {
		// Implementation is the same as declaration
		if (SymbolItem.isPrivate(this.tsSymbol)) {
			return super.doResolveImplementationResult();
		}
		if (SymbolItem.isStatic(this.tsSymbol)) {
			return super.doResolveImplementationResult();
		}

		// We could be implementing another method
		// Look for base method
		let baseMethods = this.findBaseMethods();
		if (baseMethods.length === 0) {
			return super.doResolveImplementationResult();
		}

		// We implement some base method
		let implementationResult = this.context.vertex.implementationResult();
		// implementationResult.result = [];

		// // In this case, point all base methods to our results as well
		// let toEmit: Edge[] = [];
		// baseMethods.forEach(baseMethod => {
		// 	if (baseMethod._implementationResult) {
		// 		toEmit.push(this.context.edge.item(baseMethod._implementationResult, implementationResult));
		// 	}
		// });

		// this.context.emitOnEndVisit(emittingNode, [implementationResult, this.context.edge.implementation(this.resultSet, implementationResult), ...toEmit]);

		return implementationResult;
	}

	private getMemberContainer(): MemberContainerItem | undefined {
		let tsSymbol = this.tsSymbol;
		let symbolParent = tss.getSymbolParent(tsSymbol);
		if (symbolParent === undefined) {
			return undefined;
		}
		let memberContainer = SymbolItem.get(this.context, symbolParent);
		if (!(memberContainer instanceof MemberContainerItem)) {
			return undefined;
		}
		return memberContainer;
	}

	protected recordDeclaration(symbolItemCluster: SymbolDataPartition, definition: DefinitionRange): void {
		super.recordDeclaration(symbolItemCluster, definition);
		// if (this.baseReferenceResults !== undefined) {
		// 	this.baseReferenceResults.forEach(result =>  {
		// 		this.context.emit(this.context.edge.item(result, definition, ItemEdgeProperties.definitions))
		// 	});
		// }
	}

	protected recordReference(symbolItemCluster: SymbolDataPartition, reference: ReferenceRange): void {
		super.recordReference(symbolItemCluster, reference);
		// if (this.baseReferenceResults !== undefined) {
		// 	this.baseReferenceResults.forEach(result => {
		// 		this.context.emit(this.context.edge.item(result, reference, ItemEdgeProperties.references));
		// 	});
		// 	return;
		// }
	}
}

class AliasSymbolItem extends SymbolItem  {
	public constructor(id: string, context: SymbolItemContext, tsSymbol: ts.Symbol, private aliased: SymbolItem) {
		super(id, context, tsSymbol);
	}

	protected initialize(): void {
		this.ensureResultSet();
		this._referenceResult = this.aliased.referenceResult;
		this.definitionResult = this.aliased.definitionResult;

		// Wire the reference and definition result to aliased Symbol
		if (this.definitionResult !== undefined) {
			this.context.emit(this.context.edge.definition(this.resultSet, this.definitionResult));
		}
		this.emitEdgeToForeignReferenceResult(this.resultSet, this.referenceResult);
		let declarations = this.tsSymbol.getDeclarations();
		if (declarations !== undefined && declarations.length > 0) {
			this.initializeDeclarations(declarations);
		} else {
			// An aliased symbol without a declaration is not valid.
			// We should log this @log
		}
	}

	protected getDefinitionResultValues(): RangeId[] | undefined {
		// This is handled in recordDeclaration which forwards to the aliased set.
		return undefined;
	}

	protected recordDeclaration(symbolItemCluster: SymbolDataPartition, definition: DefinitionRange): void {
		// this.context.emit(this.context.edge.next(definition, this.resultSet));
		// symbolItemCluster.
		// if (this.referenceResult === undefined) {
		// 	return;
		// }
		// // Alias declarations are recorded as references on the aliased set.
		// if (this.referenceResult.references === undefined) {
		// 	this.context.emit(this.context.edge.item(this.referenceResult, definition, ItemEdgeProperties.references));
		// } else {
		// 	this.referenceResult.references.push(definition.id);
		// }
	}
}

export interface ProjectInfo {
	rootDir: string;
	outDir: string;
}

export interface Options {
	projectRoot: string;
	noContents: boolean;
}

class Visitor implements SymbolItemContext {

	private builder: Builder;
	private project: Project;
	private projectRoot: string;
	private rootDir: string | undefined;
	private outDir: string | undefined;
	private dependentOutDirs: string[];
	private currentSourceFile: ts.SourceFile | undefined;
	private _currentDocumentData: DocumentData | undefined;
	private _currentExports: Set<ts.Symbol> | undefined;
	private symbolContainer: RangeBasedDocumentSymbol[];
	private recordDocumentSymbol: boolean[];
	private dataManager: DataManager;
	private symbolDataResolvers: Map<number, SymbolDataResolver>;
	private packageInfos: Map<string, PackageInformation>;
	private resultPartitions: Map<string /*document*/, Map<string /* Symbol */, SymbolDataPartition>>;
	private externalLibraryImports: Map<string, ts.ResolvedModuleFull>;

	constructor(private languageService: ts.LanguageService, options: Options, dependsOn: ProjectInfo[], private emitter: Emitter, idGenerator: () => Id, tsConfigFile: string | undefined) {
		this.builder = new Builder({
			idGenerator,
			emitSource: !options.noContents
		});
		this.symbolContainer = [];
		this.recordDocumentSymbol = [];
		this.externalLibraryImports = new Map();
		this.packageInfos = new Map();
		this.resultPartitions = new Map();
		this.dependentOutDirs = [];
		for (let info of dependsOn) {
			this.dependentOutDirs.push(info.outDir);
		}
		this.dependentOutDirs.sort((a, b) => {
			return b.length - a.length;
		})
		this.projectRoot = options.projectRoot;
		this.emit(this.vertex.metaData(Version, URI.file(this.projectRoot).toString(true)));
		this.project = this.vertex.project();
		const configLocation = tsConfigFile !== undefined ? path.dirname(tsConfigFile) : undefined;
		let compilerOptions = this.program.getCompilerOptions();
		if (compilerOptions.outDir !== undefined) {
			this.outDir = tss.makeAbsolute(compilerOptions.outDir, configLocation);
		}
		if (compilerOptions.rootDir !== undefined) {
			this.rootDir = tss.makeAbsolute(compilerOptions.rootDir, configLocation);
		} else {
			// Try to compute the root directories.
		}
		this.dataManager = new DataManager(this, this.project);
		this.symbolDataResolvers = new Map();
		this.symbolDataResolvers.set(0, new StandardResolver(this.dataManager));
		this.symbolDataResolvers.set(ts.SymbolFlags.Alias, new TypeAliasResolver(this.dataManager));
		// if (this.isClass(symbol)) {
		// 	result = new ClassSymbolItem(key, context, symbol);
		// } else if (this.isInterface(symbol)) {
		// 	result = new InterfaceSymbolItem(key, context, symbol);
		// } else if (this.isTypeLiteral(symbol)) {
		// 	result = new TypeLiteralSymbolItem(key, context, symbol);
		// } else if (this.isMethodSymbol(symbol)) {
		// 	result = new MethodSymbolItem(key, context, symbol);
		// } else if (this.isFunction(symbol)) {
		// 	result = new FunctionSymbolItem(key, context, symbol);
		// } else if (this.isAliasSymbol(symbol)) {
		// 	let aliased = context.typeChecker.getAliasedSymbol(symbol);
		// 	if (aliased !== undefined) {
		// 		let aliasedSymbolItem = this.get(context, aliased);
		// 		if (aliasedSymbolItem !== undefined) {
		// 			result = new AliasSymbolItem(key, context, symbol, aliasedSymbolItem);
		// 		}
		// 	}
		// }
		// if (result === undefined) {
		// 	result = new GenericSymbolItem(key, context, symbol);
		// }
	}

	public visitProgram(): ProjectInfo {
		// Make a first pass to collect all know external libray imports
		for (let sourceFile of this.program.getSourceFiles()) {
			let resolvedModules = tss.getResolvedModules(sourceFile);
			if (resolvedModules !== undefined) {
				resolvedModules.forEach((resolvedModule) => {
					if (resolvedModule === undefined) {
						return;
					}
					if (resolvedModule.isExternalLibraryImport === true) {
						if (!this.externalLibraryImports.has(resolvedModule.resolvedFileName)) {
							this.externalLibraryImports.set(resolvedModule.resolvedFileName, resolvedModule);
						}
					}
				});
			}
		}

		for (let sourceFile of this.program.getSourceFiles()) {
			// let start = Date.now();
			this.visit(sourceFile);
			// let end = Date.now();
			// console.log(`Processing ${sourceFile.fileName} took ${end-start} ms`);
		}
		return {
			rootDir: this.rootDir!,
			outDir: this.outDir!
		};
	}

	public endVisitProgram(): void {
		this.dataManager.projectDone();
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
			case ts.SyntaxKind.Identifier:
				let identifier = node as ts.Identifier;
				this.visitIdentifier(identifier);
				break;
			default:
				node.forEachChild(child => this.visit(child));
		}
	}

	private doVisit<T extends ts.Node>(visit: (node: T) => boolean, endVisit: (node: T) => void, node: T): void {
		if (visit.call(this, node)) {
			node.forEachChild(child => this.visit(child));
		}
		endVisit.call(this, node);
		this.dataManager.nodeProcessed(node);
	}

	private visitSourceFile(sourceFile: ts.SourceFile): boolean {
		if (this.isFullContentIgnored(sourceFile)) {
			return false;
		}
		// process.stderr.write('.');

		this.currentSourceFile = sourceFile;
		let documentData = this.getOrCreateDocumentData(sourceFile);
		this._currentDocumentData = documentData;
		this.symbolContainer.push({ id: documentData.document.id, children: [] });
		this.recordDocumentSymbol.push(true);

		// Exported Symbols
		let symbol = this.program.getTypeChecker().getSymbolAtLocation(sourceFile);
		let symbols: Set<ts.Symbol> = new Set();
		if (symbol !== undefined) {
			this.collectExportedSymbols(symbols, symbol);
		}
		this._currentExports = symbols;

		return true;
	}

	private collectExportedSymbols(symbols: Set<ts.Symbol>, symbol: ts.Symbol): void {
		symbols.add(symbol);
		if (symbol.exports !== undefined && symbol.exports.size > 0) {
			symbol.exports.forEach(item => this.collectExportedSymbols(symbols, item));
		}
	}

	private endVisitSourceFile(sourceFile: ts.SourceFile): void {
		if (this.isFullContentIgnored(sourceFile)) {
			return;
		}

		// emit partial result if present
		let key = URI.file(sourceFile.fileName).toString(true);
		let resultPartitions = this.resultPartitions.get(key);
		if (resultPartitions !== undefined) {
			this.resultPartitions.delete(key);
			for (let partition of resultPartitions.values()) {
				partition.end();
			}
		}

		let path = tss.computeMonikerPath(this.projectRoot, tss.toOutLocation(sourceFile.fileName, this.rootDir!, this.outDir!));

		// Exported symbols.
		let symbol = this.program.getTypeChecker().getSymbolAtLocation(sourceFile);
		if (symbol !== undefined) {
			if (symbol.exports !== undefined && symbol.exports.size > 0) {
				symbol.exports.forEach(item => this.emitExportMonikers(path, undefined, item));
			}
		}
		this._currentExports = undefined;

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
		let spans = this.languageService.getOutliningSpans(sourceFile.fileName);
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
		this.dataManager.documentDone(sourceFile.fileName);
		if (this.symbolContainer.length !== 0) {
			throw new Error(`Unbalanced begin / end calls`);
		}
	}

	private emitExportMonikers(path: string | undefined, prefix: string | undefined, symbol: ts.Symbol): void  {
		const name  = symbol.getName();
		let symbolItem = this.getSymbolInfo(symbol);
		if (symbolItem !== undefined) {
			let symbolData = this.dataManager.getSymbolData(symbolItem)!;
			symbolData.addMoniker(path, prefix, name);
		}
		if (symbol.exports !== undefined && symbol.exports.size > 0) {
			symbol.exports.forEach(item => this.emitExportMonikers(path, name, item));
		}
		if (symbol.members !== undefined && symbol.members.size > 0) {
			symbol.members.forEach(item => {
				if (!SymbolItem.isPrivate(item)) {
					this.emitExportMonikers(path, name, item);
				}
			});
		}
	}

	public isFullContentIgnored(sourceFile: ts.SourceFile): boolean {
		if (sourceFile.isDeclarationFile) {
			return true;
		}
		let fileName = sourceFile.fileName;
		if (path.basename(fileName) === 'index.js') {
			return false;
		}
		if (path.extname(fileName) !== '.js') {
			return false;
		}
		let dirName: string;
		let parent: string = path.dirname(fileName);
		do {
			dirName = parent;
			if (path.basename(dirName) === 'node_modules') {
				return true;
			}
			parent = path.dirname(dirName);
		} while (parent !== dirName)
		return false;
	}

	public isExported(symbol: ts.Symbol): boolean {
		if (this._currentExports === undefined) {
			return false;
		}
		return this._currentExports.has(symbol);
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
		let symbolInfo = this.getSymbolInfo(symbol);
		if (symbolInfo === undefined) {
			return false;
		}
		let declaration = symbolInfo.getDeclaration(rangeNode);
		if (declaration === undefined) {
			return false;
		}
		let currentContainer = this.symbolContainer[this.symbolContainer.length - 1];
		let child: RangeBasedDocumentSymbol = { id: declaration.id };
		if (currentContainer.children === undefined) {
			currentContainer.children = [ child ];
		} else {
			currentContainer.children.push(child);
		}
		this.symbolContainer.push(child);
		return true;
	}

	private visitIdentifier(node: ts.Identifier): void {
		let symbol = this.program.getTypeChecker().getSymbolAtLocation(node);
		let declarations = symbol !== undefined ? symbol.getDeclarations() : undefined;
		if (symbol === undefined || declarations === undefined || declarations.length === 0) {
			return;
		}
		let symbolInfo = this.getSymbolInfo(symbol);
		if (symbolInfo === undefined) {
			return;
		}
		if (symbolInfo.hasDeclaration(node)) {
			return;
		}

		let sourceFile = this.currentSourceFile!;
		let reference = this.vertex.range(Converter.rangeFromNode(sourceFile, node), { type: RangeTagTypes.reference, text: node.getText() });
		this.currentDocumentData.addRange(reference);
		let symbolData = this.dataManager.getOrCreateSymbolData(symbolInfo, node);
		symbolData.getOrCreatePartition(sourceFile).addReference(reference, ItemEdgeProperties.references);
	}

	public getDefinitionAtPosition(sourceFile: ts.SourceFile, node: ts.Identifier): ReadonlyArray<ts.DefinitionInfo> | undefined {
		return this.languageService.getDefinitionAtPosition(sourceFile.fileName, node.getStart(sourceFile));
	}

	public getTypeDefinitionAtPosition(sourceFile: ts.SourceFile, node: ts.Identifier): ReadonlyArray<ts.DefinitionInfo> | undefined {
		return this.languageService.getTypeDefinitionAtPosition(sourceFile.fileName, node.getStart(sourceFile));
	}

	public getOrCreateDocumentData(sourceFile: ts.SourceFile): DocumentData {
		const computeMonikerPath = (sourceFile: ts.SourceFile): string | undefined => {
			if (!sourceFile.isDeclarationFile) {
				return undefined;
			}
			let fileName = sourceFile.fileName;
			for (let outDir of this.dependentOutDirs) {
				if (fileName.startsWith(outDir)) {
					return tss.computeMonikerPath(this.projectRoot, sourceFile.fileName);
				}
			}
			return undefined;
		}

		let result = this.dataManager.getDocumentData(sourceFile.fileName);
		if (result !== undefined) {
			return result;
		}

		let document = this.vertex.document(sourceFile.fileName, sourceFile.text)

		let resolvedModule = this.externalLibraryImports.get(sourceFile.fileName);
		let monikerPath: string | undefined;
		let packageInfo: PackageInformation | undefined;
		if (resolvedModule !== undefined) {
			if (resolvedModule.packageId !== undefined) {
				let packageId = resolvedModule.packageId;
				let key: string = JSON.stringify([packageId.name, 'npm', packageId.version]);
				packageInfo = this.packageInfos.get(key);
				if (packageInfo === undefined) {
					packageInfo = this.vertex.packageInformation(packageId.name, 'npm');
					packageInfo.version = packageId.version;
					let modulePart = `node_modules/${packageId.name}`;
					let index = sourceFile.fileName.lastIndexOf(modulePart);
					if (index !== -1) {
						let packageFile = path.join(sourceFile.fileName.substring(0, index + modulePart.length), 'package.json');
						if (fs.existsSync(packageFile)) {
							packageInfo.uri = URI.file(packageFile).toString(true);
						}
					}
					this.emit(packageInfo);
					this.packageInfos.set(key, packageInfo);
				}
			}
			monikerPath = tss.computeMonikerPath(this.projectRoot, sourceFile.fileName);
		} else {
			monikerPath = computeMonikerPath(sourceFile);
		}

		result = this.dataManager.getOrCreateDocumentData(sourceFile.fileName, document, packageInfo, MonikerKind.import, monikerPath);
		return result;
	}

	public _getOrCreateSymbolData(symbol: ts.Symbol): SymbolData {
		let id: SymbolId = tss.createSymbolKey(this.typeChecker, symbol);
		let result = this.dataManager.getSymbolData(id);
		if (result !== undefined) {
			return result;
		}
		let hover: boolean = false;
		let declarations: ts.Declaration[] = symbol.declarations;
		const monikerName = tss.computeMoniker(declarations);
		let monikers: { definition: DefinitionRange; identifier: string; kind: MonikerKind, packageInfo: PackageInformation | undefined }[] = [];
		for (let declaration of declarations) {
			let sourceFile = declaration.getSourceFile();
			let [identifierNode, identifierText] = this.getIdentifierInformation(sourceFile, symbol, declaration);
			if (identifierNode !== undefined && identifierText !== undefined) {
				let documentData = this.getOrCreateDocumentData(sourceFile);
				let definition = this.vertex.range(Converter.rangeFromNode(sourceFile, identifierNode), {
					type: RangeTagTypes.definition,
					text: identifierText,
					kind: Converter.asSymbolKind(declaration),
					fullRange: Converter.rangeFromNode(sourceFile, declaration),
				});
				documentData.addRange(definition);
				let resolver = this.getResolver(symbol);
				let scope =  this.resolveEmittingNode(symbol);

				let symbolData = this.getOrCreateSymbolData(id, () => resolver.resolve(symbol, scope));
				symbolData.addDefinition(sourceFile, definition);
				if (monikerName !== undefined && documentData.monikerPath !== undefined && documentData.monikerKind !== undefined) {
					const mi = tss.createMonikerIdentifier(documentData.monikerPath, monikerName);
					monikers.push({ definition, identifier: mi, kind: documentData.monikerKind, packageInfo: documentData.packageInfo });
				}
				this.storeDefinitionAndRange(definition, rangeNode);
				if (!hover && tss.isNamedDeclaration(declaration)) {
					hover = this.handleHover(sourceFile, declaration.name, symbolData);
				}
			} else {
				// We should log this somewhere to improve the tool.
			}
		}
		if (monikers.length > 0) {
			let last: typeof monikers[0] | undefined;
			let same = true;
			for (let item of monikers) {
				if (last === undefined) {
					last = item;
				} else {
					if (last.identifier !== item.identifier || last.kind !== item.kind || last.packageInfo !== item.packageInfo) {
						same = false;
						break;
					}
				}
			}
			if (same) {
				const item = monikers[0];
				const moniker = this.vertex.moniker(item.kind, 'tsc', item.identifier);
				this.emit(moniker);
				if (item.packageInfo) {
					this.emit(this.edge.packageInformation(moniker, item.packageInfo));
				}
				this.emit(this.edge.moniker(this.resultSet, moniker));
			} else {
				for (let item of monikers) {
					const moniker = this.vertex.moniker(item.kind, 'tsc', item.identifier);
					this.emit(moniker);
					if (item.packageInfo) {
						this.emit(this.edge.packageInformation(moniker, item.packageInfo));
					}
					this.emit(this.edge.moniker(item.definition, moniker));
				}
			}
		}
		// if (SymbolItem.isBlockScopedVariable(this.tsSymbol) && declarations.length === 1) {
		// 	let type = this.context.typeChecker.getTypeOfSymbolAtLocation(this.tsSymbol, declarations[0]);
		// 	if (type.symbol) {
		// 		let typeSymbol = SymbolItem.get(this.context, type.symbol);
		// 		let result: TypeDefinitionResult | undefined;
		// 		if (Array.isArray(typeSymbol.declarations)) {
		// 			result = this.context.vertex.typeDefinitionResult(typeSymbol.declarations.map(declaration => declaration.id));
		// 		} else if (typeSymbol.declarations !== undefined) {
		// 			result = this.context.vertex.typeDefinitionResult([typeSymbol.declarations.id]);
		// 		}
		// 		if (result !== undefined) {
		// 			this.context.emit(result);
		// 			this.context.emit(this.context.edge.typeDefinition(this.resultSet, result));
		// 		}
		// 	}
		// }
		return result;
	}

	private getIdentifierInformation(sourceFile: ts.SourceFile, symbol: ts.Symbol, declaration: ts.Declaration): [ts.Node, string] | [undefined, undefined] {
		if (tss.isNamedDeclaration(declaration)) {
			let name = declaration.name;
			return [name, name.getText()];
		}
		if (tss.isValueModule(symbol) && ts.isSourceFile(declaration)) {
			return [declaration, ''];
		}
		return [undefined, undefined];
	}

	private resolveEmittingNode(symbol: ts.Symbol): ts.Node | undefined {
		// The symbol is exported So we can't optimize any emitting.
		if (this.isExported(symbol)) {
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

	private getResolver(symbol: ts.Symbol): SymbolDataResolver {
		if (tss.isAliasSymbol(symbol)) {
			return this.symbolDataResolvers.get(ts.SymbolFlags.Alias)!;
		}
		return this.symbolDataResolvers.get(0)!;
		// if (this.isClass(symbol)) {
		// 	result = new ClassSymbolItem(key, context, symbol);
		// } else if (this.isInterface(symbol)) {
		// 	result = new InterfaceSymbolItem(key, context, symbol);
		// } else if (this.isTypeLiteral(symbol)) {
		// 	result = new TypeLiteralSymbolItem(key, context, symbol);
		// } else if (this.isMethodSymbol(symbol)) {
		// 	result = new MethodSymbolItem(key, context, symbol);
		// } else if (this.isFunction(symbol)) {
		// 	result = new FunctionSymbolItem(key, context, symbol);
		// } else if (this.isAliasSymbol(symbol)) {
		// 	let aliased = context.typeChecker.getAliasedSymbol(symbol);
		// 	if (aliased !== undefined) {
		// 		let aliasedSymbolItem = this.get(context, aliased);
		// 		if (aliasedSymbolItem !== undefined) {
		// 			result = new AliasSymbolItem(key, context, symbol, aliasedSymbolItem);
		// 		}
		// 	}
		// }
		// if (result === undefined) {
		// 	result = new GenericSymbolItem(key, context, symbol);
		// }
	}

	public getHover(node: ts.DeclarationName, sourceFile?: ts.SourceFile): lsp.Hover | undefined {
		if (sourceFile === undefined) {
			sourceFile = node.getSourceFile();
		}
		let quickInfo = this.languageService.getQuickInfoAtPosition(sourceFile.fileName, node.getStart());
		if (quickInfo === undefined) {
			return undefined;
		}
		return Converter.asHover(sourceFile, quickInfo);
	}

	private get program(): ts.Program {
		return this.languageService.getProgram()!;
	}

	public get vertex(): VertexBuilder {
		return this.builder.vertex;
	}

	public get edge(): EdgeBuilder {
		return this.builder.edge;
	}

	public get typeChecker(): ts.TypeChecker {
		return this.languageService.getProgram()!.getTypeChecker();
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

	private getSymbolInfo(tsSymbol: ts.Symbol): SymbolItem | undefined {
		return SymbolItem.get(this, tsSymbol);
	}
}


export function lsif(languageService: ts.LanguageService, options: Options, dependsOn: ProjectInfo[], emitter: Emitter, idGenerator: () => Id, tsConfigFile: string | undefined): ProjectInfo {
	let visitor = new Visitor(languageService, options, dependsOn, emitter, idGenerator, tsConfigFile);
	let result = visitor.visitProgram();
	visitor.endVisitProgram();
	return result;
}
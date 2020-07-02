/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import * as crypto from 'crypto';

import * as ts from 'typescript';

import * as Is from './utils/is';

export type Declaration = ts.ModuleDeclaration | ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeParameterDeclaration | ts.FunctionDeclaration | ts.MethodDeclaration |
	ts.MethodSignature | ts.ParameterDeclaration;

export function isNamedDeclaration(node: ts.Node): node is (ts.NamedDeclaration  & { name: ts.DeclarationName }) {
	let candidate = node as ts.NamedDeclaration;
	return candidate !== undefined && candidate.name !== undefined;
}

export function isNode(value: any): value is ts.Node {
	let candidate: ts.Node = value;
	return candidate !== undefined && Is.number(candidate.flags) && Is.number(candidate.kind);
}

export function getDefaultCompilerOptions(configFileName?: string) {
	const options: ts.CompilerOptions = configFileName && path.basename(configFileName) === 'jsconfig.json'
		? { allowJs: true, maxNodeModuleJsDepth: 2, allowSyntheticDefaultImports: true, skipLibCheck: true, noEmit: true }
		: {};
	return options;
}

const isWindows = process.platform === 'win32';
export function normalizePath(value: string): string {
	if (isWindows) {
		value = value.replace(/\\/g, '/');
		if (/^[a-z]:/.test(value)) {
			value = value.charAt(0).toUpperCase() + value.substring(1);
		}
	}
	let result = path.posix.normalize(value);
	return result.length > 0 && result.charAt(result.length - 1) === '/' ? result.substr(0, result.length - 1) : result;
}

export function makeAbsolute(p: string, root?: string): string {
	if (path.isAbsolute(p)) {
		return normalizePath(p);
	}
	if (root === undefined) {
		return normalizePath(path.join(process.cwd(), p));
	} else {
		return normalizePath(path.join(root, p));
	}
}

export function toOutLocation(path: string, rootDir: string, outDir: string): string {
	if (!path.startsWith(rootDir)) {
		return path;
	}
	return `${outDir}${path.substr(rootDir.length)}`;
}

export function computeMonikerPath(from: string, to: string): string {
	let result = path.posix.relative(from, to);
	if (result.endsWith('.d.ts')) {
		return result.substring(0, result.length - 5);
	} else if (result.endsWith('.ts') || result.endsWith('.js')) {
		return result.substring(0, result.length - 3);
	} else {
		return result;
	}
}

export function createMonikerIdentifier(path: string, symbol: string | undefined): string;
export function createMonikerIdentifier(path: string | undefined, symbol: string): string;
export function createMonikerIdentifier(path: string | undefined, symbol: string | undefined): string {
	if (path === undefined) {
		if (symbol === undefined || symbol.length === 0) {
			throw new Error(`Either path or symbol must be provided.`);
		}
		return `:${symbol}`;
	}
	if (symbol === undefined || symbol.length === 0) {
		return `${path.replace(/\:/g, '::')}:`;
	}
	return `${path.replace(/\:/g, '::')}:${symbol}`;
}


export function makeRelative(from: string, to: string): string {
	return path.posix.relative(from, to);
}

// Copies or interface which are internal
function isString(text: unknown): text is string {
	return typeof text === 'string';
}

export function flattenDiagnosticMessageText(diag: string | ts.DiagnosticMessageChain | undefined, newLine: string, indent = 0): string {
	if (isString(diag)) {
		return diag;
	}
	else if (diag === undefined) {
		return '';
	}
	let result = '';
	if (indent) {
		result += newLine;

		for (let i = 0; i < indent; i++) {
			result += '  ';
		}
	}
	result += diag.messageText;
	indent++;
	if (diag.next) {
		for (const kid of diag.next) {
			result += flattenDiagnosticMessageText(kid, newLine, indent);
		}
	}
	return result;
}

interface InternalSymbol extends ts.Symbol {
	parent?: ts.Symbol;
	containingType?: ts.UnionOrIntersectionType;
	__symbol__data__key__: string | undefined;
}

export function getSymbolParent(symbol: ts.Symbol): ts.Symbol | undefined {
	return (symbol as InternalSymbol).parent;
}

interface InternalNode extends ts.Node {
	symbol?: ts.Symbol;
}

export function getSymbolFromNode(node: ts.Node): ts.Symbol | undefined {
	return (node as InternalNode).symbol;
}

interface InternalSourceFile extends ts.SourceFile {
	resolvedModules?: ts.Map<ts.ResolvedModuleFull | undefined>;
}

export function getResolvedModules(sourceFile: ts.SourceFile): ts.Map<ts.ResolvedModuleFull | undefined> | undefined {
	return (sourceFile as InternalSourceFile).resolvedModules;
}

const Unknown = 'unkown';
const Undefined = 'undefined';
const None = 'none';
export function createSymbolKey(typeChecker: ts.TypeChecker, symbol: ts.Symbol): string {
	let result: string | undefined = (symbol as InternalSymbol).__symbol__data__key__;
	if (result !== undefined) {
		return result;
	}
	let declarations = symbol.getDeclarations();
	if (declarations === undefined) {
		if (typeChecker.isUnknownSymbol(symbol)) {
			return Unknown;
		} else if (typeChecker.isUndefinedSymbol(symbol)) {
			return Undefined;
		} else {
			return None;
		}
	}
	let fragments: { f: string; s: number; e: number}[] = [];
	for (let declaration of declarations) {
		fragments.push({
			f: declaration.getSourceFile().fileName,
			s: declaration.getStart(),
			e: declaration.getEnd()
		});
	}
	let hash = crypto.createHash('md5');
	hash.update(JSON.stringify(fragments, undefined, 0));
	result = hash.digest('base64');
	(symbol as InternalSymbol).__symbol__data__key__ = result;
	return result;
}

export interface DefinitionInfo {
	file: string;
	start: number;
	end: number
}

export namespace DefinitionInfo {
	export function equals(a: DefinitionInfo, b: DefinitionInfo): boolean {
		return a.file === b.file && a.start === b.start && a.end === b.end;
	}
}

export function createDefinitionInfo(sourceFile: ts.SourceFile, node: ts.Node): DefinitionInfo {
	return {
		file: sourceFile.fileName,
		start: node.getStart(),
		end: node.getEnd()
	};
}

export function isSourceFile(symbol: ts.Symbol): boolean  {
	let declarations = symbol.getDeclarations();
	return declarations !== undefined && declarations.length === 1 && ts.isSourceFile(declarations[0]);
}

export function isFunction(symbol: ts.Symbol): boolean {
	return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Function) !== 0;
}

export function isClass(symbol: ts.Symbol): boolean {
	return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Class) !== 0;
}

export function isInterface(symbol: ts.Symbol): boolean {
	return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Interface) !== 0;
}

export function isTypeLiteral(symbol: ts.Symbol): boolean {
	return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.TypeLiteral) !== 0;
}

export function isMethodSymbol(symbol: ts.Symbol): boolean {
	return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Method) !== 0;
}

export function isAliasSymbol(symbol: ts.Symbol): boolean  {
	return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Alias) !== 0;
}

export function isValueModule(symbol: ts.Symbol): boolean {
	return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.ValueModule) !== 0;
}

export function isTypeParameter(symbol: ts.Symbol): boolean {
	return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.TypeParameter) !== 0;
}

export function isBlockScopedVariable(symbol: ts.Symbol): boolean {
	return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.BlockScopedVariable) !== 0;
}

export function isTransient(symbol: ts.Symbol): boolean {
	return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.Transient) !== 0;
}

export function isTypeAlias(symbol: ts.Symbol): boolean {
	return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.TypeAlias) !== 0;
}

export function isComposite(typeChecker: ts.TypeChecker, symbol: ts.Symbol): boolean {
	const containingType = (symbol as InternalSymbol).containingType;
	if (containingType !== undefined && containingType.isUnionOrIntersection()) {
		return true;
	}

	const type = typeChecker.getDeclaredTypeOfSymbol(symbol);
	if (type.isUnionOrIntersection()) {
		return true;
	}

	return false;
}

export function getCompositeLeafSymbols(typeChecker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol[] | undefined {

	function _getCompositeLeafSymbols(result: Map<string, ts.Symbol>, processed: Set<String>, typeChecker: ts.TypeChecker, symbol: ts.Symbol): void {
		const symbolKey = createSymbolKey(typeChecker, symbol);
		if (processed.has(symbolKey)) {
			return;
		}
		processed.add(symbolKey);
		const containingType = (symbol as InternalSymbol).containingType;
		if (containingType !== undefined) {
			for (let typeElem of containingType.types) {
				const symbolElem = typeElem.getProperty(symbol.getName());
				if (symbolElem !== undefined) {
					_getCompositeLeafSymbols(result, processed, typeChecker, symbolElem);
				}
			}
		} else {
			// We have something like x: { prop: number} | { prop: string };
			const type = typeChecker.getDeclaredTypeOfSymbol(symbol);
			// we have something like x: A | B;
			if (type.isUnionOrIntersection()) {
				for (let typeElem of type.types) {
					const symbolElem = typeElem.symbol;
					// This happens for base types like undefined, number, ....
					if (symbolElem !== undefined) {
						_getCompositeLeafSymbols(result, processed, typeChecker, symbolElem);
					}
				}
			} else {
				result.set(symbolKey, symbol);
			}
		}
	}

	const result: Map<string, ts.Symbol> = new Map();
	_getCompositeLeafSymbols(result, new Set(), typeChecker, symbol);
	if (result.size === 0) {
		return undefined;
	}
	return Array.from(result.values());
}

export function isPrivate(symbol: ts.Symbol): boolean {
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

export function isStatic(symbol: ts.Symbol): boolean {
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

export function getUniqueSourceFiles(declarations: ts.Declaration[] | undefined): Set<ts.SourceFile> {
	let result: Set<ts.SourceFile> = new Set();
	if (declarations === undefined || declarations.length === 0) {
		return result;
	}
	for (let declaration of declarations) {
		result.add(declaration.getSourceFile());
	}
	return result;
}

const stopKinds: Set<number> = new Set([ts.SyntaxKind.Block, ts.SyntaxKind.ClassExpression, ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.ArrowFunction]);
function doComputeMoniker(node: ts.Node): string | undefined {
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
		if (stopKinds.has(node.kind)) {
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
	} while ((node = node.parent) !== undefined && !ts.isSourceFile(node));
	return buffer.join('.');
}

export function computeMoniker(nodes: ts.Node[] | undefined): string | undefined {
	if (nodes === undefined || nodes.length === 0) {
		return undefined;
	}
	if (nodes.length === 1) {
		return doComputeMoniker(nodes[0]);
	}
	let result: string | undefined = doComputeMoniker(nodes[0]);
	if (result === undefined) {
		return undefined;
	}
	for (let i = 1; i < nodes.length; i++) {
		if (result !== doComputeMoniker(nodes[i])) {
			return undefined;
		}
	}
	return result;
}

export const EmitBoundaries: Set<number> = new Set<number>([
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

interface InternalProgram extends ts.Program {
	getCommonSourceDirectory(): string;
	isSourceFileFromExternalLibrary(sourceFile: ts.SourceFile): boolean;
	isSourceFileDefaultLibrary(sourceFile: ts.SourceFile): boolean;
}

export namespace Program {
	export function getCommonSourceDirectory(program: ts.Program): string {
		let interal: InternalProgram = program as InternalProgram;
		if (typeof interal.getCommonSourceDirectory !== 'function') {
			throw new Error(`Program is missing getCommonSourceDirectory`);
		}
		return interal.getCommonSourceDirectory();
	}

	export function isSourceFileFromExternalLibrary(program: ts.Program, sourceFile: ts.SourceFile): boolean {
		let interal: InternalProgram = program as InternalProgram;
		if (typeof interal.isSourceFileFromExternalLibrary !== 'function') {
			throw new Error(`Program is missing isSourceFileFromExternalLibrary`);
		}
		return interal.isSourceFileFromExternalLibrary(sourceFile);
	}

	export function isSourceFileDefaultLibrary(program: ts.Program, sourceFile: ts.SourceFile): boolean {
		let interal: InternalProgram = program as InternalProgram;
		if (typeof interal.isSourceFileFromExternalLibrary !== 'function') {
			throw new Error(`Program is missing isSourceFileDefaultLibrary`);
		}
		return interal.isSourceFileDefaultLibrary(sourceFile);
	}
}

interface InternalCompilerOptions extends ts.CompilerOptions {
	configFilePath?: string;
}

export namespace CompileOptions {
	export function getConfigFilePath(options: ts.CompilerOptions): string | undefined {
		if (options.project) {
			const projectPath = path.resolve(options.project);
			if (ts.sys.directoryExists(projectPath)) {
				return path.join(projectPath, 'tsconfig.json');
			} else {
				return projectPath;
			}
		}
		return (options as InternalCompilerOptions).configFilePath;
	}
}
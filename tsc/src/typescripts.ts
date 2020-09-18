/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import * as crypto from 'crypto';

import * as ts from 'typescript';

import * as Is from './utils/is';

export namespace Node {
	export type Declaration = ts.ModuleDeclaration | ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeParameterDeclaration | ts.FunctionDeclaration | ts.MethodDeclaration |
		ts.MethodSignature | ts.ParameterDeclaration | ts.PropertyDeclaration | ts.PropertySignature;

	export function isNamedDeclaration(node: ts.Node): node is (ts.NamedDeclaration  & { name: ts.DeclarationName }) {
		let candidate = node as ts.NamedDeclaration;
		return candidate !== undefined && candidate.name !== undefined;
	}

	export function isNode(value: any): value is ts.Node {
		let candidate: ts.Node = value;
		return candidate !== undefined && Is.number(candidate.flags) && Is.number(candidate.kind);
	}
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

export namespace Symbol {

	const Unknown = 'unkown';
	const Undefined = 'undefined';
	const None = 'none';

	export function createKey(typeChecker: ts.TypeChecker, symbol: ts.Symbol): string {
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
		let fragments: { f: string; s: number; e: number; k: number }[] = [];
		for (let declaration of declarations) {
			fragments.push({
				f: declaration.getSourceFile().fileName,
				s: declaration.getStart(),
				e: declaration.getEnd(),
				k: declaration.kind
			});
		}
		if (fragments.length > 1) {
			fragments.sort((a, b) => {
				let result = a.f < b.f ? -1 : (a.f > b.f ? 1 : 0);
				if (result !== 0) {
					return result;
				}
				result = a.s - b.s;
				if (result !== 0) {
					return result;
				}
				result = a.e - b.e;
				if (result !== 0) {
					return result;
				}
				return a.k - b.k;
			});
		}
		let hash = crypto.createHash('md5');
		if ((symbol.flags & ts.SymbolFlags.Transient) !== 0) {
			hash.update(JSON.stringify({ trans: true }, undefined, 0));
		}
		hash.update(JSON.stringify(fragments, undefined, 0));
		result = hash.digest('base64');
		(symbol as InternalSymbol).__symbol__data__key__ = result;
		return result;
	}

	export function getParent(symbol: ts.Symbol): ts.Symbol | undefined {
		return (symbol as InternalSymbol).parent;
	}

	export function is(value: ts.Symbol | ts.Type): value is ts.Symbol {
		let symbolCount: number = 0;
		const candidate = value as ts.Symbol;
		if (candidate.declarations !== undefined) {
			symbolCount++;
		}
		if (candidate.valueDeclaration !== undefined) {
			symbolCount++;
		}
		let typeCount: number = 0;
		const typeCandidate = value as ts.Type;
		if (typeCandidate.symbol !== undefined) {
			typeCount++;
		}
		if (symbolCount > 0 && typeCount > 0) {
			throw new Error(`Can't decide if value is symbol or type`);
		}
		return symbolCount > 0;
	}
}

export namespace Type {
	export function isCallSignature(type: ts.Type): boolean {
		const signatures = type.getCallSignatures();
		return signatures.length > 0;
	}

	export function isObjectType(type: ts.Type): type is ts.ObjectType {
		return (type.flags & ts.TypeFlags.Object) !== 0;
	}

	export function isTypeReference(type: ts.ObjectType): type is ts.TypeReference {
		return (type.objectFlags & ts.ObjectFlags.Reference) !== 0;
	}

	export function isConditionalType(type: ts.Type): type is ts.ConditionalType {
		return (type.flags & ts.TypeFlags.Conditional) !== 0;
	}

	export function isClassOrInterface(type: ts.Type): boolean {
		const symbol = type.getSymbol();
		if (symbol !== undefined) {
			return (symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class)) !== 0;
		}
		return type.isClassOrInterface();
	}

	export function isClass(type: ts.Type): boolean {
		const symbol = type.getSymbol();
		if (symbol !== undefined) {
			return (symbol.flags & ts.SymbolFlags.Class) !== 0;
		}
		return type.isClass();
	}

	export function isInterface(type: ts.Type): boolean {
		const symbol = type.getSymbol();
		if (symbol !== undefined) {
			return (symbol.flags & ts.SymbolFlags.Interface) !== 0;
		}
		return type.isClassOrInterface() && !type.isClass();
	}
}


interface InternalNode extends ts.Node {
	symbol?: ts.Symbol;
}

export namespace Node {
	export function getSymbol(node: ts.Node): ts.Symbol | undefined {
		return (node as InternalNode).symbol;
	}
}


interface InternalSourceFile extends ts.SourceFile {
	resolvedModules?: ts.Map<ts.ResolvedModuleFull | undefined>;
}

export namespace SourceFile {
	export function getResolvedModules(sourceFile: ts.SourceFile): ts.Map<ts.ResolvedModuleFull | undefined> | undefined {
		return (sourceFile as InternalSourceFile).resolvedModules;
	}
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
		const symbolKey = Symbol.createKey(typeChecker, symbol);
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
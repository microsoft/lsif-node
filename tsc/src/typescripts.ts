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

export function isNamedDeclaration(node: ts.Declaration): node is (ts.NamedDeclaration  & { name: ts.DeclarationName }) {
	let candidate = node as ts.NamedDeclaration;
	return candidate !== undefined && candidate.name !== undefined;
}

export function isNode(value: any): value is ts.Node {
	let candidate: ts.Node = value;
	return candidate !== undefined && Is.number(candidate.flags) && Is.number(candidate.kind);
}

export function getDefaultCompilerOptions(configFileName?: string) {
	const options: ts.CompilerOptions = configFileName && path.basename(configFileName) === "jsconfig.json"
		? { allowJs: true, maxNodeModuleJsDepth: 2, allowSyntheticDefaultImports: true, skipLibCheck: true, noEmit: true }
		: {};
	return options;
}

const isWindows = process.platform === 'win32';
export function normalizePath(value: string): string {
	return path.posix.normalize(isWindows ? value.replace(/\\/g, '/') : value);
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

export function createMonikerIdentifier(path: string | undefined, symbol: string): string {
	if (path === undefined) {
		return symbol;
	}
	return `${path.replace(/\:/g, '::')}:${symbol}`;
}


export function makeRelative(from: string, to: string): string {
	return path.posix.relative(from, to);
}

// Copies or interface which are internal

export function flattenDiagnosticMessageText(messageText: string | ts.DiagnosticMessageChain | undefined, newLine: string): string {
	if (Is.string(messageText)) {
		return messageText;
	} else {
		let diagnosticChain = messageText;
		let result = '';

		let indent = 0;
		while (diagnosticChain) {
			if (indent) {
				result += newLine;

				for (let i = 0; i < indent; i++) {
					result += '  ';
				}
			}
			result += diagnosticChain.messageText;
			indent++;
			diagnosticChain = diagnosticChain.next;
		}
		return result;
	}
}

interface InternalSymbol extends ts.Symbol {
	parent?: ts.Symbol;
	__symbol__data__key__: string | undefined;
}

export function getSymbolParent(symbol: ts.Symbol): ts.Symbol | undefined {
	return (symbol as InternalSymbol).parent;
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
	let declarations = symbol.getDeclarations()
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
		})
	};
	let hash = crypto.createHash('md5');
	hash.write(JSON.stringify(fragments, undefined, 0));
	result = hash.digest('base64');
	(symbol as InternalSymbol).__symbol__data__key__ = result;
	return result;
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

export function isBlockScopedVariable(symbol: ts.Symbol): boolean {
	return symbol !== undefined && (symbol.getFlags() & ts.SymbolFlags.BlockScopedVariable) !== 0;
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
	} while ((node = node.parent) !== undefined && !ts.isSourceFile(node))
	return buffer.join('.');
}

export function computeMoniker(nodes: ts.Node[]): string | undefined {
	if (nodes.length === 0) {
		return undefined;
	}
	if (nodes.length === 1) {
		return doComputeMoniker(nodes[0]);
	}
	let result: Set<string> = new Set<string>();
	for (let node of nodes) {
		let part = doComputeMoniker(node);
		if (part === undefined) {
			return undefined;
		}
		result.add(part);
	}
	return Array.from(result).join('|');
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
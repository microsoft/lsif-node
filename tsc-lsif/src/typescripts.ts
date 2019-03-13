/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';

import * as ts from 'typescript';

import * as Is from './shared/is';

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
function normalizePath(value: string): string {
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
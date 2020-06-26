/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as ts from 'typescript';

export class InMemoryLanguageServiceHost implements ts.LanguageServiceHost {

	private scriptSnapshots: Map<string, ts.IScriptSnapshot>;

	constructor(private cwd: string, private scripts: Map<string, string>, private options: ts.CompilerOptions) {
		this.scriptSnapshots = new Map();
	}

	public getScriptFileNames(): string[] {
		return Array.from(this.scripts.keys());
	}

	public getCompilationSettings(): ts.CompilerOptions {
		return this.options;
	}

	public getScriptVersion(fileName: string): string {
		return '0';
	}

	public getProjectVersion(): string {
		return '0';
	}

	public getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
		let result: ts.IScriptSnapshot | undefined = this.scriptSnapshots.get(fileName);
		if (result === undefined) {
			const content = this.scripts.get(fileName);
			if (content === undefined) {
				return undefined;
			}
			result = ts.ScriptSnapshot.fromString(content);
			this.scriptSnapshots.set(fileName, result);
		}
		return result;
	}

	public getCurrentDirectory(): string {
		return this.cwd;
	}

	public getDefaultLibFileName(options: ts.CompilerOptions): string {
		return ts.getDefaultLibFilePath(options);
	}
}
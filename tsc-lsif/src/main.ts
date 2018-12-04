/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as path from 'path';
import * as uuid from 'uuid';

import * as minimist from 'minimist';

import * as ts from 'typescript';
import * as tss from './typescripts';

import { Id } from './shared/protocol';
import { Emitter, EmitterModule } from './emitters/emitter';
import { lsif } from './lsif';

interface Options {
	outputFormat: 'json' | 'line' | 'vis' | 'graphSON';
	id: 'number' | 'uuid';
	name?: string;
}

export namespace Options {
	export const defaults: Options = {
		outputFormat: 'json',
		id: 'number'
	};
}

function loadConfigFile(file: string): ts.ParsedCommandLine {
	let absolute = path.resolve(file);

	let readResult = ts.readConfigFile(absolute, ts.sys.readFile);
	if (readResult.error) {
		throw new Error(ts.formatDiagnostics([readResult.error], ts.createCompilerHost({})));
	}
	let config = readResult.config;
	if (config.compilerOptions !== undefined) {
		config.compilerOptions = Object.assign(config.compilerOptions, tss.getDefaultCompilerOptions(file));
	}
	let result = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(absolute));
	if (result.errors.length > 0) {
		throw new Error(ts.formatDiagnostics(result.errors, ts.createCompilerHost({})));
	}
	return result;
}

function createEmitter(options: Options, idGenerator: () => Id): Emitter {
	let emitterModule: EmitterModule;
	switch (options.outputFormat) {
		case 'json':
			emitterModule = require('./emitters/json');
			break;
		case 'line':
			emitterModule = require('./emitters/line');
			break;
		case 'vis':
			emitterModule = require('./emitters/vis');
			break;
		case 'graphSON':
			emitterModule = require('./emitters/graphSON');
			break;
		default:
			emitterModule = require('./emitters/json');
	}
	return emitterModule.create(idGenerator);
}

function createIdGenerator(options: Options): () => Id {
	switch (options.id) {
		case 'uuid':
			return () => {
				return uuid.v4();
			};
		default:
			let counter = 1;
			return () => {
				return counter++;
			};
	}
}

function main(this: void, args: string[]) {

	let options: Options = Object.assign(Options.defaults, minimist(process.argv.slice(2), {
		string: [
			'outputFormat', 'id'
		]
	}));

	let config: ts.ParsedCommandLine = ts.parseCommandLine(args);
	let tsconfigFileName: string | undefined;
	if (config.options.project) {
		const projectPath = path.resolve(config.options.project);
		if (ts.sys.directoryExists(projectPath)) {
			tsconfigFileName = path.join(projectPath, 'tsconfig.json');
		} else {
			tsconfigFileName = projectPath;
		}
		if (!ts.sys.fileExists(tsconfigFileName)) {
			console.error(`Project configuration file ${tsconfigFileName} does not exist`);
			process.exitCode = 1;
			return;
		}
		config = loadConfigFile(tsconfigFileName);
	}

	if (config.fileNames.length === 0) {
		console.error(`No input files specified.`);
		process.exitCode = 1;
		return;
	}

	// Bind all symbols

	let host: ts.LanguageServiceHost = {
		getScriptFileNames: () => {
			return config.fileNames;
		},
		getCompilationSettings: () => {
			return config.options;
		},
		getScriptVersion: (fileName: string): string => {
			// The files are immutable.
			return "0";
		},
		// The project is immutable
		getProjectVersion: () => "0",
		getScriptSnapshot: (fileName: string): ts.IScriptSnapshot | undefined => {
			if (!ts.sys.fileExists(fileName)) {
				return undefined;
			}
			let content = ts.sys.readFile(fileName);
			if (content === undefined) {
				return undefined;
			}
			return ts.ScriptSnapshot.fromString(content);
		},
		getCurrentDirectory: () => {
			if (tsconfigFileName !== undefined) {
				return path.dirname(tsconfigFileName);
			} else {
				return process.cwd();
			}
		},
		getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
		directoryExists: ts.sys.directoryExists,
		getDirectories: ts.sys.getDirectories,
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
		readDirectory: ts.sys.readDirectory
	}
	let languageService = ts.createLanguageService(host);
	const program = languageService.getProgram();
	if (program === undefined) {
		console.error('Couldn\'t create langauge service with underlying program.');
		process.exitCode = -1;
		return;
	}
	program.getTypeChecker();

	const idGenerator = createIdGenerator(options);
	lsif(languageService, createEmitter(options, idGenerator), idGenerator, tsconfigFileName);
}

if (require.main === module) {
	main(ts.sys.args);
}
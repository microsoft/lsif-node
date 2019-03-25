/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as path from 'path';
import * as uuid from 'uuid';

import * as minimist from 'minimist';

import * as ts from 'typescript';
import * as tss from './typescripts';

import { Id } from 'lsif-protocol';
import { Emitter, EmitterModule } from './emitters/emitter';
import { lsif, ProjectInfo, Options as VisitorOptions } from './lsif';

interface Options {
	outputFormat: 'json' | 'line' | 'vis' | 'graphSON';
	id: 'number' | 'uuid';
	projectRoot?: string;
	noContent: boolean;
}

export namespace Options {
	export const defaults: Options = {
		outputFormat: 'line',
		id: 'number',
		noContent: false
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

function processProject(config: ts.ParsedCommandLine, options: Options, emitter: Emitter, idGenerator: () => Id): ProjectInfo | undefined {
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
			return undefined;
		}
		config = loadConfigFile(tsconfigFileName);
	}

	if (config.fileNames.length === 0) {
		console.error(`No input files specified.`);
		process.exitCode = 1;
		return undefined;
	}

	if (options.projectRoot === undefined) {
		options.projectRoot = tsconfigFileName !== undefined ? path.dirname(tsconfigFileName) : process.cwd();
	}
	options.projectRoot = tss.normalizePath(options.projectRoot);

	// Bind all symbols

	const host: ts.LanguageServiceHost = {
		getScriptFileNames: () => {
			return config.fileNames;
		},
		getCompilationSettings: () => {
			return config.options;
		},
		getProjectReferences: () => {
			return config.projectReferences;
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
	const languageService = ts.createLanguageService(host);
	const program = languageService.getProgram();
	if (program === undefined) {
		console.error('Couldn\'t create language service with underlying program.');
		process.exitCode = -1;
		return undefined;
	}
	const dependsOn: ProjectInfo[] = [];
	const references = program.getResolvedProjectReferences();
	if (references) {
		for (let reference of references) {
			if (reference) {
				const projectInfo = processProject(reference.commandLine, options, emitter, idGenerator);
				if (projectInfo !== undefined) {
					dependsOn.push(projectInfo);
				}
			}
		}
	}

	program.getTypeChecker();
	return lsif(languageService, options as VisitorOptions, dependsOn, emitter, idGenerator, tsconfigFileName);
}

function main(this: void, args: string[]) {

	const options: Options = Object.assign(Options.defaults, minimist(process.argv.slice(2), {
		string: [
			'outputFormat', 'id', 'projectRoot'
		],
		boolean: [ 'noContent' ]
	}));

	const config: ts.ParsedCommandLine = ts.parseCommandLine(args);
	const idGenerator = createIdGenerator(options);
	const emitter = createEmitter(options, idGenerator);
	let projectRoot = options.projectRoot;
	if (projectRoot !== undefined && !path.isAbsolute(projectRoot)) {
		projectRoot = path.join(process.cwd(), projectRoot);
	}
	emitter.start();
	processProject(config, options, emitter, idGenerator);
	emitter.end();
}

if (require.main === module) {
	main(ts.sys.args);
}
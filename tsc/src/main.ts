/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as path from 'path';
import * as uuid from 'uuid';
import * as fs from 'fs';

import * as minimist from 'minimist';

import * as ts from 'typescript';
import * as tss from './typescripts';

import { Id } from 'lsif-protocol';
import { Emitter, EmitterModule } from './emitters/emitter';
import { TypingsInstaller } from './typings';
import { lsif, ProjectInfo } from './lsif';
import { Writer, StdoutWriter, FileWriter } from './utils/writer';
import { URI } from 'vscode-uri';

interface CommonOptions {
	help: boolean;
	version: boolean;
	outputFormat: 'json' | 'line' | 'vis' | 'graphSON';
	id: 'number' | 'uuid';
	noContents: boolean;
	inferTypings: boolean;
	out: string | undefined;
	stdout: boolean;
}

interface Options extends CommonOptions {
	group: string | undefined;
	projectRoot: string | undefined;
	projectName: string | undefined;
}

interface GroupConfig {
	uri?: string;
	name?: string;
	conflictResolution?: 'takeDump' | 'takeDB';
	description? : string;
	repository?: {
		type: string;
		url: string;
	}
}

interface OptionDescription {
	id: keyof Options;
	type: 'boolean' | 'string';
	alias?: string;
	default: any;
	values?: string[];
	description: string;
}

namespace Options {
	export const defaults: Options = {
		help: false,
		version: false,
		outputFormat: 'line',
		id: 'number',
		group: undefined,
		projectRoot: undefined,
		projectName: undefined,
		noContents: false,
		inferTypings: false,
		out: undefined,
		stdout: false
	};
	export const descriptions: OptionDescription[] = [
		{ id: 'version', type: 'boolean', alias: 'v', default: false, description: 'output the version number'},
		{ id: 'help', type: 'boolean', alias: 'h', default: false, description: 'output usage information'},
		{ id: 'outputFormat', type: 'string', default: 'line', values: ['line', 'json'], description: 'Specifies the output format. Allowed values are: \'line\' and \'json\'.'},
		{ id: 'id', type: 'string', default: 'number', values: ['number', 'uuid'], description: 'Specifies the id format. Allowed values are: \'number\' and \'uuid\'.'},
		{ id: 'group', type: 'string', default: undefined, description: 'Specifies the group config file.'},
		{ id: 'projectRoot', type: 'string', default: undefined, description: 'Specifies the project root. Defaults to the current working directory.'},
		{ id: 'projectName', type: 'string', default: undefined, description: 'Specifies the project name. Defaults to the last directory segement of the tsconfig.json file.'},
		{ id: 'noContents', type: 'boolean', default: false, description: 'File contents will not be embedded into the dump.'},
		{ id: 'inferTypings', type: 'boolean', default: false, description: 'Infer typings for JavaScript npm modules.'},
		{ id: 'out', type: 'string', default: undefined, description: 'The output file the dump is save to.'},
		{ id: 'stdout', type: 'boolean', default: false, description: 'Writes the dump to stdout.'}
	];
}

interface ResolvedGroupConfig extends GroupConfig {
	uri: string;
	name: string;
	conflictResolution: 'takeDump' | 'takeDB';
}

namespace ResolvedGroupConfig {
	export function from(groupConfig: GroupConfig): ResolvedGroupConfig | undefined {
		if (groupConfig.uri === undefined || groupConfig.name === undefined) {
			return undefined;
		}
		return {
			uri: groupConfig.uri,
			name: groupConfig.name,
			conflictResolution: groupConfig.conflictResolution === 'takeDump' ? 'takeDump' : 'takeDB',
			description: groupConfig.description,
			repository: groupConfig.repository
		};
	}
}


interface ResolvedOptions extends CommonOptions {
	projectRoot: string;
	projectName: string;
	group: ResolvedGroupConfig | undefined;
}

namespace ResolvedOptions {
	export function from(options: Options, groupConfig: ResolvedGroupConfig | undefined): ResolvedOptions | undefined {
		if (options.projectRoot === undefined || options.projectName === undefined) {
			return undefined;
		}

		const result: ResolvedOptions = {
			help: options.help,
			version: options.version,
			outputFormat: options.outputFormat,
			id: options.id,
			noContents: options.noContents,
			inferTypings: options.inferTypings,
			out: options.out,
			stdout: options.stdout,
			projectRoot: options.projectRoot,
			projectName: options.projectName,
			group: undefined
		};
		if (groupConfig !== undefined) {
			result.group = {
				uri: groupConfig.uri,
				name: groupConfig.name,
				conflictResolution: groupConfig.conflictResolution,
				description: groupConfig.description,
				repository: groupConfig.repository
			};
		}
		return result;
	}
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

function createEmitter(options: Options, writer: Writer, idGenerator: () => Id): Emitter {
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
	return emitterModule.create(writer, idGenerator);
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

async function readGroupConfig(options: Options): Promise<GroupConfig | undefined | number> {
	const group = options.group;
	if (group === undefined) {
		return undefined;
	}
	if (group === 'stdin') {
		try {
			const result: GroupConfig = await new Promise((resolve, reject) => {
				const stdin = process.stdin;
				let buffer: Buffer | undefined;
				stdin.on('data', (data) => {
					if (buffer === undefined) {
						buffer = data;
					} else {
						buffer = Buffer.concat([buffer, data]);
					}
				});
				stdin.on('end', () => {
					try {
						if (buffer === undefined) {
							resolve(undefined);
						} else {
							resolve(JSON.parse(buffer.toString('utf8')));
						}
					} catch (err) {
						reject(err);
					}
				});
				stdin.on('error', (err) => {
					reject(err);
				});
			});
			if (result === undefined) {
				return 1;
			}
			return result;
		} catch (err) {
			if (err) {
				console.error(err);
			}
			return 1;
		}
	} else {
		const fileName = group;
		if (!fs.existsSync(fileName)) {
			console.error(`Group config file ${options.group} doesn't exist.`);
			return 1;
		}
		let groupConfig: GroupConfig | undefined;
		try {
			groupConfig = JSON.parse(fs.readFileSync(fileName, { encoding: 'utf8'}));
		} catch (err) {
			console.error(`Reading group config file ${options.group} failed.`);
			if (err) {
				console.error(err);
			}
		}
		if (groupConfig === undefined) {
			return 1;
		}
		return groupConfig;
	}
}

async function processProject(config: ts.ParsedCommandLine, options: Options, emitter: Emitter, idGenerator: () => Id, typingsInstaller: TypingsInstaller): Promise<ProjectInfo | undefined> {
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
		options.projectRoot = process.cwd();
	}
	options.projectRoot = tss.makeAbsolute(options.projectRoot);
	if (options.projectName === undefined) {
		if (tsconfigFileName !== undefined) {
			options.projectName = path.basename(path.basename(path.dirname(tsconfigFileName)));
		}
		if (options.projectName === undefined) {
			console.error(`No project name provided.`);
			process.exitCode = 1;
			return undefined;
		}
	}

	if (options.inferTypings) {
		if (config.options.types !== undefined) {
			const start = tsconfigFileName !== undefined ? tsconfigFileName : process.cwd();
			await typingsInstaller.installTypings(options.projectRoot, start, config.options.types);
		} else {
			await typingsInstaller.guessTypings(options.projectRoot, tsconfigFileName !== undefined ? path.dirname(tsconfigFileName) : process.cwd());
		}
	}

	let resolvedGroupConfig: ResolvedGroupConfig  | undefined;
	const groupConfig = await readGroupConfig(options);
	if (typeof groupConfig === 'number') {
		process.exitCode = groupConfig;
		return;
	}
	if (groupConfig !== undefined) {
		if (!groupConfig.uri || URI.parse(groupConfig.uri).scheme !== 'lsif-group') {
			console.error(`Group config must provide an URI with scheme lsif-group.`);
			process.exitCode = 1;
			return;
		}
		if (!groupConfig.name) {
			console.error(`Group config must provide a group name.`);
			process.exitCode = 1;
			return;
		}
		resolvedGroupConfig = ResolvedGroupConfig.from(groupConfig);
		if (resolvedGroupConfig === undefined) {
			console.error(`Couldn't resolve group configration to proper values:\n\r${JSON.stringify(groupConfig, undefined, 4)}`);
			process.exitCode = 1;
			return;
		}
	}

	const resolvedOptions = ResolvedOptions.from(options, resolvedGroupConfig);
	if (resolvedOptions === undefined) {
		console.error(`Couldn't resolve all options to proper values:\n\r${JSON.stringify(options, undefined, 4)}`);
		process.exitCode = 1;
		return undefined;
	}

	// Bind all symbols
	let scriptSnapshots: Map<string, ts.IScriptSnapshot> = new Map();
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
			return '0';
		},
		// The project is immutable
		getProjectVersion: () => '0',
		getScriptSnapshot: (fileName: string): ts.IScriptSnapshot | undefined => {
			let result: ts.IScriptSnapshot | undefined = scriptSnapshots.get(fileName);
			if (result === undefined) {
				if (!ts.sys.fileExists(fileName)) {
					return undefined;
				}
				let content = ts.sys.readFile(fileName);
				if (content === undefined) {
					return undefined;
				}
				result = ts.ScriptSnapshot.fromString(content);
				scriptSnapshots.set(fileName, result);
			}
			return result;
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
	};
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
				const projectInfo = await processProject(reference.commandLine, options, emitter, idGenerator, typingsInstaller);
				if (projectInfo !== undefined) {
					dependsOn.push(projectInfo);
				}
			}
		}
	}

	program.getTypeChecker();
	return lsif(languageService, resolvedOptions, dependsOn, emitter, idGenerator, tsconfigFileName);
}

async function run(this: void, args: string[]): Promise<void> {

	const minOpts: minimist.Opts = {
		string: [],
		boolean: [],
		default: Object.create(null),
		alias: Object.create(null)
	};

	let longestId: number = 0;
	for (let description of Options.descriptions) {
		longestId = Math.max(longestId, description.id.length);
		(minOpts[description.type] as string[]).push(description.id);
		minOpts.default![description.id] = description.default;
		if (description.alias !== undefined) {
			minOpts.alias![description.id] = [description.alias];
		}
	}

	const options: Options = Object.assign(Options.defaults, minimist(process.argv.slice(2), minOpts));

	if (options.version) {
		console.log(require('../package.json').version);
		return;
	}

	const buffer: string[] = [];
	if (options.help) {
		buffer.push(`Languag Server Index Format tool for TypeScript`);
		buffer.push(`Version: ${require('../package.json').version}`);
		buffer.push('');
		buffer.push(`Usage: lsif-tsc [options][tsc options]`);
		buffer.push('');
		buffer.push(`Options`);
		for (let description of Options.descriptions) {
			if (description.alias !== undefined) {
				buffer.push(`  -${description.alias} --${description.id}${' '.repeat(longestId - description.id.length)} ${description.description}`);
			} else {
				buffer.push(`  --${description.id}   ${' '.repeat(longestId - description.id.length)} ${description.description}`);
			}
		}
		console.log(buffer.join('\n'));
		return;
	}

	let writer: Writer | undefined;
	if (options.out) {
		writer = new FileWriter(fs.openSync(options.out, 'w'));
	} else if (options.stdout) {
		writer = new StdoutWriter();
	}

	if (writer === undefined) {
		console.log(`Either a output file using --out or --stdout must be specified.`);
		process.exitCode = -1;
		return;
	}

	const config: ts.ParsedCommandLine = ts.parseCommandLine(args);
	const idGenerator = createIdGenerator(options);
	const emitter = createEmitter(options, writer, idGenerator);
	let projectRoot = options.projectRoot;
	if (projectRoot !== undefined && !path.isAbsolute(projectRoot)) {
		projectRoot = path.join(process.cwd(), projectRoot);
	}
	emitter.start();
	await processProject(config, options, emitter, idGenerator, new TypingsInstaller());
	emitter.end();
}

export async function main(): Promise<void> {
	return run(ts.sys.args);
}

if (require.main === module) {
	run(ts.sys.args).then(undefined, (error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
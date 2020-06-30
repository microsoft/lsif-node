/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as path from 'path';
import * as uuid from 'uuid';
import * as fs from 'fs';
import * as crypto from 'crypto';

import { URI } from 'vscode-uri';
import * as minimist from 'minimist';

import * as ts from 'typescript';

import { Id, Version, EventKind, Group, EventScope } from 'lsif-protocol';

import { Emitter, EmitterModule } from './emitters/emitter';
import { TypingsInstaller } from './typings';
import { lsif, ProjectInfo, Options as LSIFOptions } from './lsif';
import { Writer, StdoutWriter, FileWriter } from './utils/writer';
import { Builder } from './graph';
import * as tss from './typescripts';

interface CommonOptions {
	help: boolean;
	version: boolean;
	outputFormat: 'json' | 'line' | 'vis' | 'graphSON';
	id: 'number' | 'uuid';
	noContents: boolean;
	typeAcquisition: boolean;
	out: string | undefined;
	stdout: boolean;
}

interface Options extends CommonOptions {
	group: string | undefined;
	projectName: string | undefined;
}

interface GroupConfig {
	uri?: string;
	conflictResolution?: 'takeDump' | 'takeDB';
	name?: string;
	rootUri?: string;
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
		projectName: undefined,
		noContents: false,
		typeAcquisition: false,
		out: undefined,
		stdout: false
	};
	export const descriptions: OptionDescription[] = [
		{ id: 'version', type: 'boolean', alias: 'v', default: false, description: 'output the version number'},
		{ id: 'help', type: 'boolean', alias: 'h', default: false, description: 'output usage information'},
		{ id: 'outputFormat', type: 'string', default: 'line', values: ['line', 'json'], description: 'Specifies the output format. Allowed values are: \'line\' and \'json\'.'},
		{ id: 'id', type: 'string', default: 'number', values: ['number', 'uuid'], description: 'Specifies the id format. Allowed values are: \'number\' and \'uuid\'.'},
		{ id: 'group', type: 'string', default: undefined, description: 'Specifies the group config file, the group folder or stdin to read the group information from stdin.'},
		{ id: 'projectName', type: 'string', default: undefined, description: 'Specifies the project name. Defaults to the last directory segement of the tsconfig.json file.'},
		{ id: 'noContents', type: 'boolean', default: false, description: 'File contents will not be embedded into the dump.'},
		{ id: 'typeAcquisition', type: 'boolean', default: false, description: 'Run automatic type acquisition for JavaScript npm modules.'},
		{ id: 'out', type: 'string', default: undefined, description: 'The output file the dump is save to.'},
		{ id: 'stdout', type: 'boolean', default: false, description: 'Writes the dump to stdout.'}
	];
}

interface ResolvedGroupConfig extends GroupConfig {
	uri: string;
	conflictResolution: 'takeDump' | 'takeDB';
	name: string;
	rootUri: string;
}

namespace ResolvedGroupConfig {
	export function from(groupConfig: GroupConfig): ResolvedGroupConfig | undefined {
		if (groupConfig.uri === undefined || groupConfig.name === undefined || groupConfig.rootUri === undefined) {
			return undefined;
		}
		return {
			uri: groupConfig.uri,
			conflictResolution: groupConfig.conflictResolution === 'takeDump' ? 'takeDump' : 'takeDB',
			name: groupConfig.name,
			rootUri: groupConfig.rootUri,
			description: groupConfig.description,
			repository: groupConfig.repository
		};
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
		const filePath = group !== undefined ? group : process.cwd();
		try {
			const stat = fs.statSync(filePath);
			if (stat.isFile()) {
				let groupConfig: GroupConfig | undefined;
				try {
					groupConfig = JSON.parse(fs.readFileSync(filePath, { encoding: 'utf8'}));
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
			} else if (stat.isDirectory()) {
				const absolute = tss.makeAbsolute(filePath);
				const uri: string = URI.file(absolute).toString(true);
				return {
					uri: uri,
					conflictResolution: 'takeDB',
					name: path.basename(absolute),
					rootUri: uri
				};
			} else {
				return 1;
			}
		} catch (error) {
			console.error(`Group config file system path ${options.group} doesn't exist.`);
			return 1;
		}
	}
}

function makeKey(config: ts.ParsedCommandLine): string {
	let hash = crypto.createHash('md5');
	hash.update(JSON.stringify(config.options, undefined, 0));
	return  hash.digest('base64');
}

interface ProcessProjectOptions {
	group: Group;
	projectRoot: string;
	projectName?:string;
	typeAcquisition: boolean;
	stdout: boolean;
	processed: Map<String, ProjectInfo>;
}

async function processProject(config: ts.ParsedCommandLine, emitter: Emitter, builder: Builder, typingsInstaller: TypingsInstaller, options: ProcessProjectOptions): Promise<ProjectInfo | number> {
	const configFilePath = tss.CompileOptions.getConfigFilePath(config.options);
	const key = configFilePath ?? makeKey(config);
	if (options.processed.has(key)) {
		return options.processed.get(key)!;
	}
	if (configFilePath && !ts.sys.fileExists(configFilePath)) {
		console.error(`Project configuration file ${configFilePath} does not exist`);
		return 1;
	}
	// we have a config file path that came from a -p option. Load the file.
	if (configFilePath && config.options.project) {
		config = loadConfigFile(configFilePath);
	}

	if (options.typeAcquisition && (config.typeAcquisition === undefined || !!config.typeAcquisition.enable)) {
		const projectRoot = options.projectRoot;
		if (config.options.types !== undefined) {
			const start = configFilePath !== undefined ? configFilePath : process.cwd();
			await typingsInstaller.installTypings(projectRoot, start, config.options.types);
		} else {
			await typingsInstaller.guessTypings(projectRoot, configFilePath !== undefined ? path.dirname(configFilePath) : process.cwd());
		}
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
			if (configFilePath !== undefined) {
				return path.dirname(configFilePath);
			} else {
				return process.cwd();
			}
		},
		getDefaultLibFileName: (options) => {
			const result = ts.getDefaultLibFilePath(options);
			return result;
		},
		directoryExists: (path) => {
			const result = ts.sys.directoryExists(path);
			return result;
		},
		getDirectories: ts.sys.getDirectories,
		fileExists: ts.sys.fileExists,
		readFile: (path: string, encoding?: string): string | undefined => {
			const result = ts.sys.readFile(path, encoding);
			return result;
		},
		readDirectory: ts.sys.readDirectory
	};
	const languageService = ts.createLanguageService(host);
	const program = languageService.getProgram();
	if (program === undefined) {
		console.error('Couldn\'t create language service with underlying program.');
		process.exitCode = -1;
		return -1;
	}
	const dependsOn: ProjectInfo[] = [];
	const references = program.getResolvedProjectReferences();
	if (references) {
		for (let reference of references) {
			if (reference) {
				const result = await processProject(reference.commandLine, emitter, builder, typingsInstaller, options);
				if (typeof result === 'number') {
					return result;
				}
				dependsOn.push(result);
			}
		}
	}
	if ((!references || references.length === 0) && config.fileNames.length === 0) {
		console.error(`No input files specified.`);
		return 1;
	}
	program.getTypeChecker();
	const level: number = options.processed.size;
	let projectName: string | undefined;
	if (options.projectName !== undefined && level === 0 && (!references || references.length === 0)) {
		projectName = options.projectName;
	}
	if (projectName === undefined && configFilePath !== undefined) {
		projectName = path.basename(path.dirname(configFilePath));
	}
	if (projectName === undefined) {
		if (options.projectName !== undefined) {
			projectName = `${options.projectName}/${level + 1}`;
		} else {
			projectName =`${path.basename(options.projectRoot)}/${level + 1}`;
		}
	}
	if (projectName === undefined) {
		console.error(`No project name provided.`);
		return 1;
	}

	const lsifOptions: LSIFOptions = {
		group: options.group,
		projectRoot: options.projectRoot,
		projectName: projectName,
		tsConfigFile: configFilePath,
		stdout: options.stdout
	};

	const result = lsif(emitter, builder, languageService, dependsOn, lsifOptions);
	if (typeof result !== 'number') {
		options.processed.set(key, result);
	}
	return result;
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

	let groupConfig = await readGroupConfig(options);
	if (typeof groupConfig === 'number') {
		process.exitCode = groupConfig;
		return;
	}

	let resolvedGroupConfig: ResolvedGroupConfig | undefined;
	if (groupConfig !== undefined) {
		if (!groupConfig.uri) {
			console.error(`Group config must provide an URI.`);
			process.exitCode = 1;
			return;
		}
		if (!groupConfig.name) {
			console.error(`Group config must provide a group name.`);
			process.exitCode = 1;
			return;
		}
		if (!groupConfig.rootUri) {
			console.error(`Group config must provide a file system root URI.`);
			process.exitCode = 1;
			return;
		}
		resolvedGroupConfig = ResolvedGroupConfig.from(groupConfig);
	}
	if (resolvedGroupConfig === undefined) {
		console.error(`Couldn't resolve group configration to proper values:\n\r${JSON.stringify(groupConfig, undefined, 4)}`);
		process.exitCode = 1;
		return;
	}


	const config: ts.ParsedCommandLine = ts.parseCommandLine(args);
	const idGenerator = createIdGenerator(options);
	const emitter = createEmitter(options, writer, idGenerator);
	emitter.start();
	const builder = new Builder({
		idGenerator,
		emitSource: !options.noContents
	});
	emitter.emit(builder.vertex.metaData(Version));
	const group = builder.vertex.group(resolvedGroupConfig.uri, resolvedGroupConfig.name, resolvedGroupConfig.rootUri);
	group.conflictResolution = resolvedGroupConfig.conflictResolution;
	group.description = resolvedGroupConfig.description;
	group.repository = resolvedGroupConfig.repository;
	emitter.emit(group);
	emitter.emit(builder.vertex.event(EventScope.group, EventKind.begin, group));
	const processProjectOptions: ProcessProjectOptions = {
		group: group,
		projectRoot: tss.normalizePath(URI.parse(group.rootUri).fsPath),
		projectName: options.projectName,
		typeAcquisition: options.typeAcquisition,
		stdout: options.stdout,
		processed: new Map()
	};
	await processProject(config, emitter, builder, new TypingsInstaller(),  processProjectOptions);
	emitter.emit(builder.vertex.event(EventScope.group, EventKind.end, group));
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
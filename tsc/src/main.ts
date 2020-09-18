/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as path from 'path';
import * as uuid from 'uuid';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';

import * as yargs from 'yargs';
import { URI } from 'vscode-uri';
import * as ts from 'typescript';

import { Id, Version, EventKind, Group, EventScope, Vertex, Edge } from 'lsif-protocol';

import { Emitter, EmitterModule } from './emitters/emitter';
import { TypingsInstaller } from './typings';
import { lsif, ProjectInfo, Options as LSIFOptions, EmitterContext, DataManager, DataMode, Reporter } from './lsif';
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
	moniker: 'strict' | 'lenient'
	out: string | undefined;
	log: string | boolean;
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
		moniker: 'lenient',
		out: undefined,
		log: '',
		stdout: false
	};
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

interface InternalReporter extends Reporter {
	begin(): void;
	end(): void;
}

class StreamReporter implements InternalReporter {

	private reported: Set<string>;

	constructor(private stream: NodeJS.WritableStream) {
		this.reported = new Set();
	}

	public begin(): void {
	}

	public end(): void {
	}

	public reportProgress(scannedFiles: number): void {
		this.stream.write('.'.repeat(scannedFiles));
	}

	public reportStatus(projectName: string, numberOfSymbols: number, numberOfDocuments: number, time: number | undefined): void {
		this.stream.write(os.EOL);
		this.stream.write(`Processed ${numberOfSymbols} symbols in ${numberOfDocuments} files for project ${projectName}`);
		if (time !== undefined) {
			this.stream.write(` in ${time}ms.`)
		} else {
			this.stream.write('.');
		}
		this.stream.write(os.EOL);
		this.stream.write(os.EOL);
	}

	public reportInternalSymbol(symbol: ts.Symbol, symbolId: string, location: ts.Node): void {
		if (this.reported.has(symbolId)) {
			return;
		}
		this.reported.add(symbolId);
		this.stream.write(os.EOL);
		this.stream.write(`The symbol ${symbol.name} with id ${symbolId} is treated as internal although it is referenced outside`);
		this.stream.write(os.EOL);
		const declarations = symbol.getDeclarations();
		if (declarations === undefined) {
			this.stream.write(`  The symbol has no visible declarations.`);
			this.stream.write(os.EOL);
		} else {
			this.stream.write(`  The symbol is declared in the following files:`);
			this.stream.write(os.EOL);
			for (const declaration of declarations) {
				const sourceFile = declaration.getSourceFile();
				const lc = ts.getLineAndCharacterOfPosition(sourceFile, declaration.getStart());
				this.stream.write(`    ${sourceFile.fileName} at location [${lc.line},${lc.character}]`);
				this.stream.write(os.EOL);
			}
		}
		if (location !== undefined) {
			const sourceFile = location.getSourceFile();
			const lc = ts.getLineAndCharacterOfPosition(sourceFile, location.getStart());
			this.stream.write(`  Problem got detected while parsing the following file:`);
			this.stream.write(os.EOL);
			this.stream.write(`    ${sourceFile.fileName} at location [${lc.line},${lc.character}]`);
			this.stream.write(os.EOL);
		}
	}
}

class NullReporter implements InternalReporter {
	constructor() {
	}

	public begin(): void {
	}

	public end(): void {
	}

	public reportProgress(scannedFiles: number): void {
	}

	public reportStatus(projectName: string, numberOfSymbols: number, numberOfDocuments: number, time: number): void {
	}

	public reportInternalSymbol(symbol: ts.Symbol, symbolId: string, location: ts.Node): void {
	}
}

class FileReporter extends StreamReporter {

	private fileStream: fs.WriteStream;
	private reportProgressOnStdout: boolean;

	constructor(file: string, reportProgressOnStdout: boolean) {
		const stream = fs.createWriteStream(file, { encoding: 'utf8' });
		super(stream);
		this.fileStream = stream;
		this.reportProgressOnStdout = reportProgressOnStdout;
	}

	public end(): void {
		this.fileStream.close();
		if (this.reportProgressOnStdout) {
			process.stdout.write(os.EOL);
		}
	}

	public reportProgress(scannedFiles: number): void {
		if (this.reportProgressOnStdout) {
			process.stdout.write('.'.repeat(scannedFiles));
		}
	}
}

interface ProcessProjectOptions {
	group: Group;
	projectRoot: string;
	projectName?:string;
	typeAcquisition: boolean;
	stdout: boolean;
	dataMode: DataMode;
	reporter: Reporter;
	processed: Map<String, ProjectInfo>;
}

async function processProject(config: ts.ParsedCommandLine, emitter: EmitterContext, typingsInstaller: TypingsInstaller, dataManager: DataManager, options: ProcessProjectOptions): Promise<ProjectInfo | number> {
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
				const result = await processProject(reference.commandLine, emitter, typingsInstaller, dataManager, options);
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
		stdout: options.stdout,
		reporter: options.reporter,
		dataMode: options.dataMode,
	};

	const result = lsif(emitter, languageService, dataManager, dependsOn, lsifOptions);
	if (typeof result !== 'number') {
		options.processed.set(key, result);
	}
	return result;
}

async function run(this: void, args: string[]): Promise<void> {

	yargs.parserConfiguration({ "camel-case-expansion": false });
	const options: Options = Object.assign(Options.defaults,
		yargs.
			exitProcess(false).
			usage(`Languag Server Index Format tool for TypeScript\nVersion: ${require('../package.json').version}\nUsage: lsif-tsc [options][tsc options]`).
			example(`lsif-tsc -p tsconfig.json --stdout`, `Create a LSIF dump for the tsconfig.json file and print it to stdout.`).
			version(false).
			option('v', {
				alias: 'version',
				description: 'Output the version number',
				boolean: true
			}).
			option('h', {
				alias: 'help',
				description: 'Output usage information',
				boolean: true
			}).
			option('outputFormat', {
				 description: 'Specifies the output format.',
				 choices: ['line', 'json'],
				 default: 'line'
			}).
			option('id', {
				description: 'Specifies the id format.',
				choices: ['number', 'uuid'],
				default: 'number'
			}).
			option('group', {
				description: 'Specifies the group config file, the group folder or stdin to read the group information from stdin.',
				string: true
			}).
			option('projectName', {
				description: 'Specifies the project name. Defaults to the last directory segement of the tsconfig.json file.',
				string: true
			}).
			option('noContents', {
				description: 'File contents will not be embedded into the dump.',
				boolean: true
			}).
			option('typeAcquisition', {
				description: 'Run automatic type acquisition for JavaScript npm modules.',
				boolean: true
			}).
			option('moniker', {
				description: 'Monikers are use to relate symbols across repositories. In lenient mode the tool will proceed if a moniker was not generated for a visible symbol. In strict mode it will throw an exception.',
				choices: ['strict', 'lenient'],
				default: 'lenient'
			}).
			option('out', {
				description: 'The output file the dump is save to.',
				string: true
			}).
			option('stdout', {
				description: 'Writes the dump to stdout.',
				boolean: true
			}).
			option('log', {
				description: 'If provided witout a file name then the name of the output file is used with an additonal \'.log\' extension.',
				skipValidation: true
			}).
			argv
	);

	if (options.help) {
		return;
	}

	if (options.version) {
		console.log(require('../package.json').version);
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
	const emitterContext: EmitterContext = {
		get edge() {
			return builder.edge;
		},
		get vertex() {
			return builder.vertex;
		},
		emit(element: Vertex | Edge): void {
			emitter.emit(element);
		}
	};
	emitter.emit(builder.vertex.metaData(Version));
	const group = builder.vertex.group(resolvedGroupConfig.uri, resolvedGroupConfig.name, resolvedGroupConfig.rootUri);
	group.conflictResolution = resolvedGroupConfig.conflictResolution;
	group.description = resolvedGroupConfig.description;
	group.repository = resolvedGroupConfig.repository;
	emitter.emit(group);
	emitter.emit(builder.vertex.event(EventScope.group, EventKind.begin, group));
	let reporter: InternalReporter;
	if (options.log === '') { // --log not provided
		// The trace is written to stdout so we can't log anything.
		if (options.stdout) {
			reporter = new NullReporter();
		} else {
			reporter = new StreamReporter(process.stdout);
		}
	} else if (options.log === true) { // --log without a file name
		if (options.out !== undefined) {
			reporter = new FileReporter(`${options.out}.log`, true);
		} else {
			reporter = new StreamReporter(process.stdout);
		}
	} else if ((typeof options.log === 'string') && options.log.length > 0) { // --log filename
		reporter = new FileReporter(options.log, !options.stdout);
	} else {
		reporter = new NullReporter();
	}
	reporter.begin();
	const processProjectOptions: ProcessProjectOptions = {
		group: group,
		projectRoot: tss.normalizePath(URI.parse(group.rootUri).fsPath),
		projectName: options.projectName,
		typeAcquisition: options.typeAcquisition,
		stdout: options.stdout,
		dataMode: options.moniker === 'strict' ? DataMode.free : DataMode.keep,
		reporter: reporter,
		processed: new Map()
	};
	const dataManager: DataManager = new DataManager(emitterContext, group, processProjectOptions.projectRoot, processProjectOptions.reporter, processProjectOptions.dataMode);
	dataManager.begin();
	await processProject(config, emitterContext, new TypingsInstaller(), dataManager, processProjectOptions);
	dataManager.end();
	emitter.emit(builder.vertex.event(EventScope.group, EventKind.end, group));
	emitter.end();
	reporter.end();
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
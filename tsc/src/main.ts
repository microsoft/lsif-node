/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import { promisify } from 'util';
import * as fs from 'fs';

namespace pfs {
	export const stat = promisify(fs.stat);
	export const readFile = promisify(fs.readFile);
	export async function isFile(path: fs.PathLike): Promise<boolean> {
		const stat = await pfs.stat(path);
		return stat.isFile();
	}
}

import * as path from 'path';
import * as uuid from 'uuid';
import * as crypto from 'crypto';
import * as os from 'os';

import * as yargs from 'yargs';
import { URI } from 'vscode-uri';
import * as ts from 'typescript';

import { Id, Version, EventKind, Group, EventScope, Vertex, Edge } from 'lsif-protocol';

import { Writer, StdoutWriter, FileWriter } from './common/writer';
import { Builder, EmitterContext } from './common/graph';
import { Emitter, EmitterModule } from './emitters/emitter';

import { TypingsInstaller } from './typings';
import { lsif, ProjectInfo, Options as LSIFOptions, DataManager, DataMode, Reporter } from './lsif';
import * as tss from './typescripts';
import { Options, builder, GroupOptions } from './args';
import { ImportMonikers } from './npm/importMonikers';
import { ExportMonikers } from './npm/exportMonikers';
import { PackageJson } from './npm/package';

interface ResolvedGroupConfig extends GroupOptions {
	uri: string;
	conflictResolution: 'takeDump' | 'takeDB';
	name: string;
	rootUri: string;
}

namespace ResolvedGroupOptions {
	export function from(groupConfig: GroupOptions): ResolvedGroupConfig | undefined {
		if (groupConfig.uri === undefined || groupConfig.name === undefined || groupConfig.rootUri === undefined) {
			return undefined;
		}
		let groupUri = URI.parse(groupConfig.uri);
		if (groupUri.scheme === 'file' && !groupConfig.uri.startsWith('file:')) {
			groupUri = groupUri.with({ 'scheme': 'lsif'});
		}
		let rootUri = URI.parse(groupConfig.rootUri);
		if (rootUri.scheme !== 'file') {
			console.log();
		}
		return {
			uri: groupUri.toString(true),
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

async function readGroupConfig(options: Options): Promise<GroupOptions | undefined | number> {
	const group = options.group;
	if (group === 'stdin') {
		try {
			const result: GroupOptions | undefined = await new Promise((resolve, reject) => {
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
	} else if (typeof group === 'string' || group === undefined) {
		const filePath = group !== undefined ? group : process.cwd();
		try {
			const stat = await pfs.stat(filePath);
			if (stat.isFile()) {
				let groupConfig: GroupOptions | undefined;
				try {
					groupConfig = JSON.parse(await pfs.readFile(filePath, { encoding: 'utf8'}));
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
	} else {
		return group;
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
			this.stream.write(` in ${time}ms.`);
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

	public reportProgress(_scannedFiles: number): void {
	}

	public reportStatus(_projectName: string, _numberOfSymbols: number, _numberOfDocuments: number, _time: number): void {
	}

	public reportInternalSymbol(_symbol: ts.Symbol, _symbolId: string, _location: ts.Node): void {
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
	workspaceFolder: string;
	projectName?:string;
	typeAcquisition: boolean;
	noProjectReferences: boolean;
	packageInfo?: Map<string /* tsConfig */, string /* packageJson */>;
	stdout: boolean;
	dataMode: DataMode;
	reporter: Reporter;
	processed: Map<String, ProjectInfo>;
}

async function processProject(config: ts.ParsedCommandLine, emitter: EmitterContext, typingsInstaller: TypingsInstaller, dataManager: DataManager, importMonikers: ImportMonikers, exportMonikers: ExportMonikers | undefined,  options: ProcessProjectOptions): Promise<ProjectInfo | number> {
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

	// Check if we need to do type acquisition
	if (options.typeAcquisition && (config.typeAcquisition === undefined || !!config.typeAcquisition.enable)) {
		const projectRoot = options.workspaceFolder;
		if (config.options.types !== undefined) {
			const start = configFilePath !== undefined ? configFilePath : process.cwd();
			await typingsInstaller.installTypings(projectRoot, start, config.options.types);
		} else {
			await typingsInstaller.guessTypings(projectRoot, configFilePath !== undefined ? path.dirname(configFilePath) : process.cwd());
		}
	}

	// See if we need to setup a new Export moniker manager.
	if (configFilePath !== undefined && options.packageInfo !== undefined) {
		const packageFile = options.packageInfo.get(configFilePath);
		if (packageFile !== undefined) {
			const packageJson = PackageJson.read(packageFile);
			if (packageJson !== undefined) {
				exportMonikers = new ExportMonikers(emitter, options.workspaceFolder, packageJson);
			}
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
		getScriptVersion: (_fileName: string): string => {
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
			// We need to return the path since the language service needs
			// to know the full path and not only the name which is return
			// from ts.getDefaultLibFileName
			return ts.getDefaultLibFilePath(options);
		},
		directoryExists: ts.sys.directoryExists,
		getDirectories: ts.sys.getDirectories,
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
		readDirectory: ts.sys.readDirectory,
		// this is necessary to make source references work.
		realpath: ts.sys.realpath
	};

	tss.LanguageServiceHost.useSourceOfProjectReferenceRedirect(host, () => {
		return !config.options.disableSourceOfProjectReferenceRedirect;
	});

	const languageService = ts.createLanguageService(host);
	let program = languageService.getProgram();
	if (program === undefined) {
		console.error('Couldn\'t create language service with underlying program.');
		process.exitCode = -1;
		return -1;
	}
	const dependsOn: ProjectInfo[] = [];
	const references = options.noProjectReferences ? undefined : program.getResolvedProjectReferences();
	if (references) {
		for (let reference of references) {
			if (reference) {
				const result = await processProject(reference.commandLine, emitter, typingsInstaller, dataManager, importMonikers, exportMonikers, options);
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
	// Re-fetch the program to synchronize host data after the dependent project
	// has been processed.
	program = languageService.getProgram()!;
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
			projectName =`${path.basename(options.workspaceFolder)}/${level + 1}`;
		}
	}
	if (projectName === undefined) {
		console.error(`No project name provided.`);
		return 1;
	}

	const packageJsonFile: string | undefined = options.packageInfo === undefined
		? undefined
		: typeof options.packageInfo === 'string'
			? options.packageInfo
			: configFilePath !== undefined ? options.packageInfo.get(configFilePath) : undefined;

	const lsifOptions: LSIFOptions = {
		group: options.group,
		workspaceFolder: options.workspaceFolder,
		projectName: projectName,
		tsConfigFile: configFilePath,
		packageJsonFile: packageJsonFile,
		stdout: options.stdout,
		reporter: options.reporter,
		dataMode: options.dataMode,
	};

	const result = lsif(emitter, languageService, dataManager, importMonikers, exportMonikers, dependsOn, lsifOptions);
	if (typeof result !== 'number') {
		options.processed.set(key, result);
	}
	return result;
}

export async function run(this: void, options: Options): Promise<void> {

	if (options.help) {
		return;
	}

	if (options.version) {
		console.log(require('../package.json').version);
		return;
	}

	if (options.package !== undefined && options.publishedPackages !== undefined) {
		console.log(`Only package or publishedPackages can be set but not both.`);
		process.exitCode = - 1;
		return;
	}

	options = Options.resolvePathToConfig(options);
	if (options.package && !await pfs.isFile(options.package)) {
		console.error(`The package.json file referenced by the package option doesn't exist. The value is ${options.package}`);
		process.exitCode = -1;
		return;
	} else if (options.publishedPackages !== undefined) {
		let failed: boolean = false;
		for (const item of options.publishedPackages) {
			if (!await pfs.isFile(item.package)) {
				console.error(`The package.json file referenced by the 'publishedPackages' option doesn't exist. The value is ${JSON.stringify(item, undefined, 0)}`);
				failed = true;
			}
			if (!await pfs.isFile(item.project)) {
				console.error(`The project file referenced by the 'publishedPackages' options doesn't exist. The value is ${JSON.stringify(item, undefined, 0)}`);
				failed = true;
			}
		}
		if (failed) {
			process.exitCode = -1;
			return;
		}
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
		resolvedGroupConfig = ResolvedGroupOptions.from(groupConfig);
	}
	if (resolvedGroupConfig === undefined) {
		console.error(`Couldn't resolve group configuration to proper values:\n\r${JSON.stringify(groupConfig, undefined, 4)}`);
		process.exitCode = 1;
		return;
	}

	// We have read the config from file. See if we need to put back a -p to successfully
	// parse the command line.
	const args: string[] = [];
	let needsProject: boolean = true;
	for (let i = 0; i < ts.sys.args.length; i++) {
		const arg = ts.sys.args[i];
		if (arg === '-p' || arg === '--project' || arg.startsWith('-p=') || arg.startsWith('--project=')) {
			needsProject = false;
		}
		if (arg === '--config') {
			i++;
			continue;
		}
		if (arg.startsWith('--config=')) {
			continue;
		}
		args.push(arg);
	}
	if (needsProject && options.p !== undefined) {
		args.push('-p', options.p);
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

	let packageInfo: string | Map<string, string> | undefined;
	if (options.package !== undefined) {
		packageInfo = options.package;
	} else {
		packageInfo = new Map();
		if (options.publishedPackages !== undefined) {
			for (const item of options.publishedPackages) {
				const packagePath = tss.normalizePath(item.package);
				const projectPath = tss.normalizePath(item.project);
				packageInfo.set(projectPath, packagePath);
			}
		}
	}
	const workspaceFolder =  tss.normalizePath(URI.parse(group.rootUri).fsPath);
	let exportMonikers: ExportMonikers | undefined;
	if (typeof packageInfo === 'string') {
		const packageJson = PackageJson.read(packageInfo);
		if (packageJson !== undefined) {
			exportMonikers = new ExportMonikers(emitterContext, workspaceFolder, packageJson);
		}
		packageInfo = undefined;
	}
	const processProjectOptions: ProcessProjectOptions = {
		group: group,
		workspaceFolder: workspaceFolder,
		projectName: options.projectName,
		typeAcquisition: options.typeAcquisition,
		noProjectReferences: options.noProjectReferences,
		stdout: options.stdout,
		dataMode: options.moniker === 'strict' ? DataMode.free : DataMode.keep,
		packageInfo: packageInfo,
		reporter: reporter,
		processed: new Map()
	};
	const dataManager: DataManager = new DataManager(emitterContext, group, processProjectOptions.workspaceFolder, processProjectOptions.reporter, processProjectOptions.dataMode);
	const importMonikers: ImportMonikers = new ImportMonikers(emitterContext, processProjectOptions.workspaceFolder);
	dataManager.begin();
	await processProject(config, emitterContext, new TypingsInstaller(), dataManager, importMonikers, exportMonikers, processProjectOptions);
	dataManager.end();
	emitter.emit(builder.vertex.event(EventScope.group, EventKind.end, group));
	emitter.end();
	reporter.end();
}

export async function main(this: void): Promise<void> {
	yargs.
		parserConfiguration({ 'camel-case-expansion': false }).
		exitProcess(false).
		usage(`Language Server Index Format tool for TypeScript\nVersion: ${require('../package.json').version}\nUsage: lsif-tsc [options][tsc options]`).
		example(`lsif-tsc -p tsconfig.json --stdout`, `Create a LSIF dump for the tsconfig.json file and print it to stdout.`).
		version(false).
		wrap(Math.min(100, yargs.terminalWidth()));
	const parsed = builder(yargs).argv;
	if (typeof parsed.exitCode === 'number') {
		process.exitCode = parsed.exitCode;
		return;
	}
	const options: Options = Object.assign({}, Options.defaults, parsed);
	return run(Options.sanitize(options));
}

if (require.main === module) {
	main().then(undefined, (error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
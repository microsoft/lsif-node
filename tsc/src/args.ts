/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as yargs from 'yargs';

export const command: string = 'tsc';

export const describe: string = 'Language Server Index Format tool for TypeScript';

export interface CommonOptions {
	help: boolean;
	version: boolean;
	outputFormat: 'json' | 'line' | 'vis' | 'graphSON';
	id: 'number' | 'uuid';
	noContents: boolean;
	noProjectReferences: boolean;
	typeAcquisition: boolean;
	moniker: 'strict' | 'lenient'
	out: string | undefined;
	log: string | boolean;
	stdout: boolean;
}

export interface Options extends CommonOptions {
	group: string | undefined;
	projectName: string | undefined;
}

export namespace Options {
	export const defaults: Options = {
		help: false,
		version: false,
		outputFormat: 'line',
		id: 'number',
		group: undefined,
		projectName: undefined,
		noContents: false,
		noProjectReferences: false,
		typeAcquisition: false,
		moniker: 'lenient',
		out: undefined,
		log: '',
		stdout: false
	};
}

export function builder(yargs: yargs.Argv): yargs.Argv {
	return yargs.
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
			description: 'Specifies the project name. Defaults to the last directory segment of the tsconfig.json file.',
			string: true
		}).
		option('noContents', {
			description: 'File contents will not be embedded into the dump.',
			boolean: true
		}).
		option('noProjectReferences', {
			description: 'Project references will not be follow and embedded into the dump.',
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
			description: 'If provided without a file name then the name of the output file is used with an additional \'.log\' extension.',
			skipValidation: true
		});
}
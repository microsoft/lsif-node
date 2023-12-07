/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as yargs from 'yargs';

export const command: string = 'sqlite';

export const describe: string = 'SQLite database importer';

export type Mode = 'create' | 'import';

export interface Options {
	help: boolean;
	version: boolean;
	compressOnly: boolean;
	format: 'graph' | 'blob';
	projectVersion?: string;
	delete: boolean,
	in?: string;
	stdin: boolean;
	out?: string;
	mode: Mode
	stdout: boolean;
}

export namespace Options {
	export const defaults: Options = {
		help: false,
		version: false,
		compressOnly: false,
		format: 'graph',
		projectVersion: undefined,
		delete: false,
		in: undefined,
		stdin: false,
		out: undefined,
		mode: 'create',
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
		option('compressOnly', {
			description: 'Only does compression. No SQLite DB generation.',
			boolean: true,
			default: false
		}).
		option('format', {
			description: 'The SQLite format. Currently only graph is supported.',
			choices: ['graph'],
			default: 'graph'
		}).
		option('delete', {
			description: 'Deletes an old version of the DB. Only valid with blob format.',
			boolean: true,
			default: false
		}).
		option('projectVersion', {
			description: 'The imported project version. Only valid with blob format.',
			string: true
		}).
		option('in', {
			description: 'Specifies the file that contains a LSIF dump.',
			string: true
		}).
		option('stdin', {
			description: 'Reads the dump from stdin.',
			boolean: true,
			default: false
		}).
		option('out', {
			description: 'The name of the SQLite DB.',
			string: true
		}).
		option('mode', {
			description: 'Whether to create a new DB or import into an existing one.',
			choices: ['create', 'import'],
			default: 'create'
		});
}
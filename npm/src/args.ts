/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as yargs from 'yargs';

export const command: string = 'npm';

export interface Options {
	help: boolean;
	version: boolean;
	package?: string;
	projectRoot?: string;
	in?: string;
	stdin: boolean;
	out?: string;
	stdout: boolean;
}


export namespace Options {
	export const defaults: Options = {
		help: false,
		version: false,
		package: undefined,
		projectRoot: undefined,
		in: undefined,
		stdin: false,
		out: undefined,
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
		option('package', {
			description: 'Specifies the location of the package.json file to use. Defaults to the package.json in the current directory.',
			string: true
		}).
		option('in', {
			description: 'Specifies the file that contains a LSIF dump.',
			string: true
		}).
		option('stdin', {
			description: 'Reads the dump from stdin.',
			default: false,
			boolean: true
		}).
		option('out', {
			description: 'The output file the converted dump is saved to.',
			string: true
		}).
		option('stdout', {
			description: 'Writes the dump to stdout.',
			boolean: true
		});
}
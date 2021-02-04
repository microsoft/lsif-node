/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as yargs from 'yargs';

export const command: string = 'validate';

export const describe: string = 'Language Server Index Format tool to validate LSIF dumps';

export interface Options {
	help: boolean;
	version: boolean;
	stdin: boolean;
	in: string | undefined;
}

export namespace Options {
	export const defaults: Options = {
		help: false,
		version: false,
		stdin: false,
		in: undefined
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
		option('stdin', {
			description: 'Reads the dump from stdin.',
			boolean: true
		}).
		options('in', {
			description: 'Specifies the file that contains a LSIF dump.',
			string: true
		});
}

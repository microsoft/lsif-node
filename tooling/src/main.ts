/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as fs from 'fs';

import * as yargs from 'yargs';

import * as proto from 'lsif-protocol';


interface Options {
	stdin: boolean;
	in: string | undefined;
}

namespace Options {
	export const defaults: Options = {
		stdin: false,
		in: undefined
	};
}

export async function main(): Promise<void> {

	yargs.parserConfiguration({ 'camel-case-expansion': false });
	const options: Options = Object.assign(Options.defaults,
		yargs.
			exitProcess(false).
			usage(`Language Server Index Format tool to validate LSIF dumps\nVersion: ${require('../package.json').version}\nUsage: lsif-tooling [options]`).
			example(`lsif-tooling --stdin`, `Reads a LSIF dump from stdin and validated it.`).
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
			option('stdin', {
				description: 'Reads the dump from stdin.',
				boolean: true
			}).
			options('in', {
				description: 'Specifies the file that contains a LSIF dump.',
				string: true
			}).
			argv
	);
	let input: NodeJS.ReadStream | fs.ReadStream = process.stdin;
	if (options.in !== undefined && fs.existsSync(options.in)) {
		input = fs.createReadStream(options.in, { encoding: 'utf8'});
	}

}

if (require.main === module) {
	main().then(undefined, (error) => console.error(error));
}
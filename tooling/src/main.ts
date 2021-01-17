/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as fs from 'fs';
import { Edge, Vertex, ElementTypes } from 'lsif-protocol';

import * as yargs from 'yargs';
import { DiagnosticReporter } from './command';

import { ValidateCommand } from './validate';

interface Options {
	help: boolean;
	version: boolean;
	stdin: boolean;
	in: string | undefined;
}

namespace Options {
	export const defaults: Options = {
		help: false,
		version: false,
		stdin: false,
		in: undefined
	};
}

class ConsoleDiagnosticReporter implements DiagnosticReporter {
	error(element: Edge | Vertex, message?: string): void {
		if (message === undefined) {
			if (element.type === ElementTypes.edge) {
				console.log(`Malformed edge ${JSON.stringify(element, undefined, 0)}:`);
			} else {
				console.log(`Malformed vertex ${JSON.stringify(element, undefined, 0)}:`);
			}
		} else {
			console.log(`\t- ${message}`);
		}
	}
	warn(element: Edge | Vertex, message?: string): void {
		this.error(element, message);
	}
	info(element: Edge | Vertex, message?: string): void {
		this.error(element, message);
	}
}

export async function main(): Promise<void> {

	yargs.parserConfiguration({ 'camel-case-expansion': false });
	const options: Options = Object.assign(Options.defaults,
		yargs.
			exitProcess(false).
			usage(`Language Server Index Format tool to validate LSIF dumps\nVersion: ${require('../package.json').version}\nUsage: lsif-tooling [options]`).
			example(`lsif-tooling --stdin`, `Reads a LSIF dump from stdin and validates it.`).
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
	if (options.help) {
		return;
	}
	if (options.version) {
		console.log(require('../package.json').version);
		return;
	}
	let input: NodeJS.ReadStream | fs.ReadStream = process.stdin;
	if (options.in !== undefined && fs.existsSync(options.in)) {
		input = fs.createReadStream(options.in, { encoding: 'utf8'});
	}
	await new ValidateCommand(input, {}, new ConsoleDiagnosticReporter()).run();
}

if (require.main === module) {
	main();
}
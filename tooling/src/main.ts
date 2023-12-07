/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as fs from 'fs';
import { Edge, Vertex, ElementTypes } from 'lsif-protocol';

import * as yargs from 'yargs';
import { DiagnosticReporter } from './command';
import { ValidateCommand } from './validate';
import { Options, builder } from './args';

class ConsoleDiagnosticReporter implements DiagnosticReporter {
	hasError: boolean = false;
	error(element: Edge | Vertex, message?: string): void {
		this.hasError = true;
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

export async function run(options: Options): Promise<void> {
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
	const reporter = new ConsoleDiagnosticReporter();
	await new ValidateCommand(input, {}, reporter).run();
	if (reporter.hasError) {
		process.exitCode = 1;
	}
}

export async function main(): Promise<void> {
	yargs.
		parserConfiguration({ 'camel-case-expansion': false }).
		exitProcess(false).
		usage(`Language Server Index Format tool to validate LSIF dumps\nVersion: ${require('../package.json').version}\nUsage: lsif-tooling [options]`).
		example(`lsif-tooling --stdin`, `Reads a LSIF dump from stdin and validates it.`).
		version(false).
		wrap(Math.min(100, yargs.terminalWidth()));

	const options: Options = Object.assign({}, Options.defaults, builder(yargs).argv);
	run(options);
}

if (require.main === module) {
	main();
}
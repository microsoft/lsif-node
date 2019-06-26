/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as fse from 'fs-extra';
import * as LSIF from 'lsif-protocol';
import * as path from 'path';
import * as readline from 'readline';
import * as yargs from 'yargs';
import { getFilteredIds, IFilter } from './filter';
import { validate } from './validate';
import { visualize } from './visualize';

function readInput(format: string, inputPath: string, callback: (input: LSIF.Element[]) => void): void {
	let inputStream: NodeJS.ReadStream | fse.ReadStream = process.stdin;

	if (inputPath !== '--stdin') {
		inputStream = fse.createReadStream(inputPath);
	}

	let input: LSIF.Element[] = [];
	const buffer: string[] = [];
	const rd: readline.Interface = readline.createInterface(inputStream);
	rd.on('line', (line: string) => {
		switch (format) {
			case 'json':
				buffer.push(line);
				break;
			case 'line': default:
				input.push(JSON.parse(line));
		}
	});

	rd.on('close', () => {
		if (buffer.length > 0) {
			input = JSON.parse(buffer.join('\n'));
		}

		callback(input);
	});
}

export function main(): void {
	yargs
	.usage('Usage: $0 [validate|visualize] [file] --inputFormat=[line|json] [filters]')

	// Validation tool
	.command('validate [file]', '', (argv: yargs.Argv) => argv
		.positional('file', {
			describe: 'Path to input file or --stdin',
		}) as any /* ToDo@jumattos */,  (argv: yargs.Arguments<{ stdin: boolean; file: string; inputFormat: string }>) => {
			if (!argv.stdin && argv.file === undefined) {
				yargs.showHelp('log');
				console.error('\nError: Missing input file. Did you forget --stdin?');
				process.exitCode = 1;
			} else {
				readInput(argv.inputFormat, argv.stdin ? '--stdin' : argv.file, (input: LSIF.Element[]) => {
					const filter: IFilter = argv as unknown as IFilter;
					process.exitCode = validate(input, getFilteredIds(filter, input),
												path.join(__dirname,
													'../node_modules/lsif-protocol/lib/protocol.d.ts'));
				});
			}
		})

	// Visualization tool
	.command('visualize [file]', '', (argv: yargs.Argv) => argv
		.positional('file', {
			describe: 'Path to input file or --stdin',
		})
		.option('distance', {
			default: 1,
			describe: 'Max distance between any vertex and the filtered input',
		}) as any /* ToDo@jumattos */, (argv: yargs.Arguments<{ stdin: boolean; file: string; inputFormat: string; distance: number }>) => {
			if (!argv.stdin && argv.file === undefined) {
				yargs.showHelp('log');
				console.error('\nError: Missing input file. Did you forget --stdin?');
				process.exitCode = 1;
			} else {
				readInput(argv.inputFormat, argv.stdin ? '--stdin' : argv.file, (input: LSIF.Element[]) => {
					const filter: IFilter = argv as unknown as IFilter;
					process.exitCode = visualize(input, getFilteredIds(filter, input), argv.distance);
				});
			}
		})

	// One and only one command should be specified
	.demandCommand(1, 1)

	// Common options between tools
	.option('inputFormat', { default: 'line', choices: ['line', 'json'], description: 'Specify input format' })
	.boolean('stdin')
	.option('id', { default: [], type: 'string', array: true, description: 'Filter by id' })
	.option('inV', { default: [], type: 'string', array: true, description: 'Filter by inV' })
	.option('outV', { default: [], type: 'string', array: true, description: 'Filter by outV' })
	.option('type', { default: [], type: 'string', array: true, description: 'Filter by type' })
	.option('label', { default: [], type: 'string', array: true, description: 'Filter by label' })
	.option('property', { default: [], type: 'string', array: true, description: 'Filter by property' })
	.option('regex', { type: 'string', description: 'Filter by regex' })

	// Error handler
	.fail((message: string, error: Error) => {
		if (error !== undefined) {
			throw error;
		}
		yargs.showHelp('log');
		console.error(`\nError: ${message}`);
		process.exitCode = 1;
	})

	// Auto-generated help
	.help('info', 'Show usage information')
	.argv;
}

if (require.main === module) {
	main();
}

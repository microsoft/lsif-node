/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as fse from 'fs-extra';
import * as LSIF from 'lsif-protocol';
import * as path from 'path';
import { exit } from 'process';
import * as readline from 'readline';
import * as yargs from 'yargs';
import { getFilteredIds, IFilter } from './filter';
import { validate } from './validate';
import { visualize } from './visualize';

function readInput(format: string, inputPath: string, callback: (input: LSIF.Element[]) => void): void {
    let inputStream: NodeJS.ReadStream | fse.ReadStream = process.stdin;
    if (inputPath !== undefined) {
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
            default: './lsif.json',
            describe: 'input file',
        }),  (argv: yargs.Arguments<{ stdin: boolean; file: string; inputFormat: string }>) => {
            readInput(argv.inputFormat, argv.stdin ? undefined : argv.file, (input: LSIF.Element[]) => {
                const filter: IFilter = argv as unknown as IFilter;
                process.exitCode = validate(input, getFilteredIds(filter, input),
                                            path.join(path.dirname(process.argv[1]),
                                                      '../node_modules/lsif-protocol/lib/protocol.d.ts'));
            });
        })

    // Visualization tool
    .command('visualize [file]', '', (argv: yargs.Argv) => argv
        .positional('file', {
            default: './lsif.json',
            describe: 'input file',
        })
        .option('distance', {
            default: 1,
            describe: 'Max distance between any vertex and the filtered input',
        }),  (argv: yargs.Arguments<{ stdin: boolean; file: string; inputFormat: string; distance: number }>) => {
            readInput(argv.inputFormat, argv.stdin ? undefined : argv.file, (input: LSIF.Element[]) => {
                const filter: IFilter = argv as unknown as IFilter;
                process.exitCode = visualize(input, getFilteredIds(filter, input), argv.distance);
            });
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
        process.exit(1);
    })

    // Auto-generated help
    .help('info', 'Show usage information')
    .argv;
}

if (require.main === module) {
    main();
}

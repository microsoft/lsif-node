/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as fs from 'fs';

import * as yargs from 'yargs';

import { Options, Mode, builder } from './args';
import {GraphStore } from './graphStore';
import {BlobStore } from './blobStore';
import { CompressStore } from './compressStore';

export class RunError extends Error {
	private _exitCode: number;

	constructor(message: string, exitCode: number) {
		super(message);
		this._exitCode = exitCode;
	}

	public get exitCode(): number {
		return this._exitCode;
	}
}

export interface RunOptions {
	in?: string;
	stdin: boolean;
	compressOnly: boolean;
	out?: string;
	stdout: boolean;
	format: 'graph' | 'blob';
	mode: Mode;
}

async function execute(options: RunOptions): Promise<void> {
	let input: NodeJS.ReadStream | fs.ReadStream = process.stdin;
	if (options.in !== undefined && fs.existsSync(options.in)) {
		input = fs.createReadStream(options.in, { encoding: 'utf8'});
	}
	let store: CompressStore | GraphStore | BlobStore | undefined;
	if (options.compressOnly && (options.out !== undefined || options.stdout === true)) {
		store = new CompressStore(input, options.out);
	} else if (!options.compressOnly && options.out) {
		let filename = options.out;
		if (!filename.endsWith('.db')) {
			filename = filename + '.db';
		}
		if (options.format === 'blob') {
			throw new RunError(`Currently only graph format is supported.`, 1);
			// if (options.projectVersion === undefined) {
			// 	console.log(`Blob format requires a project version.`);
			// 	process.exitCode = -1;
			// 	return;
			// }
			// store = new BlobStore(input, filename, options.projectVersion, options.delete);
		} else {
			store = new GraphStore(input, filename, options.mode);
		}
	}
	if (store === undefined) {
		throw new RunError(`Failed to create output store.`, 1);
	}
	return store.run();
}

export async function run(this: void, options: Options): Promise<void> {
	if (options.help) {
		return;
	}

	if (options.version) {
		console.log(require('../package.json').version);
		return;
	}


	if (!options.stdin && options.in === undefined) {
		console.error(`Either a input file using --in or --stdin must be specified.`);
		process.exitCode = -1;
		return;
	}

	if (!options.stdout && options.out === undefined) {
		console.error(`Either a output file using --out or --stdout must be specified.`);
		process.exitCode = -1;
		return;
	}

	if (options.stdout && !options.compressOnly) {
		console.error(`Writing to stdout can only be used together with --compressOnly`);
		process.exitCode = -1;
		return;
	}

	if (options.mode !== 'create' && options.mode !== 'import') {
		console.error(`Valid mode values are either 'create' or 'import'.`);
		process.exitCode = -1;
		return;
	}

	if (options.mode === 'import' && options.format === 'blob') {
		console.error(`Import mode is only valid when using graph format.`);
		process.exitCode = -1;
		return;
	}

	try {
		await execute(options);
	} catch (error) {
		if (error instanceof RunError) {
			console.error(error.message);
			process.exitCode = error.exitCode;
			return;
		} else {
			throw error;
		}
	}
}

export async function main(): Promise<void> {
	yargs.
		parserConfiguration({ 'camel-case-expansion': false }).
		exitProcess(false).
		usage(`SQLite database importer\nVersion: ${require('../package.json').version}\nUsage: lsif-sqlite [options]`).
		example(`lsif-sqlite --in dump.lsif --out dump.db`, `Imports the dump into the SQLite database.`).
		version(false).
		wrap(Math.min(100, yargs.terminalWidth()));

	const options: Options = Object.assign({}, Options.defaults, builder(yargs).argv);
	return run(options);
}

if (require.main === module) {
	main().then(undefined, (error) => console.error(error));
}
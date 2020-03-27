/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as fs from 'fs';

import * as minimist from 'minimist';

import {GraphStore } from './graphStore';
import {BlobStore } from './blobStore';
import { CompressStore } from './compressStore';

type Mode = 'create' | 'import';

interface Options {
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

interface OptionDescription {
	id: keyof Options;
	type: 'boolean' | 'string';
	alias?: string;
	default: any;
	values?: string[];
	description: string;
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

	export const descriptions: OptionDescription[] = [
		{ id: 'version', type: 'boolean', alias: 'v', default: false, description: 'output the version number'},
		{ id: 'help', type: 'boolean', alias: 'h', default: false, description: 'output usage information'},
		{ id: 'compressOnly', type: 'boolean', default: false, description: 'Only does compression. No SQLite DB generation.'},
		{ id: 'format', type: 'string', default: 'graph', description: 'The SQLite format. Currently only graph is supported.'},
		{ id: 'delete', type: 'boolean', default: false, description: 'Deletes an old version of the DB. Only valid with blob format.'},
		{ id: 'projectVersion', type: 'string', default: undefined, description: 'The imported project version. Only valid with blob format.'},
		{ id: 'in', type: 'string', default: undefined, description: 'Specifies the file that contains a LSIF dump.'},
		{ id: 'stdin', type: 'boolean', default: false, description: 'Reads the dump from stdin'},
		{ id: 'out', type: 'string', default: undefined, description: 'The name of the SQLite DB.'},
		{ id: 'mode', type: 'string', default: 'create', description: 'Whether to create a new DB or import into an existing one. Either create (default) or import.'},
		{ id: 'stdout', type: 'boolean', default: false, description: 'Writes the dump to stdout'},
	];
}

export async function main(): Promise<void> {

	let minOpts: minimist.Opts = {
		string: [],
		boolean: [],
		default: Object.create(null),
		alias: Object.create(null)
	};

	let longestId: number = 0;
	for (let description of Options.descriptions) {
		longestId = Math.max(longestId, description.id.length);
		(minOpts[description.type] as string[]).push(description.id);
		minOpts.default![description.id] = description.default;
		if (description.alias !== undefined) {
			minOpts.alias![description.id] = [description.alias];
		}
	}

	const options: Options = Object.assign(Options.defaults, minimist(process.argv.slice(2), minOpts));

	if (options.version) {
		console.log(require('../package.json').version);
		return;
	}

	let buffer: string[] = [];
	if (options.help) {
		buffer.push(`Tool to convert a LSIF dump into a SQLite DB`);
		buffer.push(`Version: ${require('../package.json').version}`);
		buffer.push('');
		buffer.push(`Usage: lsif-sqlite [options][tsc options]`);
		buffer.push('');
		buffer.push(`Options`);
		for (let description of Options.descriptions) {
			if (description.alias !== undefined) {
				buffer.push(`  -${description.alias} --${description.id}${' '.repeat(longestId - description.id.length)} ${description.description}`);
			} else {
				buffer.push(`  --${description.id}   ${' '.repeat(longestId - description.id.length)} ${description.description}`);
			}
		}
		console.log(buffer.join('\n'));
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
			console.error(`Currently only graph format is supported.`);
			process.exitCode = 1;
			return;
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
		console.error(`Failed to create output store.`);
		process.exitCode = 1;
		return;
	}
	await store.run();
}

if (require.main === module) {
	main().then(undefined, (error) => console.error(error));
}
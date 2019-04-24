/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as os from 'os';
import * as fs from 'fs';
import * as readline from 'readline';

import * as minimist from 'minimist';

import { Edge, Vertex, ElementTypes, VertexLabels, } from 'lsif-protocol';
import { CompressorPropertyDescription, MetaData } from './protocol.compress';
import { Compressor, CompressorProperty, vertexShortForms, edgeShortForms, vertexCompressor, edgeCompressor, itemEdgeCompressor } from './compress';
import * as sql from './sqlite';

const __out = process.stdout;
const __eol = os.EOL;

interface Options {
	help: boolean;
	version: boolean;
	file: string | undefined;
	db: string;
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
		file: undefined,
		db: 'lisf.db'
	};

	export const descriptions: OptionDescription[] = [
		{ id: 'version', type: 'boolean', alias: 'v', default: false, description: 'output the version number'},
		{ id: 'help', type: 'boolean', alias: 'h', default: false, description: 'output usage information'},
		{ id: 'db', type: 'string', default: 'lsif.db', description: 'Specifies the name of the SQLite DB.'},
		{ id: 'file', type: 'string', default: undefined, description: 'Reads the LSIF dump from file instead of stdin.'},
	];
}

function emit(value: string): void {
	__out.write(value);
	__out.write(__eol);
}

export function main(): void {

	let minOpts: minimist.Opts = {
		string: [],
		boolean: [],
		default: Object.create(null),
		alias: Object.create(null)
	};

	let longestId: number = 0;
	for (let description of Options.descriptions) {
		longestId = Math.max(longestId, description.id.length);
		minOpts[description.type] = description.id;
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

	function stringify(element: Vertex | Edge): string {
		if (element.type === ElementTypes.vertex && element.label === VertexLabels.metaData) {
			return JSON.stringify(element, undefined, 0);
		}
		let compressor = Compressor.getCompressor(element);
		if (compressor === undefined) {
			throw new Error(`No compressor found for ${element.label}`);
		}
		return JSON.stringify(compressor.compress(element));
	}

	function shortForm(element: Vertex | Edge): number {
		let result: number | undefined;
		if (element.type === ElementTypes.vertex) {
			result = vertexShortForms.get(element.label);
		} else {
			result = edgeShortForms.get(element.label);
		}
		if (result === undefined) {
			throw new Error(`Can't compute short form for ${element.label}`);
		}
		return result;
	}

	let input: NodeJS.ReadStream | fs.ReadStream = process.stdin;
	if (options.file !== undefined && fs.existsSync(options.file)) {
		input = fs.createReadStream(options.file, { encoding: 'utf8'});
	}
	let db: sql.Database | undefined;
	if (options.db) {
		let filename = options.db;
		if (!filename.endsWith('.db')) {
			filename = filename + '.db';
		}
		db = new sql.Database(filename, stringify, shortForm);
	}

	function emitMetaData(vertex: MetaData): void {
		if (!db) {
			emit(stringify(vertex));
		} else {
			db.insert(vertex);
		}
	}

	function emitCompressed(element: Vertex | Edge): void {
		if (!db) {
			emit(stringify(element));
		} else {
			db.insert(element);
		}
	}

	function run() {
		const rd = readline.createInterface(input);
		rd.on('line', (line) => {
			if (!line) {
				return;
			}
			let element: Edge | Vertex;
			try {
				element = JSON.parse(line);
			} catch (err) {
				console.log(`Parsing failed for line:\n${line}`);
				throw err;
			}
			if (element.type === ElementTypes.vertex && element.label === VertexLabels.metaData) {
				let convertMetaData = (data: CompressorProperty): CompressorPropertyDescription => {
					let result: CompressorPropertyDescription = {
						name: data.name as string,
						index: data.index,
						compressionKind: data.compressionKind
					};
					if (data.shortForm !== undefined) {
						let long: Set<string> = new Set();
						let short: Set<string | number> = new Set();
						result.shortForm = [];
						for (let elem of data.shortForm) {
							let [key, value] = elem;
							if (long.has(key)) {
								throw new Error(`Duplicate key ${key} in short form.`);
							}
							long.add(key);
							if (short.has(value)) {
								throw new Error(`Duplicate value ${value} in short form.`);
							}
							short.add(value);
							result.shortForm.push([key, value]);
						}
					}
					return result;
				}
				let compressors = Compressor.allCompressors();
				if (compressors.length > 0) {
					let compressMetaData: MetaData = element as MetaData;
					compressMetaData.compressors = {
						vertexCompressor: vertexCompressor.id,
						edgeCompressor: edgeCompressor.id,
						itemEdgeCompressor: itemEdgeCompressor.id,
						all: []
					};
					for (let compressor of compressors) {
						compressMetaData.compressors.all.push({
							id: compressor.id,
							parent: compressor.parent !== undefined ? compressor.parent.id : undefined,
							properties: compressor.metaData().map(convertMetaData)
						});
					}
				}
				emitMetaData(element);
			} else {
				emitCompressed(element);
			}
		});
		rd.on('close', () => {
			if (db) {
				db.close();
			}
		});
	};

	if(!db) {
		run();
	} else {
		db.runInsertTransaction(run);
	}
}

if (require.main === module) {
	main();
}
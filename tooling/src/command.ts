/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as fs from 'fs';
import * as readline from 'readline';

import { Edge, Vertex } from 'lsif-protocol';

export abstract class Command {

	private readonly input: NodeJS.ReadStream | fs.ReadStream;

	constructor(input: NodeJS.ReadStream | fs.ReadStream) {
		this.input = input;
	}

	async run(): Promise<void> {
		return new Promise((resolve, _reject) => {
			const rd = readline.createInterface(this.input);
			rd.on('line', (line) => {
				if (!line) {
					return;
				}
				let element: Edge | Vertex;
				try {
					element = JSON.parse(line);
				} catch (err) {
					console.error(`Parsing failed for line:\n${line}`);
					throw err;
				}
				try {
					this.process(element);
				} catch (err) {
					console.error(`Processing failed for line:\n${line}`);
					throw err;
				}
			});
			rd.on('close', () => {
				resolve();
			});
		});
	}

	protected abstract process(element: Edge | Vertex): Promise<void>;
}
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as fs from 'fs';
import * as readline from 'readline';

import { Edge, Vertex } from 'lsif-protocol';

export interface DiagnosticReporter {
	error(element: Vertex | Edge, message?: string): void;
	warn(element: Vertex | Edge, message?: string): void;
	info(element: Vertex | Edge, message?: string): void;
}

export abstract class Command {

	private readonly input: NodeJS.ReadStream | fs.ReadStream | IterableIterator<Edge | Vertex>;
	protected readonly reporter: DiagnosticReporter;

	constructor(input: NodeJS.ReadStream | fs.ReadStream | IterableIterator<Edge | Vertex>, reporter: DiagnosticReporter) {
		this.input = input;
		this.reporter = reporter;
	}

	async run(): Promise<void> {
		function isIterable(value: any): value is IterableIterator<Edge | Vertex> {
			if (value === null || value === undefined) {
				return false;
			}
			return typeof value[Symbol.iterator] === 'function';
		}
		const input = this.input;
		if (isIterable(input)) {
			for (const element of input) {
				await this.process(element);
			}
		} else {
			const rd = readline.createInterface(input);
			return new Promise((resolve, _reject) => {
				rd.on('line', async (line) => {
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
						await this.process(element);
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
	}

	protected abstract process(element: Edge | Vertex): Promise<void>;
}
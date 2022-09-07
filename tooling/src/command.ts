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
			this.process(input);
		} else {
			const elements = await this.extractElementsFromFile(input);
			this.process(elements);
		}
	}

	protected abstract process(elements: IterableIterator<Edge | Vertex>): Promise<void>;

	private async extractElementsFromFile(input: any) {
		const rd = readline.createInterface(input);
		return new Promise<IterableIterator<Edge | Vertex>>((resolve, _reject) => {
			const elements = new Array<Edge | Vertex>();
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
					elements.push(element);
				} catch (err) {
					console.error(`Processing failed for line:\n${line}`);
					throw err;
				}
			});
			rd.on('close', () => {
				resolve(elements.values());
			});
		});
	}
}
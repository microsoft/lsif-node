/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as fs from 'fs';

import { Edge, Vertex } from 'lsif-protocol';

import { Command } from './command';

export interface ValidateOptions {
}

export class Validate extends Command {

	private readonly options: ValidateOptions;

	constructor(input: NodeJS.ReadStream | fs.ReadStream, options: ValidateOptions) {
		super(input);
		this.options = options;
		this.options;
	}

	protected async process(element: Edge | Vertex ): Promise<void> {
		
	}
}
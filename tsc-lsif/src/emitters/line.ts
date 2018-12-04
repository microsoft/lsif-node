/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as os from 'os';

import { Emitter, Create } from './emitter';
import { Vertex, Edge } from '../shared/protocol';

const __out = process.stdout;
const __eol = os.EOL;

export const create: Create = (): Emitter => {
	return {
		start: () => {},
		emit: (element: Vertex | Edge) => {
			__out.write(JSON.stringify(element, undefined, 0));
			__out.write(__eol);
		},
		end: () => {}
	};
}
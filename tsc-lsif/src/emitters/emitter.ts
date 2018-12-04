/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { Vertex, Edge, Id } from '../shared/protocol';

export interface Emitter {
	start(): void;
	emit(element: Vertex | Edge): void;
	end(): void;
}

export interface Create {
	(idGenerator?: () => Id): Emitter;
}

export interface EmitterModule {
	create: Create;
}
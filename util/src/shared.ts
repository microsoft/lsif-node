/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as LSIF from 'lsif-protocol';

export function getInVs(edge: LSIF.Edge): string[] {
	const inVs: string[] = [];
	if (LSIF.Edge.is11(edge)) {
		inVs.push(edge.inV.toString());
	} else {
		for (const inV of edge.inVs) {
			inVs.push(inV.toString());
		}
	}
	return inVs;
}

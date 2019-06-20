/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as LSIF from 'lsif-protocol';
import { Edge, ElementTypes } from 'lsif-protocol';

export interface IFilter {
	id: string[];
	inV: string[];
	outV: string[];
	type: string[];
	label: string[];
	property: string[];
	regex: string | undefined;
}

interface IParameter extends LSIF.Element {
	property: string;
	label: string;
}

export function getFilteredIds(argv: IFilter, input: LSIF.Element[]): string[] {
	let result: LSIF.Element[] = input;
	const { id, inV, outV, type, label, property, regex } = argv;

	result = result.filter((element: LSIF.Element) => includes(id, element.id));
	result = result.filter((element: LSIF.Element) => {
		/* ToDo@jumattos The element is a vertex here as well. Uncomment the if and test are failing*/
		if (element.type !== ElementTypes.edge) {
			return false;
		}
		let edge: Edge = element as Edge;
		if (Edge.is11(edge)) {
			return includes(inV, edge.inV);
		} else {
			console.log(JSON.stringify(edge, undefined, 0));
			for (let item of edge.inVs) {
				if (includes(inV, item)) {
					return true;
				}
			}
			return false;
		}
	});
	result = result.filter((element: LSIF.Element) => {
		const edge: LSIF.Edge = element as LSIF.Edge;

		return includes(outV, edge.outV);
	});
	result = result.filter((element: LSIF.Element) => element.type !== undefined && includes(type, element.type));
	result = result.filter((element: LSIF.Element) => {
		const param: IParameter = element as IParameter;

		return includes(label, param.label);
	});
	result = result.filter((element: LSIF.Element) => {
		const param: IParameter = element as IParameter;

		return includes(property, param.property);
	});
	result = result.filter((element: LSIF.Element) => {
		return regex !== undefined ? new RegExp(regex).test(JSON.stringify(element)) : true;
	});

	return result.map((element: LSIF.Element) => element.id.toString());
}

function includes(array: string[], id: string | number): boolean {
	return array.length > 0 ? id !== undefined && array.includes(id.toString()) : true;
}

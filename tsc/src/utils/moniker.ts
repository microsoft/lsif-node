/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

export const separator: string = ':';

export interface TscMoniker {
	/**
	 * The symbol name of the moniker.
	 */
	name: string;

	/**
	 * The path of the moniker;
	 */
	path?: string;
}

export namespace TscMoniker {

	export const scheme: string = 'tsc';

	export function parse(identifier: string): TscMoniker {
		let index = identifier.lastIndexOf(separator);
		if (index === -1) {
			return { name: identifier };
		}
		return {
			name: identifier.substring(index + 1),
			path: identifier.substr(0, index).replace(/::/g, ':')
		}
	}

	export function create(name: string, path?: string): string {
		if (!path) {
			return name;
		}
		return `${escape(path)}${separator}${name}`;
	}

	export function hasPath(moniker: TscMoniker): moniker is (TscMoniker & { path: string }) {
		return !!moniker.path
	}
}

export namespace NpmMoniker {

	export const scheme: string = 'npm';

	export function create(module: string, path: string | undefined, name: string): string {
		return `${module}${separator}${path !== undefined ? escape(path) : ''}${separator}${name}`;
	}
}

function escape(value: string): string {
	return value.replace(/:/g, '::');
}
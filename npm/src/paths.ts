/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as path from 'path';

const isWindows = process.platform === 'win32';

export function removeExtension(value: string): string {
	if (value.endsWith('.d.ts')) {
		return value.substring(0, value.length - 5);
	} else if (value.endsWith('.ts') || value.endsWith('.js')) {
		return value.substring(0, value.length - 3);
	} else {
		return value;
	}
}

export function normalizePath(value: string): string {
	if (isWindows) {
		value = value.replace(/\\/g, '/');
		if (/^[a-z]:/.test(value)) {
			value = value.charAt(0).toUpperCase() + value.substring(1);
		}
	}
	return path.posix.normalize(value);
}

export function makeAbsolute(p: string, root?: string): string {
	if (path.isAbsolute(p)) {
		return normalizePath(p);
	}
	if (root === undefined) {
		return normalizePath(path.join(process.cwd(), p));
	} else {
		return normalizePath(path.join(root, p));
	}
}

export function isParent(parent: string, file: string): boolean {
	if (parent.length === 0 || file.length === 0) {
		throw new Error(`isParent require a parent and a file.`);
	}
	if (!file.startsWith(parent)) {
		return false;
	}
	if (parent[parent.length - 1] === '/') {
		return true;
	}

	if (file.charAt(parent.length) === '/' ) {
		return true;
	}

	return false;
}

export function normalizeSeparator(value: string): string {
	return value.replace(/\\/g, '/');
}
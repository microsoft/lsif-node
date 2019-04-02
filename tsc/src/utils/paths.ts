/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

export function removeExtension(value: string): string {
	if (value.endsWith('.d.ts')) {
		return value.substring(0, value.length - 5);
	} else if (value.endsWith('.ts') || value.endsWith('.js')) {
		return value.substring(0, value.length - 3);
	} else {
		return value;
	}
}

export function normalizeSeparator(value: string): string {
	return value.replace(/\\/g, '/');
}
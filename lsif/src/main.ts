/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as yargs from 'yargs';

import * as tsc from 'lsif-tsc/lib/args';

export async function main(): Promise<void> {
	yargs.parserConfiguration({ 'camel-case-expansion': false });

	yargs
		.exitProcess(false)
		.version(false)
		.command({
			command: tsc.command,
			builder: (yargs) => { return tsc.builder(yargs); },
			handler: async (argv) => {
				const options: tsc.Options = Object.assign({}, tsc.Options.defaults, argv);
				const tscMain =	await import('lsif-tsc');
				await tscMain.runWithOptions(options);
			}
		})
		.demandCommand()
		.argv;
}

if (require.main === module) {
	main();
}
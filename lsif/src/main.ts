/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as yargs from 'yargs';

import * as tsc from 'lsif-tsc/lib/args';
import * as npm from 'lsif-npm/lib/args';
import * as sqlite from 'lsif-sqlite/lib/args';
import * as validate from 'lsif-tooling/lib/args';

export async function main(): Promise<void> {
	try {
		yargs.
			parserConfiguration({ 'camel-case-expansion': false }).
			exitProcess(false).
			version(false).
			command({
				command: tsc.command,
				describe: tsc.describe,
				builder: (yargs) => { return tsc.builder(yargs); },
				handler: async (argv) => {
					const options: tsc.Options = Object.assign({}, tsc.Options.defaults, argv);
					const main = await import('lsif-tsc');
					await main.run(tsc.Options.sanitize(options));
				}
			}).
			command({
				command: npm.command,
				describe: npm.describe,
				builder: (yargs) => { return npm.builder(yargs); },
				handler: async (argv) => {
					const options: npm.Options = Object.assign({}, npm.Options.defaults, argv);
					const main = await import('lsif-npm');
					await main.run(options);
				}
			}).
			command({
				command: sqlite.command,
				describe: sqlite.describe,
				builder: (yargs) => { return sqlite.builder(yargs); },
				handler: async (argv) => {
					const options: sqlite.Options = Object.assign({}, sqlite.Options.defaults, argv);
					const main = await import('lsif-sqlite');
					await main.run(options);
				}
			}).
			command({
				command: validate.command,
				describe: validate.describe,
				builder: (yargs) => { return validate.builder(yargs); },
				handler: async (argv) => {
					const options: validate.Options = Object.assign({}, validate.Options.defaults, argv);
					const main = await import('lsif-tooling');
					await main.run(options);
				}
			}).
			demandCommand(1, 1, 'You need to specify one of the above commands.').
			wrap(Math.min(100, yargs.terminalWidth())).
			argv;
	} catch (err) {
	}
}

if (require.main === module) {
	main();
}
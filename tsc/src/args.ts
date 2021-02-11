/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as path from 'path';
import * as fs from 'fs';

import * as yargs from 'yargs';

export const command: string = 'tsc';

export const describe: string = 'Language Server Index Format tool for TypeScript';

export type PublishedPackageOptions = {
	package: string;
	project: string;
}

export namespace PublishedPackageOptions {
	export function is(value: any): value is PublishedPackageOptions {
		const candidate = value as PublishedPackageOptions;
		return candidate && typeof candidate.package === 'string' && typeof candidate.project === 'string';
	}
}

export interface GroupOptions {
	uri?: string;
	conflictResolution?: 'takeDump' | 'takeDB';
	name?: string;
	rootUri?: string;
	description? : string;
	repository?: {
		type: string;
		url: string;
	}
}

export type Options = {
	help: boolean;
	version: boolean;
	config: string | undefined;
	p: string | undefined;
	id: 'number' | 'uuid';
	outputFormat: 'json' | 'line' | 'vis' | 'graphSON';
	stdout: boolean;
	out: string | undefined;
	noContents: boolean;
	noProjectReferences: boolean;
	typeAcquisition: boolean;
	moniker: 'strict' | 'lenient'
	group: string | GroupOptions | undefined;
	projectName: string | undefined;
	package: string | undefined;
	publishedPackages: PublishedPackageOptions[] | undefined;
	log: string | boolean;
}

export namespace Options {
	export const defaults: Options = {
		help: false,
		version: false,
		config: undefined,
		p: undefined,
		id: 'number',
		outputFormat: 'line',
		stdout: false,
		out: undefined,
		noContents: false,
		noProjectReferences: false,
		typeAcquisition: false,
		moniker: 'lenient',
		group: undefined,
		projectName: undefined,
		package: undefined,
		publishedPackages: undefined,
		log: ''
	};

	export function sanitize(options: Options): Options {
		const result = Object.assign({}, options);
		if (!Array.isArray(result.publishedPackages)) {
			result.publishedPackages = undefined;
		}
		if (result.publishedPackages !== undefined) {
			for (let i = 0; i < result.publishedPackages.length; ) {
				if (!PublishedPackageOptions.is(result.publishedPackages[i])) {
					result.publishedPackages.splice(i, 1);
				} else {
					i++;
				}
			}
		}
		if (result.group === undefined || typeof result.group === 'string') {
			return result;
		}
		const group: GroupOptions = {};
		if (typeof result.group.name === 'string') {
			group.name = result.group.name;
		}
		if (typeof result.group.uri === 'string') {
			group.uri = result.group.uri;
		}
		if (result.group.conflictResolution === 'takeDB' || result.group.conflictResolution === 'takeDump') {
			group.conflictResolution = result.group.conflictResolution;
		}
		if (typeof result.group.rootUri === 'string') {
			group.rootUri = result.group.rootUri;
		}
		if (typeof result.group.description === 'string') {
			group.description = result.group.description;
		}
		if (typeof result.group.repository?.type === 'string' && typeof result.group.repository?.url === 'string') {
			group.repository = { url: result.group.repository.url, type: result.group.repository.type };
		}
		Object.keys(group).length > 0 ? result.group = group : result.group = undefined;
		return result;
	}

	export function resolvePathToConfig(options: Options): Options {
		if (options.config === undefined) {
			return options;
		}
		const configDirectory = path.isAbsolute(options.config) ? path.dirname(options.config) : path.dirname(path.join(process.cwd(), options.config));
		function makeAbsolute(value: string): string {
			return path.isAbsolute(value) ? value : path.join(configDirectory, value);
		}

		const result: Options = Object.assign({}, options);
		if (typeof options.group === 'string' && options.group !== 'stdin') {
			result.group = makeAbsolute(options.group);
		}
		if (typeof options.package === 'string') {
			result.package = makeAbsolute(options.package);
		}
		if (Array.isArray(options.publishedPackages)) {
			result.publishedPackages = [];
			for (const item of options.publishedPackages) {
				const newItem: PublishedPackageOptions = {
					package: makeAbsolute(item.package),
					project: makeAbsolute(item.project)
				};
				result.publishedPackages.push(newItem);
			}
		}
		return result;
	}
}

function stripComments(content: string): string {
	const regexp = /("(?:[^\\"]*(?:\\.)?)*")|('(?:[^\\']*(?:\\.)?)*')|(\/\*(?:\r?\n|.)*?\*\/)|(\/{2,}.*?(?:(?:\r?\n)|$))/g;

	return content.replace(regexp, function (match, _m1, _m2, m3, m4) {
		// Only one of m1, m2, m3, m4 matches
		if (m3) {
			// A block comment. Replace with nothing
			return '';
		} else if (m4) {
			// A line comment. If it ends in \r?\n then keep it.
			const length_1 = m4.length;
			if (length_1 > 2 && m4[length_1 - 1] === '\n') {
				return m4[length_1 - 2] === '\r' ? '\r\n' : '\n';
			}
			else {
				return '';
			}
		} else {
			// We match a string
			return match;
		}
	});
}

export function builder(yargs: yargs.Argv): yargs.Argv {
	return yargs.
		option('v', {
			alias: 'version',
			description: 'Output the version number',
			boolean: true
		}).
		option('h', {
			alias: 'help',
			description: 'Output usage information',
			boolean: true
		}).
		options('p', {
			alias: 'project',
			description: 'The TypeScript project file',
			string: true
		}).
		option('outputFormat', {
			description: 'Specifies the output format.',
			choices: ['line', 'json'],
			default: 'line'
		}).
		option('id', {
			description: 'Specifies the id format.',
			choices:['number', 'uuid'],
			default: 'number'
		}).
		option('group', {
			description: 'Specifies the group config file, the group folder or stdin to read the group information from stdin.',
			string: true
		}).
		option('projectName', {
			description: 'Specifies the project name. Defaults to the last directory segment of the tsconfig.json file.',
			string: true
		}).
		option('noContents', {
			description: 'File contents will not be embedded into the dump.',
			boolean: true
		}).
		option('noProjectReferences', {
			description: 'Project references will not be follow and embedded into the dump.',
			boolean: true
		}).
		option('typeAcquisition', {
			description: 'Run automatic type acquisition for JavaScript npm modules.',
			boolean: true
		}).
		option('moniker', {
			description: 'Monikers are use to relate symbols across repositories. In lenient mode the tool will proceed if a moniker was not generated for a visible symbol. In strict mode it will throw an exception.',
			choices: ['strict', 'lenient'],
			default: 'lenient'
		}).
		option('out', {
			description: 'The output file the dump is save to.',
			string: true
		}).
		option('stdout', {
			description: 'Writes the dump to stdout.',
			boolean: true
		}).
		option('package', {
			description: 'The package.json file used to publish the project to npm.',
			string: true
		}).
		option('log', {
			description: 'If provided without a file name then the name of the output file is used with an additional \'.log\' extension.',
			skipValidation: true
		}).
		config('config', 'Specifies a JSON file to read the LSIF configuration from.', (configPath) => {
			try {
				return JSON.parse(stripComments(fs.readFileSync(configPath, { encoding: 'utf8'})));
			} catch (error) {
				if (typeof error.message === 'string') {
					console.log(error.message);
				} else {
					console.log(`Can't read config from file ${configPath}.`);
				}
				return { exitCode: -1 };
			}
		});
}
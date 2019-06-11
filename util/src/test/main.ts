/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as yargs from 'yargs';
import { main } from '../main';

const delay: number = 500;

describe('The console-line interface usage', () => {
    beforeAll(() => {
        // Hijack console functions to suppress logs
        console.log = () => {
            // Empty
        };
        console.error = () => {
            // Empty
        };
    });
    it('Should require at least one command', () => {
        yargs.parse([]);
        main();
        expect(process.exitCode).toBe(1);
    });
    it('Should ask for an input file if none specified and --stdin is missing', () => {
        yargs.parse(['validate']);
        main();
        expect(process.exitCode).toBe(1);
    });
});

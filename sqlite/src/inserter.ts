/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as Sqlite from 'better-sqlite3';

export class Inserter {

	private sqlStmt: Sqlite.Statement;
	private batch: any[];

	public constructor(private db: Sqlite.Database, private stmt: string, private numberOfArgs: number, private batchSize: number) {
		const args = `(${new Array(numberOfArgs).fill('?').join(',')})`;
		this.sqlStmt = db.prepare(`${stmt} Values ${new Array(batchSize).fill(args).join(',')}`);
		this.batch = [];
	}

	public do(...params: any[]): void {
		if (params.length !== this.numberOfArgs) {
			throw new Error(`Wrong number of arguments. Expected ${this.numberOfArgs} but got ${params.length}`);
		}
		this.batch.push(...params);
		if (this.batch.length === this.numberOfArgs * this.batchSize) {
			this.sqlStmt.run(...this.batch);
			this.batch = [];
		}
	}

	public finish(): void {
		if (this.batch.length === 0) {
			return;
		}
		let values: string[] = [];
		for (let i = 0; i < this.batch.length; i = i + this.numberOfArgs) {
			let elem: any[] = [];
			for (let e = 0; e < this.numberOfArgs; e++) {
				let param = this.batch[i + e];
				if (param === null) {
					elem.push('NULL');
				} else {
					elem.push(typeof param === 'string' ? `'${param}'` : param);
				}
			}
			values.push(`(${elem.join(',')})`);
		}
		const stmt = `${this.stmt} Values ${values.join(',')}`;
		this.db.exec(stmt);
	}
}
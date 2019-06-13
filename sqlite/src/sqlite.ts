/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as fs from 'fs';
import * as Sqlite from 'better-sqlite3';

import { Edge, Vertex, ElementTypes, VertexLabels, Document, Range, Project, MetaData, EdgeLabels, contains, PackageInformation, item } from 'lsif-protocol';
// import { itemPropertyShortForms } from './compress';

class Inserter {

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
				elem.push(typeof param === 'string' ? `'${param}'` : param);
			}
			values.push(`(${elem.join(',')})`);
		}
		const stmt = `${this.stmt} Values ${values.join(',')}`;
		this.db.exec(stmt);
	}
}

export class Database {

	private db: Sqlite.Database;
	private insertContentStmt: Sqlite.Statement;
	private vertexInserter: Inserter;
	private edgeInserter: Inserter;
	// private itemInserter: Inserter;
	private rangeInserter: Inserter;
	private documentInserter: Inserter;
	private pendingRanges: Map<number | string, Range>;

	public constructor(filename: string, private stringify: (element: Vertex | Edge) => string, private shortForm: (element: Vertex | Edge) => number) {
		this.pendingRanges = new Map();
		try {
			fs.unlinkSync(filename);
		} catch (err) {
		}
		this.db = new Sqlite(filename);
		this.db.pragma('synchronous = OFF');
		this.db.pragma('journal_mode = MEMORY');
		this.createTables();
		this.insertContentStmt = this.db.prepare('Insert Into contents (id, content) VALUES (?, ?)');
		this.vertexInserter = new Inserter(this.db, 'Insert Into vertices (id, label, value)', 3, 128);
		this.edgeInserter = new Inserter(this.db, 'Insert Into edges (id, label, outV, inV)', 4, 128);
		// this.itemInserter = new Inserter(this.db, 'Insert Into items (id, outV, inV, property)', 4, 128);
		this.rangeInserter = new Inserter(this.db, 'Insert into ranges (id, belongsTo, startLine, startCharacter, endLine, endCharacter)', 6, 128);
		this.documentInserter = new Inserter(this.db, 'Insert Into documents (uri, id)', 2, 5);
	}

	private createTables(): void {
		this.db.exec('Create Table vertices (id Integer Unique Primary Key, label Integer Not Null, value Text Not Null)');
		this.db.exec('Create Table edges (id Integer Unique Primary Key, label Integer Not Null, outV Integer Not Null, inV Integer Not Null)');
		this.db.exec('Create Table meta (id Integer Unique Primary Key, value Text Not Null)');
		this.db.exec('Create Table documents (uri Text Unique Primary Key, id Integer Not Null)');
		this.db.exec('Create Table contents (id Integer Unique Primary Key, content Blob Not Null)');
		this.db.exec('Create Table ranges (id Integer Unique Primary Key, belongsTo Integer Not Null, startLine Integer Not Null, startCharacter Integer Not Null, endLine Integer Not Null, endCharacter Integer Not Null)');
		this.db.exec('Create Table items (id Integer Unique Primary Key, outV Integer Not Null, inV Integer Not Null, property Integer)');
	}

	private createIndices(): void {
		this.db.exec('Create Index edges_outv on edges (outV)');
		this.db.exec('Create Index edges_inv on edges (inV)');
		this.db.exec('Create Index ranges_index on ranges (belongsTo, startLine, endLine, startCharacter, endCharacter)',);
		this.db.exec('Create Index items_outv on items (outV)');
		this.db.exec('Create Index items_inv on items (inV)');
	}

	public runInsertTransaction(cb: (db: Database) => void): void {
		this.db.transaction(() => {
			cb(this);
		})();
	}

	public insert(element: Edge | Vertex): void {
		if (element.type === ElementTypes.vertex) {
			switch (element.label) {
				case VertexLabels.metaData:
					this.insertMetaData(element);
					break;
				case VertexLabels.project:
					this.insertProject(element);
					break;
				case VertexLabels.document:
					this.insertDocument(element);
					break;
				case VertexLabels.packageInformation:
					this.insertPackageInformation(element);
					break;
				case VertexLabels.range:
					this.insertRange(element);
					break;
				default:
					this.insertVertex(element);
			}
		} else {
			switch(element.label) {
				case EdgeLabels.contains:
					this.insertContains(element);
					break;
				case EdgeLabels.item:
					this.insertItem(element);
					break;
				default:
					this.insertEdge(element);
			}
		}
	}

	private insertVertex(vertex: Vertex): void {
		let value = this.stringify(vertex);
		let label = this.shortForm(vertex);
		this.vertexInserter.do(vertex.id, label, value);
	}

	private insertMetaData(vertex: MetaData): void {
		let value = this.stringify(vertex);
		this.db.exec(`Insert Into meta (id, value) Values (${vertex.id}, '${value}')`);
	}

	private insertContent(vertex: Document | Project | PackageInformation): void {
		if (vertex.contents === undefined || vertex.contents === null) {
			return;
		}
		let contents = Buffer.from(vertex.contents, 'base64').toString('utf8');
		this.insertContentStmt.run(vertex.id, contents);
	}

	private insertProject(project: Project): void {
		if (project.resource !== undefined && project.contents !== undefined) {
			this.documentInserter.do(project.resource, project.id);
			this.insertContent(project);
		}
		let newProject = Object.assign(Object.create(null) as object, project);
		newProject.contents = undefined;
		this.insertVertex(newProject);
	}

	private insertDocument(document: Document): void {
		this.documentInserter.do(document.uri, document.id);
		this.insertContent(document);
		let newDocument = Object.assign(Object.create(null) as object, document);
		newDocument.contents = undefined;
		this.insertVertex(newDocument);
	}

	private insertPackageInformation(info: PackageInformation): void {
		if (info.uri !== undefined && info.contents !== undefined) {
			this.documentInserter.do(info.uri, info.id);
			this.insertContent(info);
		}
		let newInfo = Object.assign(Object.create(null) as object, info);
		newInfo.contents = undefined;
		this.insertVertex(newInfo);
	}

	private insertRange(range: Range): void {
		this.insertVertex(range);
		this.pendingRanges.set(range.id, range);
	}

	private insertEdge(edge: Edge): void {
		// let label = this.shortForm(edge);
		// this.edgeInserter.do(edge.id, label, edge.outV, edge.inV);
	}

	private insertContains(contains: contains): void {
		// const range = this.pendingRanges.get(contains.inV);
		// if (range === undefined) {
		// 	this.insertEdge(contains);
		// } else {
		// 	this.pendingRanges.delete(contains.inV);
		// 	this.insertEdge(contains);
		// 	this.rangeInserter.do(range.id, contains.outV, range.start.line, range.start.character, range.end.line, range.end.character);
		// }
	}

	private insertItem(item: item): void {
		// if (item.property !== undefined) {
		// 	this.itemInserter.do(item.id, item.outV, item.inV, itemPropertyShortForms.get(item.property));
		// } else {
		// 	this.itemInserter.do(item.id, item.outV, item.inV, null);
		// }
	}

	public close(): void {
		this.vertexInserter.finish();
		this.edgeInserter.finish();
		this.rangeInserter.finish();
		this.documentInserter.finish();
		if(this.pendingRanges.size > 0) {
			console.error(`Pending ranges exists before DB is closed.`);
		}
		this.createIndices();
		this.db.close();
	}
}
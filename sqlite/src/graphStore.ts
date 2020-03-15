/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as fs from 'fs';
import * as Sqlite from 'better-sqlite3';

import {
	Edge, Vertex, ElementTypes, VertexLabels, Document, Range, Project, MetaData, EdgeLabels, contains,
	PackageInformation, item, Group, Id
} from 'lsif-protocol';

import { itemPropertyShortForms } from './compress';
import { Inserter } from './inserter';
import { Store } from 'store';

type Mode = 'create' | 'import';

export class GraphStore extends Store {

	private db: Sqlite.Database;
	private insertContentStmt: Sqlite.Statement;
	private vertexInserter: Inserter;
	private edgeInserter: Inserter;
	private itemInserter: Inserter;
	private rangeInserter: Inserter;
	private documentInserter: Inserter;
	private groupInserter: Inserter;
	private pendingRanges: Map<number | string, Range>;

	public constructor(input: NodeJS.ReadStream | fs.ReadStream, filename: string, mode: Mode) {
		super(input);
		this.pendingRanges = new Map();
		if (mode === 'import' && fs.existsSync(filename)) {
			this.db = new Sqlite(filename);
			const format = this.db.prepare('Select * from format f').get().format;
			if (format !== 'graph') {
				this.db.close();
				throw new Error(`Can only import an additional dump into a graph DB. Format was ${format}`);
			}
			const maxVertices: Id | undefined = this.db.prepare('Select Max([id]) as max from vertices').get().max;
			const maxEdges: Id | undefined = this.db.prepare('Select Max([id]) as max from edges').get().max;
			if (typeof maxVertices === 'number' && typeof maxEdges === 'number') {
				const delta = Math.max(maxVertices, maxEdges);
				this.setIdTransformer((value: Id) => {
					if (typeof value !== 'number') {
						throw new Error(`Expected number Id but received ${value}`);
					}
					return value + delta;
				});
			}
		} else {
			if (mode === 'create') {
				try {
					fs.unlinkSync(filename);
				} catch (err) {
				}
			}
			this.db = new Sqlite(filename);
			this.createTables();
			this.db.exec(`Insert into format (format) Values ('graph')`);
		}
		this.db.pragma('synchronous = OFF');
		this.db.pragma('journal_mode = MEMORY');

		this.vertexInserter = new Inserter(this.db, 'Insert Into vertices (id, label, value)', 3, 128);
		this.rangeInserter = new Inserter(this.db, 'Insert into ranges (id, belongsTo, startLine, startCharacter, endLine, endCharacter)', 6, 128);
		this.documentInserter = new Inserter(this.db, 'Insert Into documents (uri, id)', 2, 5);
		this.groupInserter = new Inserter(this.db, 'Insert Into groups (uri, id)', 2, 5);
		this.insertContentStmt = this.db.prepare('Insert Into contents (id, content) VALUES (?, ?)');

		this.edgeInserter = new Inserter(this.db, 'Insert Into edges (id, label, outV, inV)', 4, 128);
		this.itemInserter = new Inserter(this.db, 'Insert Into items (id, outV, inV, document, property)', 5, 128);
	}

	private createTables(): void {
		// Vertex information
		this.db.exec('Create Table format (format Text Not Null)');
		this.db.exec('Create Table vertices (id Integer Unique Primary Key, label Integer Not Null, value Text Not Null)');
		this.db.exec('Create Table meta (id Integer Unique Primary Key, value Text Not Null)');
		this.db.exec('Create Table ranges (id Integer Unique Primary Key, belongsTo Integer Not Null, startLine Integer Not Null, startCharacter Integer Not Null, endLine Integer Not Null, endCharacter Integer Not Null)');
		this.db.exec('Create Table documents (uri Text Unique Primary Key, id Integer Not Null)');
		this.db.exec('Create Table contents (id Integer Unique Primary Key, content Blob Not Null)');
		this.db.exec('Create Table groups (uri Text Unique Primary Key, id Integer Not Null)');

		// Edge information
		this.db.exec('Create Table edges (id Integer Not Null, label Integer Not Null, outV Integer Not Null, inV Integer Not Null)');
		this.db.exec('Create Table items (id Integer Not Null, outV Integer Not Null, inV Integer Not Null, document Integer Not Null, property Integer)');
	}

	private createIndices(): void {
		// Index label, outV and inV on edges
		this.db.exec('Create Index edges_outv on edges (outV, label)');
		this.db.exec('Create Index edges_inv on edges (inV, label)');
		this.db.exec('Create Index ranges_index on ranges (belongsTo, startLine, endLine, startCharacter, endCharacter)',);
		this.db.exec('Create Index items_outv on items (outV)');
		this.db.exec('Create Index items_inv on items (inV)');
	}

	public close(): void {
		this.vertexInserter.finish();
		this.edgeInserter.finish();
		this.rangeInserter.finish();
		this.documentInserter.finish();
		this.itemInserter.finish();
		if(this.pendingRanges.size > 0) {
			console.error(`Pending ranges exists before DB is closed.`);
		}
		this.createIndices();
		this.db.close();
	}

	public async run(): Promise<void> {
		// Begin transaction
		await super.run();
		this.close();
		// End transation
	}

	public insert(element: Edge | Vertex): void {
		if (element.type === ElementTypes.vertex) {
			switch (element.label) {
				case VertexLabels.metaData:
					this.insertMetaData(element);
					break;
				case VertexLabels.group:
					this.insertGroup(element);
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

	private insertMetaData(vertex: MetaData): void {
		let value = this.compress(vertex);
		this.db.exec(`Insert Into meta (id, value) Values (${vertex.id}, '${value}')`);
	}

	private insertVertex(vertex: Vertex): void {
		let value = this.compress(vertex);
		let label = this.shortForm(vertex);
		this.vertexInserter.do(vertex.id, label, value);
	}

	private insertContent(vertex: Document | Project | PackageInformation): void {
		if (vertex.contents === undefined || vertex.contents === null) {
			return;
		}
		let contents = Buffer.from(vertex.contents, 'base64').toString('utf8');
		this.insertContentStmt.run(vertex.id, contents);
	}

	private insertGroup(group: Group): void {
		this.groupInserter.do(group.uri, group.id);
		this.insertVertex(group);
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
		let label = this.shortForm(edge);
		if (Edge.is11(edge)) {
			this.edgeInserter.do(edge.id, label, edge.outV, edge.inV);
		} else if (Edge.is1N(edge)) {
			for (let inV of edge.inVs) {
				this.edgeInserter.do(edge.id, label, edge.outV, inV);
			}
		}
	}

	private insertContains(contains: contains): void {
		let label = this.shortForm(contains);
		for (let inV of contains.inVs) {
			const range = this.pendingRanges.get(inV);
			if (range === undefined) {
				this.edgeInserter.do(contains.id, label, contains.outV, inV);
			} else {
				this.pendingRanges.delete(inV);
				this.rangeInserter.do(range.id, contains.outV, range.start.line, range.start.character, range.end.line, range.end.character);
			}
		}
	}

	private insertItem(item: item): void {
		for (let inV of item.inVs) {
			if (item.property !== undefined) {
				this.itemInserter.do(item.id, item.outV, inV, item.document, itemPropertyShortForms.get(item.property));
			} else {
				this.itemInserter.do(item.id, item.outV, inV, item.document, null);
			}
		}
	}
}
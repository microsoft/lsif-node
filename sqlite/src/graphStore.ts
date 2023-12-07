/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as Sqlite from 'better-sqlite3';

import {
	Edge, Vertex, ElementTypes, VertexLabels, Document, Range, Project, MetaData, EdgeLabels, contains,
	PackageInformation, item, Source, Id, Moniker, Event
} from 'lsif-protocol';

import { itemPropertyShortForms } from './compress';
import { Inserter } from './inserter';
import { Store } from './store';

type Mode = 'create' | 'import';

export class GraphStore extends Store {


	private db: Sqlite.Database;
	private checkContentStmt: Sqlite.Statement;
	private insertContentStmt: Sqlite.Statement;

	private vertexInserter: Inserter;
	private projectInserter: Inserter;

	private edgeInserter: Inserter;
	private itemInserter: Inserter;
	private rangeInserter: Inserter;
	private documentInserter: Inserter;
	private monikerInserter: Inserter;

	private source: Source | undefined;
	private pendingDocumentInserts: Map<Id, { uri: string; hash: string }>;
	private pendingRangeInserts: Map<Id, Range>;

	public constructor(input: NodeJS.ReadStream | fs.ReadStream, filename: string, private mode: Mode) {
		super(input);
		this.pendingDocumentInserts = new Map();
		this.pendingRangeInserts = new Map();
		if (mode === 'import' && fs.existsSync(filename)) {
			this.db = new Sqlite(filename);
			const format = (this.db.prepare('Select * from format f').get() as any).format;
			if (format !== 'graph') {
				this.db.close();
				throw new Error(`Can only import an additional dump into a graph DB. Format was ${format}`);
			}
			const maxVertices: Id | undefined = (this.db.prepare('Select Max([id]) as max from vertices').get() as any).max;
			const maxEdges: Id | undefined = (this.db.prepare('Select Max([id]) as max from edges').get() as any).max;
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
		this.projectInserter = new Inserter(this.db, 'Insert Into projects (id, name, sourceId)', 3, 1);
		this.rangeInserter = new Inserter(this.db, 'Insert into ranges (id, belongsTo, startLine, startCharacter, endLine, endCharacter)', 6, 128);
		this.monikerInserter = new Inserter(this.db, 'Insert into monikers (identifier, scheme, kind, uniqueness, id)', 5, 128);
		this.documentInserter = new Inserter(this.db, 'Insert Into documents (projectId, uri, id, documentHash)', 4, 5);
		this.insertContentStmt = this.db.prepare('Insert Into contents (documentHash, content) VALUES (?, ?)');
		this.checkContentStmt = this.db.prepare('Select documentHash from contents Where documentHash = $documentHash');

		this.edgeInserter = new Inserter(this.db, 'Insert Into edges (id, label, outV, inV)', 4, 128);
		this.itemInserter = new Inserter(this.db, 'Insert Into items (id, outV, inV, document, property)', 5, 128);
	}

	private createTables(): void {
		// Meta information
		this.db.exec('Create Table format (format Text Not Null)');
		this.db.exec('Create Table meta (id Integer Unique Primary Key, value Text Not Null)');

		// Vertex information
		this.db.exec('Create Table vertices (id Integer Unique Primary Key, label Integer Not Null, value Text Not Null)');

		// Search tables for vertices.
		this.db.exec('Create table projects (id Integer Unique Primary Key, name Text Not Null, sourceId Integer Not Null)');
		this.db.exec('Create Table ranges (id Integer Unique Primary Key, belongsTo Integer Not Null, startLine Integer Not Null, startCharacter Integer Not Null, endLine Integer Not Null, endCharacter Integer Not Null)');
		this.db.exec('Create Table monikers (identifier Text Not Null, scheme Text Not Null, kind Integer, uniqueness Integer Not Null, id Integer Unique)');
		this.db.exec('Create Table documents (projectId Integer Not Null, uri Text Not Null, id Integer Not Null, documentHash Text Not Null, Primary Key(projectId, uri))');
		this.db.exec('Create Table contents (documentHash Text Unique Primary Key, content Blob Not Null)');

		// Edge information
		this.db.exec('Create Table edges (id Integer Not Null, label Integer Not Null, outV Integer Not Null, inV Integer Not Null)');

		// Search tables for edges.
		this.db.exec('Create Table items (id Integer Not Null, outV Integer Not Null, inV Integer Not Null, document Integer Not Null, property Integer)');
	}

	private createIndices(): void {
		// Index label, outV and inV on edges
		this.db.exec('Create Index edges_outv on edges (outV, label)');
		this.db.exec('Create Index edges_inv on edges (inV, label)');
		this.db.exec('Create Index ranges_index on ranges (belongsTo, startLine, endLine, startCharacter, endCharacter)');
		this.db.exec('Create Index items_outv on items (outV)');
		this.db.exec('Create Index items_inv on items (inV)');
		this.db.exec('Create Index monikers_index on monikers (identifier, scheme, uniqueness)');
	}

	public close(): void {
		this.vertexInserter.finish();
		this.projectInserter.finish();
		this.rangeInserter.finish();
		this.monikerInserter.finish();
		this.documentInserter.finish();

		this.edgeInserter.finish();
		this.itemInserter.finish();
		if (this.pendingDocumentInserts.size > 0) {
			console.error(`${this.pendingDocumentInserts.size} pending documents exists before DB is closed.`);
		}
		if (this.pendingRangeInserts.size > 0) {
			console.error(`${this.pendingRangeInserts.size} pending ranges exists before DB is closed.`);
		}
		if (this.mode === 'create') {
			this.createIndices();
		}
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
				case VertexLabels.event:
					this.handleEvent(element);
					break;
				case VertexLabels.source:
					this.insertSource(element);
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
				case VertexLabels.moniker:
					this.insertMoniker(element);
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

	private handleEvent(_event: Event): void {
	}

	private insertMetaData(vertex: MetaData): void {
		if (this.mode === 'create') {
			const value = this.compress(vertex);
			this.db.exec(`Insert Into meta (id, value) Values (${vertex.id}, '${value}')`);
		} else {
			const stored: MetaData = JSON.parse((this.db.prepare(`Select id, value from meta`).get() as any).value);
			if (vertex.version !== stored.version || vertex.positionEncoding !== stored.positionEncoding) {
				this.db.close();
				throw new Error(`Index can't be merged into DB. Version, position encoding or project root differs.`);
			}
		}
	}

	private insertSource(source: Source): void {
		this.source = source;
		this.insertVertex(source);
	}

	private insertProject(project: Project): void {
		const id = this.transformId(project.id);
		this.projectInserter.do(id, project.name, this.source?.id);
		if (project.resource !== undefined && project.contents !== undefined) {
			const hash = this.insertContent(project);
			if (hash !== undefined) {
				this.documentInserter.do(id, project.resource, id, hash);
			}
		}
		const newProject = Object.assign(Object.create(null) as object, project);
		newProject.contents = undefined;
		this.insertVertex(newProject);
	}

	private insertRange(range: Range): void {
		this.insertVertex(range);
		const id = this.transformId(range.id);
		this.pendingRangeInserts.set(id, range);
	}

	private insertMoniker(moniker: Moniker): void {
		const kind: number = this.shortFormMonikerKind(moniker.kind);
		const unique: number = this.shortFormMonikerUnique(moniker.unique);
		this.monikerInserter.do(moniker.identifier, moniker.scheme, kind, unique, this.transformId(moniker.id));
		this.insertVertex(moniker);
	}

	private insertDocument(document: Document): void {
		const hash = this.insertContent(document);
		if (hash !== undefined) {
			const id = this.transformId(document.id);
			this.pendingDocumentInserts.set(id, { uri: document.uri, hash });
		}
		const newDocument = Object.assign(Object.create(null) as object, document);
		newDocument.contents = undefined;
		this.insertVertex(newDocument);
	}

	private insertPackageInformation(info: PackageInformation): void {
		if (info.uri !== undefined && info.contents !== undefined) {
			const hash = this.insertContent(info);
			if (hash !== undefined) {
				this.documentInserter.do(-1, info.uri, this.transformId(info.id), hash);
			}
		}
		const newInfo = Object.assign(Object.create(null) as object, info);
		newInfo.contents = undefined;
		this.insertVertex(newInfo);
	}

	private insertContent(vertex: Document | Project | PackageInformation): string | undefined {
		if (vertex.contents === undefined || vertex.contents === null) {
			return undefined;
		}
		const contents = Buffer.from(vertex.contents, 'base64').toString('utf8');
		const hash = crypto.createHash('md5').update(contents).digest('base64');
		const exist = this.checkContentStmt.get({ documentHash: hash });
		if (exist === undefined) {
			this.insertContentStmt.run(hash, contents);
		}
		return hash;
	}

	private insertVertex(vertex: Vertex): void {
		const value = this.compress(vertex);
		const label = this.shortForm(vertex);
		this.vertexInserter.do(this.transformId(vertex.id), label, value);
	}

	private insertEdge(edge: Edge): void {
		const label = this.shortForm(edge);
		if (Edge.is11(edge)) {
			this.edgeInserter.do(this.transformId(edge.id), label, this.transformId(edge.outV), this.transformId(edge.inV));
		} else if (Edge.is1N(edge)) {
			const id = this.transformId(edge.id);
			const outV = this.transformId(edge.outV);
			for (const inV of edge.inVs) {
				this.edgeInserter.do(id, label, outV, this.transformId(inV));
			}
		}
	}

	private insertContains(contains: contains): void {
		const label = this.shortForm(contains);
		const id = this.transformId(contains.id);
		const outV = this.transformId(contains.outV);

		for (const element of contains.inVs) {
			const inV = this.transformId(element);
			const document = this.pendingDocumentInserts.get(inV);
			const range = this.pendingRangeInserts.get(inV);
			if (document !== undefined && range !== undefined) {
				throw new Error(`Found pending documents and ranges for the same contains edge`);
			}
			if (document !== undefined) {
				this.pendingDocumentInserts.delete(inV);
				this.documentInserter.do(outV, document.uri, inV, document.hash);
			} else if (range !== undefined) {
				this.pendingRangeInserts.delete(inV);
				this.rangeInserter.do(this.transformId(range.id), outV, range.start.line, range.start.character, range.end.line, range.end.character);
			} else {
				this.edgeInserter.do(this.transformId(id), label, outV, inV);
			}
		}
	}

	private insertItem(item: item): void {
		const id = this.transformId(item.id);
		const outV = this.transformId(item.outV);
		const shard = this.transformId(item.shard);
		for (const element of item.inVs) {
			const inV = this.transformId(element);
			if (item.property !== undefined) {
				this.itemInserter.do(id, outV, inV, shard, itemPropertyShortForms.get(item.property));
			} else {
				this.itemInserter.do(id, outV, inV, shard, null);
			}
		}
	}
}
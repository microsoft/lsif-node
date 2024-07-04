/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import assert from 'assert';
import { JsonStore } from '../jsonStore';
import path from 'path';

suite('JSON Dump', async () => {

	let store: JsonStore;

	setup(async () => {
		store = new JsonStore();
		await store.load(path.join(__dirname, '..', '..', 'src', 'tests', 'dump.lsif'));
	});

	test('document symbols', async () => {
		const symbols = store.documentSymbols('file:///lsif-node/protocol/src/protocol.ts');
		assert.ok(symbols !== undefined);
		assert.strictEqual(symbols!.length, 128);
	});

	test('references', async () => {
		const references = store.references('file:///lsif-node/protocol/src/protocol.ts', { line: 7, character: 11 }, { includeDeclaration: true });
		assert.ok(references !== undefined);
		assert.strictEqual(references!.length, 10);
	});
});

suite('Rust dump', async () => {
	let store: JsonStore;

	setup(async () => {
		store = new JsonStore();
		await store.load(path.join(__dirname, '..', '..', 'src', 'tests', 'rust.lsif'));
	});

	test('Normalized URIs', async() => {
		assert.strictEqual(store.getWorkspaceRoot().toString(true), 'file:///c:/fixtures/fix-test-failure/case9');
		const documents = store.getDocumentInfos();
		assert.strictEqual(documents.length, 2);
		assert.strictEqual(documents[0].uri.toString(), 'file:///c:/fixtures/fix-test-failure/case9/src/lib.rs');
		assert.strictEqual(documents[1].uri.toString(), 'file:///c:/.rustup/toolchains/stable-x86_64-pc-windows-msvc/lib/rustlib/src/rust/library/core/src/macros/mod.rs');
	});
});
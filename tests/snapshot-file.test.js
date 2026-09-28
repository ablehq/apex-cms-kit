import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetContentMemo } from '../src/server/content/read.ts';
import {
	DEFAULT_SNAPSHOT_PATH,
	SnapshotFileError,
	fileContentStore,
	snapshotCollections,
	snapshotPath
} from '../src/server/content/snapshot-file.node.ts';

let dir;
const originalPath = process.env.CMS_SNAPSHOT_PATH;
const envelope = (version, values) =>
	JSON.stringify({
		version,
		publishedAt: '2026-01-01T00:00:00Z',
		publishedBy: 'test',
		accountId: 'test',
		counts: {},
		warnings: [],
		collections: { pages: values }
	});
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'kit-snapshot-'));
	resetContentMemo();
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	resetContentMemo();
	if (originalPath === undefined) delete process.env.CMS_SNAPSHOT_PATH;
	else process.env.CMS_SNAPSHOT_PATH = originalPath;
});

describe('Node snapshot adapter', () => {
	it('uses default and nonempty configured paths', () => {
		delete process.env.CMS_SNAPSHOT_PATH;
		assert.equal(snapshotPath(), DEFAULT_SNAPSHOT_PATH);
		process.env.CMS_SNAPSHOT_PATH = '';
		assert.equal(snapshotPath(), 'cms/snapshot.json');
		process.env.CMS_SNAPSHOT_PATH = 'custom/file.json';
		assert.equal(snapshotPath(), 'custom/file.json');
	});
	it('returns null only for missing paths, including dangling symlinks', async () => {
		const missing = join(dir, 'missing');
		assert.equal(await fileContentStore(missing).get('content'), null);
		const link = join(dir, 'link');
		symlinkSync(missing, link);
		assert.equal(await fileContentStore(link).get('content'), null);
		await assert.rejects(snapshotCollections(missing), /no published snapshot/);
	});
	it('preserves exact non-ASCII bytes and creates nested directories', async () => {
		const path = join(dir, 'nested', 'snapshot.json');
		const raw = envelope('v1', [{ title: 'नमस्ते — hello' }]) + '\n';
		const store = fileContentStore(path);
		await store.put('content', raw);
		assert.equal(readFileSync(path, 'utf8'), raw);
		assert.equal(await store.get('content'), raw);
		assert.deepEqual(await snapshotCollections(path), { pages: [{ title: 'नमस्ते — hello' }] });
	});
	it('does not mask directories, invalid ancestors or symlink loops as absent', async () => {
		const ancestor = join(dir, 'file');
		writeFileSync(ancestor, 'x');
		const loop = join(dir, 'loop');
		symlinkSync(loop, loop);
		for (const path of [dir, join(ancestor, 'child'), loop]) {
			await assert.rejects(fileContentStore(path).get('content'), SnapshotFileError);
			await assert.rejects(snapshotCollections(path), /could not read/);
		}
		await assert.rejects(
			fileContentStore(join(ancestor, 'child')).put('content', 'x'),
			/could not write/
		);
	});
	it('refuses a missing snapshot even when the shared reader has a warm memo', async () => {
		const path = join(dir, 'snapshot.json');
		writeFileSync(path, envelope('v1', ['first']));
		assert.deepEqual(await snapshotCollections(path), { pages: ['first'] });
		rmSync(path);
		await assert.rejects(snapshotCollections(path), /no published snapshot/);
	});
	it('shares reader memo/reset identity and rejects malformed JSON when read', async () => {
		const path = join(dir, 'snapshot.json');
		writeFileSync(path, envelope('v1', ['first']));
		assert.deepEqual(await snapshotCollections(path), { pages: ['first'] });
		writeFileSync(path, envelope('v2', ['second']));
		resetContentMemo();
		assert.deepEqual(await snapshotCollections(path), { pages: ['second'] });
		writeFileSync(path, 'not JSON');
		resetContentMemo();
		await assert.rejects(snapshotCollections(path));
	});
});

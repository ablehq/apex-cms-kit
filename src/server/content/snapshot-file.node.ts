/** Node-only file adapter. Import directly from build/CLI code, never a browser barrel. */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readContent, type ContentStore } from './read';

export const DEFAULT_SNAPSHOT_PATH = 'cms/snapshot.json';

export function snapshotPath(): string {
	return globalThis.process?.env?.CMS_SNAPSHOT_PATH || DEFAULT_SNAPSHOT_PATH;
}

export class SnapshotFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SnapshotFileError';
	}
}

/** A dangling symlink is ENOENT too, matching the previous missing-file behavior. */
function isMissing(error: unknown): boolean {
	return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

export function fileContentStore(path: string): ContentStore {
	return {
		async get() {
			try {
				return readFileSync(path, 'utf8');
			} catch (cause) {
				if (isMissing(cause)) return null;
				throw new SnapshotFileError(`could not read the snapshot at ${path}: ${String(cause)}`);
			}
		},
		async put(_key, value) {
			try {
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, value);
			} catch (cause) {
				throw new SnapshotFileError(`could not write the snapshot to ${path}: ${String(cause)}`);
			}
		}
	};
}

/** Keep the missing-path check outside readContent's memo; parsed envelope semantics stay with it. */
export async function snapshotCollections(
	path = snapshotPath()
): Promise<Record<string, unknown[]>> {
	try {
		if (!statSync(path).isFile()) throw new Error('snapshot path is not a file');
	} catch (cause) {
		if (isMissing(cause)) {
			throw new SnapshotFileError(
				`no published snapshot at ${path} — set CMS_SNAPSHOT_PATH, or fetch the published one before building.`
			);
		}
		throw new SnapshotFileError(`could not read the snapshot at ${path}: ${String(cause)}`);
	}
	return (await readContent(fileContentStore(path))).collections;
}

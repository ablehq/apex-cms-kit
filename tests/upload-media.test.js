// @ts-nocheck — node:test suite over the browser upload helper; behaviour is the contract.
import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';

import { uploadMedia } from '../src/admin/upload-media.js';
import { UPLOAD_LIMIT_BYTES, declaredContentType } from '../src/admin/media-types.js';

/**
 * A stand-in for a chosen `File`. Only four members are touched — `name`, `type`,
 * `size` and `arrayBuffer()` — and a literal keeps the size tests from allocating
 * 25 MiB just to prove a comparison.
 */
function fakeFile({ name = 'photo.png', type = 'image/png', size, bytes = null } = {}) {
	const body = bytes ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
	return {
		name,
		type,
		size: size ?? body.length,
		async arrayBuffer() {
			return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
		}
	};
}

/**
 * A client that records every call. `sign` and `finalize` answer whatever the test
 * hands them; anything not overridden succeeds, so a test only states what it is
 * about.
 */
function fakeClient(calls, { sign, finalize } = {}) {
	return {
		async signMediaUpload(payload) {
			calls.push(['sign', payload]);
			if (typeof sign === 'function') return sign(payload);
			return {
				ok: true,
				status: 200,
				uploadUrl: 'https://storage.test/put/abc',
				uploadHeaders: { 'Content-Type': payload.file.content_type },
				signedId: 'signed-abc'
			};
		},
		async finalizeMediaUpload(payload) {
			calls.push(['finalize', payload]);
			if (typeof finalize === 'function') return finalize(payload);
			return { ok: true, status: 200, galleryItemId: 'item-1', mediumId: 'medium-1' };
		}
	};
}

/** Swap `fetch` for the PUT leg, recording it in the same ordered list. */
function stubFetch(calls, impl) {
	const original = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		calls.push(['PUT', url, init?.method]);
		return impl ? impl(url, init) : { ok: true, status: 204 };
	};
	return () => {
		globalThis.fetch = original;
	};
}

let restore = null;
afterEach(() => {
	if (restore) restore();
	restore = null;
});

describe('uploadMedia — refusals cost nothing', () => {
	it('refuses a type outside the gallery list with ZERO client calls', async () => {
		const calls = [];
		restore = stubFetch(calls);
		const result = await uploadMedia(fakeClient(calls), {
			gallery: 'images',
			file: fakeFile({ name: 'clip.mp4', type: 'video/mp4' })
		});
		assert.equal(result.ok, false);
		assert.equal(result.reason, 'type-not-allowed');
		// The message must name what IS allowed, or the editor has to guess.
		assert.match(result.message, /JPEG, PNG, GIF or WebP/u);
		// The whole point of checking first: nothing was signed, nothing was stored.
		assert.deepEqual(calls, []);
	});

	it('refuses SVG and the literal image/*, which Apex itself would accept', async () => {
		const calls = [];
		restore = stubFetch(calls);
		for (const type of ['image/svg+xml', 'image/*']) {
			const result = await uploadMedia(fakeClient(calls), {
				gallery: 'images',
				file: fakeFile({ name: 'thing.svg', type })
			});
			assert.equal(result.ok, false, `${type} must be refused`);
			assert.equal(result.reason, 'type-not-allowed');
		}
		assert.deepEqual(calls, []);
	});

	it('refuses at the size boundary — the largest that lands is one byte under', async () => {
		const calls = [];
		restore = stubFetch(calls);
		const refused = await uploadMedia(fakeClient(calls), {
			gallery: 'files',
			file: fakeFile({ name: 'big.pdf', type: 'application/pdf', size: UPLOAD_LIMIT_BYTES })
		});
		// EXACTLY 26,214,400 is refused: Rails' `less_than: 25.megabytes` answers 422 at
		// finalize for that size, measured. An inclusive limit would ship it upstream.
		assert.equal(refused.ok, false);
		assert.equal(refused.reason, 'too-large');
		assert.match(refused.message, /25 MB/u);
		assert.deepEqual(calls, [], 'an oversized file costs no upload at all');

		const allowed = await uploadMedia(fakeClient(calls), {
			gallery: 'files',
			file: fakeFile({ name: 'ok.pdf', type: 'application/pdf', size: UPLOAD_LIMIT_BYTES - 1 })
		});
		assert.equal(allowed.ok, true, 'one byte under the limit must proceed');
	});

	it('refuses an unknown gallery and an empty file, before signing', async () => {
		const calls = [];
		restore = stubFetch(calls);
		const bogus = await uploadMedia(fakeClient(calls), {
			gallery: 'documents',
			file: fakeFile({ name: 'a.pdf', type: 'application/pdf' })
		});
		assert.equal(bogus.reason, 'no-such-gallery');
		const empty = await uploadMedia(fakeClient(calls), {
			gallery: 'files',
			file: fakeFile({ name: 'a.pdf', type: 'application/pdf', size: 0 })
		});
		assert.equal(empty.reason, 'empty-file');
		assert.deepEqual(calls, []);
	});
});

describe('uploadMedia — the .csv correction', () => {
	it('declares text/csv for a .csv the browser called an Excel file', () => {
		// Windows reports `.csv` as `application/vnd.ms-excel`, which Apex 422s at sign.
		assert.equal(
			declaredContentType({ name: 'members.csv', type: 'application/vnd.ms-excel' }),
			'text/csv'
		);
		assert.equal(declaredContentType({ name: 'MEMBERS.CSV', type: '' }), 'text/csv');
		// Everything else is taken at face value — no broader guessing.
		assert.equal(
			declaredContentType({ name: 'a.pdf', type: 'application/pdf' }),
			'application/pdf'
		);
	});

	it('uploads that .csv instead of refusing it', async () => {
		const calls = [];
		restore = stubFetch(calls);
		const result = await uploadMedia(fakeClient(calls), {
			gallery: 'files',
			file: fakeFile({
				name: 'members.csv',
				type: 'application/vnd.ms-excel',
				bytes: new Uint8Array([0x61, 0x2c, 0x62])
			})
		});
		assert.equal(result.ok, true);
		// The CORRECTED type is what reaches the server, not the browser's guess.
		assert.equal(calls[0][1].file.content_type, 'text/csv');
	});
});

describe('uploadMedia — the three legs', () => {
	it('signs, PUTs and finalizes exactly once each, in that order', async () => {
		const calls = [];
		restore = stubFetch(calls);
		const phases = [];
		const result = await uploadMedia(fakeClient(calls), {
			gallery: 'images',
			file: fakeFile({ name: 'hero.png', type: 'image/png' }),
			title: 'Hero',
			alt: 'A hero',
			onPhase: (p) => phases.push(p)
		});
		assert.deepEqual(result, { ok: true, galleryItemId: 'item-1' });
		assert.deepEqual(
			calls.map((c) => c[0]),
			['sign', 'PUT', 'finalize']
		);
		// The sign body carries NO caption and NO gallery item — that is the design.
		assert.deepEqual(Object.keys(calls[0][1]).sort(), ['file', 'gallery']);
		assert.equal(calls[0][1].gallery, 'images');
		assert.equal(calls[0][1].file.filename, 'hero.png');
		assert.ok(calls[0][1].file.checksum.length > 0, 'a content-MD5 is computed');
		assert.equal(calls[1][2], 'PUT');
		// The caption and alt travel with FINALIZE, which is what creates the item.
		assert.deepEqual(calls[2][1], {
			gallery: 'images',
			signedId: 'signed-abc',
			title: 'Hero',
			alt: 'A hero'
		});
		// "Preparing…" before "Uploading…": hashing 25 MiB is half a second of nothing.
		assert.deepEqual(phases, ['preparing', 'uploading', 'saving']);
	});

	it('reports store-failed on a non-2xx PUT, and finalizes nothing', async () => {
		const calls = [];
		restore = stubFetch(calls, async () => ({ ok: false, status: 422 }));
		const result = await uploadMedia(fakeClient(calls), {
			gallery: 'images',
			file: fakeFile()
		});
		assert.equal(result.ok, false);
		assert.equal(result.reason, 'store-failed');
		// Nothing was created, so there is nothing to roll back and no cleanup call.
		assert.deepEqual(
			calls.map((c) => c[0]),
			['sign', 'PUT']
		);
	});

	it('reports finalize-failed, and still creates nothing to clean up', async () => {
		const calls = [];
		restore = stubFetch(calls);
		const result = await uploadMedia(
			fakeClient(calls, {
				finalize: () => ({ ok: false, status: 502, error: 'upstream error' })
			}),
			{ gallery: 'images', file: fakeFile() }
		);
		assert.equal(result.ok, false);
		assert.equal(result.reason, 'finalize-failed');
		assert.deepEqual(
			calls.map((c) => c[0]),
			['sign', 'PUT', 'finalize']
		);
	});

	it('reports sign-failed when the signature comes back incomplete', async () => {
		const calls = [];
		restore = stubFetch(calls);
		const result = await uploadMedia(
			fakeClient(calls, {
				sign: () => ({ ok: true, status: 200, uploadUrl: null, signedId: null })
			}),
			{ gallery: 'images', file: fakeFile() }
		);
		assert.equal(result.reason, 'sign-failed');
		// No PUT to a null URL.
		assert.deepEqual(
			calls.map((c) => c[0]),
			['sign']
		);
	});

	it("surfaces Apex's own message instead of a generic apology", async () => {
		const calls = [];
		restore = stubFetch(calls);
		const result = await uploadMedia(
			fakeClient(calls, {
				sign: () => ({
					ok: false,
					status: 422,
					error: 'Content type image/avif is not a valid kind'
				})
			}),
			{ gallery: 'images', file: fakeFile() }
		);
		assert.equal(result.reason, 'sign-failed');
		assert.equal(result.message, 'Content type image/avif is not a valid kind');
	});
});

describe('uploadMedia — a rejected promise is that leg failing', () => {
	for (const leg of ['sign', 'PUT', 'finalize']) {
		it(`treats a thrown ${leg} as ${leg === 'PUT' ? 'store' : leg}-failed`, async () => {
			const calls = [];
			const boom = () => {
				throw new Error('network down');
			};
			restore = stubFetch(calls, leg === 'PUT' ? boom : undefined);
			const client = fakeClient(calls, {
				sign: leg === 'sign' ? boom : undefined,
				finalize: leg === 'finalize' ? boom : undefined
			});
			const result = await uploadMedia(client, { gallery: 'images', file: fakeFile() });
			assert.equal(result.ok, false);
			assert.equal(result.reason, leg === 'PUT' ? 'store-failed' : `${leg}-failed`);
			// A thrown leg has no server message, so the fallback sentence is used —
			// and it is a sentence, not an exception reaching the screen.
			assert.ok(result.message.length > 0);
		});
	}
});

// @ts-nocheck — legacy-mode admin browser module (plan §8, 3a compile-mode (a)).
// Deliberately untyped JS to sit beside the legacy-compiled admin components; its
// behavior is covered by tests/admin-save-page.test.js + tests/bff-realapex.test.js.
// The browser's ONLY door to the server (plan §8, 3a "the browser talks only to
// same-origin server routes"). Every method here calls a same-origin `/api/admin/*`
// BFF route — never Apex, never with any Apex token. The BFF resolves the editor's
// server-side session and calls Apex with THAT PERSON's Apex staff token, which this
// file never sees and could not read if it wanted to: the session cookie is httpOnly.
//
// Mutations attach the double-submit CSRF header the boundary verifies, read from the
// `apex_bff_csrf` cookie the admin session issued (hooks.server.ts, F3). The browser
// supplies Origin + Sec-Fetch-Site itself; `credentials: 'same-origin'` sends the
// session + CSRF cookies. Reads throw on failure (savePage catches); mutations resolve
// to a normalized `{ ok, status, ... }` so the caller can branch without a try/catch.

import { CSRF_COOKIE } from '../cookies.js';

function readCsrfToken() {
	if (typeof document === 'undefined') return '';
	for (const pair of document.cookie.split(';')) {
		const index = pair.indexOf('=');
		if (index === -1) continue;
		if (pair.slice(0, index).trim() === CSRF_COOKIE) {
			return decodeURIComponent(pair.slice(index + 1).trim());
		}
	}
	return '';
}

/**
 * `@ts-nocheck` suppresses errors in THIS file; the annotation below still types
 * every importer. `BffClient` in `./types.d.ts` mirrors the object returned here,
 * method for method, and its return shapes are those of the BFF operations in
 * `src/lib/server/bff/operations/`.
 *
 * `extend` is how a site adds its own methods over the SAME transport: it receives
 * `get` and `mutate` and returns an object merged over the base client. It is not
 * given the internal `readJson` — neither site ever destructured it.
 *
 * @param {{ fetchImpl?: typeof fetch, csrfToken?: string | (() => string), extend?: (transport: { get: Function, mutate: Function }) => object }} [options]
 * @returns {import('./types').BffClient}
 */
export function createBffClient({ fetchImpl = fetch, csrfToken, extend } = {}) {
	const getToken = typeof csrfToken === 'function' ? csrfToken : () => csrfToken ?? readCsrfToken();

	async function readJson(response) {
		try {
			return await response.json();
		} catch {
			return null;
		}
	}

	async function get(path) {
		const response = await fetchImpl(path, {
			method: 'GET',
			credentials: 'same-origin',
			headers: { accept: 'application/json' }
		});
		if (!response.ok) {
			const body = await readJson(response);
			const error = new Error(body?.error || `request failed (${response.status})`);
			error.status = response.status;
			throw error;
		}
		return readJson(response);
	}

	async function mutate(path, method, body) {
		const response = await fetchImpl(path, {
			method,
			credentials: 'same-origin',
			headers: {
				accept: 'application/json',
				'content-type': 'application/json',
				'x-csrf-token': getToken()
			},
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		const parsed = await readJson(response);
		return {
			ok: response.ok,
			status: response.status,
			...(parsed && typeof parsed === 'object' ? parsed : {})
		};
	}

	const base = {
		/**
		 * Sign in with Apex staff credentials. The credentials go to the same-origin
		 * BFF, which performs the Apex password grant server-side; the response body
		 * carries an email and a display name and no token of any kind. The session
		 * itself arrives as an httpOnly cookie this code cannot read.
		 */
		login(email, password) {
			return mutate('/api/admin/auth/login', 'POST', { email, password });
		},
		/** End the session server-side (the row is deleted; the cookie is cleared). */
		logout() {
			return mutate('/api/admin/auth/logout', 'POST');
		},
		async listPages(query = {}) {
			const params = new URLSearchParams();
			for (const [key, value] of Object.entries(query)) {
				if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
			}
			const suffix = params.toString();
			const body = await get(`/api/admin/pages${suffix ? `?${suffix}` : ''}`);
			return Array.isArray(body?.pages) ? body.pages : [];
		},
		async listTemplates() {
			const body = await get('/api/admin/page-block-templates');
			return Array.isArray(body?.templates) ? body.templates : [];
		},
		getPage(pageId) {
			return get(`/api/admin/pages/${pageId}`);
		},
		readVersion(pageId) {
			return get(`/api/admin/pages/${pageId}/version`);
		},
		patchEntityFields(entityTypeId, entityId, fieldsData) {
			return mutate(`/api/admin/entities/${entityTypeId}/${entityId}`, 'PATCH', {
				fields_data: fieldsData
			});
		},
		savePageStructure(pageId, payload) {
			return mutate(`/api/admin/pages/${pageId}/structure`, 'PATCH', payload);
		},
		changePageStatus(pageId, statusEvent) {
			return mutate(`/api/admin/pages/${pageId}/status`, 'PATCH', { status_event: statusEvent });
		},
		// Media upload path (MediaPickerModal). `sign` creates the gallery item + a
		// signed storage URL; the browser PUTs the file to that URL directly (it is a
		// storage URL, not Apex); `finalize` records the medium. All same-origin.
		signMediaUpload(payload) {
			return mutate('/api/admin/media/uploads', 'POST', payload);
		},
		// Publish. NOT an Apex call — it refreshes the committed snapshot the public
		// site is built from and rebuilds it. `mutate` normalizes every outcome to
		// `{ ok, status, ... }`, which is what lets the rail report a 501
		// `publish_not_configured` as the plain sentence the server sent rather than
		// as a thrown error or, worse, as success.
		publishSite(options = {}) {
			return mutate('/api/admin/site/publish', 'POST', options);
		},
		siteStatus() {
			return get('/api/admin/site/publish');
		},
		finalizeMediaUpload(payload) {
			return mutate('/api/admin/media', 'POST', payload);
		},

		// ── Images (3d) ──────────────────────────────────────────────────────────
		//
		// There is no `createImage`. An image is created by uploading BYTES, and that
		// leg is bring-up-gated (§2.7): the signed upload URL Apex hands back points at
		// a port it does not serve. `listImages` reports the gate as `uploadEnabled` so
		// the screen can disable the control and say why, instead of offering an upload
		// that would stall forever and leave a captioned item with no picture.

		async listImages() {
			const body = await get('/api/admin/images');
			return {
				images: Array.isArray(body?.images) ? body.images : [],
				galleryId: typeof body?.galleryId === 'string' ? body.galleryId : '',
				uploadEnabled: body?.uploadEnabled === true,
				uploadDisabledReason:
					typeof body?.uploadDisabledReason === 'string' ? body.uploadDisabledReason : ''
			};
		},
		/** Caption and alt only. Position is not writable — this screen cannot reorder. */
		updateImage(imageId, fields) {
			return mutate(`/api/admin/images/${encodeURIComponent(imageId)}`, 'PATCH', fields);
		},
		/**
		 * Unguarded, unlike `deleteAuthor`: nothing in Apex answers "what references
		 * this image", so there is no count to show first. The screen carries that
		 * warning rather than implying a check it cannot perform.
		 */
		deleteImage(imageId) {
			return mutate(`/api/admin/images/${encodeURIComponent(imageId)}`, 'DELETE');
		}
	};
	// A site adds its own methods over the same `get`/`mutate`, never a second transport.
	return extend ? { ...base, ...extend({ get, mutate }) } : base;
}

// @ts-nocheck — legacy-mode admin browser module (plan §8, 3a compile-mode (a)).
// Deliberately untyped JS to sit beside the legacy-compiled admin components; its
// behavior is covered by tests/admin-save-page.test.js + tests/bff-realapex.test.js.
import {
	adoptListChildId,
	BUNDLE_BLOCKABLE,
	newBundleEntities,
	dirtyEntityPatches,
	editedListChildren,
	newListChildren,
	structurePayload,
	reconcile
} from './page-draft.js';
import { isTempId } from './block-serialize.js';
import { BLANK_SLUG_MESSAGE, RESERVED_SLUG_MESSAGE } from './field-errors.js';

// The one explicit save (plan §8, 3a M1, "One explicit savePage() — no autosave, no
// coordinator"). This is the WHOLE persistence path: no debounce helper, no
// coordinator store, no flush registry, no barrier. It is a plain async function of a
// draft and a BFF client, so its invariants — write order, stop-on-partial-failure,
// the stale guard checked once, re-baseline — are unit-testable without a DOM or a
// network.
//
// Write order, exactly:
//   1. Stale guard, ONCE: read the composite version; if it moved, refuse (recoverable).
//   2. Per-entity field PATCHes, in order; STOP on the first failure.
//   3. Page structure (order / add / remove); STOP on failure.
//   3b. Fields of the blocks that step 3 just minted (a duplicated section carries
//       its source's fields on a temp entity; Rails permits no `fields_data` under
//       `entity_attributes`, so they are PATCHed once the entity has a real id).
//   3c. Page SEO on its own route, so description-only edits cannot be skipped by
//       the structure gate (phase-4-plan.md §1.2); STOP on failure.
//   4. Status event (publish / unpublish), only when asked; never after any failure.
// Publish is the SAME function with `statusEvent: 'publish'` — it awaits every prior
// step and never dispatches the status if an earlier step failed (plan M1).

export const STALE_MESSAGE =
	'This page was changed somewhere else since you opened it. Reload to get the latest version, then re-apply your changes.';

function messageFor(stage, result, names = []) {
	const status = result?.status;
	if (stage === 'fields') {
		return status === 422
			? 'A section field was rejected (check required values). Your other changes were not saved yet — fix it and Save again.'
			: 'Saving a section field failed. Nothing after it was saved — Save again to retry.';
	}
	// ── THE THREE CHILD STAGES, AND WHY THEY CANNOT SHARE A SENTENCE ──────────
	// They used to. The shared sentence ended "Nothing on the page was saved", which
	// is true of exactly ONE of them — and telling an editor nothing was saved when
	// half their rows were is worse than saying nothing at all: the obvious response
	// is to redo the work, and the half that DID save is then done twice.
	if (stage === 'children') {
		// A new `array_ref` row: a FREE-STANDING entity, created before the section
		// that will name it. Until the parent PATCH lands, the page genuinely has not
		// changed — the row exists but nothing points at it.
		return status === 422
			? 'A row in a list was rejected (check its required values). Nothing on the page was saved yet — fix it and Save again.'
			: 'Saving a row in a list failed. Nothing on the page was saved — Save again to retry.';
	}
	if (stage === 'children-owned') {
		// A bundle child is OWNED by the block (`has_many :entities, as: :owner`), so
		// the moment its create lands it is on the page. Earlier cards in the same
		// batch are already there; this one is not.
		return status === 422
			? 'A card was rejected (check its required values). Any cards before it were added — fix this one and Save again.'
			: 'Adding a card failed. Any cards before it were added — Save again to add the rest.';
	}
	if (stage === 'children-edit') {
		// Each edited row is its own PATCH, so the rows before this one are SAVED.
		return status === 422
			? 'An edited row was rejected (check its required values). Rows saved before it were kept — fix it and Save again.'
			: 'Saving an edited row failed. Rows saved before it were kept — Save again to retry.';
	}
	if (stage === 'order') {
		// A reorder renumbers EVERY sibling, because they all share `position: 0` and
		// there is no value below zero. So a failure part-way leaves the order
		// genuinely half-written, and "your other changes were not saved" — what the
		// 'fields' sentence claims — is the opposite of what happened.
		return 'The new order was only partly saved. Save again to finish putting the items in order.';
	}
	if (stage === 'new-block-fields') {
		return 'The new section was added, but its fields could not be saved. Open it, check its values and Save again.';
	}
	if (stage === 'structure') {
		// The CODE before the status. `save-page-structure.ts` refuses a rename onto
		// a route the site generates, onto the chrome or onto (or away from) the home
		// page with `400 reserved-slug`, and a BLANK slug with `400 invalid-slug`; the
		// human reason goes to the audit row and only the code comes back here.
		// Without these branches the editor is told "Saving the page layout failed.
		// Save again to retry." — about the layout, not the address, and advising a
		// retry that is guaranteed to fail forever. The reserved sentence is the
		// create form's own, shared from `field-errors.js`, because it is the same
		// rule refusing for the same reason; the blank one is its own, because
		// "choose a different one" is no instruction for an emptied field.
		if (result?.error === 'reserved-slug') return RESERVED_SLUG_MESSAGE;
		if (result?.error === 'invalid-slug') return BLANK_SLUG_MESSAGE;
		return status === 422
			? 'The page layout was rejected. Your field edits were saved; fix the layout and Save again.'
			: 'Saving the page layout failed. Save again to retry.';
	}
	if (stage === 'seo') {
		// Keep the Phase 4 description-only copy byte-identical: admin-save-page.test.js:230-335
		// pins it. Other names need their own limits and must never point at description.
		if (names.length !== 1 || names[0] !== 'description') {
			const labels = names.map((name) => `meta ${name}`).join(' and ');
			const single = names.length === 1;
			const limits = { title: '300', description: '1,000', keywords: '500' };
			const caps = names
				.map((name) => `${limits[name]} characters or fewer for meta ${name}`)
				.join(' and ');
			if (result?.error === 'missing meta row')
				return `This page has no stored row for ${labels}. Your field, row and layout changes were saved, but ${labels} ${single ? 'was' : 'were'} not. Clear the ${labels} ${single ? 'field' : 'fields'}, then Save or Publish again.`;
			if (status === 400 && result?.error === 'invalid body')
				return `${labels} could not be accepted. Your field, row and layout changes were saved. Use ${caps} and Save again.`;
			return status === 422
				? `${labels} ${single ? 'was' : 'were'} rejected. Your field, row and layout changes were saved. Check ${single ? 'its value' : 'their values'} and Save again.`
				: `Saving ${labels} failed. Your field, row and layout changes were saved. Save again to retry.`;
		}
		if (result?.error === 'missing meta row') {
			return 'This page has no stored meta description row. Your field, row and layout changes were saved, but the description was not. Clear the meta description field, then Save or Publish again.';
		}
		if (status === 400 && result?.error === 'invalid body') {
			return 'The meta description could not be accepted. Your field, row and layout changes were saved. Use 1,000 characters or fewer and Save again.';
		}
		return status === 422
			? 'The meta description was rejected. Your field, row and layout changes were saved. Check its value and Save again.'
			: 'Saving the meta description failed. Your field, row and layout changes were saved. Save again to retry.';
	}
	return 'Publishing failed after your changes were saved. Save/Publish again to retry.';
}

/**
 * The fields the editor gave to blocks that do not exist yet — a duplicated section
 * (`addTemplateBlock` with the source's `fieldsData`) — remembered by POSITION
 * before the structure save, because Apex will mint their ids and the position is
 * the only handle that survives the round-trip (`serializeBlocksForSave` writes
 * `position: index`, and `reconcile` re-sorts the fresh page by position).
 * Top-level blocks only: that is the one place the admin seeds fields on a temp
 * entity. A temp block with no fields is not listed — it needs no PATCH.
 *
 * @param {import('./types').AdminPageDraft} draft
 * @returns {Array<{ position: number, fields_data: Record<string, unknown> }>}
 */
function seededNewBlockFields(draft) {
	const out = [];
	const blocks = Array.isArray(draft.page?.blocks) ? draft.page.blocks : [];
	blocks.forEach((block, position) => {
		const entity = block?.blockable?.entity;
		if (!entity || !isTempId(`${entity.id}`)) return;
		const fields = entity.fields_data;
		if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) return;
		out.push({ position, fields_data: structuredClone(fields) });
	});
	return out;
}

/**
 * RE-BASELINE AFTER A FAILURE THAT ALREADY WROTE SOMETHING.
 *
 * The stale guard compares ONCE, at the top of the save. So when a batch fails
 * part-way, the writes that landed have moved the server's composite version while
 * `draft.baselineVersion` still holds the pre-save one — and the editor's RETRY is
 * then refused as stale, telling them someone else changed the page when it was
 * their own half-save. The advice that comes with that refusal is to reload, which
 * throws away the very changes the retry was for.
 *
 * So: when the server could have moved because of US, re-read the version and adopt
 * it, and the retry compares against reality. Two things make that true — a write
 * that definitely landed earlier in this save (`wroteOk`), or a failure that is NOT
 * a refusal. A 4xx is decided before anything is written; a 5xx or a thrown request
 * may have applied and then failed to report, so it counts.
 *
 * A save that only ever got refused therefore KEEPS its old baseline, and a genuine
 * concurrent edit is still caught. What remains is the case one version token cannot
 * express: our write landed and someone else's landed in the same window. That needs
 * a per-row token, not a page one — noted on the PR rather than papered over.
 *
 * A failed re-read leaves the baseline alone. That is the safe direction: the editor
 * gets the stale notice on retry, which is wrong but recoverable, rather than a
 * write over somebody else's work.
 *
 * @param {import('./types').AdminPageDraft} draft
 * @param {import('./types').BffClient} client
 * @param {boolean} wroteOk true once a mutating call in this save has succeeded
 * @param {import('./types').SavePageResult} result
 * @returns {Promise<import('./types').SavePageResult>}
 */
async function failAfterWrites(draft, client, wroteOk, result) {
	const status = result?.status;
	const refusal = typeof status === 'number' && status >= 400 && status < 500;
	if (!wroteOk && refusal) return result;
	try {
		const current = await client.readVersion(draft.pageId);
		if (current?.version) draft.baselineVersion = current.version;
	} catch {
		// Deliberately swallowed: the save already failed, and the message the caller
		// is about to show is the one that matters.
	}
	return result;
}

/**
 * @param {import('./types').AdminPageDraft} draft a page-draft (page-draft.js)
 * @param {import('./types').BffClient} client the ONLY thing that touches the network
 * @param {{ statusEvent?: import('./types').AdminStatusEvent }} [options]
 * @returns {Promise<import('./types').SavePageResult>}
 */
export async function savePage(draft, client, options = {}) {
	const { statusEvent } = options;
	const pageId = draft.pageId;

	// 1. Stale guard — compared ONCE, before any write. page.updated_at alone would
	// miss block-field edits, so this is the composite version (page-version.ts).
	let current;
	try {
		current = await client.readVersion(pageId);
	} catch {
		return {
			ok: false,
			stage: 'version',
			message: 'Could not check the page version. Save again to retry.'
		};
	}
	if (current?.version !== draft.baselineVersion) {
		return { ok: false, stale: true, stage: 'version', message: STALE_MESSAGE };
	}

	/**
	 * Did any free-standing child row get written this save?
	 *
	 * It decides HOW the draft re-baselines below. The rows an `array_ref` points at
	 * are not part of the page, so the page a structure save hands back does not
	 * carry them — and `reconcile` clears `listChildEdits`. Re-baselining from that
	 * page would drop an edit from the screen and redraw the row from its stale
	 * pre-edit baseline, which reads as "my change did not save" on a save that
	 * succeeded. A fresh `getPage` carries `childRows`, so when children moved we take
	 * the slower read deliberately.
	 */
	let childrenWritten = false;
	/**
	 * Has a write DEFINITELY landed this save?
	 *
	 * Set after each successful mutating response — not before the call. Together
	 * with the failing response's own status it decides whether the draft re-baselines
	 * (see `failAfterWrites`): a 4xx with nothing landed yet moved nothing, and
	 * adopting a version in that case would adopt someone ELSE's write and let the
	 * retry sail through the stale guard over the top of it.
	 */
	let wroteOk = false;

	// 2N. CREATE each new child row of an `array_ref` field, BEFORE the parent that
	// will name it. An `array_ref` element must be the id of an entity that already
	// exists — Apex resolves every element on write and 422s on one it cannot find,
	// naming a field the editor never typed into.
	//
	// Each id is adopted into the parent's array IN THE DRAFT as it lands, so a retry
	// after a later failure does not create the same row twice. That is
	// `save-record.js`'s rule, unchanged.
	for (const row of newListChildren(draft)) {
		childrenWritten = true;
		const res = await client.createEntity(row.childType, row.fields_data);
		if (!res.ok) {
			return failAfterWrites(draft, client, wroteOk, {
				ok: false,
				stage: 'children',
				status: res.status,
				message: messageFor('children', res)
			});
		}
		// `{ok: true, entityId}` — the key `create-entity.ts:208` actually returns, and
		// which its own comment names. Reading a key it does not return made every Add
		// report failure while the entity existed, so the next Save minted another.
		const realId = res.entityId;
		if (!realId) {
			return failAfterWrites(draft, client, wroteOk, {
				ok: false,
				stage: 'children',
				message: 'A row was created but Apex did not return its id. Save again to retry.'
			});
		}
		wroteOk = true;
		adoptListChildId(draft, row.blockId, row.fieldName, row.id, realId);
	}

	// 2B. CREATE each new BUNDLE child. Its owner is the bundle's blockable, and the
	// entities route carries fields, owner and position in ONE call — the page-PATCH
	// alternative mints an empty row and then needs a second write for its fields.
	//
	// `entities_attributes` on the page PATCH cannot express any of this: it permits
	// no `:position`, and it is used below for removals only.
	for (const child of newBundleEntities(draft)) {
		const block = draft.page.blocks.find((candidate) => candidate.id === child.blockId);
		const ownerId = block?.blockable?.id;
		if (!ownerId || isTempId(`${ownerId}`)) {
			return failAfterWrites(draft, client, wroteOk, {
				ok: false,
				stage: 'children-owned',
				message: 'Save the page once before adding cards to a new section.'
			});
		}
		const res = await client.createEntity(child.childType, child.fields_data, {
			owner_type: BUNDLE_BLOCKABLE,
			owner_id: ownerId,
			position: child.position,
			page_id: pageId
		});
		if (!res.ok) {
			return failAfterWrites(draft, client, wroteOk, {
				ok: false,
				stage: 'children-owned',
				status: res.status,
				message: messageFor('children-owned', res)
			});
		}
		// `{ok: true, entityId}` — the key `create-entity.ts:208` actually returns, and
		// which its own comment names. Reading a key it does not return made every Add
		// report failure while the entity existed, so the next Save minted another.
		const realId = res.entityId;
		if (!realId) {
			return failAfterWrites(draft, client, wroteOk, {
				ok: false,
				stage: 'children-owned',
				message: 'A card was created but Apex did not return its id. Save again to retry.'
			});
		}
		wroteOk = true;
		// Adopt in place, so a retry after a later failure does not create it twice.
		const row = (block.blockable.entities ?? []).find((item) => item.id === child.id);
		if (row) row.id = realId;
	}

	// 3N. PATCH each EDITED existing child row. These entities are free-standing —
	// `collectEntities` walks blocks and never reaches them — so they are their own
	// leg rather than part of the dirty-entity set below.
	for (const edit of editedListChildren(draft)) {
		childrenWritten = true;
		const res = await client.patchEntityFields(edit.childType, edit.childId, edit.fields_data);
		if (!res.ok) {
			return failAfterWrites(draft, client, wroteOk, {
				ok: false,
				stage: 'children-edit',
				status: res.status,
				message: messageFor('children-edit', res)
			});
		}
		wroteOk = true;
	}

	// 2. Dirty entity field PATCHes, in order. Stop on the first failure so the
	// structure/status writes below are never dispatched after a partial failure.
	for (const patch of dirtyEntityPatches(draft)) {
		const res = await client.patchEntityFields(
			patch.entityTypeId,
			patch.entityId,
			patch.fields_data,
			patch.position
		);
		if (!res.ok) {
			// A patch that carries `position` is a REORDER. It reads as a field failure
			// otherwise, and tells the editor their other changes were not saved — when
			// the truth is that the order is half-written and the fix is to Save again.
			const stage = Number.isInteger(patch.position) ? 'order' : 'fields';
			return failAfterWrites(draft, client, wroteOk, {
				ok: false,
				stage,
				status: res.status,
				message: messageFor(stage, res)
			});
		}
		wroteOk = true;
	}

	// 3. Page structure — only if it changed. Carries block order / add / remove.
	let freshPage = null;
	let freshVersion = null;
	// Captured BEFORE the structure save: after it, `reconcile` replaces the tree.
	const seeded = draft.structureDirty ? seededNewBlockFields(draft) : [];
	if (draft.structureDirty || draft.deletedBlockIds.length > 0) {
		const res = await client.savePageStructure(pageId, structurePayload(draft));
		if (!res.ok) {
			return failAfterWrites(draft, client, wroteOk, {
				ok: false,
				stage: 'structure',
				status: res.status,
				message: messageFor('structure', res)
			});
		}
		wroteOk = true;
		freshPage = res.page ?? null;
		freshVersion = res.version ?? null;
	}

	// 3b. The fields of the blocks the structure save just minted. The fresh page
	// carries their real entity ids at the same positions; PATCH each, in order,
	// and STOP on the first failure — the section exists, its fields do not, and
	// the message says exactly that. Runs BEFORE the status event so a publish
	// never goes out over a half-copied section.
	if (seeded.length > 0) {
		let minted = freshPage;
		if (!minted) {
			try {
				minted = (await client.getPage(pageId)).page;
			} catch {
				// The structure write already landed, so this exit re-baselines like every
				// other post-write failure. Returning directly left the draft behind the
				// server and the next Save was refused as stale — about this editor's own
				// write, with advice to reload that discards the copied fields.
				return failAfterWrites(draft, client, wroteOk, {
					ok: false,
					stage: 'new-block-fields',
					message: messageFor('new-block-fields')
				});
			}
		}
		const byPosition = [...(Array.isArray(minted?.blocks) ? minted.blocks : [])].sort(
			(a, b) => (a.position ?? 0) - (b.position ?? 0)
		);
		for (const { position, fields_data } of seeded) {
			const entity = byPosition[position]?.blockable?.entity;
			if (!entity?.id || isTempId(`${entity.id}`) || !entity.entity_type_id) {
				// Same reason as the catch above: the section exists on the server now.
				return failAfterWrites(draft, client, wroteOk, {
					ok: false,
					stage: 'new-block-fields',
					message: messageFor('new-block-fields')
				});
			}
			const res = await client.patchEntityFields(entity.entity_type_id, entity.id, fields_data);
			if (!res.ok) {
				return failAfterWrites(draft, client, wroteOk, {
					ok: false,
					stage: 'new-block-fields',
					status: res.status,
					message: messageFor('new-block-fields', res)
				});
			}
		}
		// Those PATCHes moved the composite version; the page the structure save
		// returned is now behind it. Re-read below so the baseline is honest.
		freshPage = null;
	}

	// Page SEO has a separate route: meta-only edits must not sit behind
	// the structureDirty gate (phase-4-plan.md §1.2).
	if (Object.keys(draft.metaEdits).length > 0) {
		const names = Object.keys(draft.metaEdits);
		const res = await client.updatePageSeo(pageId, { ...draft.metaEdits });
		if (!res.ok) {
			return failAfterWrites(draft, client, wroteOk, {
				ok: false,
				stage: 'seo',
				status: res.status,
				message: messageFor('seo', res, names)
			});
		}
		wroteOk = true;
		// The earlier structure snapshot predates this write.
		freshPage = null;
	}

	// 4. Status event — only when asked (Publish / Unpublish). Never reached if any
	// step above returned. A status change invalidates the structure snapshot, so we
	// force a fresh read below.
	if (statusEvent) {
		const res = await client.changePageStatus(pageId, statusEvent);
		if (!res.ok) {
			return failAfterWrites(draft, client, wroteOk, {
				ok: false,
				stage: 'status',
				status: res.status,
				message: messageFor('status', res)
			});
		}
		wroteOk = true;
		freshPage = null;
	}

	// 5. Re-baseline. Prefer the page the structure save already returned; otherwise
	// read it fresh so the draft (and the stale guard's baseline) match the server.
	if (freshPage && freshVersion && !childrenWritten) {
		reconcile(draft, freshPage, freshVersion);
	} else {
		try {
			const { page, version, childRows } = await client.getPage(pageId);
			reconcile(draft, page, version, childRows);
		} catch {
			// The writes succeeded; only the refresh failed. Report success but flag
			// that the draft may be behind, so the UI can prompt a reload.
			return { ok: true, refreshed: false };
		}
	}
	return { ok: true, refreshed: true };
}

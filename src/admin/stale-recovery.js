// @ts-nocheck — legacy-mode admin browser module (plan §8, 3a compile-mode (a)).
//
// WHAT THE LOSING VOLUNTEER KEEPS when a stale save is recovered from.
//
// The stale guard (ADR-2) is guard-only: Apex has no compare-and-swap, so a save
// that finds the stored document moved is REFUSED, and the editor offers a
// reload. That reload used to be `draft = createTranscriptDraft(fresh)` — the
// losing draft, and every word in it, replaced by the server's copy in one
// statement, with nothing shown first. The refusal message even said "re-apply
// your changes" while the only button on offer was the one that destroyed them.
//
// On this deployment that is not a theoretical race. Two people share ~20 sermons
// and a staging admin; the way a conflict actually happens is the SAME person in
// two tabs, or a save that 500'd after Apex had already committed (the audit bug
// in this same phase), which made the retry look stale against the volunteer's own
// writing. Either way the answer must not be "your work is gone".
//
// So recovery is split in two. Reloading still adopts the server's document —
// that part is correct, and merging two transcripts automatically is not
// something this editor should invent. What changes is that the losing text is
// CARRIED OUT of the discarded draft first, reduced to the rows that actually
// differ, and handed to the editor to display beside the reloaded document so it
// can be read and typed back. Nothing is dropped that the volunteer has not seen.
//
// WHAT IS DELIBERATELY NOT HERE (owner's call — see the report): automatic
// merging, per-row "apply mine" buttons, and any persistence of the losing draft
// beyond the current page. Each is a real UI design decision; the non-destructive
// minimum is not.

/**
 * The shape this module actually reads, declared STRUCTURALLY rather than imported.
 * It used to say `import('../transcript-contract/contract.js')`, a path that exists
 * in no repo — the contract module stayed in GLC when this file moved here — so
 * `TranscriptDocument` silently resolved to `any` and every annotation below meant
 * nothing. Only `sections[].title` and `sections[].rows[].{id,text,startSeconds}`
 * are touched, so that is what the typedef says.
 *
 * @typedef {{ id?: string, text?: string, startSeconds?: number | null }} TranscriptRow
 * @typedef {{ title?: string, rows?: TranscriptRow[] }} TranscriptSection
 * @typedef {{ sections?: TranscriptSection[] }} TranscriptDocument
 * @typedef {{ rowId: string, sectionTitle: string, startSeconds: number | null, mine: string, theirs: string | null }} LostRow
 */

/**
 * Index a document's rows by id, remembering the text and where it sat.
 *
 * @param {TranscriptDocument | null | undefined} document
 * @returns {Map<string, { text: string, sectionTitle: string, startSeconds: number | null }>}
 */
function rowsById(document) {
	const index = new Map();
	for (const section of document?.sections ?? []) {
		for (const row of section?.rows ?? []) {
			if (!row || typeof row.id !== 'string') continue;
			index.set(row.id, {
				text: `${row.text ?? ''}`,
				sectionTitle: `${section.title ?? ''}`,
				startSeconds: typeof row.startSeconds === 'number' ? row.startSeconds : null
			});
		}
	}
	return index;
}

/**
 * The volunteer's own wording, wherever it differs from the document that won.
 *
 * Rows are matched by ID, which is the only stable identity a transcript row has
 * — the times can be equal across rows and the text is the thing that changed.
 * Three cases, and all three are reported rather than any being assumed harmless:
 *
 *   * the row exists in both and the text differs  → `theirs` is the winner's text
 *   * the row exists only in the losing draft      → `theirs` is null (the other
 *     editor merged or removed a section, and this row's words would vanish)
 *   * the row exists only in the winner            → nothing to report; the
 *     volunteer never had it and cannot lose it
 *
 * A row whose text is identical is not listed: the point of the panel is what
 * would otherwise be silently thrown away, and a list padded with 400 unchanged
 * rows is a list nobody reads.
 *
 * Section titles and section structure are NOT diffed. They are recoverable in
 * seconds by hand and including them would bury the words, which are not.
 *
 * @param {TranscriptDocument | null | undefined} mine   the draft about to be replaced
 * @param {TranscriptDocument | null | undefined} theirs the document that won
 * @returns {LostRow[]}
 */
export function lostRows(mine, theirs) {
	const winner = rowsById(theirs);
	/** @type {LostRow[]} */
	const lost = [];
	for (const section of mine?.sections ?? []) {
		for (const row of section?.rows ?? []) {
			if (!row || typeof row.id !== 'string') continue;
			const myText = `${row.text ?? ''}`;
			const won = winner.get(row.id);
			if (won && won.text === myText) continue;
			lost.push({
				rowId: row.id,
				sectionTitle: `${section.title ?? ''}`,
				startSeconds: typeof row.startSeconds === 'number' ? row.startSeconds : null,
				mine: myText,
				theirs: won ? won.text : null
			});
		}
	}
	return lost;
}

/**
 * Everything the editor needs to show after a non-destructive reload, or `null`
 * when there is genuinely nothing to keep.
 *
 * `null` matters as much as the list does: a volunteer who hit a conflict without
 * having typed anything (two tabs, one idle) must not be shown a scary panel
 * about work they never did. The panel appears exactly when something would
 * otherwise have been lost.
 *
 * @param {{ document?: TranscriptDocument | null, dirty?: boolean }} losing
 * @param {TranscriptDocument | null | undefined} winning
 * @returns {{ rows: LostRow[], count: number } | null}
 */
export function recoveryFrom(losing, winning) {
	if (!losing?.dirty || !losing?.document) return null;
	const rows = lostRows(losing.document, winning);
	return rows.length === 0 ? null : { rows, count: rows.length };
}

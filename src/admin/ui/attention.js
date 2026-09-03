// @ts-nocheck — legacy-mode admin browser module (plan §8, 3a compile-mode (a)).
// The number beside "Messages" in the rail, and the one rule the messages list
// buckets by.
//
// The prototype shows it on every screen, so the naive wiring is "the shell counts
// messages on mount". That would be wrong here for a reason the BFF spells out in
// `operations/list-sermons.ts`: the summaries are cheap on the BROWSER hop only —
// Apex has no field selection, so every call drags the whole transcript catalogue
// (≈12 MB in production) over the server hop. Paying that on every admin navigation
// to draw a badge is not a trade worth making.
//
// So the count is fetched at most ONCE per browser session and held here: any screen
// that already has the sermon list publishes the real number into it for free, and
// the shell only goes and asks when nothing has.

import { writable, get } from 'svelte/store';

// R5-4 changed what this number MEANS — it used to be "held back from the site"
// and is now "published, waiting for a human". A key that did not move would have
// let a session cached under the old meaning keep drawing the old number.
const KEY = 'glc-admin-messages-awaiting-review';

function initial() {
	if (typeof sessionStorage === 'undefined') return null;
	const stored = sessionStorage.getItem(KEY);
	if (stored === null) return null;
	const parsed = Number(stored);
	return Number.isFinite(parsed) ? parsed : null;
}

/** The count of published messages nobody has reviewed, or null while it is unknown. */
export const messagesAwaitingReview = writable(initial());

/** @param {number} count */
export function setMessagesAwaitingReview(count) {
	messagesAwaitingReview.set(count);
	if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(KEY, String(count));
}

/**
 * Which of the three states a message is in, decided once, here.
 *
 * This is where the admin drifted. It used to bucket on `reviewed || aboveBar`,
 * which was the site's rule at the time — and when R5-4 removed that rule from
 * `transcript-contract/visibility.js`, the admin kept its own copy and started
 * lying: with every backfilled sermon around 15% flagged against a 5% bar, an
 * operator would have opened this list mid-backfill and read "Live 0 / Held back
 * 20" over twenty sermons that were live on the public site. The contract's own
 * header warns about exactly this ("a second copy is how the four of them would
 * drift"), so the rule now has one home per fact: the CONTRACT decides visibility
 * from the document, the BFF derives `hasDocument`/`reviewed` through it, and this
 * function does nothing but name the pair.
 *
 *   'none'     — no readable transcript; nothing published, nothing to review.
 *   'awaiting' — published, and no human has said they read it. The public page
 *                carries the "Not yet reviewed" notice. This is the work queue.
 *   'reviewed' — published, and a human said they read it. The notice is gone.
 *
 * `aboveBar` is deliberately not consulted. The confidence measure survives R5-4
 * as an ergonomics number — how much is left to check — and it is shown as the
 * flag count beside the row; it decides nothing.
 *
 * @param {{ hasDocument?: boolean, reviewed?: boolean }} sermon
 * @returns {'none' | 'awaiting' | 'reviewed'}
 */
export function messageReviewState(sermon) {
	if (!sermon.hasDocument) return 'none';
	return sermon.reviewed ? 'reviewed' : 'awaiting';
}

/**
 * The review backlog: published transcripts waiting on a human.
 *
 * A message with no readable transcript is NOT counted. There is nothing to read,
 * so there is nothing to review — the same call the snapshot projection makes for
 * its `unreviewed` figure, and the two numbers are meant to agree.
 *
 * @param {Array<{ hasDocument?: boolean, reviewed?: boolean }>} sermons
 */
export function countAwaitingReview(sermons) {
	return sermons.filter((sermon) => messageReviewState(sermon) === 'awaiting').length;
}

/**
 * Fetch the count once per session; a failure leaves the badge absent, not wrong.
 *
 * @param {import('../types').BffClient} client
 */
export async function ensureMessagesAwaitingReview(client) {
	if (get(messagesAwaitingReview) !== null) return;
	try {
		setMessagesAwaitingReview(countAwaitingReview(await client.listSermons()));
	} catch {
		// No badge is better than a made-up one.
	}
}

// @ts-nocheck — legacy-mode admin browser module.
import { writable } from 'svelte/store';

/**
 * ONE unsaved-changes guard for the whole admin.
 *
 * Nothing in this admin autosaves. Every editor screen holds a LOCAL draft and
 * writes it only when someone presses Save — which is a deliberate design, and
 * which the editors arriving here have no habit for: they are coming from a
 * system that saved as they typed. Reported from real use, before this existed:
 * "I've gone to other screens without saving."
 *
 * ── WHY THE OLD GUARD DID NOT COVER THAT ────────────────────────────────────────
 * `PageForm` and `PostEditor` each registered a `beforeunload` listener, and
 * `RecordEditor` registered nothing at all. `beforeunload` fires when the DOCUMENT
 * unloads: a tab close, a reload, an address typed into the bar. It does NOT fire
 * for a client-side route change, and a client-side route change is how an editor
 * leaves a screen in practice — they click the rail. So the everyday way of
 * losing work was completely unguarded, and the guarded way was the rare one.
 *
 * ── WHY THIS IS ONE MECHANISM AND NOT TWO ───────────────────────────────────────
 * SvelteKit's `beforeNavigate` covers BOTH. It fires for link clicks, `goto()` and
 * history moves, and its client also invokes the same callbacks from its own
 * `beforeunload` listener with `navigation.type === 'leave'`, where calling
 * `cancel()` is what makes the browser show its native "Leave site?" dialog
 * (`@sveltejs/kit/src/runtime/client/client.js:2662-2688`, `_start_router`). So one
 * registration replaces three hand-rolled copies and covers the case none of them
 * covered. It also unregisters itself when the component is destroyed —
 * `beforeNavigate` adds its callback inside `onMount` and removes it on teardown —
 * so the `onDestroy` bookkeeping the listeners needed is gone with them.
 *
 * ── WHY `beforeNavigate` IS PASSED IN ───────────────────────────────────────────
 * So the decision and the registration can be tested without a component mount
 * stack, which this repo does not have. Same shape as `runUpload` in
 * `image-upload.js` and for the same reason. The caller passes SvelteKit's real
 * `beforeNavigate`; a test passes a function that records the callback and then
 * hands it whatever navigation it wants to ask about.
 * A site's dialog MUST call `answer(false)` on Escape, cancel, or close so a
 * dismissed question settles. A later navigation replaces a pending question.
 */

/** What the editor is asked before their work is thrown away. */
export const UNSAVED_PROMPT =
	'You have unsaved changes on this screen. Leave anyway and lose them?';

/**
 * Whether a navigation lands on the screen it started from — the current rail
 * entry clicked again, or an in-page anchor. Nothing is lost, so nothing is
 * asked. The hash is deliberately not compared: `#section` is the same document.
 * A navigation that unloads or changes origin can still lose the draft.
 * @param {{ from?: { url?: URL } | null, to?: { url?: URL } | null } | null | undefined} navigation
 */
function staysOnThisScreen(navigation) {
	const from = navigation && navigation.from && navigation.from.url;
	const to = navigation && navigation.to && navigation.to.url;
	if (!from || !to) return false;
	return (
		!navigation.willUnload &&
		from.origin === to.origin &&
		from.pathname === to.pathname &&
		from.search === to.search
	);
}

/**
 * What to do about a navigation away from a screen holding unsaved work.
 *
 *   `allow` — nothing is at risk, or the navigation is not leaving this screen.
 *   `stop`  — cancel without asking anything HERE. This is the `leave` case only,
 *             and it is not "block": cancelling a `leave` is precisely what makes
 *             the BROWSER ask, in its own dialog, which is the only dialog that
 *             may be shown while a document unloads. A native dialog called here
 *             would be ignored by the browser and the tab would close.
 *   `ask`   — an in-app route change. No dialog appears unless one is put there,
 *             so this is the case that must ask.
 *
 * @param {boolean} dirty
 * @param {{ type?: string, from?: { url?: URL } | null, to?: { url?: URL } | null } | null | undefined} navigation
 * @returns {'allow' | 'stop' | 'ask'}
 */
export function unsavedNavigationAction(dirty, navigation) {
	if (!dirty) return 'allow';
	if (navigation && navigation.type === 'leave') return 'stop';
	if (staysOnThisScreen(navigation)) return 'allow';
	return 'ask';
}

/**
 * Register during component initialization. `isDirty` is read at navigation time.
 * A cancelled Back/Forward is reverted by SvelteKit (`client.js:2917-2919`), so
 * retry with the original delta; a GET form retry uses `goto` and loses its form
 * focus, scroll, and replace-state options. The bypass permits only the retry's
 * target and type, so an unrelated navigation cannot use its approval. A retry
 * expires if the browser never reports its navigation or unload.
 *
 * @param {(callback: (navigation: any) => void) => void} beforeNavigate
 * @param {() => boolean} isDirty
 * @param {{ ask?: (message: string, navigation: any) => boolean | PromiseLike<boolean>, goto?: (href: string) => Promise<unknown>, go?: (delta: number) => void, assign?: (href: string) => void }} [options]
 */
export function guardUnsavedChanges(beforeNavigate, isDirty, options = {}) {
	const ask = options.ask ?? ((message) => globalThis.confirm(message));
	if (!options.goto && (ask.constructor?.name === 'AsyncFunction' || ask.requiresGoto)) {
		throw new TypeError('guardUnsavedChanges: an async ask needs options.goto');
	}
	const assign = options.assign ?? ((href) => globalThis.location.assign(href));
	const go = options.go ?? ((delta) => globalThis.history.go(delta));
	let asking = false;
	let question = 0;
	/** @type {{ href: string, type: string, timer?: ReturnType<typeof setTimeout> } | null} */
	let retry = null;
	const clearRetry = (record) => {
		if (retry !== record) return;
		if (record.timer) clearTimeout(record.timer);
		retry = null;
	};
	const setRetry = (href, type) => {
		const record = { href, type };
		retry = record;
		// Re-entry happens at the start of a navigation. A settled/no-op retry
		// must not keep its approval for a later, unrelated browser action.
		record.timer = setTimeout(() => clearRetry(record), 100);
		return record;
	};
	beforeNavigate((navigation) => {
		const href = navigation?.to?.url?.href;
		if (retry) {
			if (
				(navigation.type === retry.type && href === retry.href) ||
				(retry.type === 'assign' && navigation.type === 'leave')
			) {
				clearRetry(retry);
				return;
			}
			if (navigation?.cancel) navigation.cancel();
			return;
		}
		const action = unsavedNavigationAction(Boolean(isDirty()), navigation);
		if (action === 'allow') return;
		if (action === 'stop') {
			navigation?.cancel?.();
			return;
		}
		const wasAsking = asking;
		if (wasAsking) navigation?.cancel?.();
		const answer = ask(UNSAVED_PROMPT, navigation);
		const currentQuestion = ++question;
		if (!answer || typeof answer.then !== 'function') {
			asking = false;
			if (!answer && !wasAsking) navigation?.cancel?.();
			return;
		}
		if (!options.goto) {
			navigation?.cancel?.();
			throw new TypeError('guardUnsavedChanges: an async ask needs options.goto');
		}
		navigation?.cancel?.();
		asking = true;
		Promise.resolve(answer).then(
			(leave) => {
				if (currentQuestion !== question) return;
				asking = false;
				if (!leave || !href) return;
				const origin = globalThis.location?.origin ?? navigation?.from?.url?.origin;
				if (navigation.willUnload || navigation.to.url.origin !== origin) {
					const record = setRetry(href, 'assign');
					try {
						assign(href);
					} catch (error) {
						clearRetry(record);
						console.error('guardUnsavedChanges: assignment failed', error);
					}
					return;
				}
				if (navigation.type === 'popstate') {
					const record = setRetry(href, 'popstate');
					try {
						go(navigation.delta);
					} catch (error) {
						clearRetry(record);
						console.error('guardUnsavedChanges: history retry failed', error);
					}
					return;
				}
				const record = setRetry(href, 'goto');
				try {
					Promise.resolve(options.goto(href))
						.catch(() => {})
						.finally(() => clearRetry(record));
				} catch {
					clearRetry(record);
				}
			},
			() => {
				if (currentQuestion !== question) return;
				asking = false;
			}
		);
	});
}

/**
 * A pending Leave/Stay question as a Svelte store: `{ open, message }`.
 * The guard must receive a promise to cancel immediately and retry after the
 * editor answers (`unsaved-changes.js:121-128`); this keeps dialog state shared
 * between that callback and the screen markup.
 */
export function createLeavePrompt() {
	const prompt = writable({ open: false, message: '' });
	/** @type {((leave: boolean) => void) | null} */
	let resolve = null;
	const ask = (message) => {
		if (resolve) resolve(false);
		prompt.set({ open: true, message });
		return new Promise((done) => {
			resolve = done;
		});
	};
	ask.requiresGoto = true;
	return {
		subscribe: prompt.subscribe,
		/** @param {string} message @returns {Promise<boolean>} */
		ask,
		/** @param {boolean} leave */
		answer(leave) {
			if (!resolve) return;
			const done = resolve;
			resolve = null;
			prompt.set({ open: false, message: '' });
			done(leave);
		}
	};
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { get } from 'svelte/store';
import {
	UNSAVED_PROMPT,
	unsavedNavigationAction,
	guardUnsavedChanges,
	createLeavePrompt
} from '../src/admin/unsaved-changes.js';

const url = (path) => new URL(path, 'https://example.test');
const rail = {
	type: 'link',
	from: { url: url('/admin/team/abc') },
	to: { url: url('/admin/images') }
};

function router() {
	let callback;
	const history = [url('/landing'), url('/admin/images'), rail.from.url];
	let index = 2;
	const moves = [];
	const dispatch = (nav) => {
		let cancelled = false;
		callback({ ...nav, cancel: () => (cancelled = true) });
		return cancelled;
	};
	const go = (delta, callbacks = true) => {
		const from = history[index];
		index += delta;
		moves.push({ delta, callbacks });
		if (!callbacks) return false;
		const cancelled = dispatch({
			type: 'popstate',
			delta,
			from: { url: from },
			to: { url: history[index] }
		});
		if (cancelled) go(-delta, false); // Kit reverts without running beforeNavigate again.
		return cancelled;
	};
	return {
		get historyIndex() {
			return index;
		},
		get history() {
			return history;
		},
		moves,
		go,
		beforeNavigate(fn) {
			callback = fn;
		},
		navigate: dispatch
	};
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('K1 decision table: clean, app route, unload, same screen', () => {
	assert.equal(unsavedNavigationAction(false, rail), 'allow');
	assert.equal(unsavedNavigationAction(false, { type: 'leave', from: rail.from }), 'allow');
	assert.equal(unsavedNavigationAction(true, rail), 'ask');
	assert.equal(
		unsavedNavigationAction(true, {
			type: 'goto',
			from: rail.from,
			to: { url: url('/admin/team/def') }
		}),
		'ask'
	);
	assert.equal(
		unsavedNavigationAction(true, {
			type: 'popstate',
			from: rail.from,
			to: { url: url('/admin/team') }
		}),
		'ask'
	);
	assert.equal(unsavedNavigationAction(true, { type: 'leave', from: rail.from }), 'stop');
	assert.equal(
		unsavedNavigationAction(true, {
			type: 'link',
			from: rail.from,
			to: { url: url('/admin/team/abc#seo') }
		}),
		'allow'
	);
	assert.equal(
		unsavedNavigationAction(true, {
			type: 'link',
			from: { url: url('/admin/updates') },
			to: { url: url('/admin/updates?status=draft') }
		}),
		'ask'
	);
	for (const nav of [
		{ ...rail, to: { url: url('https://other.test/admin/team/abc') } },
		{ ...rail, to: { url: rail.from.url }, willUnload: true },
		{ ...rail, to: { url: rail.from.url }, type: 'link', willUnload: true }
	]) {
		assert.equal(unsavedNavigationAction(true, nav), 'ask');
	}
});

test('K2 synchronous ask preserves the original decision path', () => {
	const r = router();
	let dirty = false;
	let answer = false;
	const prompts = [];
	guardUnsavedChanges(r.beforeNavigate, () => dirty, {
		ask(message, navigation) {
			prompts.push([message, navigation.type]);
			return answer;
		}
	});
	assert.equal(r.navigate(rail), false);
	assert.equal(prompts.length, 0);
	dirty = true;
	assert.equal(r.navigate(rail), true);
	answer = true;
	assert.equal(r.navigate(rail), false);
	assert.equal(r.navigate({ type: 'leave', from: rail.from }), true);
	assert.equal(r.navigate({ ...rail, type: 'form' }), false);
	assert.deepEqual(prompts, [
		[UNSAVED_PROMPT, 'link'],
		[UNSAVED_PROMPT, 'link'],
		[UNSAVED_PROMPT, 'form']
	]);
});

test('K3 async ask cancels in the callback, before the answer settles', async () => {
	const r = router();
	const answer = deferred();
	guardUnsavedChanges(r.beforeNavigate, () => true, {
		ask: () => answer.promise,
		goto: async () => {}
	});
	assert.equal(r.navigate(rail), true);
	answer.resolve(false);
	await tick();
});

test('K4 Leave retries goto once, and Back retries the original history delta', async () => {
	const r = router();
	const answer = deferred();
	const targets = [];
	const retryCancelled = [];
	let asked = 0;
	guardUnsavedChanges(r.beforeNavigate, () => true, {
		ask: () => {
			asked++;
			return answer.promise;
		},
		goto: async (href) => {
			targets.push(href);
			retryCancelled.push(r.navigate({ ...rail, type: 'goto' }));
		}
	});
	assert.equal(r.navigate(rail), true);
	answer.resolve(true);
	await tick();
	assert.deepEqual(targets, [rail.to.url.href]);
	assert.deepEqual(retryCancelled, [false]);
	assert.equal(asked, 1);

	const backRouter = router();
	const backAnswer = deferred();
	const secondBackAnswer = deferred();
	let backAsked = 0;
	const backGotoCalls = [];
	guardUnsavedChanges(backRouter.beforeNavigate, () => true, {
		ask: () => {
			backAsked++;
			return backAsked === 1 ? backAnswer.promise : secondBackAnswer.promise;
		},
		go: backRouter.go,
		goto: async (href) => {
			backGotoCalls.push(href);
		}
	});
	assert.equal(backRouter.go(-1), true);
	assert.equal(backRouter.historyIndex, 2, 'cancelled Back is reverted');
	backAnswer.resolve(true);
	await tick();
	assert.deepEqual(
		backRouter.moves.map((move) => [move.delta, move.callbacks]),
		[
			[-1, true],
			[1, false],
			[-1, true]
		]
	);
	assert.deepEqual(backGotoCalls, []);
	assert.equal(backAsked, 1);
	assert.equal(backRouter.history[backRouter.historyIndex].pathname, '/admin/images');
	assert.equal(backRouter.go(-1), true, 'dirty second Back asks about the landing page');
	assert.equal(
		backRouter.history[backRouter.historyIndex].pathname,
		'/admin/images',
		'cancelled second Back stays on list'
	);
	assert.equal(backAsked, 2);
	secondBackAnswer.resolve(true);
	await tick();
	assert.equal(
		backRouter.history[backRouter.historyIndex].pathname,
		'/landing',
		'second Back lands on entry before the list'
	);

	const formRouter = router();
	const formAnswer = deferred();
	const formTargets = [];
	const formRetryCancelled = [];
	guardUnsavedChanges(formRouter.beforeNavigate, () => true, {
		ask: () => formAnswer.promise,
		goto: async (href) => {
			formTargets.push(href);
			formRetryCancelled.push(formRouter.navigate({ ...rail, type: 'goto' }));
		}
	});
	assert.equal(formRouter.navigate({ ...rail, type: 'form' }), true);
	formAnswer.resolve(true);
	await tick();
	assert.deepEqual(formTargets, [rail.to.url.href]);
	assert.deepEqual(formRetryCancelled, [false]);
});

test('K5 Stay does not retry or touch the draft', async () => {
	const r = router();
	const answer = deferred();
	const draft = { title: 'unsaved' };
	let calls = 0;
	guardUnsavedChanges(r.beforeNavigate, () => draft.title !== 'saved', {
		ask: () => answer.promise,
		goto: async () => calls++
	});
	assert.equal(r.navigate(rail), true);
	answer.resolve(false);
	await tick();
	assert.equal(calls, 0);
	assert.deepEqual(draft, { title: 'unsaved' });
	const rejected = deferred();
	const otherRouter = router();
	let rejectedAsks = 0;
	guardUnsavedChanges(otherRouter.beforeNavigate, () => true, {
		ask: () => {
			rejectedAsks++;
			return rejectedAsks === 1 ? rejected.promise : true;
		},
		goto: async () => calls++
	});
	assert.equal(otherRouter.navigate(rail), true);
	rejected.reject(new Error('dialog closed'));
	await tick();
	assert.equal(calls, 0);
	assert.equal(otherRouter.navigate(rail), false, 'a new synchronous approval is allowed');
	assert.equal(rejectedAsks, 2, 'rejected answer ends the pending question');
});

test('K6 a pending prompt is replaced by a new navigation question', async () => {
	const r = router();
	const prompt = createLeavePrompt();
	let asked = 0;
	guardUnsavedChanges(r.beforeNavigate, () => true, {
		ask: (message) => {
			asked++;
			return prompt.ask(message);
		},
		goto: async () => {}
	});
	assert.equal(r.navigate(rail), true);
	assert.equal(r.navigate({ ...rail, to: { url: url('/admin/posts') } }), true);
	assert.equal(asked, 2);
	assert.equal(get(prompt).open, true);
	prompt.answer(false);
	await tick();
	assert.equal(r.navigate(rail), true);
	assert.equal(asked, 3);
	prompt.answer(false);
	await tick();
});

test('K7 unload or cross-origin Leave uses assign and permits its unload callback', async () => {
	for (const nav of [
		{ ...rail, willUnload: true },
		{ ...rail, to: { url: url('https://other.test/admin') } }
	]) {
		const r = router();
		const answer = deferred();
		const assigned = [];
		let gotoCalls = 0;
		guardUnsavedChanges(r.beforeNavigate, () => true, {
			ask: () => answer.promise,
			assign: (href) => assigned.push(href),
			goto: async () => gotoCalls++
		});
		assert.equal(r.navigate(nav), true);
		answer.resolve(true);
		await tick();
		assert.deepEqual(assigned, [nav.to.url.href]);
		assert.equal(gotoCalls, 0);
		assert.equal(r.navigate({ type: 'leave', from: rail.from }), false);
		assert.equal(
			r.navigate({ type: 'leave', from: rail.from }),
			true,
			'only the first unload uses the approval'
		);
	}
});

test('assign approval expires if no unload follows', async () => {
	const r = router();
	const answer = deferred();
	guardUnsavedChanges(r.beforeNavigate, () => true, {
		ask: () => answer.promise,
		assign: () => {},
		goto: async () => {}
	});
	assert.equal(r.navigate({ ...rail, willUnload: true }), true);
	answer.resolve(true);
	await tick();
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(r.navigate({ type: 'leave', from: rail.from }), true);
});

test('K8 leave prompt opens, answers, and supersedes an earlier question', async () => {
	const prompt = createLeavePrompt();
	const first = prompt.ask('First');
	assert.deepEqual(get(prompt), { open: true, message: 'First' });
	const second = prompt.ask('Second');
	assert.equal(await first, false);
	assert.deepEqual(get(prompt), { open: true, message: 'Second' });
	prompt.answer(true);
	assert.equal(await second, true);
	assert.deepEqual(get(prompt), { open: false, message: '' });
});

test('K9 a competing navigation cannot consume the pending retry approval', async () => {
	const r = router();
	const answer = deferred();
	const gotoResult = deferred();
	let asked = 0;
	guardUnsavedChanges(r.beforeNavigate, () => true, {
		ask: () => {
			asked++;
			return answer.promise;
		},
		goto: () => gotoResult.promise
	});
	assert.equal(r.navigate(rail), true);
	answer.resolve(true);
	await tick();
	assert.equal(r.navigate({ ...rail, type: 'goto', to: { url: url('/admin/posts') } }), true);
	assert.equal(r.navigate({ ...rail, type: 'link' }), true);
	assert.equal(asked, 1);
	assert.equal(r.navigate({ ...rail, type: 'goto' }), false);
	assert.equal(asked, 1);
	gotoResult.resolve();
	await tick();
});

test('a settled goto without callback cannot block later navigation', async () => {
	for (const outcome of ['resolve', 'reject']) {
		const r = router();
		const answer = deferred();
		let asked = 0;
		guardUnsavedChanges(r.beforeNavigate, () => true, {
			ask: () => {
				asked++;
				return asked === 1 ? answer.promise : false;
			},
			goto: () =>
				outcome === 'resolve' ? Promise.resolve() : Promise.reject(new Error('navigation failed'))
		});
		assert.equal(r.navigate(rail), true);
		answer.resolve(true);
		await tick();
		assert.equal(r.navigate({ ...rail, type: 'link' }), true);
		assert.equal(asked, 2, `${outcome} must clear the retry`);
	}
});

test('an older goto settlement cannot clear a newer retry', async () => {
	const r = router();
	const answers = [deferred(), deferred()];
	const gotos = [deferred(), deferred()];
	let asked = 0;
	let gotoCalls = 0;
	guardUnsavedChanges(r.beforeNavigate, () => true, {
		ask: () => answers[asked++].promise,
		goto: () => gotos[gotoCalls++].promise
	});
	assert.equal(r.navigate(rail), true);
	answers[0].resolve(true);
	await tick();
	assert.equal(r.navigate({ ...rail, type: 'goto' }), false);
	assert.equal(r.navigate(rail), true);
	answers[1].resolve(true);
	await tick();
	gotos[0].resolve();
	await tick();
	assert.equal(r.navigate({ ...rail, type: 'goto', to: { url: url('/admin/posts') } }), true);
	assert.equal(asked, 2);
	assert.equal(r.navigate({ ...rail, type: 'goto' }), false);
	gotos[1].resolve();
	await tick();
});

test('history retry approval expires if no popstate follows', async () => {
	const r = router();
	const answer = deferred();
	let asked = 0;
	guardUnsavedChanges(r.beforeNavigate, () => true, {
		ask: () => {
			asked++;
			return asked === 1 ? answer.promise : false;
		},
		go: () => {},
		goto: async () => {}
	});
	assert.equal(r.navigate({ ...rail, type: 'popstate', delta: -1 }), true);
	answer.resolve(true);
	await tick();
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(r.navigate({ ...rail, type: 'popstate' }), true);
	assert.equal(asked, 2);
});

test('an async ask requires goto at registration', () => {
	const r = router();
	assert.throws(
		() =>
			guardUnsavedChanges(r.beforeNavigate, () => true, {
				ask: async () => false
			}),
		/async ask needs options\.goto/
	);
	const prompt = createLeavePrompt();
	assert.throws(
		() =>
			guardUnsavedChanges(r.beforeNavigate, () => true, {
				ask: prompt.ask
			}),
		/async ask needs options\.goto/
	);
});

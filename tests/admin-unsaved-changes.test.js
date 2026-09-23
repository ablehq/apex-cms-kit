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
	return {
		beforeNavigate(fn) {
			callback = fn;
		},
		navigate(nav) {
			let cancelled = false;
			callback({ ...nav, cancel: () => (cancelled = true) });
			return cancelled;
		}
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
	let asked = 0;
	guardUnsavedChanges(r.beforeNavigate, () => true, {
		ask: () => {
			asked++;
			return answer.promise;
		},
		goto: async (href) => targets.push(href)
	});
	assert.equal(r.navigate(rail), true);
	answer.resolve(true);
	await tick();
	assert.deepEqual(targets, [rail.to.url.href]);
	assert.equal(r.navigate({ ...rail, type: 'goto' }), false);
	assert.equal(asked, 1);

	const backRouter = router();
	const backAnswer = deferred();
	const deltas = [];
	const history = ['landing', 'list', 'editor'];
	let historyIndex = 2;
	let backAsked = 0;
	const back = { ...rail, type: 'popstate', delta: -1 };
	guardUnsavedChanges(backRouter.beforeNavigate, () => true, {
		ask: () => {
			backAsked++;
			return backAnswer.promise;
		},
		go: (delta) => {
			deltas.push(delta);
			historyIndex += delta;
		},
		goto: async () => assert.fail('Back must not push a new history entry')
	});
	assert.equal(backRouter.navigate(back), true);
	backAnswer.resolve(true);
	await tick();
	assert.deepEqual(deltas, [-1]);
	assert.equal(backRouter.navigate(back), false);
	assert.equal(backAsked, 1);
	assert.equal(history[historyIndex], 'list');
	historyIndex -= 1;
	assert.equal(history[historyIndex], 'landing', 'a second Back must not reopen the editor');

	const formRouter = router();
	const formAnswer = deferred();
	const formTargets = [];
	guardUnsavedChanges(formRouter.beforeNavigate, () => true, {
		ask: () => formAnswer.promise,
		goto: async (href) => formTargets.push(href)
	});
	assert.equal(formRouter.navigate({ ...rail, type: 'form' }), true);
	formAnswer.resolve(true);
	await tick();
	assert.deepEqual(formTargets, [rail.to.url.href]);
	assert.equal(formRouter.navigate({ ...rail, type: 'goto' }), false);
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
	guardUnsavedChanges(otherRouter.beforeNavigate, () => true, {
		ask: () => rejected.promise,
		goto: async () => calls++
	});
	assert.equal(otherRouter.navigate(rail), true);
	rejected.reject(new Error('dialog closed'));
	await tick();
	assert.equal(calls, 0);
});

test('K6 a pending prompt cancels a second navigation without a second question', async () => {
	const r = router();
	const answer = deferred();
	let asked = 0;
	guardUnsavedChanges(r.beforeNavigate, () => true, {
		ask: () => {
			asked++;
			return answer.promise;
		},
		goto: async () => {}
	});
	assert.equal(r.navigate(rail), true);
	assert.equal(r.navigate({ ...rail, to: { url: url('/admin/posts') } }), true);
	assert.equal(asked, 1);
	answer.resolve(false);
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
	}
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
	let asked = 0;
	guardUnsavedChanges(r.beforeNavigate, () => true, {
		ask: () => {
			asked++;
			return answer.promise;
		},
		goto: async () => {}
	});
	assert.equal(r.navigate(rail), true);
	answer.resolve(true);
	await tick();
	assert.equal(r.navigate({ ...rail, type: 'goto', to: { url: url('/admin/posts') } }), true);
	assert.equal(r.navigate({ ...rail, type: 'link' }), true);
	assert.equal(asked, 1);
	assert.equal(r.navigate({ ...rail, type: 'goto' }), false);
	assert.equal(asked, 1);
});

// @ts-nocheck — node:test suite over the rich-text bar's caret state.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';

import { BAR_IDLE, barState, closestWithin, headingBlock } from '../src/admin/rich-text-bar.js';

/**
 * THE BAR KNOWS WHERE THE CARET IS (Isaac on Poovayya's article editor, 2026-10-05):
 * a paragraph made a heading could not be made a paragraph again, because H2 ran
 * `formatBlock '<h2>'` whatever it was pressed in, and no button ever showed
 * pressed. These cases drive the decisions with plain objects standing in for DOM
 * nodes — `parentNode` and `nodeName` are all the module reads.
 */

/** A node chain: `tree('H2', '#text')` is a text node inside an H2 inside a fresh root. */
function tree(...names) {
	const root = { nodeName: 'DIV', parentNode: { nodeName: 'BODY', parentNode: null } };
	let at = root;
	for (const nodeName of names) at = { nodeName, parentNode: at };
	return { root, leaf: at };
}

const noFormatting = () => false;

describe('closestWithin', () => {
	it('finds the heading a text node is in', () => {
		const { root, leaf } = tree('H2', '#text');
		assert.equal(closestWithin(leaf, root, 'H2'), leaf.parentNode);
	});

	it('stops at the surface: a heading AROUND the field is not the field`s', () => {
		const outer = { nodeName: 'H2', parentNode: null };
		const root = { nodeName: 'DIV', parentNode: outer };
		const leaf = { nodeName: 'P', parentNode: root };
		assert.equal(closestWithin(leaf, root, 'H2'), null);
	});
});

describe('barState', () => {
	it('has nothing pressed while the selection is outside the field, and asks the browser nothing', () => {
		const { root } = tree('P', '#text');
		const elsewhere = tree('H2', '#text').leaf;
		const asked = [];
		const ask = (command) => {
			asked.push(command);
			return true;
		};
		assert.equal(barState({ anchorNode: elsewhere, focusNode: elsewhere }, root, ask), BAR_IDLE);
		assert.equal(barState(null, root, ask), BAR_IDLE);
		assert.equal(barState({ anchorNode: null, focusNode: null }, root, ask), BAR_IDLE);
		assert.deepEqual(asked, []);
	});

	it('is in a heading when the caret is in one', () => {
		const { root, leaf } = tree('H2', '#text');
		const state = barState({ anchorNode: leaf, focusNode: leaf }, root, noFormatting);
		assert.deepEqual(state, { bold: false, italic: false, heading: true, list: false });
	});

	it('is in a heading when the caret is in bold text inside one', () => {
		const { root, leaf } = tree('H2', 'B', '#text');
		const state = barState({ anchorNode: leaf, focusNode: leaf }, root, noFormatting);
		assert.equal(state.heading, true);
	});

	it('is not in a heading when the selection runs from a heading into a paragraph', () => {
		const { root, leaf: inHeading } = tree('H2', '#text');
		const paragraph = { nodeName: 'P', parentNode: root };
		const inParagraph = { nodeName: '#text', parentNode: paragraph };
		const state = barState({ anchorNode: inHeading, focusNode: inParagraph }, root, noFormatting);
		assert.equal(state.heading, false);
	});

	it('is not in a heading when the caret is in a paragraph, or on the empty surface itself', () => {
		const { root, leaf } = tree('P', '#text');
		assert.equal(
			barState({ anchorNode: leaf, focusNode: leaf }, root, noFormatting).heading,
			false
		);
		assert.equal(
			barState({ anchorNode: root, focusNode: root }, root, noFormatting).heading,
			false
		);
	});

	it('is in a list when the caret is in a bullet', () => {
		const { root, leaf } = tree('UL', 'LI', '#text');
		assert.equal(barState({ anchorNode: leaf, focusNode: leaf }, root, noFormatting).list, true);
	});

	it('takes bold and italic from the browser, the state execCommand toggles by', () => {
		const { root, leaf } = tree('P', '#text');
		const asked = [];
		const state = barState({ anchorNode: leaf, focusNode: leaf }, root, (command) => {
			asked.push(command);
			return command === 'bold';
		});
		assert.equal(state.bold, true);
		assert.equal(state.italic, false);
		assert.deepEqual(asked.sort(), ['bold', 'italic']);
	});
});

describe('headingBlock', () => {
	it('turns a heading back into a paragraph, and anything else into a heading', () => {
		assert.equal(headingBlock(true), '<p>');
		assert.equal(headingBlock(false), '<h2>');
	});
});

describe('RichTextField`s bar', () => {
	it('marks B, I, H2 and List as toggles, none pressed before the caret is anywhere', async () => {
		const tempDir = await mkdtemp(resolve('.rich-text-bar-test-'));
		try {
			const path = 'src/admin/ui/RichTextField.svelte';
			const code = compile(await readFile(path, 'utf8'), { filename: path, generate: 'server' })
				.js.code.replace(
					"'../rich-text.js'",
					JSON.stringify(pathToFileURL(resolve('src/admin/rich-text.js')).href)
				)
				.replace(
					"'../rich-text-bar.js'",
					JSON.stringify(pathToFileURL(resolve('src/admin/rich-text-bar.js')).href)
				);
			const componentPath = join(tempDir, 'RichTextField.js');
			await writeFile(componentPath, code);
			const { default: RichTextField } = await import(pathToFileURL(componentPath).href);

			const html = render(RichTextField, { props: { value: '<p>Text</p>' } }).body;
			const buttons = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gu)].map(([tag]) => ({
				label: tag.replace(/<[^>]+>/gu, '').trim(),
				pressed: /aria-pressed="([^"]*)"/u.exec(tag)?.[1] ?? null
			}));
			assert.deepEqual(buttons, [
				{ label: 'B', pressed: 'false' },
				{ label: 'I', pressed: 'false' },
				{ label: 'H2', pressed: 'false' },
				{ label: 'Link', pressed: null },
				{ label: 'List', pressed: 'false' }
			]);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});

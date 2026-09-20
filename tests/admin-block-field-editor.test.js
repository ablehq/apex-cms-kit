// @ts-nocheck — node:test suite over Svelte's parsed template AST.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { compile, parse } from 'svelte/compiler';

const path = 'src/admin/ui/BlockFieldEditor.svelte';

function descendants(node, match, found = []) {
	if (!node || typeof node !== 'object') return found;
	if (match(node)) found.push(node);
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) {
			for (const child of value) descendants(child, match, found);
		} else if (value && typeof value === 'object') {
			descendants(value, match, found);
		}
	}
	return found;
}

function attribute(node, name) {
	return node.attributes?.find((item) => item.type === 'Attribute' && item.name === name);
}

function staticAttribute(node, name, value) {
	const item = attribute(node, name);
	return item?.value?.length === 1 && item.value[0].type === 'Text' && item.value[0].data === value;
}

describe('BlockFieldEditor save lock', () => {
	it('puts the disabled-bound inert attribute around every field control branch', async () => {
		const source = await readFile(path, 'utf8');
		compile(source, { filename: path, generate: 'server' });
		const ast = parse(source, { filename: path, modern: true });
		const fieldsRoots = descendants(
			ast.fragment,
			(node) => node.type === 'RegularElement' && staticAttribute(node, 'class', 'fields')
		);
		assert.equal(fieldsRoots.length, 1, 'one .fields root encloses the editor');

		const fields = fieldsRoots[0];
		const inert = attribute(fields, 'inert');
		assert.equal(inert?.value?.type, 'ExpressionTag');
		assert.equal(inert?.value?.expression?.type, 'Identifier');
		assert.equal(inert?.value?.expression?.name, 'disabled');

		const controls = descendants(
			fields,
			(node) => node.type === 'RegularElement' || node.type === 'Component'
		);
		assert.ok(
			controls.some((node) => node.name === 'input' && staticAttribute(node, 'type', 'checkbox')),
			'checkbox branch is enclosed'
		);
		assert.ok(
			controls.some((node) => node.name === 'select'),
			'select branch is enclosed'
		);
		assert.ok(
			controls.some((node) => node.type === 'Component' && node.name === 'RichTextField'),
			'rich-text branch is enclosed'
		);
		assert.equal(
			controls.filter((node) => node.name === 'input' && staticAttribute(node, 'type', 'text'))
				.length,
			2,
			'text-array and default text branches are enclosed'
		);
		assert.ok(
			controls.some((node) => node.name === 'textarea'),
			'multiline branch is enclosed'
		);
		assert.ok(
			controls.some((node) => node.name === 'div' && staticAttribute(node, 'class', 'media')),
			'media branch is enclosed'
		);
		assert.equal(
			controls.filter((node) => node.name === 'button').length,
			2,
			'both media actions are enclosed'
		);
	});
});

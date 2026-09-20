// @ts-nocheck — node:test suite over Svelte's parsed template AST.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { compile, parse } from 'svelte/compiler';
import { render } from 'svelte/server';

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

	it('renders inert only while the editor is disabled', async () => {
		const tempDir = await mkdtemp(resolve('.block-field-editor-test-'));
		try {
			const richTextPath = 'src/admin/ui/RichTextField.svelte';
			const richTextSource = await readFile(richTextPath, 'utf8');
			const richTextCode = compile(richTextSource, {
				filename: richTextPath,
				generate: 'server'
			}).js.code.replace(
				"'../rich-text.js'",
				JSON.stringify(pathToFileURL(resolve('src/admin/rich-text.js')).href)
			);
			await writeFile(join(tempDir, 'RichTextField.js'), richTextCode);

			const source = await readFile(path, 'utf8');
			const componentCode = compile(source, { filename: path, generate: 'server' }).js.code.replace(
				"'./RichTextField.svelte'",
				"'./RichTextField.js'"
			);
			const componentPath = join(tempDir, 'BlockFieldEditor.js');
			await writeFile(componentPath, componentCode);
			const { default: BlockFieldEditor } = await import(pathToFileURL(componentPath).href);

			const fieldDefs = [
				{ field_name: 'published', display_name: 'Published', validator_kind: 'boolean' },
				{
					field_name: 'choice',
					display_name: 'Choice',
					validator_kind: 'text',
					text_inclusion: ['one', 'two']
				},
				{ field_name: 'body', display_name: 'Body', validator_kind: 'rich_text' },
				{ field_name: 'tags', display_name: 'Tags', validator_kind: 'text_array' },
				{ field_name: 'summary', display_name: 'Summary', validator_kind: 'multiline_text' },
				{
					field_name: 'image',
					display_name: 'Image',
					validator_kind: 'ref/model/Cms::GalleryItem'
				},
				{ field_name: 'title', display_name: 'Title', validator_kind: 'text' }
			].map((field) => ({ text_inclusion: null, ...field }));
			const fieldsTag = (disabled) => {
				const html = render(BlockFieldEditor, { props: { fieldDefs, disabled } }).body;
				return html.match(/<div class="fields[^>]*>/u)?.[0] ?? '';
			};

			assert.doesNotMatch(fieldsTag(false), /\sinert(?:=|\s|>)/u);
			assert.match(fieldsTag(true), /\sinert(?:=|\s|>)/u);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});

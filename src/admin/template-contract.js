// @ts-nocheck — legacy-mode admin browser module (plan §8, 3a compile-mode (a)).
// Deliberately untyped JS to sit beside the legacy-compiled admin components; its
// behavior is covered by tests/admin-save-page.test.js + tests/bff-realapex.test.js.

// The admin's field-definition source is the COMMITTED template contract (plan §8,
// 3a: "BlockFieldEditor edits block field values per the template contract's field
// defs"), not a live Apex fetch. The same JSON the provisioner uses to create the
// GLC templates tells the editor which control to render for each field. It is
// diffable, reviewable, and cannot drift from an Apex response mid-session.
//
// A hydrated page block carries `blockable.page_block_template.slug`; that slug keys
// into this contract to get the field list and each field's `validatorKind`.

/**
 * `@ts-nocheck` suppresses errors in THIS file; the annotations below still type
 * every importer. The shapes live in `./types.d.ts`.
 *
 * @typedef {import('./types').AdminBlockTemplateContract} AdminBlockTemplateContract
 * @typedef {import('./types').AdminFieldDef} AdminFieldDef
 */

export function createTemplateContract(contract) {
	const BY_SLUG = new Map((contract.templates || []).map((template) => [template.slug, template]));

	/**
	 * Every root template that can be placed as a page section.
	 *
	 * @returns {AdminBlockTemplateContract[]}
	 */
	function placeableTemplates() {
		return (contract.templates || []).filter((template) => template.placement === 'section');
	}

	/**
	 * @param {string | null | undefined} slug
	 * @returns {AdminBlockTemplateContract | null}
	 */
	function getTemplate(slug) {
		return BY_SLUG.get(slug) || null;
	}

	/**
	 * The field defs for a template slug, normalized to what BlockFieldEditor reads.
	 *
	 * @param {string | null | undefined} slug
	 * @returns {AdminFieldDef[]}
	 */
	function getFieldDefs(slug) {
		const template = getTemplate(slug);
		if (!template || !Array.isArray(template.fields)) return [];
		return template.fields.map((field) => ({
			field_name: field.name,
			display_name: field.displayName || field.name,
			validator_kind: field.validatorKind ?? null,
			role: field.role ?? null,
			text_inclusion: field.textInclusion ?? null
		}));
	}

	/**
	 * The child template defs for a repeatable/group template (parent + child only).
	 *
	 * @param {string | null | undefined} slug
	 * @returns {AdminBlockTemplateContract[]}
	 */
	function getChildTemplates(slug) {
		const template = getTemplate(slug);
		if (!template || !Array.isArray(template.children)) return [];
		return template.children
			.map((childSlug) => getTemplate(childSlug))
			.filter((child) => child !== null);
	}
	return {
		TEMPLATE_CONTRACT: contract,
		placeableTemplates,
		getTemplate,
		getFieldDefs,
		getChildTemplates
	};
}

/**
 * The site binds its committed contract once (its own `template-contract.js` does
 * this at import time); the kit's components read through these accessors.
 */
let bound = null;
/**
 * @param {unknown} contract the committed page-block template contract
 * @param {{ sectionGroups?: Array<[string, string[]]>, derivedTemplates?: string[] }} [options]
 *   how the add-section dialog groups the placeable templates, and which of them
 *   are derived (their content computed at publish, not authored).
 */
export function bindTemplateContract(contract, options = {}) {
	bound = createTemplateContract(contract);
	bound.sectionGroups = options.sectionGroups ?? null;
	bound.derivedTemplates = new Set(options.derivedTemplates ?? []);
	return bound;
}
/** The dialog's groups; null means one flat list of everything placeable. */
export function sectionGroups() {
	return current().sectionGroups;
}
/** @param {string} slug */
export function isDerivedTemplate(slug) {
	return current().derivedTemplates.has(slug);
}
function current() {
	if (!bound)
		throw new Error("template contract not bound: import the site's template-contract.js first");
	return bound;
}
export function placeableTemplates(...args) {
	return current().placeableTemplates(...args);
}
export function getTemplate(...args) {
	return current().getTemplate(...args);
}
export function getFieldDefs(...args) {
	return current().getFieldDefs(...args);
}
export function getChildTemplates(...args) {
	return current().getChildTemplates(...args);
}
export function templateContract() {
	return current().TEMPLATE_CONTRACT;
}

# @ablehq/apex-cms-kit

The site-side mechanics of the Apex CMS, for SvelteKit sites on Cloudflare Workers:
the admin BFF (session in D1, origin/CSRF boundary, audit, the Apex client and its
operations), the content module (publish every collection to one KV value; read it per
request), the sanitizer, the page draft model, the generic record layer (list/get/create/update/delete over a
site's `ContentContract`), the record draft, the write-boundary sanitizer, the field
editors and pickers as building blocks, and the D1 migrations. **Not** the admin's screens, shell, navigation
or stylesheet — every site owns how its admin looks and which screens it has, and
composes them from these pieces. Extracted from `ablehq/gospel-life-church` in September 2026; consumed
by gospel-life-church, poovayya and godrej-foundation.

The plan it implements: `sites/.ai/session-2026-09-02/01-workers-and-full-admin-plan.md` §2.4.

## Layout

`src/` mirrors a site's `src/lib/`: `server/bff`, `server/content`, `cms`, `sanitize`,
`admin`, `admin/ui`, plus `hooks.ts`. It ships TypeScript and Svelte source — no build
step — and vite-plugin-svelte bundles it because of the `svelte` field.

Import paths: `@ablehq/apex-cms-kit/server/bff/guard` (TS, no extension),
`@ablehq/apex-cms-kit/admin/md5.js`, `@ablehq/apex-cms-kit/admin/ui/PageForm.svelte`,
`@ablehq/apex-cms-kit/admin/ui/BlockFieldEditor.svelte`. (The kit ships no CSS — a
site's admin stylesheet is its own.)

## A site adds

- `src/lib/server/bff/context.ts` — `buildContext` = the kit's plus the site's Apex
  client extension and its `project` (see gospel-life-church).
- `src/lib/server/bff/apex-admin-client.ts` — `createApexAdminClient` = the kit's
  plus the site's methods over `request()`/`get()`.
- `src/lib/admin/bff-client.js` — `createBffClient` = the kit's with `extend`.
- `src/hooks.server.ts` — `export const handle = adminHooks();`
- `migrations/` — copy the kit's; apply with `wrangler d1 migrations apply`.
- `src/kit-svelte.d.ts` — an ambient `declare module '@ablehq/apex-cms-kit/*.svelte'`
  (the kit ships component source, not declaration files; copy gospel-life-church's).
- `tsconfig.json` — `"maxNodeModuleJsDepth": 2`, so svelte-check reads the kit's JSDoc.
- `.npmrc` — `install-links=true` when depending on a local checkout (`file:`), so
  the kit is copied, not symlinked, and resolves one copy of svelte/kit/zod. The copy
  is stale until `npm run kit:sync` (rm the copy, `npm install`) — `vite dev` will not
  see a kit edit before that.
- `src/lib/site.js` — binds what the kit leaves to the site: `bindReservedRoutes` and
  `allowRichTextClasses`; import it from the root `+layout.svelte` and `hooks.server.ts`.
- its own admin: shell, stylesheet, navigation, screens, the page form and its template
  contract (gospel-life-church's `src/lib/admin/` is the reference).

Cookies are `apex_admin_session` and `apex_bff_csrf` on every site.

## Develop

    npm install
    npm test        # node --import tsx --test tests/*.test.js
    npm run check   # tsc
    npm run lint    # prettier --check .

`--import tsx` is not decoration. The suites import `src/**/*.ts` directly and some
`.js` modules import a `.ts` sibling, so plain `node --test` cannot load them — this
line used to read `node --test over tests/`, which never worked. There is no
plain-`node` entry point anywhere in the kit or the three sites.

## The export map is a wildcard, and that is the decision

`package.json`'s `exports` maps `./*.js`, `./*.ts`, `./*.svelte`, `./*.css` and a bare
`./*` straight onto `src/`. **Every module under `src/` is therefore importable, and
that is deliberate rather than an oversight** (codex's P5 fix 4, item 6, asked for the
question to be settled either way).

Blocking "internal" subpaths was the alternative and it is the wrong shape here:

- the wildcard _is_ the delivery mechanism. The three sites already import about forty
  subpaths directly — `server/bff/reject`, `admin/save-page.js`, `sanitize/html.js`
  and so on — and there is no `index` re-export surface for them to go through;
- what counts as internal does not hold still. `server/bff/operations/created-id` was
  written as a private helper for four handlers in one pass and is imported by
  gospel-life-church's own tag handler in the next, precisely so the two copies cannot
  drift on the same rule;
- a denylist has the same failure mode as the accident it fixes. Every new file would
  need an entry and forgetting one is exactly how something becomes public by default.

What makes that affordable is what this package is: a workspace-local source package
consumed by three first-party repositories pinned to a SHA, not a semver'd library with
unknown users. A removal is not a silent break — it is a build failure in three repos
in the same workspace, before anything is published anywhere.

The boundary that actually governs what belongs here is the kit-boundary ruling
(mechanics and field editors in the kit; screens, shell, CSS and navigation per site),
not the export map. So: **treat everything under `src/` as supported**, and remove or
rename a module only with the three consumers' builds run.

## Naming modules

No module under `src/` may have a basename ending in `ts` or `js` (before its
extension) — `list-posts.ts`, `objs.js`. Vite 6.2's package `exports` matcher treats a
bare import of such a subpath as a hit for this package's `./*.ts` / `./*.js` patterns
and looks for a file that does not exist, so the consumer's build fails while Node
resolves it fine (measured 2026-09-05). `tests/module-names.test.js` enforces the rule.

# @ablehq/apex-cms-kit

The site-side half of the Apex CMS, for SvelteKit sites on Cloudflare Workers: the
admin BFF (session in D1, origin/CSRF boundary, audit, the Apex client), the admin
UI (shell, page editor, field editors, media picker), the content module (publish
every collection to one KV value; read it per request), sanitizers, and the D1
migrations. Extracted from `ablehq/gospel-life-church` in September 2026; consumed
by gospel-life-church, poovayya and godrej-foundation.

The plan it implements: `sites/.ai/session-2026-09-02/01-workers-and-full-admin-plan.md` §2.4.

## Layout

`src/` mirrors a site's `src/lib/`: `server/bff`, `server/content`, `cms`, `sanitize`,
`admin`, `admin/ui`, plus `hooks.ts`. It ships TypeScript and Svelte source — no build
step — and vite-plugin-svelte bundles it because of the `svelte` field.

Import paths: `@ablehq/apex-cms-kit/server/bff/guard` (TS, no extension),
`@ablehq/apex-cms-kit/admin/md5.js`, `@ablehq/apex-cms-kit/admin/ui/PageForm.svelte`,
`@ablehq/apex-cms-kit/admin/admin.css`.

## A site adds

- `src/lib/server/bff/context.ts` — `buildContext` = the kit's plus the site's Apex
  client extension and its `project` (see gospel-life-church).
- `src/lib/server/bff/apex-admin-client.ts` — `createApexAdminClient` = the kit's
  plus the site's methods over `request()`/`get()`.
- `src/lib/admin/bff-client.js` — `createBffClient` = the kit's with `extend`.
- `src/lib/admin/template-contract.js` — `bindTemplateContract(contract)`.
- `src/hooks.server.ts` — `export const handle = adminHooks();`
- `migrations/` — copy the kit's; apply with `wrangler d1 migrations apply`.
- `.npmrc` — `install-links=true` when depending on a local checkout (`file:`), so
  the kit is copied, not symlinked, and resolves one copy of svelte/kit/zod.

Cookies are `apex_admin_session` and `apex_bff_csrf` on every site.

## Develop

    npm install
    npm test        # node --test over tests/
    npm run check   # tsc

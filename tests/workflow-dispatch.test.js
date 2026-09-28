import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
	dispatchWorkflow,
	sanitizeReason,
	REASON_MAX_LENGTH
} from '../src/server/github/workflow-dispatch.ts';

const config = {
	repo: 'owner/site',
	workflow: 'refresh.yml',
	ref: 'preview',
	userAgent: 'site-admin'
};
const workflowUrl = 'https://github.com/owner/site/actions/workflows/refresh.yml';
const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});
const answer = (payload, status = 200) => new Response(JSON.stringify(payload), { status });
const dispatch = (payload) =>
	dispatchWorkflow(config, {
		token: 'test',
		actor: 'editor',
		fetchImpl: async () => answer(payload)
	});

describe('workflow dispatch transport', () => {
	it('uses configuration and exact plain-object headers and string inputs', async () => {
		let calls = 0;
		const result = await dispatchWorkflow(config, {
			token: 'test',
			actor: 'editor',
			reason: 'why\n\u200bnow',
			allowEmpty: true,
			dryRun: true,
			fetchImpl: async (url, init) => {
				calls++;
				assert.equal(
					url,
					'https://api.github.com/repos/owner/site/actions/workflows/refresh.yml/dispatches'
				);
				assert.equal(init.method, 'POST');
				assert.deepEqual(init.headers, {
					Accept: 'application/vnd.github+json',
					Authorization: 'Bearer test',
					'X-GitHub-Api-Version': '2022-11-28',
					'Content-Type': 'application/json',
					'User-Agent': 'site-admin'
				});
				assert.deepEqual(JSON.parse(init.body), {
					ref: 'preview',
					inputs: { reason: 'why now', actor: 'editor', allow_empty: 'true', dry_run: 'true' },
					return_run_details: true
				});
				return answer({ workflow_run_id: 7 });
			}
		});
		assert.equal(calls, 1);
		assert.deepEqual(result, {
			ok: true,
			runId: 7,
			runUrl: 'https://github.com/owner/site/actions/runs/7',
			status: 200
		});
	});
	it('resolves global fetch at call time and retains defaults', async () => {
		globalThis.fetch = async (_url, init) => {
			assert.deepEqual(JSON.parse(init.body).inputs, {
				actor: 'ingest',
				reason: 'Publish from the admin by ingest',
				allow_empty: 'false',
				dry_run: 'false'
			});
			return new Response(null, { status: 204 });
		};
		assert.deepEqual(await dispatchWorkflow(config, { token: 'test', actor: 'ingest' }), {
			ok: true,
			runId: null,
			runUrl: workflowUrl,
			status: 204
		});
	});
	it('sanitizes and bounds reasons including controls and formatting characters', () => {
		assert.equal(sanitizeReason(' a\u0000b\u200bc\n\r\t d '), 'a b c d');
		assert.equal(sanitizeReason('x'.repeat(1000)).length, REASON_MAX_LENGTH);
		assert.equal(REASON_MAX_LENGTH, 200);
	});
	for (const html_url of [
		'javascript:alert(1)',
		'http://github.com/owner/site/actions/runs/7',
		'https://evil.test/',
		'https://github.com.evil/owner/site/actions/runs/7',
		'https://github.com@evil.test/owner/site/actions/runs/7',
		'https://user:pass@github.com/owner/site/actions/runs/7',
		'https://github.com\\@evil.test/owner/site/actions/runs/7',
		'https://github.com/owner/other/actions/runs/7',
		'https://github.com/owner/site/actions/../../other/actions/runs/7',
		'https://github.com/owner/site/actions/%2e%2e/%2e%2e/other/actions/runs/7',
		'https://github.com/owner/site/actions/%2f..%2fother',
		null,
		5
	])
		it(`rejects unsafe/non-string response URL ${html_url}`, async () => {
			assert.equal(
				(await dispatch({ workflow_run_id: 7, html_url })).runUrl,
				'https://github.com/owner/site/actions/runs/7'
			);
		});
	it('accepts and normalizes safe workflow and run URLs', async () => {
		assert.equal(
			(await dispatch({ workflow_run_id: 7, html_url: workflowUrl })).runUrl,
			workflowUrl
		);
		assert.equal(
			(
				await dispatch({
					workflow_run_id: 7,
					html_url: 'https://GITHUB.COM/owner/site/actions/runs/7'
				})
			).runUrl,
			'https://github.com/owner/site/actions/runs/7'
		);
	});
	for (const id of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '7'])
		it(`falls back on invalid run ID ${id}`, async () => {
			assert.deepEqual(
				await dispatch({
					workflow_run_id: id,
					html_url: 'https://github.com/owner/site/actions/runs/7'
				}),
				{ ok: true, runId: null, runUrl: workflowUrl, status: 200 }
			);
		});
	it('handles successful non-JSON responses without claiming a run', async () => {
		const result = await dispatchWorkflow(config, {
			token: 'test',
			actor: 'editor',
			fetchImpl: async () => new Response('not json')
		});
		assert.deepEqual(result, { ok: true, runId: null, runUrl: workflowUrl, status: 200 });
	});
	it('preserves network and upstream failure shapes', async () => {
		assert.deepEqual(
			await dispatchWorkflow(config, {
				token: 'test',
				actor: 'editor',
				fetchImpl: async () => {
					throw new Error('offline');
				}
			}),
			{ ok: false, status: 502, detail: 'GitHub could not be reached: offline' }
		);
		assert.deepEqual(
			await dispatchWorkflow(config, {
				token: 'test',
				actor: 'editor',
				fetchImpl: async () => answer({ message: 'Denied' }, 403)
			}),
			{ ok: false, status: 403, detail: 'GitHub refused the dispatch (403): Denied' }
		);
		assert.deepEqual(
			await dispatchWorkflow(config, {
				token: 'test',
				actor: 'editor',
				fetchImpl: async () => new Response('not json', { status: 503, statusText: 'Unavailable' })
			}),
			{ ok: false, status: 503, detail: 'GitHub refused the dispatch (503): Unavailable' }
		);
	});
});

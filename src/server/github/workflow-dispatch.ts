/** GitHub transport only. Caller owns authorization, auditing and scheduling. */
export interface WorkflowDispatchConfig {
	repo: string;
	workflow: string;
	ref: string;
	userAgent: string;
}

export interface WorkflowDispatchInput {
	token: string;
	actor: string;
	reason?: string;
	allowEmpty?: boolean;
	dryRun?: boolean;
	fetchImpl?: typeof fetch;
}

export type WorkflowDispatchResult =
	| { ok: true; runId: number | null; runUrl: string; status: number }
	| { ok: false; status: number; detail: string };

export const REASON_MAX_LENGTH = 200;

export function sanitizeReason(reason: string): string {
	return reason
		.replace(/[\p{Cc}\p{Cf}]/gu, ' ')
		.replace(/\s+/gu, ' ')
		.trim()
		.slice(0, REASON_MAX_LENGTH);
}

/** Normalize before judging the repository boundary; never forward userinfo or encoded paths. */
function safeRunUrl(value: unknown, repo: string): string | null {
	if (typeof value !== 'string') return null;
	try {
		const url = new URL(value);
		if (url.origin !== 'https://github.com' || url.username || url.password) return null;
		if (!url.pathname.startsWith(`/${repo}/actions/`) || url.pathname.includes('%')) return null;
		return url.href;
	} catch {
		return null;
	}
}

/** One request, with a workflow-list fallback when GitHub supplies no usable run details. */
export async function dispatchWorkflow(
	config: WorkflowDispatchConfig,
	input: WorkflowDispatchInput
): Promise<WorkflowDispatchResult> {
	const workflowUrl = `https://github.com/${config.repo}/actions/workflows/${config.workflow}`;
	const doFetch = input.fetchImpl ?? fetch;
	let response: Response;
	try {
		response = await doFetch(
			`https://api.github.com/repos/${config.repo}/actions/workflows/${config.workflow}/dispatches`,
			{
				method: 'POST',
				headers: {
					Accept: 'application/vnd.github+json',
					Authorization: `Bearer ${input.token}`,
					'X-GitHub-Api-Version': '2022-11-28',
					'Content-Type': 'application/json',
					'User-Agent': config.userAgent
				},
				body: JSON.stringify({
					ref: config.ref,
					inputs: {
						reason: sanitizeReason(input.reason || `Publish from the admin by ${input.actor}`),
						actor: input.actor,
						allow_empty: input.allowEmpty ? 'true' : 'false',
						dry_run: input.dryRun ? 'true' : 'false'
					},
					return_run_details: true
				})
			}
		);
	} catch (error) {
		return {
			ok: false,
			status: 502,
			detail: `GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}`
		};
	}
	if (response.status === 204) return { ok: true, runId: null, runUrl: workflowUrl, status: 204 };
	if (!response.ok) {
		return {
			ok: false,
			status: response.status,
			detail: `GitHub refused the dispatch (${response.status}): ${await readDetail(response)}`
		};
	}
	const payload = (await response.json().catch(() => null)) as {
		workflow_run_id?: unknown;
		html_url?: unknown;
	} | null;
	const id = payload?.workflow_run_id;
	const runId = typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
	const runUrl =
		runId === null
			? workflowUrl
			: (safeRunUrl(payload?.html_url, config.repo) ??
				`https://github.com/${config.repo}/actions/runs/${runId}`);
	return { ok: true, runId, runUrl, status: response.status };
}

async function readDetail(response: Response): Promise<string> {
	try {
		const text = await response.text();
		const parsed = JSON.parse(text) as { message?: unknown } | null;
		return typeof parsed?.message === 'string' ? parsed.message : text.slice(0, 200);
	} catch {
		return response.statusText || 'no message';
	}
}

import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, afterEach, describe, it, expect, vi } from 'vitest';
import worker from '../src/index';

/*
 * The deploy hook secret is production-only. If it ever lands in .dev.vars,
 * the vitest pool loads it into env, and every existing PUT test would POST
 * the real deploy hook on every run -- silently spending build quota with all
 * tests green. Fail the suite loudly instead; these tests inject the URL
 * per-call and never need it in the environment.
 */
beforeAll(() => {
	expect(env.DEPLOY_HOOK_URL, 'DEPLOY_HOOK_URL must not be set in .dev.vars').toBeUndefined();
});

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const HOOK_URL = 'https://hooks.invalid/deploy/test-hook';

/*
 * The tests invoke the handler directly, so the worker code runs in this
 * runtime and sees the stubbed global fetch. Bindings (R2) do not go through
 * global fetch, so the stub only intercepts the deploy hook call.
 */
const putWithHook = async (hookUrl: string | undefined) => {
	const request = new IncomingRequest('https://worker.askhb.no/personalinfo.json', {
		method: 'PUT',
		headers: {
			'X-Custom-API-Key': env.AUTH_KEY_SECRET,
			'Content-Type': 'application/json',
		},
		body: '{"name":"Ask"}',
	});
	const ctx = createExecutionContext();
	const hookedEnv = { ...env, DEPLOY_HOOK_URL: hookUrl };
	const response = await worker.fetch(request, hookedEnv, ctx);
	await waitOnExecutionContext(ctx);
	return response;
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('deploy hook after a successful save', () => {
	it('fires one POST to the configured hook', async () => {
		const hookFetch = vi.fn(async () => new Response('ok', { status: 200 }));
		vi.stubGlobal('fetch', hookFetch);

		const response = await putWithHook(HOOK_URL);

		expect(response.status).toBe(200);
		expect(hookFetch).toHaveBeenCalledTimes(1);
		expect(hookFetch).toHaveBeenCalledWith(HOOK_URL, { method: 'POST' });
	});

	it('keeps the save successful when the hook fails', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));

		const response = await putWithHook(HOOK_URL);

		expect(response.status).toBe(200);
	});

	it('keeps the save successful when the hook is unreachable', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => {
			throw new Error('network down');
		}));

		const response = await putWithHook(HOOK_URL);

		expect(response.status).toBe(200);
	});

	it('does not call the hook when none is configured', async () => {
		const hookFetch = vi.fn(async () => new Response('ok', { status: 200 }));
		vi.stubGlobal('fetch', hookFetch);

		const response = await putWithHook(undefined);

		expect(response.status).toBe(200);
		expect(hookFetch).not.toHaveBeenCalled();
	});
});

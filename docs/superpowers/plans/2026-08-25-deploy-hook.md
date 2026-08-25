# Deploy Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After every successful content save, r2-worker fires the Cloudflare Pages deploy hook for askhb.no, fire-and-forget, so the prerendered HTML follows content edits within minutes (askhb.no spec `docs/superpowers/specs/2026-08-25-prerender-design.md`, section 5).

**Architecture:** One optional secret (`DEPLOY_HOOK_URL`) on the worker, one small function called after a successful `PUT`, dispatched through `ctx.waitUntil` so it never delays or fails the save response. Absent secret means no hook fires, which keeps dev, tests and a pre-hook deploy all working.

**Tech Stack:** Cloudflare Workers, vitest with `@cloudflare/vitest-pool-workers` and its `fetchMock`.

## Global Constraints

- Work in the worktree `/Users/ahallemberg/repos/personal/r2-worker-wt` on branch `feat/deploy-hook`. Paths below are relative to it.
- This repo HAS a test framework (vitest, `npm test`): follow the test-first cycle.
- Match per-file indentation: `src/index.ts` uses 4 spaces, `test/*.spec.ts` use tabs.
- `.dev.vars` holds real local secrets: never print it, never commit it, and do not add `DEPLOY_HOOK_URL` to it (tests inject the value per-call instead).
- **Never add attribution trailers** to commits or PRs.
- Changes reach `main` via PR.

**Design amendment vs the askhb.no spec:** the spec said the secret lives in "the admin.askhb.no worker". There is no admin worker; admin.askhb.no is a static frontend and **r2-worker is the write path** (every save is an authed `PUT` here). The hook therefore lives in r2-worker. The screenshot `POST` route does not fire the hook: a capture only reaches the page after the `projects.json` save that references it, and that save is a `PUT`.

---

### Task 1: Fire the hook after a successful PUT

**Files:**
- Create: `test/deploy-hook.spec.ts`
- Modify: `src/index.ts` (`Env` interface; new `triggerDeployHook` function; one call in the `PUT` case)

**Interfaces:**
- Consumes: existing `Env`, `authorizeRequest`, the `PUT` case in the default fetch handler.
- Produces: `Env.DEPLOY_HOOK_URL?: string` and `triggerDeployHook(env: Env, ctx: ExecutionContext): void`.

- [ ] **Step 1: Write the failing test — `test/deploy-hook.spec.ts`**

```ts
import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { beforeAll, afterEach, describe, it, expect } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const HOOK_ORIGIN = 'https://hooks.invalid';
const HOOK_PATH = '/deploy/test-hook';

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

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

/*
 * assertNoPendingInterceptors doubles as the positive assertion: a registered
 * interceptor that was never consumed fails the test, so "the hook was called
 * exactly once" is proven by registering exactly one.
 */
afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

describe('deploy hook after a successful save', () => {
	it('fires one POST to the configured hook', async () => {
		fetchMock.get(HOOK_ORIGIN).intercept({ path: HOOK_PATH, method: 'POST' }).reply(200, 'ok');

		const response = await putWithHook(`${HOOK_ORIGIN}${HOOK_PATH}`);
		expect(response.status).toBe(200);
	});

	it('keeps the save successful when the hook fails', async () => {
		fetchMock.get(HOOK_ORIGIN).intercept({ path: HOOK_PATH, method: 'POST' }).reply(500, 'boom');

		const response = await putWithHook(`${HOOK_ORIGIN}${HOOK_PATH}`);
		expect(response.status).toBe(200);
	});

	it('saves normally when no hook is configured', async () => {
		const response = await putWithHook(undefined);
		expect(response.status).toBe(200);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/ahallemberg/repos/personal/r2-worker-wt && npm install --no-audit --no-fund && npm test -- --run`
Expected: the first test FAILS on `assertNoPendingInterceptors` (the interceptor is never consumed because nothing fetches the hook yet). The other two may pass; that is fine — the first one is the driver. The pre-existing `test/index.spec.ts` must still pass.

- [ ] **Step 3: Implement in `src/index.ts`**

Add to the `Env` interface (after `SCREENSHOT_HOSTS: string;`):

```ts
    // Cloudflare Pages deploy hook for askhb.no, set with `wrangler secret put
    // DEPLOY_HOOK_URL`. Optional so dev and tests run without one; absent means
    // saves succeed and no rebuild fires.
    DEPLOY_HOOK_URL?: string;
```

Add above the default export:

```ts
/*
 * A successful save means the prerendered askhb.no is now stale, so ask
 * Cloudflare Pages for a rebuild. Fire-and-forget by contract: a build that
 * fails to start must never turn a successful save into a failed one, so the
 * call rides ctx.waitUntil and failures are logged rather than thrown.
 */
const triggerDeployHook = (env: Env, ctx: ExecutionContext): void => {
    if (!env.DEPLOY_HOOK_URL) {
        return;
    }

    ctx.waitUntil(
        fetch(env.DEPLOY_HOOK_URL, { method: 'POST' })
            .then(response => {
                if (!response.ok) {
                    console.log(`Deploy hook responded ${response.status}`);
                }
            })
            .catch(error => {
                console.log(`Deploy hook unreachable: ${error}`);
            }),
    );
};
```

In the fetch handler's `switch (request.method)`, change the `PUT` case to call it after the successful put (the existing content-type comment and the put call stay exactly as they are):

```ts
            case "PUT":
                // Store the uploaded Content-Type. Without it R2 serves the object
                // with no type at all and the browser sniffs the bytes, which both
                // breaks anything relying on a declared type and lets an uploaded
                // file be interpreted as something other than what it is.
                await env.MAIN_BUCKET.put(key, request.body, {
                    httpMetadata: {
                        contentType: request.headers.get("content-type") ?? "application/octet-stream"
                    }
                });
                triggerDeployHook(env, ctx);
                return new Response(`Put ${key} successfully!`, {status: 200, headers});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --run`
Expected: all tests pass, including the pre-existing `test/index.spec.ts` (those tests pass an `env` without `DEPLOY_HOOK_URL`, which now exercises the absent-secret branch under `disableNetConnect` isolation-free, since no fetch happens).

- [ ] **Step 5: Commit**

```bash
git add test/deploy-hook.spec.ts src/index.ts
git commit -m "Fire the askhb.no deploy hook after a successful save"
```

---

### Task 2: Document the secret and the dashboard step

**Files:**
- Modify: `README.md` (Setup section)

**Interfaces:** none.

- [ ] **Step 1: Add a setup step to `README.md`**

After the existing "Set API secret" step, add:

```markdown
4. **Set the deploy hook (optional)**

   askhb.no is prerendered at build time, so a content save should trigger a
   rebuild. Create a deploy hook for the askhb.no project in the Cloudflare
   dashboard (Workers & Pages -> the askhb.no project -> Settings -> Builds &
   deployments -> Deploy hooks), then:

   ```bash
   npx wrangler secret put DEPLOY_HOOK_URL
   # Paste the hook URL when prompted
   ```

   Without the secret the worker saves normally and simply never triggers a
   rebuild.
```

Renumber the following steps accordingly.

- [ ] **Step 2: Verify and commit**

Run: `npm test -- --run` (unchanged, still green).

```bash
git add README.md
git commit -m "Document the askhb.no deploy hook secret"
```

---

### Task 3: PR and rollout

**Files:** none (process).

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin feat/deploy-hook
gh pr create --title "Fire the askhb.no deploy hook after content saves" --body "After a successful PUT, the worker POSTs the Cloudflare Pages deploy hook for askhb.no through ctx.waitUntil, so the prerendered HTML follows content edits. The secret is optional: without it saves behave exactly as today. Fire-and-forget by contract, covered by fetchMock tests for the fired, failing and unconfigured cases."
```

- [ ] **Step 2: Rollout (owner steps, after merge)**

1. In the Cloudflare dashboard, create a deploy hook for the askhb.no Pages project and copy its URL.
2. In the r2-worker checkout on main: `npx wrangler secret put DEPLOY_HOOK_URL` (paste the URL), then `npm run deploy`.
3. Verify end to end: make a trivial edit in admin (for example re-save personal info), then confirm a new askhb.no Pages build starts within a minute and the deployed HTML carries the edit. Worker-side failures are visible as console lines via the observability telemetry endpoint.

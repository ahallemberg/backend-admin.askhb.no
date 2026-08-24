import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const AUTH_HEADER = 'X-Custom-API-Key';

const put = async (key: string, body: string, headers: Record<string, string>) => {
	const request = new IncomingRequest(`https://worker.askhb.no/${key}`, {
		method: 'PUT',
		headers,
		body,
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
};

const authed = (contentType?: string) => ({
	[AUTH_HEADER]: env.AUTH_KEY_SECRET,
	...(contentType ? { 'Content-Type': contentType } : {}),
});

describe('PUT stores the uploaded content type', () => {
	it('keeps application/pdf on an uploaded CV', async () => {
		const response = await put('cv.pdf', '%PDF-1.4 fake', authed('application/pdf'));
		expect(response.status).toBe(200);

		const stored = await env.MAIN_BUCKET.get('cv.pdf');
		expect(stored?.httpMetadata?.contentType).toBe('application/pdf');
	});

	it('keeps application/json on the portfolio files', async () => {
		const response = await put('personalinfo.json', '{"name":"Ask"}', authed('application/json'));
		expect(response.status).toBe(200);

		const stored = await env.MAIN_BUCKET.get('personalinfo.json');
		expect(stored?.httpMetadata?.contentType).toBe('application/json');
	});

	it('falls back to application/octet-stream when no type is sent', async () => {
		// A string body makes Request auto-set text/plain, so send bytes instead —
		// an ArrayBufferView adds no Content-Type of its own.
		const request = new IncomingRequest('https://worker.askhb.no/untyped.bin', {
			method: 'PUT',
			headers: { [AUTH_HEADER]: env.AUTH_KEY_SECRET },
			body: new Uint8Array([1, 2, 3]),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);

		const stored = await env.MAIN_BUCKET.get('untyped.bin');
		expect(stored?.httpMetadata?.contentType).toBe('application/octet-stream');
	});

	it('never stores an empty type, which is what made R2 serve objects unsniffed', async () => {
		await put('typed.txt', 'hello', authed('text/plain'));
		const stored = await env.MAIN_BUCKET.get('typed.txt');
		expect(stored?.httpMetadata?.contentType).toBeTruthy();
	});
});

describe('authorization', () => {
	it('rejects a PUT with no API key', async () => {
		const response = await put('cv.pdf', 'x', { 'Content-Type': 'application/pdf' });
		expect(response.status).toBe(403);
	});

	it('rejects a PUT with the wrong API key', async () => {
		const response = await put('cv.pdf', 'x', {
			[AUTH_HEADER]: 'not-the-secret',
			'Content-Type': 'application/pdf',
		});
		expect(response.status).toBe(403);
	});

	it('rejects methods other than PUT', async () => {
		for (const method of ['GET', 'DELETE', 'POST']) {
			const request = new IncomingRequest('https://worker.askhb.no/cv.pdf', {
				method,
				headers: { [AUTH_HEADER]: env.AUTH_KEY_SECRET },
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(403);
		}
	});
});

describe('CORS preflight', () => {
	it('allows PUT with the headers the admin app sends', async () => {
		const request = new IncomingRequest('https://worker.askhb.no/cv.pdf', { method: 'OPTIONS' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		// POST as well as PUT: without it the admin app's capture request never
		// leaves the browser, and 'PUT, POST' satisfies a toContain('PUT') alone.
		expect(response.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
		expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
		expect(response.headers.get('Access-Control-Allow-Headers')).toContain(AUTH_HEADER);
	});
});


/*
 * A minimal valid PNG: the 8-byte signature plus a little payload. The tests
 * care that the bytes the binding hands back are the bytes that reach R2, not
 * what they depict, and a real screenshot in the repo would be a megabyte of
 * fixture nobody can review. The signature has to be real, because the worker
 * checks it.
 */
const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

const pngResponse = () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } });

type QuickActionCall = { action: string; options: Record<string, any> };

/*
 * Browser Run has no local simulator, so the binding is stubbed rather than
 * exercised: these tests are about what the worker asks for and what it does
 * with the answer. That the real service honours the request is verified by
 * running it, not here.
 */
const stubBrowser = (reply?: (call: QuickActionCall) => Response) => {
	const calls: QuickActionCall[] = [];
	return {
		calls,
		binding: {
			async quickAction(action: string, options: Record<string, any>) {
				calls.push({ action, options });
				return reply ? reply({ action, options }) : pngResponse();
			},
		},
	};
};

const screenshot = async (
	body: unknown,
	options: { headers?: Record<string, string>; method?: string; browser?: any; raw?: string } = {},
) => {
	const request = new IncomingRequest('https://worker.askhb.no/screenshot', {
		method: options.method ?? 'POST',
		headers: options.headers ?? { [AUTH_HEADER]: env.AUTH_KEY_SECRET, 'Content-Type': 'application/json' },
		...(options.method === 'GET' ? {} : { body: options.raw ?? JSON.stringify(body) }),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, { ...env, BROWSER: options.browser } as any, ctx);
	await waitOnExecutionContext(ctx);
	return response;
};

const VEIVETT = { url: 'https://veivett.no/', key: 'screenshots/veivett-no/shot' };

describe('POST /screenshot authorization', () => {
	it('rejects a capture with no API key', async () => {
		const response = await screenshot(VEIVETT, { headers: { 'Content-Type': 'application/json' } });
		expect(response.status).toBe(403);
	});

	it('rejects a capture with the wrong API key', async () => {
		const response = await screenshot(VEIVETT, {
			headers: { [AUTH_HEADER]: 'not-the-secret', 'Content-Type': 'application/json' },
		});
		expect(response.status).toBe(403);
	});

	it('rejects methods other than POST', async () => {
		const response = await screenshot(VEIVETT, { method: 'GET' });
		expect(response.status).toBe(405);
	});
});

describe('POST /screenshot renders only allowed hosts', () => {
	/*
	 * Asserting the url the binding was handed, not just the status. Validating
	 * the caller's host and then rendering something else would otherwise pass
	 * every test in this block.
	 */
	it('renders an allowed host, and renders the url it validated', async () => {
		const browser = stubBrowser();
		const response = await screenshot(VEIVETT, { browser: browser.binding });

		expect(response.status).toBe(200);
		expect(browser.calls[0].options.url).toBe('https://veivett.no/');
	});

	it('renders the www spelling, which is listed in its own right', async () => {
		const browser = stubBrowser();
		const response = await screenshot(
			{ ...VEIVETT, url: 'https://www.veivett.no/' },
			{ browser: browser.binding },
		);

		expect(response.status).toBe(200);
		expect(browser.calls[0].options.url).toBe('https://www.veivett.no/');
	});

	/*
	 * Exact matching, so a subdomain is refused even though its parent is
	 * allowed: a subdomain that falls out of the owner's hands would otherwise
	 * be renderable and storable under askhb.no.
	 */
	it('rejects a subdomain of an allowed host', async () => {
		const browser = stubBrowser();
		const response = await screenshot(
			{ ...VEIVETT, url: 'https://status.veivett.no/' },
			{ browser: browser.binding },
		);
		expect(response.status).toBe(400);
		expect(browser.calls).toHaveLength(0);
	});

	const rejectedUrls = [
		'https://example.com/',
		'https://notveivett.no/',
		'https://veivett.no.evil.com/',
		'http://veivett.no/',
	];

	for (const url of rejectedUrls) {
		it(`rejects ${url}`, async () => {
			const browser = stubBrowser();
			const response = await screenshot({ ...VEIVETT, url }, { browser: browser.binding });
			expect(response.status).toBe(400);
			expect(browser.calls).toHaveLength(0);
		});
	}
});

describe('POST /screenshot pins where a capture can land', () => {
	const rejected = [
		'personalinfo.json',
		'screenshots/../personalinfo',
		// Clears the prefix and still carries dots, which the two above do not:
		// without these the character class could be widened and nothing fails.
		'screenshots/a../b',
		'screenshots/veivett.no',
		'../secrets',
		'logos/veivett',
		'screenshots/Veivett',
	];

	for (const key of rejected) {
		it(`rejects the key ${key}`, async () => {
			const browser = stubBrowser();
			const response = await screenshot({ ...VEIVETT, key }, { browser: browser.binding });
			expect(response.status).toBe(400);
			expect(browser.calls).toHaveLength(0);
		});
	}
});

describe('POST /screenshot asks the browser for the right thing', () => {
	const lightOptions = {
		url: 'https://veivett.no/',
		// A desktop viewport, and the 16:10 the portfolio card crops to.
		viewport: { width: 1280, height: 800 },
		gotoOptions: { waitUntil: 'networkidle2', timeout: 30000 },
		screenshotOptions: { type: 'png' },
		addStyleTag: [{
			content: '*,*::before,*::after{transition:none !important;'
				+ 'animation-duration:.001ms !important;animation-delay:0s !important;'
				+ 'animation-iteration-count:1 !important}',
		}],
		waitForTimeout: 600,
	};

	/*
	 * The whole options object, not just its keys. The stub answers with a PNG
	 * whatever it is asked for, so a jpeg screenshotOptions, a one-millisecond
	 * navigation timeout or a changed waitUntil all sail through a key-only
	 * assertion while breaking every real capture.
	 *
	 * The key set matters on its own too: the quick action validates strictly
	 * and answers an unknown key with a 400, which nothing here can catch --
	 * `emulateMediaFeatures` is the obvious way to force dark and is one it
	 * rejects.
	 */
	it('asks for a light capture with exactly these options', async () => {
		const browser = stubBrowser();
		await screenshot(VEIVETT, { browser: browser.binding });

		expect(browser.calls[0].action).toBe('screenshot');
		expect(browser.calls[0].options).toEqual(lightOptions);
	});

	it('asks for a dark capture with exactly these options', async () => {
		const browser = stubBrowser();
		await screenshot({ ...VEIVETT, themes: ['dark'] }, { browser: browser.binding });

		expect(browser.calls[0].action).toBe('screenshot');
		expect(browser.calls[0].options).toEqual({
			...lightOptions,
			addScriptTag: [{
				content: "document.documentElement.setAttribute('data-theme','dark');"
					+ "document.documentElement.classList.add('dark');",
			}],
		});
	});

	/*
	 * The fix for a capture taken mid-motion. Forcing dark flips the theme after the
	 * page has painted, so anything carrying a CSS transition animates towards
	 * its new value instead of jumping, and the shot lands on a colour that
	 * exists in neither theme. Entrance animations are the same hazard with a
	 * longer tail, and a rule that only names transitions does not touch them. Asserted on both themes, because the pair has
	 * to be produced the same way to be comparable at all.
	 *
	 * The toEqual tests above pin these exactly; this one names why they are
	 * there, so removing them fails a test that says what was lost.
	 */
	it('suppresses transitions and lets the page settle, on both themes', async () => {
		for (const themes of [['light'], ['dark']]) {
			const browser = stubBrowser();
			await screenshot({ ...VEIVETT, themes }, { browser: browser.binding });

			const { options } = browser.calls[0];
			expect(options.addStyleTag[0].content).toContain('transition:none !important');
			expect(options.addStyleTag[0].content).toContain('animation-duration:.001ms !important');
			// Not `animation:none`, which drops an element back to how it looks before
			// its animation runs -- invisible, wherever a base rule holds the element
			// at zero opacity and the animation is what fades it in.
			expect(options.addStyleTag[0].content).not.toContain('animation:none');
			expect(options.waitForTimeout).toBeGreaterThanOrEqual(600);
		}
	});
});

/*
 * The bug this exists for: veivett.no/klasse/bil paints in about 2.4s and then
 * holds a connection open indefinitely, so `networkidle0` was never satisfied
 * -- not at 30s and not at 55s -- and every capture of that page failed with no
 * image while the page sat there fully rendered. The condition, not the page,
 * was the thing that could not finish.
 */
describe('POST /screenshot survives a page that never goes idle', () => {
	const NAVIGATION_TIMEOUT = JSON.stringify({
		success: false,
		errors: [{
			code: 6002,
			message: 'A timeout was reached. Check gotoOptions/waitForSelector/waitForTimeout/actionTimeout options.',
			detail: 'Navigation timeout of 30000 ms exceeded',
		}],
	});

	const timeoutResponse = () =>
		new Response(NAVIGATION_TIMEOUT, { status: 422, headers: { 'Content-Type': 'application/json' } });

	it('asks for the strict condition first', async () => {
		const browser = stubBrowser();
		await screenshot(VEIVETT, { browser: browser.binding });

		expect(browser.calls).toHaveLength(1);
		expect(browser.calls[0].options.gotoOptions.waitUntil).toBe('networkidle2');
	});

	it('falls back to load when the navigation times out, and stores the image', async () => {
		const browser = stubBrowser(call =>
			call.options.gotoOptions.waitUntil === 'networkidle2' ? timeoutResponse() : pngResponse());

		const response = await screenshot(
			{ ...VEIVETT, key: 'screenshots/never-idle' },
			{ browser: browser.binding },
		);

		expect(response.status).toBe(200);
		expect(browser.calls.map(call => call.options.gotoOptions.waitUntil)).toEqual(['networkidle2', 'load']);
		expect(await env.MAIN_BUCKET.get('screenshots/never-idle-light.png')).not.toBeNull();
	});

	/*
	 * The retry changes only the wait. A fallback that also dropped the motion
	 * rule or the dark script would answer 200 with an image taken a different
	 * way from every other capture, which is the one failure nobody would see.
	 */
	it('retries with the same options but for the wait', async () => {
		const browser = stubBrowser(call =>
			call.options.gotoOptions.waitUntil === 'networkidle2' ? timeoutResponse() : pngResponse());
		await screenshot({ ...VEIVETT, themes: ['dark'] }, { browser: browser.binding });

		const [first, second] = browser.calls;
		expect(second.options).toEqual({ ...first.options, gotoOptions: { waitUntil: 'load', timeout: 30000 } });
		expect(second.options.addScriptTag[0].content).toContain("data-theme','dark'");
	});

	// Both conditions timing out is a real failure, not a third attempt.
	it('gives up when the fallback times out too', async () => {
		const browser = stubBrowser(() => timeoutResponse());
		const response = await screenshot(
			{ ...VEIVETT, key: 'screenshots/hopeless' },
			{ browser: browser.binding },
		);

		expect(response.status).toBe(502);
		expect((await response.json() as any).error).toContain('422');
		expect(browser.calls).toHaveLength(2);
	});

	/*
	 * Only the navigation timeout is worth a second browser session. A rate
	 * limit or a rejected option fails the same way however the page is waited
	 * for, and the account's three concurrent browsers are shared with the
	 * capture running beside this one.
	 */
	it('does not retry a 422 that is not a navigation timeout', async () => {
		const browser = stubBrowser(() => new Response(
			JSON.stringify({ success: false, errors: [{ code: 6001, message: 'invalid option' }] }),
			{ status: 422, headers: { 'Content-Type': 'application/json' } },
		));
		const response = await screenshot(VEIVETT, { browser: browser.binding });

		expect(response.status).toBe(502);
		expect(browser.calls).toHaveLength(1);
	});

	it('does not retry a status that is not 422', async () => {
		const browser = stubBrowser(() => new Response(NAVIGATION_TIMEOUT, { status: 429 }));
		const response = await screenshot(VEIVETT, { browser: browser.binding });

		expect(response.status).toBe(502);
		expect(browser.calls).toHaveLength(1);
	});
});

describe('POST /screenshot themes', () => {
	it('stores one PNG per theme and reports the keys', async () => {
		const browser = stubBrowser();
		const response = await screenshot(
			{ ...VEIVETT, themes: ['light', 'dark'] },
			{ browser: browser.binding },
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			stored: [
				{ theme: 'light', key: 'screenshots/veivett-no/shot-light.png' },
				{ theme: 'dark', key: 'screenshots/veivett-no/shot-dark.png' },
			],
		});

		const light = await env.MAIN_BUCKET.get('screenshots/veivett-no/shot-light.png');
		expect(light?.httpMetadata?.contentType).toBe('image/png');
		expect(new Uint8Array(await light!.arrayBuffer())).toEqual(PNG);
	});

	it('captures light only by default', async () => {
		const browser = stubBrowser();
		await screenshot({ ...VEIVETT, key: 'screenshots/default-theme' }, { browser: browser.binding });
		expect(browser.calls).toHaveLength(1);
		expect(await env.MAIN_BUCKET.get('screenshots/default-theme-dark.png')).toBeNull();
	});

	/*
	 * The caller decides how many captures one request makes, and each is a real
	 * browser session against a small daily allowance shared by the whole
	 * account. Without deduplication a single request spawns as many as it likes.
	 */
	it('captures each theme once however many times it was asked for', async () => {
		const browser = stubBrowser();
		const response = await screenshot(
			{ ...VEIVETT, key: 'screenshots/dupes', themes: Array(50).fill('dark') },
			{ browser: browser.binding },
		);

		expect(response.status).toBe(200);
		expect(browser.calls).toHaveLength(1);
	});

	it('captures in a fixed order regardless of how they were listed', async () => {
		const browser = stubBrowser();
		await screenshot(
			{ ...VEIVETT, key: 'screenshots/order', themes: ['dark', 'light'] },
			{ browser: browser.binding },
		);
		expect(browser.calls.map(call => call.options.addScriptTag === undefined)).toEqual([true, false]);
	});

	/*
	 * Rejected, not quietly dropped. Filtering answered 200 for work that never
	 * happened, and the caller then cache-busts a key holding nothing.
	 */
	const badThemes: [string, unknown][] = [
		['a bare string', 'dark'],
		['an unknown name', ['banana']],
		['the wrong case', ['light', 'Dark']],
		['an empty array', []],
		['a null entry', ['light', null]],
	];

	for (const [label, themes] of badThemes) {
		it(`rejects ${label}`, async () => {
			const browser = stubBrowser();
			const response = await screenshot(
				{ ...VEIVETT, key: 'screenshots/bad-themes', themes },
				{ browser: browser.binding },
			);
			expect(response.status).toBe(400);
			expect(browser.calls).toHaveLength(0);
		});
	}
});

describe('POST /screenshot stores only real PNG bytes', () => {
	const refused: [string, () => Response][] = [
		['a body that is not an image', () =>
			new Response('{"success":false}', { headers: { 'Content-Type': 'application/json' } })],
		['a jpeg answered to a png request', () =>
			new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { 'Content-Type': 'image/jpeg' } })],
		// Real PNG bytes under the wrong type, which is the only fixture the
		// content-type narrowing refuses on its own -- the jpeg above is caught by
		// the signature check before the type is ever consulted.
		['a png labelled as something else', () =>
			new Response(PNG, { headers: { 'Content-Type': 'image/jpeg' } })],
		// Exactly the signature and nothing after it, which is what holds the
		// length guard at a strict greater-than.
		['a bare png signature with no payload', () =>
			new Response(PNG.slice(0, 8), { headers: { 'Content-Type': 'image/png' } })],
		['an empty body that claims to be a png', () =>
			new Response(new Uint8Array([]), { headers: { 'Content-Type': 'image/png' } })],
		['png bytes that are not a png', () =>
			new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), { headers: { 'Content-Type': 'image/png' } })],
		['an upstream error', () => new Response('rate limited', { status: 429 })],
	];

	for (const [label, reply] of refused) {
		it(`refuses ${label}`, async () => {
			const key = `screenshots/refused-${refused.findIndex(entry => entry[0] === label)}`;
			const browser = stubBrowser(reply);
			const response = await screenshot({ ...VEIVETT, key }, { browser: browser.binding });

			expect(response.status).toBe(502);
			expect(await env.MAIN_BUCKET.get(`${key}-light.png`)).toBeNull();
		});
	}

	// Distinguishes the two rejection branches: a non-ok status is refused on the
	// status alone, before the content type is looked at.
	it('refuses an error response even when it is typed as a png', async () => {
		const browser = stubBrowser(() =>
			new Response(PNG, { status: 500, headers: { 'Content-Type': 'image/png' } }),
		);
		const response = await screenshot(
			{ ...VEIVETT, key: 'screenshots/error-png' },
			{ browser: browser.binding },
		);

		expect(response.status).toBe(502);
		expect(await env.MAIN_BUCKET.get('screenshots/error-png-light.png')).toBeNull();
	});
});

describe('POST /screenshot failures', () => {
	const failSecond = () => {
		let call = 0;
		return stubBrowser(() => {
			call += 1;
			return call === 1 ? pngResponse() : new Response('boom', { status: 500 });
		});
	};

	it('reports which half stored, and whether the failed key still holds anything', async () => {
		const browser = failSecond();
		const response = await screenshot(
			{ ...VEIVETT, key: 'screenshots/half', themes: ['light', 'dark'] },
			{ browser: browser.binding },
		);

		expect(response.status).toBe(502);
		const body = (await response.json()) as any;
		expect(body.stored).toEqual([{ theme: 'light', key: 'screenshots/half-light.png' }]);
		expect(body.failed).toEqual({ theme: 'dark', key: 'screenshots/half-dark.png', existing: false });
		expect(body.skipped).toEqual([]);
	});

	/*
	 * The case the caller cannot work out for itself: the capture failed but the
	 * key is not empty, so publishing one cache-busting version across both
	 * themes leaves a fresh light shot beside a silently stale dark one.
	 */
	it('says so when the failed key still holds an earlier image', async () => {
		await env.MAIN_BUCKET.put('screenshots/stale-dark.png', PNG, {
			httpMetadata: { contentType: 'image/png' },
		});

		const browser = failSecond();
		const response = await screenshot(
			{ ...VEIVETT, key: 'screenshots/stale', themes: ['light', 'dark'] },
			{ browser: browser.binding },
		);

		const body = (await response.json()) as any;
		expect(body.failed.existing).toBe(true);
	});

	/*
	 * The only shape in which `skipped` can carry anything: the first capture
	 * fails and a second theme was asked for. Without this the field is
	 * documented but never once observed holding a value.
	 */
	it('names the themes it never attempted when the first capture fails', async () => {
		const browser = stubBrowser(() => new Response('boom', { status: 500 }));
		const response = await screenshot(
			{ ...VEIVETT, key: 'screenshots/first-fails', themes: ['light', 'dark'] },
			{ browser: browser.binding },
		);

		expect(response.status).toBe(502);
		const body = (await response.json()) as any;
		expect(body.stored).toEqual([]);
		expect(body.failed.theme).toBe('light');
		expect(body.skipped).toEqual(['dark']);
		// And it stops: a failing site cannot cost two browser sessions per request.
		expect(browser.calls).toHaveLength(1);
	});

	// Upstream's own words stay in the log. The caller acts on the status.
	it('keeps the upstream body out of the answer', async () => {
		const browser = stubBrowser(() => new Response('UPSTREAM-INTERNAL-DETAIL', { status: 500 }));
		const response = await screenshot(
			{ ...VEIVETT, key: 'screenshots/no-leak' },
			{ browser: browser.binding },
		);

		const body = (await response.json()) as any;
		expect(body.error).not.toContain('UPSTREAM-INTERNAL-DETAIL');
		expect(body.error).toContain('500');
	});

	it('rejects a body that is not JSON', async () => {
		const response = await screenshot(undefined, { raw: 'not json' });
		expect(response.status).toBe(400);
	});

	/*
	 * `null` is valid JSON, so it survives the parse and reaches the field reads.
	 * Unguarded that is a TypeError, which is a 500 rather than the 400 meant.
	 */
	const notObjects: [string, string][] = [
		['null', 'null'],
		['a number', '42'],
		['a string', '"veivett"'],
		['an array', '[]'],
	];

	for (const [label, raw] of notObjects) {
		it(`rejects a body that is ${label}`, async () => {
			const response = await screenshot(undefined, { raw });
			expect(response.status).toBe(400);
		});
	}

	it('rejects a body with no url or key', async () => {
		const response = await screenshot({});
		expect(response.status).toBe(400);
	});
});

/*
 * The admin app calls this cross-origin, so every answer it can receive needs the
 * CORS headers -- an error the browser will not let it read is indistinguishable
 * from the network being down.
 */
describe('POST /screenshot answers a browser caller', () => {
	it('sets the origin header on a success', async () => {
		const browser = stubBrowser();
		const response = await screenshot(
			{ ...VEIVETT, key: 'screenshots/cors-ok' },
			{ browser: browser.binding },
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});

	it('sets the origin header on a rejection', async () => {
		const browser = stubBrowser();
		const response = await screenshot(
			{ ...VEIVETT, url: 'https://example.com/' },
			{ browser: browser.binding },
		);
		expect(response.status).toBe(400);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});

	it('sets the origin header on a forbidden response', async () => {
		const response = await screenshot(VEIVETT, { headers: { 'Content-Type': 'application/json' } });
		expect(response.status).toBe(403);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});
});

describe('the screenshot path is not treated as an R2 key', () => {
	it('does not let a PUT write an object called screenshot', async () => {
		const response = await put('screenshot', 'x', authed('text/plain'));
		expect(response.status).toBe(405);
		expect(await env.MAIN_BUCKET.get('screenshot')).toBeNull();
	});
});

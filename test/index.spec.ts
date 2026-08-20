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
		expect(response.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
		expect(response.headers.get('Access-Control-Allow-Headers')).toContain(AUTH_HEADER);
	});
});

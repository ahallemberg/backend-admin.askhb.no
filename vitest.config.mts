import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
	plugins: [
		cloudflareTest({
			/*
			 * The Browser Run binding is declared `remote` so that `wrangler dev`
			 * can drive the real service. Without this the pool honours that flag
			 * too and opens a remote proxy session before the first test runs, so
			 * a checkout with no Cloudflare credentials -- a fresh clone, an
			 * offline run, CI -- executes zero tests rather than failing loudly.
			 * Nothing here needs the real binding: the tests stub it.
			 */
			remoteBindings: false,
			wrangler: { configPath: './wrangler.jsonc' },
		}),
	],
});

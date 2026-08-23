# R2 Upload Worker

Cloudflare Worker for secure file uploads to R2 storage with API key
authentication, and for capturing project screenshots straight into the bucket.

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Create R2 bucket**
   ```bash
   npx wrangler r2 bucket create experiences
   ```

3. **Set API secret**
   ```bash
   npx wrangler secret put AUTH_KEY_SECRET
   # Enter secure API key when prompted
   ```

4. **Check the screenshot settings**

   `wrangler.jsonc` declares the Browser Run binding and `SCREENSHOT_HOSTS`, the
   list of hosts `/screenshot` will render. Both ship in the config, so nothing
   is needed here beyond adding a host when a new site should be capturable —
   which takes a deploy.

5. **Deploy**
   ```bash
   npx wrangler deploy
   ```

## Development

```bash
npm run dev
```

Create `.dev.vars` for local testing:
```
AUTH_KEY_SECRET=dev-secret-here
```

```bash
npx vitest run
```

The tests need no Cloudflare credentials and reach no network: the Browser Run
binding is stubbed. Everything else runs against a simulated R2.

## Usage

Upload files with PUT requests:

```bash
curl -X PUT "https://workerurl/filename.jpg" \
  -H "X-Custom-API-Key: your-secret-key" \
  -H "Content-Type: image/jpeg" \
  --data-binary "@photo.jpg"
```

### Capturing a screenshot

`POST /screenshot` renders a page with Browser Run and stores the result in the
bucket, so a project screenshot never has to be taken by hand. `themes` defaults
to `["light"]`; each theme is stored as `<key>-<theme>.png`. Anything that is not
`"light"` or `"dark"` is a 400 rather than being quietly dropped — a silently
ignored theme means a key the caller then publishes and nothing ever wrote.

```bash
curl -X POST "https://workerurl/screenshot" \
  -H "X-Custom-API-Key: your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://veivett.no/","key":"screenshots/veivett-no/shot","themes":["light","dark"]}'

# 200
# {"stored":[{"theme":"light","key":"...-light.png"},{"theme":"dark","key":"...-dark.png"}]}
```

Captures are 1280x800 — a desktop viewport, in the 16:10 the portfolio card
crops its screenshot to. Any path on an allowed host can be captured, not just
the landing page.

Motion is neutralised before the shot: transitions are switched off and
animations are made to run to completion instantly, the same rule a site applies
for readers who ask for reduced motion. Forcing dark flips the theme after the
page has painted, so anything with a CSS transition animates towards its dark
value instead of jumping — a capture taken straight after the flip caught
veivett.no's class cards 70% of the way between the two palettes, showing a
colour that exists in neither theme. Entrance animations are the same hazard
with a longer tail.

The 600ms wait that follows is for what CSS cannot switch off — a late layout
pass, a lazy image, a webfont swapping in.

**Only ask for a theme the site actually has.** Dark is forced by injecting a
script that sets `data-theme="dark"` and adds a `dark` class, because the quick
action rejects `emulateMediaFeatures`. That can only surface a dark mode the
site already implements. `trafikkskiltene.no` has none by any mechanism, so
asking for its dark theme captures the ordinary light page and stores it under a
`-dark` key, reporting success. Nothing in the worker can detect this.

If a capture fails the answer is a 502 naming what happened, and the caller has
to handle it — a request for two themes can leave one stored:

```json
{
  "stored": [{ "theme": "light", "key": "screenshots/x-light.png" }],
  "failed": { "theme": "dark", "key": "screenshots/x-dark.png", "existing": true },
  "skipped": [],
  "error": "Error: Browser Run returned 429"
}
```

`existing: true` means that key still holds an image from an earlier run. It
matters because the bucket is served with a four hour `max-age`: publishing one
cache-busting `?v=` across both URLs would put a fresh light shot beside a
silently stale dark one.

### Exercising it locally

`wrangler dev` is enough to run a real capture: the Browser Run binding is
declared `remote`, so it reaches the real service while R2 stays simulated and
nothing lands in the live bucket. Pull a capture back out with:

```bash
npx wrangler r2 object get experiences/<key> --local --file out.png
```

Note that such a capture spends the real Browser Run allowance, which is small
and shared by the whole account.

## Security

- PUT for uploads, POST for `/screenshot`; other methods are refused
- Requires `X-Custom-API-Key` header with valid secret
- `/screenshot` renders only the hosts listed in `SCREENSHOT_HOSTS`, matched
  exactly, and writes only under `screenshots/`. This constrains the capture
  route's own reach; it is not a limit on what a caller holding the secret can
  do elsewhere in this worker
- The host list pins the URL the renderer is *sent to*. Redirects are followed,
  so a redirect off an allowed host is rendered from a page the list never
  approved
- Files uploaded to R2 bucket: `experiences`

## Commands

```bash
npm run dev          # Local development
npm run deploy       # Deploy to production
npx vitest run       # Run the test suite once (npm test starts watch mode)
```

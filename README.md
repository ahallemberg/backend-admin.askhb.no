# R2 Upload Worker

Cloudflare Worker for secure file uploads to R2 storage with API key authentication.

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

4. **Deploy**
   ```bash
   npx wrangler deploy
   ```

## Development

```bash
# Local development
npm run dev

# Development with real R2 bucket
npm run dev:remote
```

Create `.dev.vars` for local testing:
```
AUTH_KEY_SECRET=dev-secret-here
```

## Usage

Upload files with PUT requests:

```bash
curl -X PUT "https://workerurl/filename.jpg" \
  -H "X-Custom-API-Key: your-secret-key" \
  -H "Content-Type: image/jpeg" \
  --data-binary "@photo.jpg"
```

## Security

- Only PUT requests allowed
- Requires `X-Custom-API-Key` header with valid secret
- Files uploaded to R2 bucket: `experiences`

## Commands

```bash
npm run dev          # Local development
npm run deploy       # Deploy to production
npm run tail         # View logs
```
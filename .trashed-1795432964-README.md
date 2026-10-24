# RealFace Live — combined test starter

Includes registration/login, a creator dashboard, and an image face-swap engine integration through Replicate's `codeplugtech/face-swap` model. Video face swap and talking-photo/lip-sync are not implemented in this build; those require separate models/APIs and should be added after the image swap works.

## Before deploying
1. Create a Cloudflare KV namespace and bind it as `AUTH_KV`. Put its ID in `wrangler.jsonc`.
2. Add Worker secrets:
   - `SESSION_SECRET`: long random secret (32+ random characters).
   - `REPLICATE_API_TOKEN`: API token from your Replicate account.
3. Deploy the Worker with the included static assets config.
4. Register a test account, log in, choose a target photo and source face photo, confirm permission, then press Swap faces.

## Engine notes
- The image model runs on Replicate, not on Cloudflare. Usage may cost money; check current model pricing and account credits before testing.
- This starter sends image data to Replicate as data URLs. Images are limited to 4 MB each and JPG/PNG/WEBP.
- Only use faces you have rights and consent to use. Do not use it for impersonation, fraud, or non-consensual intimate imagery.
- API errors are shown in the app. If the model version changes, update `REPLICATE_VERSION` in `worker.js` to a valid model version from the model's official page.
- This is a test starter, not production-ready. Add rate limiting, email verification, password reset, account deletion, secure HttpOnly cookie sessions, storage cleanup, abuse reporting, and privacy disclosures before public launch.
- Payment integration is deliberately excluded for now.

# blog-intake

Cloudflare Email Worker that turns dictated emails (with optional photos) into
structured draft branches on your Zola blog repos.

## Pipeline

```
phone dictation + photos → email to drafts@input.{site}
  → CF Email Routing
  → Worker
    → postal-mime parse
    → LLaVA caption for each attached image
    → Gemma 4 26B (A4B) produces JSON: {title, description, tags, outline, body}
    → assemble index.md with frontmatter + outline comment + body with image refs
    → GitHub Git Data API: new branch draft/YYYY-MM-DD-slug
  → you review, trim the outline, tighten, flip draft = false, merge
```

Every draft lands with:

- `title` guessed from the dictation (not just the subject line)
- `description` blurb for the frontmatter
- `tags` — freeform from Gemma, curate at review time
- Suggested outline in an HTML comment above the body
- Vision captions as image alt text (good accessibility default, edit as needed)
- `draft = true` and a `draft/*` branch — two safeties against accidental publish

## Setup

### 1. DNS + Email Routing

In the Cloudflare dashboard for each site:

- Go to **Email → Email Routing** on the zone.
- Enable routing **on the `input.*` subdomain**, not the apex. This preserves
  Stalwart's MX on the apex. CF's wizard creates the MX records.
- Add a rule: `drafts@input.{site}` → **Send to a Worker** → `blog-intake`.
- Recommended: catch-all rule forwarding everything else on the subdomain to
  your personal inbox as a fallback for rejects and errors.

### 2. GitHub token

Fine-grained PAT, scoped to `timsiggins.com` and `auxdev.net` only:

- Contents: Read and Write
- Metadata: Read

### 3. Deploy

```sh
pnpm install
pnpm wrangler login
pnpm wrangler secret put GITHUB_TOKEN
pnpm deploy
```

### 4. Smoke test

Email `drafts@input.timsiggins.com`:

- **Subject:** anything (ignored unless Gemma returns garbage)
- **Body:** a paragraph of dictation
- Optionally attach a photo (use "Large", not "Actual Size")

Watch `pnpm wrangler tail` while you send. Within a minute you should see
`Committed draft/2026-04-23-some-title to timsiggins.com (structured=true)`.

## Review at the desk

```sh
git fetch
git checkout draft/2026-04-23-some-title
# review tags, tighten title/description, fix [bracketed] uncertainties,
# use or discard the outline, edit alt text on photos, flip draft = false
git commit -am "finalize"
git checkout main && git merge draft/2026-04-23-some-title && git push
```

## Tuning

- **Gemma returning unstructured output.** Fallback path keeps the draft but
  skips title/tags/outline and leaves a `<!-- AI did not return... -->` marker.
  If it happens often, tighten `CLEANUP_SYSTEM` in `src/ai.ts` or swap to a
  model with better JSON-mode support.
- **Tags drifting from your taxonomy.** Fetch a canonical `tags.toml` from the
  repo root once per commit and include in the prompt as "prefer these tags:".
  Not done in v1.
- **Vision captions weak.** LLaVA 1.5 7B is the stable option on CF. If CF
  ships a stronger vision model, swap `VISION_MODEL` in `src/ai.ts`.
- **Want Gemma to do vision directly.** When you've confirmed the multimodal
  message format on CF's Gemma, collapse `captionImage` + `organizeDraft` into
  one call with image content blocks in the messages array.

## Known limits

- Email Routing caps messages at 25 MiB (~18 MB of raw attachments after
  base64 overhead). Use "Large" on phone photos.
- Image EXIF is not stripped. TODO in `src/index.ts`.
- Outbound alerts pending Cloudflare Email Service beta access.
- Slug collisions (same AI-guessed title in one day) fail on branch creation.
  Rare; handle manually for now.

## Forgejo migration (later)

`commitToBranch()` hits the GitHub REST API. Forgejo is largely API-compatible
but not 1:1. When migrating:

- Swap the base URL to your Forgejo instance.
- Verify `/git/refs`, `/git/blobs`, `/git/trees`, `/git/commits` behave
  identically (they mostly do).
- Forgejo must be publicly reachable from Cloudflare. Tailscale-only won't
  work — either expose behind Caddy with an allowlist, or keep personal
  repos on GitHub.

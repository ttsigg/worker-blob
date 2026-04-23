# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`blog-intake` — a Cloudflare Email Worker that turns dictated emails (with
optional photos) into structured draft branches on Zola blog repos
(`timsiggins.com`, `auxdev.net`).

## Commands

This project uses **pnpm** and **wrangler** (Cloudflare Workers CLI).

```sh
pnpm install
pnpm typecheck                                 # tsc --noEmit
pnpm exec wrangler deploy --dry-run            # validate bundle without deploying
pnpm wrangler login
pnpm wrangler secret put GITHUB_TOKEN          # fine-grained PAT, Contents R/W + Metadata R
pnpm wrangler secret put ALLOWED_SENDERS       # required; comma-separated allowlist
pnpm wrangler secret put ALLOWED_SENDER_DOMAINS  # optional; comma-separated domains
pnpm wrangler secret put REQUIRE_DKIM_PASS     # optional; set to "true" to enforce DKIM
pnpm deploy                                     # wrangler deploy
pnpm tail                                       # wrangler tail — stream live logs
```

Smoke test by emailing `drafts@input.<your-site>` from an allowlisted
address (body = dictation, optional photo attachment). A log line like
`Committed draft/YYYY-MM-DD-slug to <your-site> (structured=true, images=1)`
confirms success.

## Architecture

Single Cloudflare Worker, triggered by CF Email Routing. The pipeline per
incoming email:

1. **Allowlist** — `isAllowedSender()` rejects any sender not on
   `ALLOWED_SENDERS` / `ALLOWED_SENDER_DOMAINS`. Default-deny if neither is
   set. If `REQUIRE_DKIM_PASS=true`, also checks `Authentication-Results`
   for `dkim=pass` with `header.d` matching the sender domain.
2. **Recipient mapping** — `siteFromTo()` picks the repo (`timsiggins.com`
   or `auxdev.net`) from the envelope-to address.
3. **Size/attachment gate** — rejects messages over 25 MiB, attachments over
   `MAX_ATTACHMENT_BYTES`, or attachment counts over `MAX_ATTACHMENTS`.
   Non-image parts are silently dropped.
4. **Parse** the MIME message with `postal-mime` (body text + image attachments).
5. **Vision pass** — each image goes through `captionImage()` (LLaVA 1.5 7B
   via Workers AI) to get alt text.
6. **Structuring pass** — `organizeDraft()` sends the dictation to Gemma 3
   12B Instruct with a system prompt (`CLEANUP_SYSTEM`) that demands JSON
   `{title, description, tags, outline, body}`. If parsing fails, a
   fallback preserves the dictation verbatim and injects
   `<!-- AI did not return... -->`.
7. **Assemble** `index.md` — Zola TOML frontmatter (`title`, `description`,
   `tags`, `draft = true`), outline in an HTML comment above the body,
   image refs with vision captions as alt text.
8. **Commit** via GitHub Git Data API (`commitToBranch()` in `src/index.ts`:
   `/git/refs`, `/git/blobs`, `/git/trees`, `/git/commits`) on a new branch
   `draft/YYYY-MM-DD-slug`. Never pushes to `main`; `draft = true` is a
   second safety.

The handler `await`s the pipeline synchronously so `setReject()` calls take
effect. Failures past the reject gates are logged but not bounced (the
message is lost; check `wrangler tail`).

### File layout

```
src/
  index.ts          # worker entry, email parsing, commit assembly, GitHub calls
  ai.ts             # Workers AI calls, prompts, JSON parsing
  exif.ts           # pure-JS metadata stripper for JPEG / PNG / WebP
wrangler.toml       # Worker config, vars, observability
package.json        # pnpm scripts + deps
tsconfig.json       # strict TS, @cloudflare/workers-types
.dev.vars.example   # local dev secret template (copy to .dev.vars — gitignored)
.gitignore
```

### Key constants and tuning points

- `CLEANUP_SYSTEM` in `src/ai.ts` — tighten if Gemma returns unstructured output often.
- `VISION_MODEL` / `TEXT_MODEL` in `src/ai.ts` — swap if CF ships stronger models.
  Long-term simplification: one multimodal Gemma call replacing both passes.
- `MAX_ATTACHMENTS`, `MAX_ATTACHMENT_BYTES` in `wrangler.toml` — size gates.
- `stripMetadata()` in `src/exif.ts` — pure-JS EXIF/XMP/IPTC/text stripper.
  Supports JPEG, PNG, WebP. HEIC/GIF/TIFF pass through unchanged. Stripping
  runs before AI captioning and before the GitHub blob upload, so GPS/camera
  metadata never leaves the worker.
- Email Routing caps messages at 25 MiB (~18 MB of attachments post-base64).
  Use "Large" on phone photos, not "Actual Size".
- Slug collisions (same AI-guessed title twice in one day) fail at branch
  creation with a `branch-create failed` error; resend with a tweak or
  rename manually.

### Security posture (summary)

- **Default-deny sender allowlist** — no traffic reaches AI/GitHub unless
  the sender matches `ALLOWED_SENDERS` or `ALLOWED_SENDER_DOMAINS`.
- **Optional DKIM enforcement** via `REQUIRE_DKIM_PASS`.
- **GitHub token** is a fine-grained PAT scoped to only the two Zola repos,
  Contents R/W + Metadata R. Rotate on a 90-day cadence.
- **Never writes to `main`** — all output goes to `draft/*` branches with
  `draft = true` frontmatter.
- **Logs redact sender addresses** and do not echo GitHub response bodies.
- **Input caps** on message size, attachment count, and per-attachment size.
- **Non-image attachments dropped silently**; only `image/*` MIME types
  reach the vision model.
- **EXIF/metadata stripped** from JPEG/PNG/WebP before AI or GitHub see the
  bytes — GPS, camera serials, author fields, and text chunks are removed.

## Forgejo migration note

`commitToBranch()` in `src/index.ts` is GitHub REST. Forgejo is mostly
API-compatible — swap the base URL and verify `/git/refs`, `/git/blobs`,
`/git/trees`, `/git/commits`. Forgejo must be publicly reachable from
Cloudflare (Tailscale-only won't work).

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`blog-intake` — a Cloudflare Email Worker that turns dictated emails (with optional photos) into structured draft branches on Zola blog repos (`timsiggins.com`, `auxdev.net`).

## Commands

This project uses **pnpm** and **wrangler** (Cloudflare Workers CLI). No test or lint scripts are defined.

```sh
pnpm install
pnpm wrangler login
pnpm wrangler secret put GITHUB_TOKEN   # one-time: fine-grained PAT, Contents R/W + Metadata R
pnpm deploy                              # deploy the worker
pnpm wrangler tail                       # stream live logs (use while smoke-testing)
```

Smoke test by emailing `drafts@input.timsiggins.com` (body = dictation, optional photo attachment). A log line like `Committed draft/YYYY-MM-DD-slug to timsiggins.com (structured=true)` confirms success.

## Architecture

Single Cloudflare Worker, triggered by CF Email Routing. The pipeline per incoming email:

1. **Parse** the MIME message with `postal-mime` (body text + image attachments).
2. **Vision pass** — each attachment goes through `captionImage()` (LLaVA 1.5 7B via Workers AI) to get alt text.
3. **Structuring pass** — `organizeDraft()` sends the dictation to Gemma 4 26B (A4B) with a system prompt (`CLEANUP_SYSTEM`) that demands JSON `{title, description, tags, outline, body}`. If the model returns garbage, a fallback preserves the dictation verbatim and injects `<!-- AI did not return... -->`.
4. **Assemble** `index.md` — Zola frontmatter (`title`, `description`, `tags`, `draft = true`), outline in an HTML comment above the body, image refs with vision captions as alt text.
5. **Commit** via GitHub Git Data API (`commitToBranch()` in `index.ts`: `/git/refs`, `/git/blobs`, `/git/trees`, `/git/commits`) on a new branch `draft/YYYY-MM-DD-slug`. Never pushes to `main`; `draft = true` is a second safety.

### File layout

- `index.ts` — worker entry, email parsing, branch/commit assembly, GitHub API calls.
- `ai.ts` — Workers AI calls: `captionImage()`, `organizeDraft()`, prompt constants (`CLEANUP_SYSTEM`, `VISION_MODEL`).
- `wrangler-1.toml` — Worker config and email routing bindings.

Note: the README refers to `src/ai.ts` and `src/index.ts`, but the files currently live at the repo root. Treat paths in the README as aspirational and match whatever layout exists at the time.

### Key constants and tuning points

- `CLEANUP_SYSTEM` in `ai.ts` — tighten if Gemma returns unstructured output often.
- `VISION_MODEL` in `ai.ts` — swap if CF ships a stronger vision model. A future simplification is collapsing `captionImage` + `organizeDraft` into one multimodal Gemma call.
- EXIF is **not** stripped from images (TODO in `index.ts`).
- Email Routing caps messages at 25 MiB (~18 MB of attachments post-base64). Use "Large" on phone photos, not "Actual Size".
- Slug collisions (same AI-guessed title twice in one day) fail at branch creation; handle manually.

## Forgejo migration note

`commitToBranch()` is GitHub REST. Forgejo is mostly API-compatible — swap the base URL and verify `/git/refs`, `/git/blobs`, `/git/trees`, `/git/commits`. Forgejo must be publicly reachable from Cloudflare (Tailscale-only won't work).

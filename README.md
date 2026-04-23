# blog-intake

Cloudflare Email Worker that turns dictated emails (with optional photos) into
structured draft branches on your Zola blog repos.

## Pipeline

```
phone dictation + photos → email to drafts@input.{site}
  → CF Email Routing
  → Worker (sender allowlist → MIME parse → vision caption → structuring pass)
    → GitHub Git Data API: new branch draft/YYYY-MM-DD-slug
  → you review, trim the outline, tighten, flip draft = false, merge
```

Every draft lands with:

- `title` guessed from the dictation (not just the subject line)
- `description` blurb for the frontmatter
- `tags` — kebab-case, capped at 8, curate at review time
- Suggested outline in an HTML comment above the body
- Vision captions as image alt text (good accessibility default, edit as needed)
- `draft = true` and a `draft/*` branch — two safeties against accidental publish

## Layout

```
src/
  index.ts        # worker entry, email parsing, GitHub commit assembly
  ai.ts           # Workers AI calls, prompts, JSON parsing
wrangler.toml     # CF Worker config (bindings, vars, observability)
package.json      # pnpm scripts + deps
.dev.vars.example # template for local secrets (copy to .dev.vars)
```

## Commands

```sh
pnpm install
pnpm typecheck
pnpm exec wrangler deploy --dry-run   # verify bundle before pushing live
pnpm deploy                            # wrangler deploy
pnpm tail                              # wrangler tail — stream live logs
```

## Setup

### 1. DNS + Email Routing

In the Cloudflare dashboard for each site:

- Go to **Email → Email Routing** on the zone.
- Enable routing **on the `input.*` subdomain**, not the apex. This preserves
  any existing MX on the apex. CF's wizard creates the MX records.
- Add a rule: `drafts@input.{site}` → **Send to a Worker** → `blog-intake`.
- Recommended: catch-all rule forwarding everything else on the subdomain to
  your personal inbox as a fallback for rejects and errors.

### 2. GitHub token

Fine-grained PAT, scoped only to the repos listed in `SITES`:

- **Contents:** Read and Write
- **Metadata:** Read
- No other scopes. Set a 90-day expiry and calendar a rotation.

### 3. Secrets

```sh
pnpm wrangler login
pnpm wrangler secret put GITHUB_TOKEN          # required
pnpm wrangler secret put ALLOWED_SENDERS       # required — see "Security" below
pnpm wrangler secret put ALLOWED_SENDER_DOMAINS  # optional
pnpm wrangler secret put REQUIRE_DKIM_PASS     # optional — "true" to enable
```

`ALLOWED_SENDERS` is a comma-separated list of exact addresses, e.g.
`me@timsiggins.com,assistant@auxdev.net`. `ALLOWED_SENDER_DOMAINS` is a
comma-separated list of bare domains, e.g. `timsiggins.com`.

**If both lists are empty or unset, the worker rejects every inbound message.**
This is the default-deny posture — you must opt in to a sender before anything
reaches the AI pipeline or GitHub.

### 4. Deploy

```sh
pnpm deploy
```

### 5. Smoke test

Email `drafts@input.timsiggins.com` from an allowlisted address:

- **Subject:** anything (used only if Gemma returns no title)
- **Body:** a paragraph of dictation
- Optionally attach a photo (use "Large", not "Actual Size")

Watch `pnpm tail` while you send. Within a minute you should see
`Committed draft/2026-04-23-some-title to timsiggins.com (structured=true, images=1)`.

## Security

### Sender allowlist

The worker rejects anything not matching `ALLOWED_SENDERS` (exact match) or
`ALLOWED_SENDER_DOMAINS` (bare-domain match). Default behavior with neither
set is **reject everything** — you cannot accidentally deploy an open relay.

### DKIM enforcement (optional)

Set `REQUIRE_DKIM_PASS=true` to additionally require that
`Authentication-Results` shows `dkim=pass` and the signing domain
(`header.d`) matches (or is a parent of) the sender domain. This mitigates
`From:` spoofing for senders whose domain actually signs (most major
providers do). Leave off if you send from a self-hosted MTA that doesn't
sign, or expect bounces.

Cloudflare Email Routing already enforces SPF before the message reaches the
worker; this is additive.

### Input caps

- 25 MiB message ceiling (CF Email Routing hard limit).
- `MAX_ATTACHMENTS` (default 12) and `MAX_ATTACHMENT_BYTES` (default 20 MiB)
  are tunable in `wrangler.toml`.
- Non-image attachments are silently dropped.

### Data flow and PII

- The `From:` address is redacted in logs (`m***@example.com`).
- Error messages from the GitHub API are not echoed verbatim — only status
  codes — to avoid leaking request paths or tokens.
- AI is invoked with dictation text + image bytes. No emails or headers are
  passed to the model.

### Branch and publish safety

- Worker never writes to `main` or any branch not prefixed with `draft/`.
- `draft = true` in the Zola frontmatter prevents accidental publish even
  if `draft/*` is merged by mistake.
- GitHub token is a fine-grained PAT scoped to the two target repos only.

### Threat model notes

- Prompt injection via dictation can only set the attacker's own
  title/tags/body; they all land in a human-reviewed `draft/*` branch.
- Slug collisions (same AI-guessed title twice in one day) fail at branch
  creation; resend with a tweak, or rename manually.

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

- **Gemma returning unstructured output.** Fallback preserves the dictation
  verbatim and injects a `<!-- AI did not return... -->` marker. Tighten
  `CLEANUP_SYSTEM` in `src/ai.ts` or swap `TEXT_MODEL`.
- **Vision captions weak.** LLaVA 1.5 7B is the stable option on CF. If CF
  ships a stronger vision model, swap `VISION_MODEL` in `src/ai.ts`.
- **Collapse both AI calls.** When CF's Gemma supports multimodal input,
  replace `captionImage` + `organizeDraft` with one call using image blocks.

## Known limits / TODO

- Email Routing caps messages at 25 MiB (~18 MB of raw attachments after
  base64 overhead). Use "Large" on phone photos.
- Image EXIF is not stripped. (Requires a WASM image lib; tracked.)
- Outbound alerts pending Cloudflare Email Service beta access.
- No per-sender rate limit. Add a KV counter if abuse becomes an issue.

## Forgejo migration (later)

`commitToBranch()` in `src/index.ts` hits the GitHub REST API. Forgejo is
largely API-compatible but not 1:1. When migrating:

- Swap `api.github.com` to your Forgejo base URL.
- Verify `/git/refs`, `/git/blobs`, `/git/trees`, `/git/commits` behave
  identically (they mostly do).
- Forgejo must be publicly reachable from Cloudflare. Tailscale-only won't
  work — expose behind Caddy with an allowlist, or keep personal repos
  on GitHub.

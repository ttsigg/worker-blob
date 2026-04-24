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
  exif.ts         # pure-JS metadata stripper (JPEG / PNG / WebP)
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
`you@example.com,assistant@example.org`. `ALLOWED_SENDER_DOMAINS` is a
comma-separated list of bare domains, e.g. `example.com`.

Set them only via `wrangler secret put` (see step 3) so your real addresses
never land in the repo.

**If both lists are empty or unset, the worker rejects every inbound message.**
This is the default-deny posture — you must opt in to a sender before anything
reaches the AI pipeline or GitHub.

### 4. Deploy

```sh
pnpm deploy
```

Or push to `main` and let GitHub Actions deploy — see
[Deploying via GitHub Actions](#deploying-via-github-actions) below.

### 5. Smoke test

Email `drafts@input.<your-site>` (the recipient configured in your Email
Routing rule) from an allowlisted address:

- **Subject:** anything (used only if Gemma returns no title)
- **Body:** a paragraph of dictation
- Optionally attach a photo (use "Large", not "Actual Size")

Watch `pnpm tail` while you send. Within a minute you should see
`Committed draft/2026-04-23-some-title to <your-site> (structured=true, images=1)`.

## Deploying via GitHub Actions

`.github/workflows/deploy.yml` runs `pnpm typecheck` and
`wrangler deploy` on every push to `main` (and on manual dispatch from the
Actions tab). It only ships code and `wrangler.toml` changes — Worker
secrets stay on Cloudflare and are never read by CI.

### What goes where

| Kind | Where | Name | Purpose |
| --- | --- | --- | --- |
| GitHub repo secret | GitHub → Settings → Secrets and variables → Actions | `CLOUDFLARE_API_TOKEN` | Lets the Action run `wrangler deploy`. |
| GitHub repo secret | GitHub → Settings → Secrets and variables → Actions | `CLOUDFLARE_ACCOUNT_ID` | Target Cloudflare account for the Worker. |
| Cloudflare Worker secret | `wrangler secret put` (local, one-time) | `GITHUB_TOKEN` | Fine-grained PAT for the Zola repos. |
| Cloudflare Worker secret | `wrangler secret put` (local, one-time) | `ALLOWED_SENDERS` | Sender allowlist (required; default-deny otherwise). |
| Cloudflare Worker secret | `wrangler secret put` (local, optional) | `ALLOWED_SENDER_DOMAINS` | Extra domain-wide allowlist. |
| Cloudflare Worker secret | `wrangler secret put` (local, optional) | `REQUIRE_DKIM_PASS` | Set to `"true"` to enforce DKIM. |
| Cloudflare Worker var | `wrangler.toml` `[vars]` | `GITHUB_OWNER`, `SITES`, `DEFAULT_BRANCH`, `COMMIT_AUTHOR_*`, `MAX_ATTACHMENT*` | Non-secret config, committed to the repo. |

The Worker secrets are the same ones covered in [Setup step 3](#3-secrets).
CI does not push or rotate them — it just redeploys the script. If you
change a secret, run `pnpm wrangler secret put NAME` locally; the value
persists across deploys.

### Creating the Cloudflare API token

Cloudflare dashboard → **My Profile → API Tokens → Create Token → Edit
Cloudflare Workers** (template). Scope it as narrowly as possible:

- **Account resources:** include only the account you deploy into.
- **Zone resources:** `All zones from an account` on the same account
  (the template needs this to read Workers routes even if you don't
  use custom domains). Restrict to a specific zone if you prefer.
- **TTL:** set an expiry (90 days is a good cadence) and calendar a
  rotation.

Copy the token once it's shown — Cloudflare won't display it again. Paste
it into the GitHub secret `CLOUDFLARE_API_TOKEN`.

Your **Account ID** is on the right-hand sidebar of the Workers & Pages
overview page. Paste it into `CLOUDFLARE_ACCOUNT_ID` (also a repo secret
to avoid exposing it in Actions logs, though it's not highly sensitive on
its own).

### Running the workflow

- Push to `main`, or trigger it from **Actions → Deploy Worker → Run
  workflow**.
- The job runs `pnpm typecheck` first, so a type error blocks the deploy.
- `concurrency: deploy-worker` serializes overlapping runs — a newer push
  waits for the in-flight deploy to finish rather than racing it.
- Docs-only changes (`**.md`, `.gitignore`, `.dev.vars.example`) skip CI.

### Rolling back

`wrangler rollback` from your machine, or re-run an older successful
workflow run from the Actions UI (it redeploys the commit that run was
built from).

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

### EXIF / metadata stripping

Every inbound image passes through `src/exif.ts` before it's sent to the AI
model or committed to the repo:

- **JPEG:** drops `APP1` (EXIF + XMP), `APP12` (Ducky), `APP13`
  (Photoshop/IPTC), and `COM` comment markers. Keeps `APP0` (JFIF),
  `APP2` (ICC profile), and `APP14` (Adobe) so color rendering is unchanged.
- **PNG:** drops `eXIf`, `tEXt`, `iTXt`, `zTXt` chunks. Keeps everything
  else (including `iCCP` / `sRGB` / `gAMA`).
- **WebP:** drops `EXIF` and `XMP ` chunks, clears their flag bits in
  `VP8X`, and fixes the `RIFF` header size.
- **HEIC / GIF / TIFF / unknown:** pass through with a `wrangler tail` log
  line. Prefer JPEG/PNG/WebP uploads.

GPS coordinates, camera serials, device names, and author fields are removed
before the image leaves the worker.

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
- HEIC uploads are not metadata-stripped (complex container format); they
  pass through unchanged with a log warning. iOS "Large" sharing usually
  produces JPEG, which is cleaned.
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

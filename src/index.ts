// blog-intake — Cloudflare Email Worker.
//
// Trigger: Email Routing rule `drafts@input.<site>` → "Send to Worker".
// Output: a new `draft/YYYY-MM-DD-slug` branch on the matching Zola repo,
// committed via the GitHub Git Data API, with `draft = true` in frontmatter
// as a second safety against accidental publish.

import PostalMime from "postal-mime";
import { captionImage, organizeDraft, type OrganizedDraft } from "./ai.js";
import { stripMetadata } from "./exif.js";

interface Env {
  AI: { run(model: string, input: unknown): Promise<unknown> };
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  SITES: string;               // comma-separated, must match the repo name
  DEFAULT_BRANCH: string;      // usually "main"
  COMMIT_AUTHOR_NAME: string;
  COMMIT_AUTHOR_EMAIL: string;
  MAX_ATTACHMENT_BYTES: string;
  MAX_ATTACHMENTS: string;
  ALLOWED_SENDERS?: string;    // secret; comma-separated exact addresses
  ALLOWED_SENDER_DOMAINS?: string; // optional secret; comma-separated domains
  REQUIRE_DKIM_PASS?: string;  // "true" to also require DKIM pass (defense against From: spoofing)
}

// Cloudflare's inbound email message type. We only use the fields we need so
// the tests stay portable across @cloudflare/workers-types versions.
interface ForwardableEmailMessage {
  from: string;
  to: string;
  headers: Headers;
  raw: ReadableStream<Uint8Array>;
  rawSize: number;
  setReject(reason: string): void;
}

const USER_AGENT = "blog-intake-worker/0.2 (+https://github.com/ttsigg/worker-blob)";

export default {
  // We await the full pipeline so that setReject() calls land before the
  // platform considers the message accepted. Cloudflare gives the email
  // handler up to 30s of wall-clock; AI + a few GitHub calls fit comfortably.
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await handle(message, env);
    } catch (err) {
      // Past the allowlist/size gates we've already committed to processing.
      // Log and let the message fail silently rather than bouncing mid-way.
      console.error("email handler failed:", err instanceof Error ? err.message : String(err));
    }
  },
} satisfies ExportedHandler<Env>;

async function handle(message: ForwardableEmailMessage, env: Env): Promise<void> {
  // 1. Sender allowlist — reject before we spend AI tokens or touch GitHub.
  const sender = normalizeAddress(message.from);
  if (!isAllowedSender(sender, env)) {
    console.warn(`rejecting sender: ${redact(sender)}`);
    message.setReject("sender not on allowlist");
    return;
  }

  // 1b. Optional: require DKIM pass. CF Email Routing already enforces SPF,
  // but DKIM pairs the message body to the sending domain and defeats most
  // From: spoofing. Off by default since self-hosted senders may not sign.
  if ((env.REQUIRE_DKIM_PASS ?? "").toLowerCase() === "true") {
    if (!dkimPasses(message.headers, sender)) {
      console.warn(`rejecting sender: DKIM not pass for ${redact(sender)}`);
      message.setReject("DKIM verification failed");
      return;
    }
  }

  // 2. Resolve target repo from the envelope-to address.
  const site = siteFromTo(message.to, env);
  if (!site) {
    console.warn(`rejecting unknown recipient: ${redact(message.to)}`);
    message.setReject("unknown recipient");
    return;
  }

  // 3. Enforce size cap before we stream the body into memory.
  const maxBody = 25 * 1024 * 1024; // CF Email Routing caps at 25 MiB
  if (message.rawSize > maxBody) {
    message.setReject("message too large");
    return;
  }

  // 4. Parse MIME.
  const parsed = await new PostalMime().parse(message.raw);
  const dictation = (parsed.text ?? stripHtml(parsed.html ?? "")).trim();

  // 5. Gate attachment count and size. Only accept images.
  const maxAttachments = parseIntSafe(env.MAX_ATTACHMENTS, 12);
  const maxAttachmentBytes = parseIntSafe(env.MAX_ATTACHMENT_BYTES, 20 * 1024 * 1024);
  const rawAttachments = Array.isArray(parsed.attachments) ? parsed.attachments : [];
  if (rawAttachments.length > maxAttachments) {
    message.setReject(`too many attachments (>${maxAttachments})`);
    return;
  }
  const images: { bytes: Uint8Array; ext: string }[] = [];
  for (const att of rawAttachments) {
    const mime = (att.mimeType ?? "").toLowerCase();
    if (!mime.startsWith("image/")) continue; // silently drop non-images
    const raw = toBytes(att.content);
    if (!raw) continue;
    if (raw.byteLength > maxAttachmentBytes) {
      message.setReject("attachment too large");
      return;
    }
    // Strip EXIF/XMP/IPTC/text metadata before the bytes go anywhere else —
    // AI captioning and GitHub both see the cleaned file. Unsupported formats
    // (HEIC, GIF, TIFF) pass through unchanged with a log line.
    const cleaned = stripMetadata(mime, raw);
    if (cleaned.format === "unknown") {
      console.warn(`unsupported image format for metadata strip: ${mime} (${raw.byteLength}B)`);
    }
    images.push({ bytes: cleaned.bytes, ext: extForMime(mime) });
  }

  // 6. AI pass — captions first (cheap, parallel), then structure the body.
  const captions = await Promise.all(images.map((img) => captionImage(env.AI, img.bytes)));
  const organized = await organizeDraft(env.AI, dictation);

  // 7. Compute the slug and branch.
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const slug = slugify(organized.title || subjectOf(parsed.subject) || "untitled");
  const branch = `draft/${today}-${slug}`;

  // 8. Assemble repo files.
  const imageFiles = images.map((img, i) => {
    const name = `${today}-${slug}-${i + 1}.${img.ext}`;
    return { path: `static/uploads/${name}`, bytes: img.bytes, webPath: `/uploads/${name}`, alt: captions[i] ?? "" };
  });
  const indexMd = buildIndexMd(organized, today, imageFiles);

  const files: CommitFile[] = [
    { path: `content/posts/${today}-${slug}/index.md`, content: indexMd, encoding: "utf-8" },
    ...imageFiles.map((f) => ({ path: f.path, content: f.bytes, encoding: "base64" as const })),
  ];

  // 9. Commit.
  const commitMessage = `draft: ${organized.title || slug} (via email-intake)`;
  await commitToBranch(env, site, branch, commitMessage, files);

  console.log(
    `Committed ${branch} to ${site} (structured=${organized.structured}, images=${images.length})`,
  );
}

// ---------------------------------------------------------------------------
// Sender allowlist
// ---------------------------------------------------------------------------

function isAllowedSender(sender: string, env: Env): boolean {
  if (!sender) return false;
  const addrs = splitCsv(env.ALLOWED_SENDERS ?? "").map(normalizeAddress);
  const domains = splitCsv(env.ALLOWED_SENDER_DOMAINS ?? "").map((d) => d.toLowerCase());
  // Default-deny: if neither list is configured, reject everything.
  if (addrs.length === 0 && domains.length === 0) return false;
  if (addrs.includes(sender)) return true;
  const at = sender.lastIndexOf("@");
  if (at < 0) return false;
  const domain = sender.slice(at + 1);
  return domains.includes(domain);
}

function normalizeAddress(raw: string): string {
  // "Display Name <user@example.com>" → "user@example.com"
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim().toLowerCase();
}

function redact(addr: string): string {
  const at = addr.lastIndexOf("@");
  if (at <= 1) return "***";
  return addr[0] + "***" + addr.slice(at);
}

function dkimPasses(headers: Headers, sender: string): boolean {
  const ar = headers.get("Authentication-Results") ?? "";
  // Standard form: "mx.cloudflare.com; dkim=pass header.d=example.com; spf=pass ..."
  // Require dkim=pass AND that header.d matches (or is a parent of) the sender domain.
  const dkim = ar.match(/dkim=(\w+)(?:\s+header\.d=([A-Za-z0-9.\-]+))?/i);
  if (!dkim || dkim[1].toLowerCase() !== "pass") return false;
  const senderDomain = sender.slice(sender.lastIndexOf("@") + 1);
  const signingDomain = (dkim[2] ?? "").toLowerCase();
  if (!signingDomain) return false;
  return senderDomain === signingDomain || senderDomain.endsWith("." + signingDomain);
}

// ---------------------------------------------------------------------------
// Recipient → site mapping
// ---------------------------------------------------------------------------

function siteFromTo(to: string, env: Env): string | null {
  const sites = splitCsv(env.SITES);
  const addr = normalizeAddress(to);
  // Accept either `drafts@input.<site>` or `drafts+<anything>@input.<site>`.
  for (const site of sites) {
    const host = `input.${site.toLowerCase()}`;
    if (addr.endsWith(`@${host}`) && addr.startsWith("drafts")) return site;
  }
  return null;
}

// ---------------------------------------------------------------------------
// index.md assembly
// ---------------------------------------------------------------------------

interface ImageRef { path: string; webPath: string; alt: string; }

function buildIndexMd(d: OrganizedDraft, date: string, images: ImageRef[]): string {
  const lines: string[] = [];
  lines.push("+++");
  lines.push(`title = ${tomlString(d.title || "Untitled")}`);
  lines.push(`date = ${date}`);
  if (d.description) lines.push(`description = ${tomlString(d.description)}`);
  lines.push(`draft = true`);
  if (d.tags.length) {
    lines.push(`[taxonomies]`);
    lines.push(`tags = [${d.tags.map(tomlString).join(", ")}]`);
  }
  lines.push("+++");
  lines.push("");
  if (!d.structured) {
    lines.push("<!-- AI did not return structured JSON; dictation preserved verbatim. -->");
    lines.push("");
  }
  if (d.outline) {
    lines.push("<!--");
    lines.push("outline:");
    lines.push(d.outline);
    lines.push("-->");
    lines.push("");
  }
  lines.push(d.body);
  if (images.length) {
    lines.push("");
    for (const img of images) {
      const alt = img.alt.replace(/[\[\]]/g, "");
      lines.push(`![${alt}](${img.webPath})`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function tomlString(s: string): string {
  // Zola frontmatter is TOML. Escape backslashes and double-quotes.
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// GitHub Git Data API
// ---------------------------------------------------------------------------

type CommitFile =
  | { path: string; content: string; encoding: "utf-8" }
  | { path: string; content: Uint8Array; encoding: "base64" };

async function commitToBranch(
  env: Env,
  repo: string,
  branch: string,
  commitMessage: string,
  files: CommitFile[],
): Promise<void> {
  const owner = env.GITHUB_OWNER;
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  // 1. Resolve the default branch head SHA.
  const refResp = await gh(env, `${base}/git/refs/heads/${encodeURIComponent(env.DEFAULT_BRANCH)}`);
  const baseSha: string = refResp.object.sha;

  // 2. Create blobs for each file. Independent calls — run in parallel so a
  //    dozen attachments don't eat the email-handler 30s budget in serial RTTs.
  const blobs = await Promise.all(files.map(async (f) => {
    const body =
      f.encoding === "utf-8"
        ? { content: f.content, encoding: "utf-8" as const }
        : { content: base64Encode(f.content), encoding: "base64" as const };
    const blob = await gh(env, `${base}/git/blobs`, "POST", body);
    return { path: f.path, sha: blob.sha as string, mode: "100644" as const };
  }));

  // 3. Create a tree with those blobs, based on the head tree.
  const tree = await gh(env, `${base}/git/trees`, "POST", {
    base_tree: baseSha,
    tree: blobs.map((b) => ({ path: b.path, mode: b.mode, type: "blob", sha: b.sha })),
  });

  // 4. Create a commit pointing to that tree.
  const commit = await gh(env, `${base}/git/commits`, "POST", {
    message: commitMessage,
    tree: tree.sha,
    parents: [baseSha],
    author: {
      name: env.COMMIT_AUTHOR_NAME,
      email: env.COMMIT_AUTHOR_EMAIL,
      date: new Date().toISOString(),
    },
  });

  // 5. Create the branch ref. If it already exists (slug collision — same
  //    AI-guessed title twice in a day), throw a dedicated error the caller
  //    can distinguish from transport failures.
  try {
    await gh(env, `${base}/git/refs`, "POST", {
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    });
  } catch (err) {
    throw new Error(`branch-create failed for ${branch} on ${repo}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function gh(env: Env, url: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: {
      "authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "accept": "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": USER_AGENT,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    // Do NOT log the response body verbatim — GitHub error payloads echo
    // request fragments, which can include paths. Status + url is enough.
    throw new Error(`GitHub ${method} ${url} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as any;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitCsv(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function parseIntSafe(s: string | undefined, fallback: number): number {
  const n = Number.parseInt(s ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function subjectOf(s: string | undefined): string {
  return (s ?? "").trim();
}

function slugify(s: string): string {
  const base = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacriticals
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || "untitled";
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extForMime(mime: string): string {
  switch (mime) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    default:
      return "bin";
  }
}

function toBytes(content: unknown): Uint8Array | null {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (typeof content === "string") {
    // postal-mime returns base64 strings for binary attachments when opts.attachmentEncoding is "base64".
    try {
      const bin = atob(content);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  }
  return null;
}

function base64Encode(bytes: Uint8Array): string {
  // btoa on a binary string. Chunked to avoid String.fromCharCode blowing the stack.
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(s);
}

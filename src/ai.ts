// Workers AI calls. Two passes:
//   captionImage()  — LLaVA 1.5 7B, one call per attached image, returns alt text.
//   organizeDraft() — Gemma 3 27B Instruct, turns dictation into structured JSON.
//
// The model IDs below are the ones currently GA on Workers AI. If Cloudflare
// ships a stronger vision model or a proper multimodal Gemma, the fast path is
// to swap VISION_MODEL / TEXT_MODEL and (eventually) collapse both calls into
// one multimodal call with image blocks.

export const VISION_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";
export const TEXT_MODEL = "@cf/google/gemma-3-12b-it";

export interface OrganizedDraft {
  title: string;
  description: string;
  tags: string[];
  outline: string;
  body: string;
  structured: boolean; // false = model returned garbage, caller should use fallback marker
}

export const CLEANUP_SYSTEM = `You are an editor helping a writer turn raw voice dictation into a blog draft.

Return ONLY a single JSON object, no prose around it, with this exact shape:
{
  "title":       string,  // <= 70 chars, no trailing period, no quotes
  "description": string,  // one sentence, <= 160 chars, for frontmatter
  "tags":        string[],// 2-6 lowercase tags, kebab-case, no "#" prefix
  "outline":     string,  // 3-8 bullet lines, each starting with "- "
  "body":        string   // the dictation cleaned up: fix transcription errors,
                          // split into paragraphs, preserve the writer's voice
                          // and opinions. Do NOT invent facts. Mark uncertain
                          // words as [bracketed].
}

Hard rules:
- Output MUST parse as JSON. No markdown fences, no commentary.
- Never include the writer's email address, phone number, or any PII that was
  not in the dictation itself.
- If the dictation is empty or unusable, return the object with empty strings
  / empty array and set body to the original text verbatim.`;

type AiBinding = {
  run(model: string, input: unknown): Promise<unknown>;
};

async function runText(ai: AiBinding, model: string, input: unknown): Promise<string> {
  const res = (await ai.run(model, input)) as { response?: string } | string;
  if (typeof res === "string") return res;
  return res?.response ?? "";
}

export async function captionImage(
  ai: AiBinding,
  imageBytes: Uint8Array,
): Promise<string> {
  try {
    const out = await runText(ai, VISION_MODEL, {
      image: Array.from(imageBytes),
      prompt:
        "Describe this image in one short sentence suitable as alt text for a blog post. No preamble, no markdown.",
      max_tokens: 96,
    });
    return sanitizeAlt(out);
  } catch (err) {
    console.warn("captionImage failed:", err);
    return "";
  }
}

function sanitizeAlt(s: string): string {
  // Strip quotes, markdown, and control chars; cap length.
  const cleaned = s
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[`*_>#]/g, "")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .trim();
  return cleaned.length > 240 ? cleaned.slice(0, 237) + "..." : cleaned;
}

export async function organizeDraft(
  ai: AiBinding,
  dictation: string,
): Promise<OrganizedDraft> {
  const fallback: OrganizedDraft = {
    title: "",
    description: "",
    tags: [],
    outline: "",
    body: dictation,
    structured: false,
  };

  let raw = "";
  try {
    raw = await runText(ai, TEXT_MODEL, {
      messages: [
        { role: "system", content: CLEANUP_SYSTEM },
        { role: "user", content: dictation },
      ],
      max_tokens: 2048,
      temperature: 0.3,
    });
  } catch (err) {
    console.warn("organizeDraft model call failed:", err);
    return fallback;
  }

  const parsed = tryParseJson(raw);
  if (!parsed) return fallback;

  const title = asString(parsed.title).slice(0, 120).trim();
  const description = asString(parsed.description).slice(0, 280).trim();
  const tags = asStringArray(parsed.tags)
    .map((t) => t.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter((t) => t.length > 0 && t.length <= 40)
    .slice(0, 8);
  const outline = asString(parsed.outline).trim();
  const body = asString(parsed.body).trim() || dictation;

  if (!title && !description && tags.length === 0) {
    // Model echoed empty fields — treat as unstructured and use fallback.
    return { ...fallback, body };
  }

  return { title, description, tags, outline, body, structured: true };
}

function tryParseJson(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  // Strip code fences if the model added them despite instructions.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  // Find the first { and last } — models sometimes add a leading "Here is:" line.
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(candidate.slice(start, end + 1));
    return typeof obj === "object" && obj !== null ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

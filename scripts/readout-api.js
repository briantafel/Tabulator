/* One request to the Claude API, and nothing else.
 *
 * Deliberately dumb: no tools, no agent loop, no retries of its own. The
 * caller (write-readout.js) owns how many calls happen; this file only makes
 * the one it is asked for, with a hard timeout and a hard output cap, and
 * says plainly what went wrong.
 *
 * The key arrives as an argument from process.env.ANTHROPIC_API_KEY (a
 * GitHub Actions secret). It is never logged, never written to a file.
 */

export const API_URL = "https://api.anthropic.com/v1/messages";
export const HAIKU = "claude-haiku-5-5";
export const SONNET = "claude-sonnet-5-5";

export const SYSTEM = `You write the read-out under a ski app's snow radar. Readers are skiers deciding where to go this week.

Voice: a knowledgeable skier who reads forecasts closely. Plain, specific, calm. Short sentences. No hype, no exclamation marks, no emojis, no cartoonish slang ("dump", "send it", "it's dumping"), no marketing words.

You get a JSON fact sheet. Write one short paragraph per region in "regions", in exactly that order, copying each "key" exactly.
- Lead with the region's top resort, its total and when it falls (the "peak" day). Mention the other resorts briefly.
- Use the NWS period wording ("short", "detail") for conditions: heavy snow, rain mixing in, snow levels, timing. If "alerts" are present, name the alert.
- At most about 60 words per region.

Hard rules — your text is checked automatically and rejected if it breaks them:
- Use only numbers that appear in the fact sheet. Totals are inches, written like 8". Do not add, convert, round or estimate.
- Name only resorts, states and regions that appear in the fact sheet.
- "ahead": null, unless the "ahead" array contains a discussion describing snow or a storm for western or northeastern mountains AFTER the fact sheet's window.to date. Then at most two sentences (under 300 characters): what is coming and roughly when, which agency says so ("the Weather Prediction Center", "the Climate Prediction Center", "the Salt Lake City NWS office"), and its confidence in its own words. Never describe anything inside the window there.

Reply with JSON only, no prose around it:
{"regions":[{"key":"...","text":"..."}],"ahead":null}`;

export class ApiError extends Error {
  constructor(message, { status = null, fatal = false } = {}) {
    super(message);
    this.status = status;
    /** fatal = the key or the account limit, not a passing hiccup. */
    this.fatal = fatal;
  }
}

/** Pull the JSON object out of the model's reply, tolerating a code fence. */
export function parseReply(text) {
  const s = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("reply has no JSON object");
  return JSON.parse(s.slice(a, b + 1));
}

/**
 * @returns { text, usage }
 * @throws ApiError
 */
export async function callClaude({ key, model, user, maxTokens, timeoutMs, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(API_URL, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: maxTokens, system: SYSTEM, messages: [{ role: "user", content: user }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ApiError(`request failed — ${e.name === "TimeoutError" ? `no answer in ${timeoutMs / 1000}s` : e.message}`);
  }

  let body = null;
  try { body = await res.json(); } catch { /* reported below */ }
  if (!res.ok) {
    const msg = body?.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      throw new ApiError(`the API key was rejected (${res.status}) — it has probably expired or been deleted. Make a new one and paste it over the ANTHROPIC_API_KEY secret.`, { status: res.status, fatal: true });
    }
    if (res.status === 400 && /usage limit|spend limit|credit balance/i.test(msg)) {
      throw new ApiError(`the account's spend limit or credit is used up — ${msg}`, { status: res.status, fatal: true });
    }
    throw new ApiError(`API answered ${res.status}: ${msg}`, { status: res.status });
  }
  const text = (body?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
  return { text, usage: body?.usage ?? null, stop: body?.stop_reason ?? null };
}

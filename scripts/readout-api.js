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

export const SYSTEM = `You write the read-out under a ski app's snow radar. Readers are skiers deciding where to go this week. They see the radar's numbers right above your text.

Voice: a knowledgeable skier who has read the forecasts so the reader doesn't have to. Plain, specific, calm. Short sentences. No hype, no exclamation marks, no emojis, no cartoonish slang ("dump", "send it", "it's dumping"), no marketing words. Leave out anything a skier would not act on (a slight chance of thunderstorms, "less than one inch").

You get a JSON fact sheet. Write one paragraph per region in "regions", in exactly that order, copying each "key" exactly. About 40 words each:
1. The top resort, its total ("totalIn") and its big day ("peak").
2. One conditions note from the NWS wording ("short", "detail"): heavy snow, rain mixing in, snow level, strong wind or wind chill. Pick the one that matters most.
3. If a resort has "nwsHigher", say so in one clause, e.g. "The NWS is calling for more, 21 to 32 inches Saturday night through Monday." Never otherwise quote NWS amounts.
4. If a resort has "alerts", name the alert and when ("from"/"to").
5. Other resorts in a few words, only if there is room.

Hard rules — your text is checked automatically and rejected if it breaks them:
- Use only numbers that appear in the fact sheet. Totals are inches, written like 8". Do not add, convert, round or estimate.
- Name only resorts, states and regions that appear in the fact sheet.
- Never mention the fact sheet, the data, the sources you were or were not given, or what is missing. Readers never see any of that.
- Days are day names ("Sunday", "Sunday night"), never "today", "tonight" or "tomorrow".
- "ahead": null, unless a discussion in "ahead" describes snow or a storm for western or northeastern mountains on one of the days in "afterWindow". Then at most two sentences (under 300 characters): what is coming, the date as written in "afterWindow" (e.g. "around Friday Nov 6"), which agency says so ("the Weather Prediction Center", "the Climate Prediction Center", "the Salt Lake City NWS office"), and its confidence in its own words. Nothing inside the window, and no "early next week" or "this weekend". If nothing qualifies, "ahead" is null — do not explain why.

Reply with JSON only, no prose around it:
{"regions":[{"key":"...","text":"..."}],"ahead":null}`;

/* Thinking, per model. These models reason before answering unless told
   not to, and that reasoning counts against max_tokens: the first live run
   (2026-10-30) spent all 1,000 tokens thinking on every call and returned
   nothing. Rewriting a fact sheet needs no reasoning. Haiku 5.5 accepts
   "disabled"; Sonnet 5.5 does not, and its lowest setting is
   "between_tools" (no up-front thinking) at medium effort or below.
   platform.claude.com/docs/en/build-with-claude/effort */
export function thinkingFor(model) {
  if (/haiku/.test(model)) return { thinking: { type: "disabled" } };
  if (/sonnet/.test(model)) return { thinking: { type: "between_tools" }, output_config: { effort: "medium" } };
  return {};
}

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
      body: JSON.stringify({ model, max_tokens: maxTokens, ...thinkingFor(model), system: SYSTEM, messages: [{ role: "user", content: user }] }),
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
  if (!text && body?.stop_reason === "max_tokens") {
    throw new ApiError(`${model} used all ${maxTokens} output tokens without writing anything (thinking: ${body?.usage?.output_tokens_details?.thinking_tokens ?? "?"})`);
  }
  return { text, usage: body?.usage ?? null, stop: body?.stop_reason ?? null };
}

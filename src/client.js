// LightningProx HTTP client: requests, response metadata and error mapping.
// The spend token is sent only as the X-Spend-Token header and is redacted
// from every string this module returns.

export const DEFAULT_URL = "https://lightningprox.com";
const USER_AGENT = "lightningprox-mcp/1.3.0";
const TIMEOUT_MS = 120_000;

/** Error carrying a user-facing message (already redacted). */
export class LightningProxError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "LightningProxError";
    this.status = status;
    this.code = code;
  }
}

/** Replace any lnpx_ spend token in s with a redacted marker. */
export function redact(s, token) {
  if (typeof s !== "string") return s;
  let out = s;
  if (token) out = out.split(token).join("lnpx_…(redacted)");
  return out.replace(/lnpx_[A-Za-z0-9]{8,}/g, "lnpx_…(redacted)");
}

export function createClient({ baseUrl, token, fetchImpl } = {}) {
  const base = (baseUrl || DEFAULT_URL).replace(/\/+$/, "");
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error("global fetch is not available: Node.js 18 or newer is required");
  }

  async function request(method, path, { body, headers = {}, auth = false } = {}) {
    const h = { "User-Agent": USER_AGENT, Accept: "application/json", ...headers };
    if (body !== undefined) h["Content-Type"] = "application/json";
    if (auth && token) h["X-Spend-Token"] = token;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await doFetch(base + path, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      const why = err && err.name === "AbortError" ? `timed out after ${TIMEOUT_MS / 1000}s` : String(err && err.message ? err.message : err);
      throw new LightningProxError(redact(`Could not reach LightningProx at ${base}: ${why}`, token), { code: "network_error" });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, headers: res.headers, json, text };
  }

  return { base, hasToken: Boolean(token), token, request };
}

function field(body, name) {
  return body && typeof body === "object" ? body[name] : undefined;
}

/**
 * Turn a non-2xx LightningProx response into a clear message.
 * 402 responses that carry an invoice are handled by the callers (they are
 * a payment step, not an error).
 */
export function describeError(res, { token, model } = {}) {
  const body = res.json || {};
  const err = field(body, "error");
  const code = typeof err === "string" ? err : err && typeof err === "object" ? err.code || err.type : undefined;
  const serverMsg =
    (typeof body.message === "string" && body.message) ||
    (err && typeof err === "object" && typeof err.message === "string" && err.message) ||
    (typeof err === "string" && err) ||
    (res.text || "").slice(0, 300);
  let msg;
  switch (true) {
    case code === "unknown_model":
      msg = `Unknown model "${body.model || model || "?"}". Call list_models for the IDs LightningProx serves (e.g. claude-haiku-5-5). Nothing was charged.`;
      break;
    case code === "model_retired":
      msg = `Model "${body.model || model}" is retired. Use ${body.replacement || "a model from list_models"} instead. Nothing was charged.`;
      break;
    case code === "context_length_exceeded":
      msg = `Prompt too long for ${body.model || model}: about ${body.estimated_input_tokens} input tokens, max ${body.max_input_tokens} with this max_tokens. Shorten the prompt, lower max_tokens, or pick a larger-context model. Nothing was charged.`;
      break;
    case code === "tools_not_supported":
      msg = `${body.model || model} does not support tool use. Call list_models and pick a model with supports_tools: true. Nothing was charged.`;
      break;
    case code === "tool_choice_not_supported":
    case code === "unsupported_tool_type":
    case code === "invalid_tools":
    case code === "invalid_tool_choice":
    case code === "invalid_tool_history":
      msg = `Tool request rejected (${code}): ${serverMsg}`;
      break;
    case code === "insufficient_balance":
      msg = `Spend token balance too low for this request (needs ${body.required_sats ?? "?"} sats). Top up with create_topup, then get_token. Nothing was charged.`;
      break;
    case code === "daily_spend_cap_reached":
      msg = `Daily spend cap reached for this token: ${serverMsg}`;
      break;
    case code === "provider_unavailable":
      msg = `${body.model || model} is unavailable from its provider right now. No sats were charged. Retry later or choose another model (list_models).`;
      break;
    case code === "provider_overloaded":
      msg = `The AI provider is overloaded right now. No sats were charged. Retry shortly or choose another model.`;
      break;
    case code === "upstream_error":
      msg = `The AI provider returned an error. No sats were charged. ${serverMsg}`;
      break;
    case res.status === 401:
      msg = `LightningProx rejected the spend token (invalid or expired). Set a valid LIGHTNINGPROX_SPEND_TOKEN, or buy one with create_topup. Server said: ${serverMsg}`;
      break;
    case res.status === 429: {
      const retry = body.retry_after_secs ?? (res.headers && res.headers.get && res.headers.get("retry-after"));
      msg = `Rate limited by LightningProx${retry ? `; retry in ${retry} seconds` : ""}. ${serverMsg}`;
      break;
    }
    case res.status === 402:
      msg = `Payment required: ${serverMsg}`;
      break;
    case res.status === 413:
      msg = `Request too large for LightningProx (4 MB limit). ${serverMsg}`;
      break;
    default:
      msg = `LightningProx error ${res.status}${code ? ` (${code})` : ""}: ${serverMsg}`;
  }
  const notice = noticeOf(res);
  if (notice) msg += `\n\nNotice from LightningProx: ${notice}`;
  return new LightningProxError(redact(msg, token), { status: res.status, code });
}

/** A token notice, from the JSON body or the X-LightningProx-Notice header. */
export function noticeOf(res) {
  const n = res.json && typeof res.json.notice === "string" ? res.json.notice : null;
  return n || (res.headers && res.headers.get && res.headers.get("x-lightningprox-notice")) || null;
}

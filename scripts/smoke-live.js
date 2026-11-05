#!/usr/bin/env node
// Live smoke test against production using only free calls:
//   1. list_models (GET /v1/models + /api/capabilities)
//   2. ask_ai with NO spend token -> must return the L402 invoice (402), not an error.
// No spend token is ever sent. Usage: node scripts/smoke-live.js [base_url]
import { createClient } from "../src/client.js";
import { callTool } from "../src/tools.js";

const base = process.argv[2] || process.env.LIGHTNINGPROX_URL || "https://lightningprox.com";
const client = createClient({ baseUrl: base, token: undefined });
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
  if (!ok) failed++;
};

const models = await callTool(client, "list_models", {});
const mt = models.content[0].text;
const count = Number((mt.match(/^(\d+) models/) || [])[1] || 0);
check("list_models returns models", !models.isError && count > 0, `${count} models`);
check("list_models includes claude-haiku-5-5 with tools", /^claude-haiku-5-5 \(anthropic\) \| tools: yes/m.test(mt));
check("list_models shows supports_tools: no for gpt-6-astra", /^gpt-6-astra .*tools: no/m.test(mt));
check("list_models has pricing", /per 1M tokens/.test(mt));

const ask = await callTool(client, "ask_ai", { model: "claude-haiku-5-5", prompt: "ping", max_tokens: 16 });
const at = ask.content[0].text;
const inv = (at.match(/Invoice \(BOLT11\): (\S+)/) || [])[1] || "";
check("unpaid ask_ai returns an invoice (not an error)", !ask.isError && /^ln(bc|tb)/.test(inv), inv ? inv.slice(0, 24) + "..." : at.slice(0, 160));
check("invoice result includes amount and macaroon", /Amount: \d+ sats/.test(at) && /Macaroon: \S+/.test(at));

const raw = await client.request("POST", "/v1/messages", { body: { model: "claude-haiku-5-5", max_tokens: 16, messages: [{ role: "user", content: "ping" }] } });
check("raw 402 has invoice + WWW-Authenticate L402", raw.status === 402 && typeof raw.json?.invoice === "string" && /^L402 /.test(raw.headers.get("www-authenticate") || ""), `HTTP ${raw.status}`);

console.log(failed ? `\n${failed} check(s) failed` : "\nall live checks passed");
process.exit(failed ? 1 : 0);

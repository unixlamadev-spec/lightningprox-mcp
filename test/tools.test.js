import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClient, redact } from "../src/client.js";
import { buildMessagesBody, callTool, toolDefinitions } from "../src/tools.js";
import { createServer } from "../src/server.js";

const TOKEN = "lnpx_" + "a1b2c3d4".repeat(8);

// mockFetch: routes "METHOD /path" to a reply; records every call.
function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || "GET"} ${u.pathname}`;
    calls.push({ key, url, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined });
    const r = routes[key];
    if (!r) return new Response(JSON.stringify({ error: "not mocked: " + key }), { status: 404 });
    const { status = 200, body = {}, headers = {} } = typeof r === "function" ? r(calls.at(-1)) : r;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  };
  fn.calls = calls;
  return fn;
}

const client = (routes, token = TOKEN) => {
  const f = mockFetch(routes);
  return { c: createClient({ baseUrl: "https://lp.test", token, fetchImpl: f }), f };
};
const out = (r) => r.content.map((c) => c.text).join("\n");

test("tool list matches the five tools", () => {
  assert.deepEqual(
    toolDefinitions.map((t) => t.name),
    ["ask_ai", "list_models", "check_balance", "create_topup", "get_token"],
  );
  for (const t of toolDefinitions) assert.equal(t.inputSchema.type, "object");
});

test("ask_ai: prompt -> /v1/messages with token, returns text, model, remap, balance, notice", async () => {
  const { c, f } = client({
    "POST /v1/messages": {
      body: {
        id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5",
        content: [{ type: "thinking", thinking: "..." }, { type: "text", text: "Hello there" }],
        stop_reason: "end_turn", balance_remaining_sats: 4321, model_used: "claude-haiku-5-5",
        notice: "Your balance was restored.",
      },
      headers: { "x-model-remapped": "claude-haiku-4-5->claude-haiku-4-5-20251001", "x-balance-remaining": "4321" },
    },
  });
  const r = await callTool(c, "ask_ai", { model: "claude-haiku-5-5", prompt: "Hi", system: "Be brief", max_tokens: 50 });
  assert.equal(r.isError, undefined);
  const t = out(r);
  assert.match(t, /^Hello there/);
  assert.match(t, /model: claude-haiku-5-5/);
  assert.match(t, /remapped: claude-haiku-4-5->claude-haiku-4-5-20251001/);
  assert.match(t, /balance: 4321 sats/);
  assert.match(t, /Notice from LightningProx: Your balance was restored\./);
  const call = f.calls[0];
  assert.equal(call.key, "POST /v1/messages");
  assert.equal(call.headers["X-Spend-Token"], TOKEN);
  assert.deepEqual(call.body, { model: "claude-haiku-5-5", max_tokens: 50, system: "Be brief", messages: [{ role: "user", content: "Hi" }] });
  assert.ok(!t.includes(TOKEN));
});

test("ask_ai: messages + tools/tool_choice passthrough, tool_use blocks returned", async () => {
  const tools = [{ name: "get_weather", description: "w", input_schema: { type: "object", properties: { city: { type: "string" } } } }];
  const { c, f } = client({
    "POST /v1/messages": {
      body: {
        type: "message", model: "gpt-4o-mini", stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } }],
      },
    },
  });
  const messages = [{ role: "user", content: "Weather in Paris?" }];
  const r = await callTool(c, "ask_ai", { model: "gpt-4o-mini", messages, tools, tool_choice: { type: "any" } });
  const t = out(r);
  assert.match(t, /Tool calls \(1\)/);
  assert.match(t, /"name": "get_weather"/);
  assert.match(t, /"city": "Paris"/);
  assert.match(t, /stop: tool_use/);
  assert.deepEqual(f.calls[0].body.tools, tools);
  assert.deepEqual(f.calls[0].body.tool_choice, { type: "any" });
  assert.deepEqual(f.calls[0].body.messages, messages);
});

test("ask_ai: OpenAI-shaped reply (non-Anthropic model without tools)", async () => {
  const { c } = client({
    "POST /v1/messages": { body: { object: "chat.completion", choices: [{ message: { content: "Bonjour" }, finish_reason: "stop" }], model_used: "gemini-3.8-flash" } },
  });
  const t = out(await callTool(c, "ask_ai", { model: "gemini-3.8-flash", prompt: "Hi" }));
  assert.match(t, /^Bonjour/);
  assert.match(t, /model: gemini-3.8-flash/);
});

test("ask_ai without a token: returns the 402 invoice, not an error; l402 retry sends the same body", async () => {
  const invoice402 = {
    status: 402,
    body: { error: "payment_required", macaroon: "MAC123", invoice: "lnbc50n1ptest", amount_sats: 5, charge_id: "ch_1" },
    headers: { "www-authenticate": 'L402 macaroon="STD", invoice="lnbc50n1ptest"' },
  };
  let paid = false;
  const { c, f } = client(
    {
      "POST /v1/messages": (call) =>
        call.headers.Authorization === "L402 MAC123:" + "ff".repeat(32)
          ? (paid = true, { body: { type: "message", model: "claude-haiku-5-5", content: [{ type: "text", text: "Paid answer" }], stop_reason: "end_turn" } })
          : invoice402,
    },
    null,
  );
  const args = { model: "claude-haiku-5-5", prompt: "Hi" };
  const r = await callTool(c, "ask_ai", args);
  assert.equal(r.isError, undefined);
  const t = out(r);
  assert.match(t, /Invoice \(BOLT11\): lnbc50n1ptest/);
  assert.match(t, /Amount: 5 sats/);
  assert.match(t, /Macaroon: MAC123/);
  assert.match(t, /create_topup/);
  assert.equal(f.calls[0].headers["X-Spend-Token"], undefined);

  const r2 = await callTool(c, "ask_ai", { ...args, l402: "MAC123:" + "ff".repeat(32) });
  assert.ok(paid);
  assert.match(out(r2), /Paid answer/);
  assert.equal(JSON.stringify(f.calls[1].body), JSON.stringify(f.calls[0].body), "L402 body must be byte-identical");
  assert.equal(f.calls[1].headers["X-Spend-Token"], undefined);
});

test("ask_ai: input validation", async () => {
  const { c, f } = client({});
  assert.equal((await callTool(c, "ask_ai", { prompt: "x" })).isError, true);
  assert.equal((await callTool(c, "ask_ai", { model: "gpt-4o-mini" })).isError, true);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(buildMessagesBody({ model: "m", prompt: "p" }), { model: "m", max_tokens: 1024, messages: [{ role: "user", content: "p" }] });
});

test("error mapping for /v1/messages", async () => {
  const cases = [
    [400, { error: "unknown_model", message: "x", model: "gpt-9" }, /Unknown model "gpt-9".*list_models/],
    [400, { error: "model_retired", model: "magistral-medium-2506", replacement: "mistral-medium-3-5" }, /retired.*mistral-medium-3-5/],
    [400, { error: "context_length_exceeded", model: "gpt-4o-mini", estimated_input_tokens: 200000, max_input_tokens: 126976 }, /Prompt too long.*200000.*126976/],
    [400, { error: "tools_not_supported", model: "gpt-6-astra", message: "m" }, /gpt-6-astra does not support tool use.*supports_tools/],
    [400, { error: "tool_choice_not_supported", message: "forced tool_choice refused" }, /Tool request rejected \(tool_choice_not_supported\): forced/],
    [402, { error: "insufficient_balance", required_sats: 25 }, /balance too low.*25 sats.*create_topup/],
    [401, { error: "Invalid or expired spend token" }, /rejected the spend token/],
    [429, { error: "Rate limit exceeded", message: "10 per minute", retry_after_secs: 12 }, /Rate limited.*12 seconds/],
    [429, { error: "daily_spend_cap_reached", message: "cap 500 sats" }, /Daily spend cap reached/],
    [503, { error: "provider_unavailable", model: "gemini-3.8-flash", charged_sats: 0 }, /gemini-3.8-flash is unavailable.*No sats were charged/],
    [503, { error: "provider_overloaded" }, /overloaded.*No sats/],
    [502, { error: "upstream_error", message: "The AI provider returned an error." }, /provider returned an error.*No sats/],
    [500, "<html>oops</html>", /LightningProx error 500/],
  ];
  for (const [status, body, re] of cases) {
    const { c } = client({ "POST /v1/messages": { status, body } });
    const r = await callTool(c, "ask_ai", { model: "gpt-4o-mini", prompt: "Hi" });
    assert.equal(r.isError, true, `${status} ${JSON.stringify(body)}`);
    assert.match(out(r), re);
    assert.ok(!out(r).includes(TOKEN));
  }
});

test("network failure is an isError result", async () => {
  const c = createClient({ baseUrl: "https://lp.test", token: TOKEN, fetchImpl: async () => { throw new Error("ECONNREFUSED " + TOKEN); } });
  const r = await callTool(c, "list_models", {});
  assert.equal(r.isError, true);
  assert.match(out(r), /Could not reach LightningProx/);
  assert.ok(!out(r).includes(TOKEN));
});

test("the spend token never appears in output, even if the server echoes it", async () => {
  const { c } = client({ "POST /v1/messages": { status: 400, body: { error: "bad token " + TOKEN } } });
  const t = out(await callTool(c, "ask_ai", { model: "gpt-4o-mini", prompt: "x" }));
  assert.ok(!t.includes(TOKEN));
  assert.match(t, /lnpx_…\(redacted\)/);
  assert.equal(redact("x lnpx_abcdef123456 y"), "x lnpx_…(redacted) y");
});

test("list_models: ids, supports_tools and pricing from /api/capabilities", async () => {
  const { c } = client({
    "GET /v1/models": { body: { object: "list", data: [
      { id: "claude-haiku-5-5", owned_by: "anthropic", supports_tools: true },
      { id: "gpt-6-astra", owned_by: "openai", supports_tools: false },
    ] } },
    "GET /api/capabilities": { body: { models: [{ id: "claude-haiku-5-5", input_cost_usd: 0.12e-6, output_cost_usd: 0.6e-6 }] } },
  });
  const t = out(await callTool(c, "list_models", {}));
  assert.match(t, /^2 models available/);
  assert.match(t, /claude-haiku-5-5 \(anthropic\) \| tools: yes \| \$0\.120 in \/ \$0\.600 out per 1M tokens/);
  assert.match(t, /gpt-6-astra \(openai\) \| tools: no$/m);
});

test("list_models works when /api/capabilities fails", async () => {
  const { c } = client({ "GET /v1/models": { body: { data: [{ id: "gpt-4o-mini", owned_by: "openai", supports_tools: true }] } } });
  const t = out(await callTool(c, "list_models", {}));
  assert.match(t, /gpt-4o-mini \(openai\) \| tools: yes$/m);
});

test("check_balance: with and without token", async () => {
  const { c, f } = client({
    "GET /v1/balance": { body: { balance_sats: 950, balance_usd: 0.77, initial_sats: 1000, expires_at: "2026-12-05T00:00:00Z", status: "active" } },
  });
  const t = out(await callTool(c, "check_balance", {}));
  assert.match(t, /Balance: 950 sats \(~\$0\.77\)/);
  assert.match(t, /Expires: 2026-12-05/);
  assert.equal(f.calls[0].headers["X-Spend-Token"], TOKEN);

  const { c: c2, f: f2 } = client({}, null);
  const r = await callTool(c2, "check_balance", {});
  assert.equal(r.isError, true);
  assert.match(out(r), /create_topup/);
  assert.equal(f2.calls.length, 0);

  const { c: c3 } = client({ "GET /v1/balance": { status: 404, body: { error: "token_invalid", message: "token expired" } } });
  assert.match(out(await callTool(c3, "check_balance", {})), /token_invalid.*token expired/);
});

test("create_topup: 402 invoice body -> invoice + charge id + next step", async () => {
  const { c, f } = client({
    "POST /v1/topup": { status: 402, body: { charge_id: "ch_9", payment_request: "lnbc10u1ptopup", amount_sats: 1000, amount_usd: 0.81, next_step: "/v1/tokens" } },
  });
  const r = await callTool(c, "create_topup", { amount_sats: 1000 });
  assert.equal(r.isError, undefined);
  const t = out(r);
  assert.match(t, /lnbc10u1ptopup/);
  assert.match(t, /Charge ID: ch_9/);
  assert.match(t, /get_token/);
  assert.match(t, /30 days/);
  assert.deepEqual(f.calls[0].body, { amount_sats: 1000 });
  assert.equal(f.calls[0].headers["X-Spend-Token"], undefined, "top-up does not send the token");
  for (const bad of [5, 100001, 12.5, "100"]) {
    assert.equal((await callTool(c, "create_topup", { amount_sats: bad })).isError, true);
  }
  const { c: c2 } = client({ "POST /v1/topup": { status: 429, body: { error: "Rate limit exceeded", retry_after_secs: 30 } } });
  assert.match(out(await callTool(c2, "create_topup", { amount_sats: 100 })), /Rate limited.*30 seconds/);
});

test("get_token: paid -> token; unpaid -> retry hint; bad charge -> error", async () => {
  const minted = "lnpx_" + "9".repeat(64);
  const { c, f } = client({ "POST /v1/tokens": { status: 201, body: { token: minted, spend_token: minted, balance_sats: 1000, expires_at: "2026-12-05T11:00:00Z", status: "active" } } });
  const t = out(await callTool(c, "get_token", { charge_id: "ch_9" }));
  assert.match(t, new RegExp("Spend token: " + minted));
  assert.match(t, /LIGHTNINGPROX_SPEND_TOKEN/);
  assert.deepEqual(f.calls[0].body, { charge_id: "ch_9" });

  const { c: c2 } = client({ "POST /v1/tokens": { status: 402, body: { error: "Payment not received" } } });
  const r2 = await callTool(c2, "get_token", { charge_id: "ch_9" });
  assert.equal(r2.isError, true);
  assert.match(out(r2), /not paid yet/);

  const { c: c3 } = client({ "POST /v1/tokens": { status: 400, body: { error: "charge_id is not a spend-token topup" } } });
  assert.match(out(await callTool(c3, "get_token", { charge_id: "x" })), /not a spend-token topup/);
  assert.equal((await callTool(c3, "get_token", {})).isError, true);
});

test("MCP protocol: initialize, tools/list and tools/call through the SDK", async () => {
  const f = mockFetch({ "GET /v1/models": { body: { data: [{ id: "claude-haiku-5-5", owned_by: "anthropic", supports_tools: true }] } } });
  const { server } = createServer({ env: { LIGHTNINGPROX_URL: "https://lp.test" }, fetchImpl: f });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: "test", version: "1" });
  await mcp.connect(b);
  assert.equal(mcp.getServerVersion().name, "lightningprox-mcp");
  assert.equal(mcp.getServerVersion().version, "1.3.0");
  const { tools } = await mcp.listTools();
  assert.equal(tools.length, 5);
  const r = await mcp.callTool({ name: "list_models", arguments: {} });
  assert.match(r.content[0].text, /claude-haiku-5-5/);
  assert.equal(new URL(f.calls[0].url).origin, "https://lp.test");
  await mcp.close();
});

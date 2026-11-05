// MCP tool definitions and handlers. Each handler takes (client, args) and
// returns an MCP CallToolResult: { content: [{type:"text", text}], isError? }.

import { describeError, LightningProxError, noticeOf, redact } from "./client.js";

export const EXAMPLE_MODEL = "claude-haiku-5-5";
const TOPUP_MIN = 10;
const TOPUP_MAX = 100_000;

const NO_TOKEN_HELP = `No spend token is configured (LIGHTNINGPROX_SPEND_TOKEN).
To get one:
  1. create_topup with amount_sats (10 to 100,000) - returns a Lightning invoice
  2. pay the invoice with any Lightning wallet
  3. get_token with the charge_id - returns your lnpx_ spend token (valid 30 days)
  4. set LIGHTNINGPROX_SPEND_TOKEN=lnpx_... in your MCP config and restart the client`;

export const toolDefinitions = [
  {
    name: "ask_ai",
    description:
      "Send a prompt or a conversation to an AI model through LightningProx (24 models: Claude, GPT, Gemini, DeepSeek, Mistral and more), paid in sats from your spend token. Returns the reply text, any tool_use blocks, the model used and your remaining balance. Without a spend token it returns a Lightning invoice (L402) for this exact request.",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description: `Model ID, e.g. ${EXAMPLE_MODEL} (cheap and fast), gpt-4o-mini, gemini-3.8-flash, deepseek-ai/DeepSeek-V4.1-Flash, mistral-small-latest. Call list_models for all IDs.`,
        },
        prompt: { type: "string", description: "A single user message. Use this or messages." },
        messages: {
          type: "array",
          description:
            'Anthropic-format conversation: [{"role":"user"|"assistant","content": string or content blocks}]. Use this or prompt.',
          items: { type: "object" },
        },
        system: { type: "string", description: "Optional system prompt." },
        max_tokens: { type: "number", description: "Maximum output tokens (default 1024, max 4096)." },
        tools: {
          type: "array",
          description:
            "Optional tool definitions in Anthropic format ({name, description, input_schema}), passed through to the model. Tool calls come back as tool_use blocks.",
          items: { type: "object" },
        },
        tool_choice: {
          type: "object",
          description: 'Optional Anthropic tool_choice, e.g. {"type":"auto"}, {"type":"any"} or {"type":"tool","name":"..."}.',
        },
        l402: {
          type: "string",
          description:
            "Optional L402 credential 'macaroon:preimage' to pay for this request without a spend token: send the same arguments that produced the invoice, plus this.",
        },
      },
      required: ["model"],
    },
  },
  {
    name: "list_models",
    description:
      "List the models LightningProx currently serves: ID, provider, whether it supports tool use, and the per-token price when available.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "check_balance",
    description: "Check the balance (sats), expiry and status of the configured spend token (LIGHTNINGPROX_SPEND_TOKEN).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_topup",
    description:
      "Create a Lightning invoice to buy a LightningProx spend token (10 to 100,000 sats). After paying it, call get_token with the returned charge_id. Tokens last 30 days.",
    inputSchema: {
      type: "object",
      properties: {
        amount_sats: { type: "number", description: "Amount in sats, 10 to 100,000." },
      },
      required: ["amount_sats"],
    },
  },
  {
    name: "get_token",
    description:
      "After paying a create_topup invoice, exchange its charge_id for the lnpx_ spend token. Safe to call again: it returns the same token.",
    inputSchema: {
      type: "object",
      properties: {
        charge_id: { type: "string", description: "The charge_id returned by create_topup." },
      },
      required: ["charge_id"],
    },
  },
];

const text = (t) => ({ content: [{ type: "text", text: t }] });
const fail = (t) => ({ content: [{ type: "text", text: t }], isError: true });

function numberOr(v, d) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : d;
}

/** The exact /v1/messages body for ask_ai args (deterministic, so an L402 retry matches). */
export function buildMessagesBody(args) {
  const body = { model: String(args.model || "").trim(), max_tokens: numberOr(args.max_tokens, 1024) };
  if (typeof args.system === "string" && args.system.trim()) body.system = args.system;
  if (Array.isArray(args.messages) && args.messages.length > 0) {
    body.messages = args.messages;
  } else if (typeof args.prompt === "string" && args.prompt.trim()) {
    body.messages = [{ role: "user", content: args.prompt }];
  }
  if (Array.isArray(args.tools) && args.tools.length > 0) body.tools = args.tools;
  if (args.tool_choice && typeof args.tool_choice === "object") body.tool_choice = args.tool_choice;
  return body;
}

/** Text + tool_use blocks from an Anthropic- or OpenAI-shaped reply. */
export function extractReply(json) {
  const out = { text: "", toolUses: [], stop: undefined };
  if (!json || typeof json !== "object") return out;
  if (Array.isArray(json.content)) {
    out.text = json.content.filter((b) => b && b.type === "text").map((b) => b.text).join("");
    out.toolUses = json.content.filter((b) => b && b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input }));
    out.stop = json.stop_reason;
  } else if (Array.isArray(json.choices) && json.choices[0]) {
    const msg = json.choices[0].message || {};
    out.text = typeof msg.content === "string" ? msg.content : "";
    out.toolUses = (msg.tool_calls || []).map((c) => {
      let input = {};
      try {
        input = JSON.parse(c.function && c.function.arguments ? c.function.arguments : "{}");
      } catch {
        input = { _raw_arguments: c.function && c.function.arguments };
      }
      return { id: c.id, name: c.function && c.function.name, input };
    });
    out.stop = json.choices[0].finish_reason;
  }
  return out;
}

function invoiceResult(res, body, haveToken) {
  const j = res.json || {};
  const lines = [
    haveToken
      ? "LightningProx asked for payment for this request."
      : "No spend token is configured, so LightningProx returned a Lightning invoice (L402) for this exact request.",
    "",
    `Amount: ${j.amount_sats ?? "?"} sats`,
    `Invoice (BOLT11): ${j.invoice}`,
  ];
  if (j.charge_id) lines.push(`Charge ID: ${j.charge_id}`);
  if (j.macaroon) lines.push(`Macaroon: ${j.macaroon}`);
  lines.push(
    "",
    "To pay for just this request: pay the invoice, then call ask_ai again with exactly the same arguments plus",
    "l402 = \"<macaroon>:<preimage>\" (the preimage comes from your wallet after payment).",
    "",
    "For repeated use, buy a spend token instead: create_topup -> pay -> get_token, then set LIGHTNINGPROX_SPEND_TOKEN.",
  );
  if (j.code === "credential_spent_rechallenged") lines.unshift("That L402 credential was already used; this is a new invoice.", "");
  return text(lines.join("\n"));
}

async function askAI(client, args) {
  const body = buildMessagesBody(args);
  if (!body.model) return fail(`model is required (e.g. ${EXAMPLE_MODEL}; list_models shows all).`);
  if (!body.messages) return fail("Provide prompt (a string) or messages (a non-empty array).");

  const headers = {};
  const l402 = typeof args.l402 === "string" ? args.l402.trim() : "";
  if (l402) headers.Authorization = "L402 " + l402.replace(/^(L402|LSAT)\s+/i, "");
  const res = await client.request("POST", "/v1/messages", { body, headers, auth: !l402 });

  if (res.status === 402 && res.json && res.json.invoice) return invoiceResult(res, body, client.hasToken);
  if (!res.ok) throw describeError(res, { token: client.token, model: body.model });

  const j = res.json || {};
  const reply = extractReply(j);
  const parts = [];
  if (reply.text) parts.push(reply.text);
  if (reply.toolUses.length) {
    parts.push(`Tool calls (${reply.toolUses.length}):\n` + JSON.stringify(reply.toolUses, null, 2));
  }
  if (!parts.length) parts.push("(The model returned no text.)");

  const meta = [];
  const served = j.model_used || j.model || body.model;
  meta.push(`model: ${served}`);
  const remapped = res.headers.get("x-model-remapped");
  if (remapped) meta.push(`remapped: ${remapped}`);
  if (reply.stop) meta.push(`stop: ${reply.stop}`);
  if (j.charged_sats !== undefined) meta.push(`charged: ${j.charged_sats} sats`);
  const balance = j.balance_remaining_sats ?? res.headers.get("x-balance-remaining");
  if (balance !== undefined && balance !== null) meta.push(`balance: ${balance} sats`);
  if (res.headers.get("x-cache") === "HIT") meta.push("cache: hit");
  let out = parts.join("\n\n") + "\n\n---\n" + meta.join(" | ");
  if (j.balance_warning) out += `\n${j.balance_warning}`;
  const notice = noticeOf(res);
  if (notice) out += `\nNotice from LightningProx: ${notice}`;
  return text(redact(out, client.token));
}

async function listModels(client) {
  const res = await client.request("GET", "/v1/models");
  if (!res.ok) throw describeError(res, { token: client.token });
  const data = (res.json && Array.isArray(res.json.data) && res.json.data) || [];
  // Pricing is not part of /v1/models; /api/capabilities has it (USD per
  // token, markup included). Best effort: models are listed without it.
  const prices = {};
  try {
    const caps = await client.request("GET", "/api/capabilities");
    const list = caps.ok && caps.json && Array.isArray(caps.json.models) ? caps.json.models : [];
    for (const m of list) {
      if (m && m.id && typeof m.input_cost_usd === "number" && typeof m.output_cost_usd === "number") {
        prices[m.id] = { in: m.input_cost_usd * 1e6, out: m.output_cost_usd * 1e6, name: m.name };
      }
    }
  } catch {
    /* pricing is optional */
  }
  const fmt = (n) => (n >= 1 ? n.toFixed(2) : n.toFixed(3));
  const lines = data.map((m) => {
    const p = prices[m.id];
    const tools = m.supports_tools === undefined ? "" : m.supports_tools ? " | tools: yes" : " | tools: no";
    const price = p ? ` | $${fmt(p.in)} in / $${fmt(p.out)} out per 1M tokens` : "";
    return `${m.id} (${m.owned_by || "?"})${tools}${price}`;
  });
  const head = `${data.length} models available on LightningProx${Object.keys(prices).length ? " (prices include LightningProx's markup; charged in sats at the live BTC rate)" : ""}:`;
  return text([head, ...lines].join("\n"));
}

async function checkBalance(client) {
  if (!client.hasToken) return fail(NO_TOKEN_HELP);
  const res = await client.request("GET", "/v1/balance", { auth: true });
  if (!res.ok) throw describeError(res, { token: client.token });
  const j = res.json || {};
  const lines = [
    `Status: ${j.status}`,
    `Balance: ${j.balance_sats} sats${typeof j.balance_usd === "number" ? ` (~$${j.balance_usd.toFixed(2)})` : ""}`,
    `Initial: ${j.initial_sats} sats`,
    `Expires: ${j.expires_at}`,
  ];
  const notice = noticeOf(res);
  if (notice) lines.push(`Notice from LightningProx: ${notice}`);
  return text(redact(lines.join("\n"), client.token));
}

async function createTopup(client, args) {
  const amount = args.amount_sats;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < TOPUP_MIN || amount > TOPUP_MAX) {
    return fail(`amount_sats must be a whole number from ${TOPUP_MIN} to ${TOPUP_MAX.toLocaleString("en-US")}.`);
  }
  const res = await client.request("POST", "/v1/topup", { body: { amount_sats: amount } });
  // Production answers 402 Payment Required with the invoice.
  const j = res.json || {};
  if ((res.status === 402 || res.ok) && j.payment_request && j.charge_id) {
    const lines = [
      `Invoice for ${j.amount_sats ?? amount} sats${typeof j.amount_usd === "number" ? ` (~$${j.amount_usd.toFixed(2)})` : ""}:`,
      "",
      j.payment_request,
      "",
      `Charge ID: ${j.charge_id}`,
      "",
      "Next: pay this invoice with any Lightning wallet, then call get_token with this charge_id to receive your lnpx_ spend token.",
      "The token is valid for 30 days from when it is issued. Set it as LIGHTNINGPROX_SPEND_TOKEN in your MCP config.",
    ];
    return text(lines.join("\n"));
  }
  throw describeError(res, { token: client.token });
}

async function getToken(client, args) {
  const chargeId = typeof args.charge_id === "string" ? args.charge_id.trim() : "";
  if (!chargeId) return fail("charge_id is required (from create_topup).");
  const res = await client.request("POST", "/v1/tokens", { body: { charge_id: chargeId } });
  const j = res.json || {};
  if (res.status === 402) {
    return fail(`The invoice for charge ${chargeId} is not paid yet (or the payment has not confirmed). Pay it, wait a few seconds, then call get_token again.`);
  }
  if (!res.ok || !j.token) throw describeError(res, {});
  // The one place the token is shown: the user needs it for their config.
  return text(
    [
      `Spend token: ${j.token}`,
      `Balance: ${j.balance_sats} sats`,
      `Expires: ${j.expires_at}`,
      "",
      "Keep it secret: anyone holding it can spend the balance.",
      "Add it to your MCP config as LIGHTNINGPROX_SPEND_TOKEN and restart the client.",
    ].join("\n"),
  );
}

const handlers = {
  ask_ai: askAI,
  list_models: listModels,
  check_balance: checkBalance,
  create_topup: createTopup,
  get_token: getToken,
};

/** Run tool name with args; errors become isError results (redacted). */
export async function callTool(client, name, args = {}) {
  const h = handlers[name];
  if (!h) return fail(`Unknown tool: ${name}`);
  try {
    return await h(client, args || {});
  } catch (err) {
    const msg = err instanceof LightningProxError ? err.message : `Unexpected error: ${err && err.message ? err.message : err}`;
    return fail(redact(msg, client.token));
  }
}

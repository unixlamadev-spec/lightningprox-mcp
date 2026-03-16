#!/usr/bin/env node
/**
 * LightningProx MCP Server
 * Pay for AI inference with Bitcoin Lightning. 19 models, 5 providers.
 * No account. No KYC. Pay in sats.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

const LIGHTNINGPROX_URL = process.env.LIGHTNINGPROX_URL || "https://lightningprox.com";

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const tools: Tool[] = [
  {
    name: "chat",
    description:
      "Send a message to an AI model via LightningProx. Pay per request with a Lightning spend token. Supports 19 models from Anthropic, OpenAI, Together.ai, Mistral, and Google.",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description:
            "Model ID (e.g. claude-opus-4-5-20251101, gpt-4-turbo, gemini-2.5-pro, mistral-large-latest, deepseek-ai/DeepSeek-V3)",
        },
        message: {
          type: "string",
          description: "The user message to send",
        },
        spend_token: {
          type: "string",
          description: "LightningProx spend token (starts with lnpx_). Get one at lightningprox.com/topup",
        },
        max_tokens: {
          type: "number",
          description: "Maximum tokens in response (default: 1024)",
        },
      },
      required: ["model", "message", "spend_token"],
    },
  },
  {
    name: "list_models",
    description:
      "List all AI models available through LightningProx. Returns model IDs, names, providers, and pricing. 19 models across Anthropic, OpenAI, Together.ai, Mistral, and Google.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_balance",
    description:
      "Check the remaining balance on a LightningProx spend token. Returns balance in sats.",
    inputSchema: {
      type: "object",
      properties: {
        spend_token: {
          type: "string",
          description: "LightningProx spend token (starts with lnpx_)",
        },
      },
      required: ["spend_token"],
    },
  },
  {
    name: "generate_invoice",
    description:
      "Generate a Bitcoin Lightning invoice to top up a LightningProx spend token. Returns a BOLT11 payment request and charge ID. Pay the invoice with any Lightning wallet.",
    inputSchema: {
      type: "object",
      properties: {
        amount_sats: {
          type: "number",
          description: "Amount in satoshis to top up (e.g. 5000, 25000, 100000)",
        },
      },
      required: ["amount_sats"],
    },
  },
  {
    name: "check_payment",
    description:
      "Check if a Lightning invoice has been paid and retrieve the spend token. Poll this after generate_invoice until the payment is confirmed.",
    inputSchema: {
      type: "object",
      properties: {
        charge_id: {
          type: "string",
          description: "Charge ID returned by generate_invoice",
        },
      },
      required: ["charge_id"],
    },
  },
];

// ============================================================================
// API HELPERS
// ============================================================================

async function chat(
  model: string,
  message: string,
  spendToken: string,
  maxTokens: number = 1024
): Promise<any> {
  const res = await fetch(`${LIGHTNINGPROX_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Spend-Token": spendToken,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: message }],
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) {
    const err = await res.json() as any;
    throw new Error(err.error || `LightningProx error: ${res.status}`);
  }
  return res.json();
}

async function listModels(): Promise<any> {
  const res = await fetch(`${LIGHTNINGPROX_URL}/api/capabilities`);
  if (!res.ok) throw new Error(`Failed to fetch models: ${res.statusText}`);
  return res.json();
}

async function getBalance(spendToken: string): Promise<any> {
  const res = await fetch(`${LIGHTNINGPROX_URL}/v1/balance`, {
    headers: { "X-Spend-Token": spendToken },
  });
  if (!res.ok) {
    const err = await res.json() as any;
    throw new Error(err.error || `Balance check failed: ${res.status}`);
  }
  return res.json();
}

async function generateInvoice(amountSats: number): Promise<any> {
  const res = await fetch(`${LIGHTNINGPROX_URL}/v1/topup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount_sats: amountSats, duration_hours: 720 }),
  });
  // 402 is expected — it IS the invoice response
  const data = await res.json() as any;
  if (!data.payment_request && !data.charge_id) {
    throw new Error(data.error || `Invoice generation failed: ${res.status}`);
  }
  return data;
}

async function checkPayment(chargeId: string): Promise<any> {
  const res = await fetch(`${LIGHTNINGPROX_URL}/v1/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ charge_id: chargeId, duration_hours: 720 }),
  });
  const data = await res.json() as any;
  return data;
}

// ============================================================================
// MCP SERVER
// ============================================================================

const server = new Server(
  { name: "lightningprox", version: "1.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "chat": {
        const { model, message, spend_token, max_tokens } = args as any;
        const result = await chat(model, message, spend_token, max_tokens);

        const content =
          result.content?.[0]?.text ||
          result.choices?.[0]?.message?.content ||
          JSON.stringify(result);

        const usage = result.usage
          ? `\n\n— ${result.usage.input_tokens ?? result.usage.prompt_tokens ?? "?"} in / ${result.usage.output_tokens ?? result.usage.completion_tokens ?? "?"} out`
          : "";

        return {
          content: [{ type: "text", text: content + usage }],
        };
      }

      case "list_models": {
        const data = await listModels();
        const models: any[] = data.models || data || [];

        if (!models.length) {
          return {
            content: [{ type: "text", text: "No models returned from API." }],
          };
        }

        // Group by provider
        const byProvider: Record<string, any[]> = {};
        for (const m of models) {
          const p = m.provider || "Unknown";
          if (!byProvider[p]) byProvider[p] = [];
          byProvider[p].push(m);
        }

        const lines: string[] = [
          `⚡ LightningProx — ${models.length} models available`,
          ``,
        ];
        for (const [provider, pModels] of Object.entries(byProvider)) {
          lines.push(`── ${provider} ──`);
          for (const m of pModels) {
            lines.push(`  ${m.id || m.name}  ${m.price_per_1k_tokens ? `$${m.price_per_1k_tokens}/1k tokens` : ""}`);
          }
          lines.push(``);
        }
        lines.push(`Get a spend token: ${LIGHTNINGPROX_URL}/topup`);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }

      case "get_balance": {
        const { spend_token } = args as any;
        const data = await getBalance(spend_token);

        const sats = data.balance_sats ?? data.sats ?? data.balance ?? "?";
        const usd = data.balance_usd != null ? ` (~$${Number(data.balance_usd).toFixed(4)})` : "";

        return {
          content: [
            {
              type: "text",
              text: `⚡ Balance: ${sats} sats${usd}\n\nToken: ${spend_token.slice(0, 16)}…\nTop up: ${LIGHTNINGPROX_URL}/topup`,
            },
          ],
        };
      }

      case "generate_invoice": {
        const { amount_sats } = args as any;
        const data = await generateInvoice(amount_sats);

        return {
          content: [
            {
              type: "text",
              text: [
                `⚡ Lightning Invoice Generated`,
                ``,
                `Amount: ${data.amount_sats || amount_sats} sats (~$${data.amount_usd || "?"})`,
                ``,
                `Invoice (BOLT11):`,
                data.payment_request,
                ``,
                `Charge ID: ${data.charge_id}`,
                ``,
                `Pay with any Lightning wallet, then use check_payment with the charge_id to get your spend token.`,
                ``,
                `Or pay at: ${LIGHTNINGPROX_URL}/topup`,
              ].join("\n"),
            },
          ],
        };
      }

      case "check_payment": {
        const { charge_id } = args as any;
        const data = await checkPayment(charge_id);

        if (data.spend_token) {
          return {
            content: [
              {
                type: "text",
                text: [
                  `✅ Payment confirmed!`,
                  ``,
                  `Your spend token:`,
                  data.spend_token,
                  ``,
                  `Expires: ${data.expires_at || "30 days"}`,
                  ``,
                  `Use this token in the spend_token field of the chat tool.`,
                ].join("\n"),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `⏳ Payment not yet confirmed for charge: ${charge_id}\n\nTry again in a few seconds after paying the Lightning invoice.`,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `❌ Error: ${error.message}` }],
      isError: true,
    };
  }
});

// ============================================================================
// START
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`✅ LightningProx MCP Server running | ${LIGHTNINGPROX_URL}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

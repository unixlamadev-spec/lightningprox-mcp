# lightningprox-mcp

<a href="https://glama.ai/mcp/servers/unixlamadev-spec/lightningprox-mcp">
<img width="380" height="200" src="https://glama.ai/mcp/servers/unixlamadev-spec/lightningprox-mcp/badge" />
</a>

MCP server for [LightningProx](https://lightningprox.com). It gives Claude Desktop, Cursor, Claude Code and other MCP clients pay-per-request AI paid in Bitcoin Lightning. No account and no provider API keys: you load a prepaid spend token, and each request is deducted from its balance in sats.

- 24 models across 5 providers: Anthropic (Claude 5.5 and 4.x), OpenAI (GPT-6, GPT-4.1, GPT-4o), Google (Gemini 4 Argon, 3.8 Flash, 2.5), Together.ai (DeepSeek V4, gpt-oss-120b, GLM 5.3, MiniMax M3.1) and Mistral. The live list comes from the `list_models` tool.
- Tool / function calling passthrough, for every model except `gpt-6-astra`.
- Failed or empty calls are never charged. Requests are priced from the actual prompt size. Top-ups last 30 days.
- Pure Node.js (18 or newer), with no native binaries. It runs on Linux, macOS and Windows.

## Setup

You need Node.js 18 or newer. `npx` downloads and runs the server.

### Claude Desktop

Edit `claude_desktop_config.json`:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "lightningprox": {
      "command": "npx",
      "args": ["-y", "lightningprox-mcp"],
      "env": {
        "LIGHTNINGPROX_SPEND_TOKEN": "lnpx_your_token_here"
      }
    }
  }
}
```

Restart Claude Desktop afterwards.

### Cursor

Add the same block to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project):

```json
{
  "mcpServers": {
    "lightningprox": {
      "command": "npx",
      "args": ["-y", "lightningprox-mcp"],
      "env": { "LIGHTNINGPROX_SPEND_TOKEN": "lnpx_your_token_here" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add lightningprox -e LIGHTNINGPROX_SPEND_TOKEN=lnpx_your_token_here -- npx -y lightningprox-mcp
```

The token is optional. Without one, `ask_ai` returns a Lightning invoice for each request, and `create_topup` / `get_token` let you buy a token from inside the chat.

## Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `LIGHTNINGPROX_SPEND_TOKEN` | no | none | Your `lnpx_...` spend token, sent as `X-Spend-Token`. The server never prints it. |
| `LIGHTNINGPROX_URL` | no | `https://lightningprox.com` | API base URL |

## Tools

| Tool | What it does |
|------|--------------|
| `ask_ai` | Sends `prompt` (or an Anthropic-format `messages` array) to `model`, with optional `system`, `max_tokens` (default 1024), `tools` and `tool_choice`. Calls `POST /v1/messages` and returns the reply text, any `tool_use` blocks, the model used, `X-Model-Remapped` when a retired ID was mapped, and your remaining balance. Without a token, it returns the request's invoice (amount, BOLT11 and macaroon). Pay it, then call again with the same arguments plus `l402: "<macaroon>:<preimage>"`. |
| `list_models` | Lists the served models: ID, provider and tool support (`GET /v1/models`), plus per-token prices from `/api/capabilities`. |
| `check_balance` | Shows the configured token's balance, expiry and status (`GET /v1/balance`). |
| `create_topup` | Creates a Lightning invoice for 10 to 100,000 sats (`POST /v1/topup`) and returns the BOLT11 invoice and its `charge_id`. |
| `get_token` | After you pay, exchanges the `charge_id` for your `lnpx_` spend token (`POST /v1/tokens`). It is safe to repeat and returns the same token. Tokens last 30 days. |

Example: ask Claude "Use ask_ai with model claude-haiku-5-5 to summarize this paragraph", or "list the LightningProx models that support tools".

### Buying a spend token without leaving the chat

1. `create_topup` with `amount_sats: 1000` returns an invoice and a `charge_id`.
2. Pay the invoice with any Lightning wallet.
3. `get_token` with that `charge_id` returns `lnpx_...`. Put it in your config as `LIGHTNINGPROX_SPEND_TOKEN` and restart the client.

You can also buy one in the browser at [lightningprox.com/topup](https://lightningprox.com/topup).

### Errors

Errors come back as plain messages that say what to do next:
- **Unknown or retired model:** the message points you to `list_models` or to the replacement model.
- **Prompt too long** (`context_length_exceeded`) or **model without tool support** (`tools_not_supported`).
- **Balance too low:** the message tells you how to top up.
- **Rate limits:** the message includes the retry time.
- **Provider outages** (`provider_unavailable`): these are never charged.

Nothing is charged when a request is rejected.

## Development

```bash
npm install
npm test               # unit tests with a mocked HTTP layer
npm run smoke          # live checks against lightningprox.com, free endpoints only
node bin/lightningprox-mcp.js   # run the server on stdio
```

## Links

- Gateway: [lightningprox.com](https://lightningprox.com)
- API docs: [lightningprox.com/docs](https://lightningprox.com/docs)
- AIProx agent registry: [aiprox.dev](https://aiprox.dev)

Built by [LPX Digital Group LLC](https://lpxdigital.com). MIT licensed.

# lightningprox-mcp

<a href="https://glama.ai/mcp/servers/unixlamadev-spec/lightningprox-mcp">
<img width="380" height="200" src="https://glama.ai/mcp/servers/unixlamadev-spec/lightningprox-mcp/badge" />
</a>

MCP server for [LightningProx](https://lightningprox.com) — pay-per-request AI via Bitcoin Lightning. No accounts, no API keys. Load a spend token, start querying.

## Install

```bash
npx lightningprox-mcp
```

## What LightningProx Is

LightningProx is an AI gateway that accepts Bitcoin Lightning payments instead of API keys. You load a prepaid spend token, pass it in the `X-Spend-Token` header, and each request is deducted from your balance in sats. No signup, no monthly plan, no credentials to manage.

**19 models across 5 providers:**

| Provider | Models |
|----------|--------|
| Anthropic | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 |
| OpenAI | gpt-4o, gpt-4-turbo, gpt-4o-mini |
| Together.ai | llama-4-maverick, llama-3.3-70b, deepseek-v3, mixtral-8x7b |
| Mistral | mistral-large-latest, mistral-medium, mistral-small, codestral, devstral, magistral |
| Google | gemini-2.5-flash, gemini-2.5-pro |

**Vision / multimodal:** Pass `image_url` directly in your request. URL mode only — no base64 encoding required.

## Setup

### Claude Desktop

```json
{
  "mcpServers": {
    "lightningprox": {
      "command": "npx",
      "args": ["lightningprox-mcp"]
    }
  }
}
```

**Config location:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/claude/claude_desktop_config.json`

### Claude Code

```bash
claude mcp add lightningprox -- npx lightningprox-mcp
```

## Tools

| Tool | Description |
|------|-------------|
| `ask_ai` | Send a prompt to any model, authenticated via spend token. Pass `model` to select (e.g. `gemini-2.5-flash`, `mistral-large-latest`, `claude-sonnet-4-6`). |
| `ask_ai_vision` | Send a prompt with an image URL for multimodal analysis |
| `check_balance` | Check remaining sats on a spend token |
| `list_models` | List available models with per-call pricing |
| `get_pricing` | Estimate cost in sats for a given model and token count |
| `get_invoice` | Generate a Lightning invoice to top up a spend token |

## Spend Token Auth

Every request authenticates via the `X-Spend-Token` header:

```bash
curl -X POST https://lightningprox.com/v1/chat \
  -H "Content-Type: application/json" \
  -H "X-Spend-Token: lnpx_your_token_here" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "What is the Lightning Network?"}]
  }'
```

For vision requests, include `image_url` in the message content — no base64 needed:

```bash
curl -X POST https://lightningprox.com/v1/chat \
  -H "Content-Type: application/json" \
  -H "X-Spend-Token: lnpx_your_token_here" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "image_url", "image_url": {"url": "https://example.com/chart.png"}},
        {"type": "text", "text": "Describe this chart"}
      ]
    }]
  }'
```

## Getting a Spend Token

1. Call `get_invoice` (or `ask_ai` without a token) to receive a Lightning invoice
2. Pay the invoice from any Lightning wallet
3. Your spend token is returned — use it for all subsequent requests until balance runs out

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat` | Chat completions — OpenAI-compatible format |
| `POST /v1/messages` | Anthropic messages format |
| `GET /v1/models` | List available models with pricing |
| `GET /v1/balance` | Check spend token balance |
| `POST /v1/invoice` | Generate Lightning invoice |

## Links

- Gateway: [lightningprox.com](https://lightningprox.com)
- Docs: [lightningprox.com/docs](https://lightningprox.com/docs)
- AIProx agent registry: [aiprox.dev](https://aiprox.dev)

Built by [LPX Digital Group LLC](https://lpxdigital.com)

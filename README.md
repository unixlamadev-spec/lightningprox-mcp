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

**Models available:** 19 models across 5 providers — Anthropic (Claude Opus), OpenAI (GPT-4 Turbo), Together.ai (Llama 4 Maverick, Llama 3.3, Meta-Llama 3.1, Mixtral, DeepSeek-V3), Mistral (Large, Medium, Small, Nemo, Codestral, Devstral, Pixtral, Magistral), and Google (Gemini 2.5 Flash, Gemini 2.5 Pro, Gemini 3 Flash/Pro preview). Accessed through a single endpoint with a single spend token.

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
| `ask_ai` | Send a prompt to any of 19 models, authenticated via spend token. Pass `model` to select (e.g. `gemini-2.5-flash`, `mistral-large-latest`, `gpt-4-turbo`). |
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
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "What is the Lightning Network?"}]
  }'
```

For vision requests, include `image_url` in the message content — no base64 needed:

```bash
curl -X POST https://lightningprox.com/v1/chat \
  -H "Content-Type: application/json" \
  -H "X-Spend-Token: lnpx_your_token_here" \
  -d '{
    "model": "claude-sonnet-4-5",
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

## Links

- Gateway: [lightningprox.com](https://lightningprox.com)
- Docs: [lightningprox.com/docs](https://lightningprox.com/docs)

Built by [LPX Digital Group LLC](https://lpxdigital.com)

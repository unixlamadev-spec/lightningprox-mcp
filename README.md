# LightningProx MCP Server ⚡

MCP server that gives AI agents access to AI models via Lightning Network micropayments. No accounts, no API keys — payment IS authentication.

## What This Does

This MCP server connects Claude Desktop, Claude Code, Cursor, or any MCP-compatible client to [LightningProx](https://lightningprox.com), letting your AI agent:

- **Query AI models** (Claude, GPT-4) and pay per request via Lightning
- **Use prepaid spend tokens** for frictionless multi-request sessions
- **Check balances** on spend tokens
- **List available models** with pricing
- **Estimate costs** before committing

## Quick Start

### Install

```bash
go install github.com/lightningprox/lightningprox-mcp/cmd/mcp-server@latest
```

### Configure Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lightningprox": {
      "command": "mcp-server",
      "args": []
    }
  }
}
```

Config file locations:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

### Configure Claude Code

```bash
claude mcp add lightningprox mcp-server
```

## Tools

### `ask_ai`
Send a prompt to an AI model. If no payment is provided, returns a Lightning invoice.

**With spend token (instant):**
```
Model: claude-sonnet-4-20250514
Prompt: "Explain quantum computing"
SpendToken: "lnpx_abc123..."
```

**With payment hash (after paying invoice):**
```
Model: claude-sonnet-4-20250514
Prompt: "Explain quantum computing"
PaymentHash: "charge_id_from_invoice"
```

### `get_invoice`
Pre-generate a Lightning invoice without executing the request. Useful for confirming cost.

### `check_balance`
Check remaining balance on a prepaid spend token.

### `list_models`
List all available models with pricing.

### `get_pricing`
Estimate cost in sats and USD for a specific model + token count.

## Payment Flow

### Option A: Prepaid Spend Token (Recommended)
1. Generate an invoice via `get_invoice` or `ask_ai`
2. Pay the Lightning invoice
3. Create a spend token: `POST https://lightningprox.com/v1/tokens` with `{"charge_id": "...", "duration_hours": 72}`
4. Use the token for multiple requests until balance runs out

### Option B: Pay Per Request
1. Call `ask_ai` without payment → get Lightning invoice
2. Pay the invoice
3. Call `ask_ai` again with `payment_hash` set to the `charge_id`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LIGHTNINGPROX_URL` | `https://lightningprox.com` | LightningProx API URL |
| `BTC_PRICE_USD` | `100000` | BTC price for sats conversion |

## How It Compares

| Feature | LightningProx MCP | Lightning Enable |
|---------|-------------------|------------------|
| Price | **Free** (pay per AI request) | $199-299/mo |
| Auth | None — payment IS auth | Account required |
| Privacy | Fully anonymous | Registration required |
| AI Models | **Included** | Bring your own keys |
| Setup | `go install` (single binary) | `dotnet tool install` |

## Build From Source

```bash
git clone https://github.com/lightningprox/lightningprox-mcp.git
cd lightningprox-mcp
make build
```

## Links

- [LightningProx](https://lightningprox.com) — the AI gateway
- [Documentation](https://lightningprox.com/docs)
- [API Capabilities](https://lightningprox.com/api/capabilities)
- [Twitter/X](https://x.com/LightProx65673)

## License

MIT

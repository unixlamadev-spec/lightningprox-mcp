// LightningProx MCP server over stdio. Configuration comes from the
// environment: LIGHTNINGPROX_SPEND_TOKEN (optional) and LIGHTNINGPROX_URL.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createClient, DEFAULT_URL } from "./client.js";
import { callTool, toolDefinitions } from "./tools.js";

export const VERSION = "1.3.0";

export function createServer({ env = process.env, fetchImpl } = {}) {
  const token = (env.LIGHTNINGPROX_SPEND_TOKEN || "").trim() || undefined;
  const client = createClient({ baseUrl: env.LIGHTNINGPROX_URL || DEFAULT_URL, token, fetchImpl });
  const server = new Server({ name: "lightningprox-mcp", version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    callTool(client, req.params.name, req.params.arguments || {}),
  );
  return { server, client };
}

export async function main() {
  const { server, client } = createServer();
  await server.connect(new StdioServerTransport());
  // stdout carries the MCP protocol; diagnostics go to stderr. Never log the token.
  console.error(
    `lightningprox-mcp ${VERSION} ready on stdio (${client.base}; spend token ${client.hasToken ? "configured" : "not set"})`,
  );
}

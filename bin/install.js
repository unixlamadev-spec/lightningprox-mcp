#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const platform = os.platform();
const arch = os.arch();

const binaries = {
  'linux-x64': 'mcp-server-linux-amd64',
  'linux-arm64': 'mcp-server-linux-arm64',
  'darwin-x64': 'mcp-server-darwin-amd64',
  'darwin-arm64': 'mcp-server-darwin-arm64',
  'win32-x64': 'mcp-server-windows-amd64.exe',
};

const key = `${platform}-${arch}`;
const binary = binaries[key];

if (!binary) {
  console.error(`Unsupported platform: ${key}`);
  process.exit(1);
}

const src = path.join(__dirname, '..', binary);
const dest = path.join(__dirname, 'lightningprox-mcp');

if (fs.existsSync(src)) {
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, '755');
  console.log(`✅ LightningProx MCP installed for ${key}`);
} else {
  console.error(`Binary not found: ${src}`);
  process.exit(1);
}

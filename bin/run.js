#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const isWin = os.platform() === 'win32';
const binary = path.join(__dirname, isWin ? 'lightningprox-mcp.exe' : 'lightningprox-mcp');

const child = spawn(binary, process.argv.slice(2), {
  stdio: 'inherit',
  env: process.env
});

child.on('exit', (code) => process.exit(code || 0));

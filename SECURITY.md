# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest  | ✅ |

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Contact: unixlamadev@gmail.com

Include in your report:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and aim to release a fix within 14 days of confirmed vulnerabilities.

## Scope

This MCP server makes network requests to `lightningprox.com`. It reads the `LIGHTNINGPROX_SPEND_TOKEN` environment variable for authentication. No other credentials or local files are accessed.

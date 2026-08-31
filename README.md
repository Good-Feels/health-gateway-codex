# Health Gateway for Codex

The official Health Gateway plugin connects Codex to the Apple Health data you
choose to sync in the Health Gateway iPhone app.

- Read-only access to your synced account
- Sign in with Apple and renewable OAuth tokens
- Fully branded local connection and recovery pages
- No local storage of Health data
- No third-party runtime dependencies

## Install

Install the marketplace and plugin from a terminal:

```sh
codex plugin marketplace add Good-Feels/health-gateway-codex
codex plugin add health-gateway@health-gateway
```

Restart Codex, begin a new chat, and ask Codex to use Health Gateway. Your
browser will open the secure Health Gateway connection flow.

## Versioned package

Every published version is also available as a downloadable package on the
[Releases page](https://github.com/Good-Feels/health-gateway-codex/releases).
The marketplace install above is recommended because Codex can manage the
plugin directly; the package is useful for review, archiving, and manual
installation.

The iPhone app and connection guide are at
[healthgateway.app](https://healthgateway.app/setup).

## Privacy and security

The plugin stores only OAuth client metadata and renewable connection tokens in
an owner-only configuration file. It sends MCP requests directly to
`https://api.healthgateway.app/mcp` and never stores raw Apple Health samples on
the computer.

[Privacy](https://healthgateway.app/privacy) ·
[Terms](https://healthgateway.app/terms) ·
[Support](https://healthgateway.app/support)

Copyright © 2026 Good Feels, Inc. All rights reserved. This repository is
published for installation and security review; it is not an open-source
license grant.

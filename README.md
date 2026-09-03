# Health Gateway for Codex

The official Health Gateway plugin connects Codex to the Apple Health data you
choose to sync in the Health Gateway iPhone app.

- Read-only access to your synced account
- Sign in with Apple and renewable OAuth tokens
- Fully branded local connection and recovery pages
- Built-in guidance for complete, freshness-aware health summaries
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

## Health insights skill

The plugin includes a `health-insights` skill that teaches Codex to check sync
freshness, use complete local date windows, deduplicate sleep records, avoid
unnecessary raw-sample queries, distinguish missing data from zero, and keep
personal health interpretations non-diagnostic.

## Privacy and security

The plugin stores only OAuth client metadata and renewable connection tokens in
an owner-only configuration file. It sends MCP requests directly to
`https://api.healthgateway.app/mcp` and never stores raw Apple Health samples on
the computer.

[Privacy](https://healthgateway.app/privacy) ·
[Terms](https://healthgateway.app/terms) ·
[Support](https://healthgateway.app/support)

## License and trademarks

The plugin source is licensed under the Apache License, Version 2.0. The
Health Gateway service, iPhone app, backend, and customer data are not included
in this repository. Health Gateway, Good Feels, and their logos remain the
trademarks and product branding of Good Feels, Inc.; the Apache license does
not grant permission to use those marks beyond describing the source of the
licensed plugin.

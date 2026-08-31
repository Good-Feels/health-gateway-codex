#!/usr/bin/env node

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile
} from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

export const HEALTH_GATEWAY_ENDPOINT = 'https://api.healthgateway.app/mcp';
export const HEALTH_GATEWAY_ORIGIN = 'https://api.healthgateway.app';
const OAUTH_SCOPE = 'health.read';
const AUTH_TIMEOUT_MS = 30 * 60 * 1000;
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;
const BRIDGE_VERSION = '1.0.0';
const currentDirectory = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(currentDirectory, '..');

export function defaultCredentialPath(environment = process.env) {
  if (environment.HEALTH_GATEWAY_CONFIG_DIR) {
    return join(environment.HEALTH_GATEWAY_CONFIG_DIR, 'codex-oauth.json');
  }
  if (platform() === 'win32') {
    return join(environment.APPDATA ?? homedir(), 'Health Gateway', 'codex-oauth.json');
  }
  return join(environment.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'health-gateway', 'codex-oauth.json');
}

export async function readCredentials(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
      return {};
    }
    throw error;
  }
}

export async function writeCredentials(path, credentials) {
  const directory = dirname(path);
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
  try {
    await writeFile(temporaryPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600).catch(() => {});
    await rename(temporaryPath, path);
    await chmod(path, 0o600).catch(() => {});
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function createPkce() {
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function friendlyError(message, options = {}) {
  const error = new Error(message);
  Object.assign(error, options);
  return error;
}

async function readJsonResponse(response, action) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw friendlyError(`Health Gateway could not ${action}. Please try again.`, {
      oauthCode: response.ok ? null : 'invalid_response'
    });
  }
  if (!response.ok) {
    throw friendlyError(`Health Gateway could not ${action}. Please try again.`, {
      oauthCode: typeof body?.error === 'string' ? body.error : 'request_failed',
      statusCode: response.status
    });
  }
  return body;
}

export function renderBrandedStatusPage({
  kind,
  title,
  lead,
  detail,
  actionLabel = 'View connection guide',
  actionUrl = 'https://healthgateway.app/setup',
  autoClose = false
}) {
  const success = kind === 'success';
  const symbol = success ? '✓' : '!';
  const eyebrow = success ? 'Securely connected' : 'Connection needs attention';
  const safeTitle = escapeHtml(title);
  const safeLead = escapeHtml(lead);
  const safeDetail = escapeHtml(detail);
  const safeActionLabel = escapeHtml(actionLabel);
  const safeActionUrl = escapeHtml(actionUrl);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${safeTitle} — Health Gateway</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --ink:#17201d; --muted:#60716b; --line:#dde7e2; --surface:rgba(255,255,255,.95); --soft:#f1f7f4; --status:${success ? '#17664f' : '#a13d17'}; --status-soft:${success ? '#dff3ec' : '#fff0e7'}; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px; color:var(--ink); background:radial-gradient(circle at 14% 12%,rgba(220,64,122,.12),transparent 31rem),radial-gradient(circle at 88% 88%,rgba(49,153,121,.13),transparent 34rem),#f6f8f7; }
    main { width:min(100%,590px); padding:clamp(28px,6vw,48px); border:1px solid rgba(215,225,220,.92); border-radius:28px; background:var(--surface); box-shadow:0 28px 90px rgba(37,62,53,.13),0 2px 10px rgba(37,62,53,.04); backdrop-filter:blur(16px); }
    .brand { display:flex; align-items:center; gap:11px; font-size:16px; font-weight:730; letter-spacing:-.01em; }
    .brand img { width:39px; height:39px; border-radius:10px; object-fit:cover; box-shadow:0 9px 22px rgba(14,27,58,.22); }
    .status { width:66px; height:66px; margin-top:42px; display:grid; place-items:center; border-radius:50%; color:var(--status); background:var(--status-soft); box-shadow:0 0 0 10px color-mix(in srgb,var(--status-soft) 55%,transparent); font-size:32px; font-weight:760; }
    .eyebrow { margin:30px 0 10px; color:var(--status); font-size:12px; font-weight:760; letter-spacing:.1em; text-transform:uppercase; }
    h1 { margin:0; max-width:500px; font-size:clamp(35px,8vw,50px); line-height:1.02; letter-spacing:-.05em; }
    .lead { margin:17px 0 0; color:var(--muted); font-size:17px; line-height:1.58; }
    .detail { margin-top:28px; padding:18px 20px; border:1px solid var(--line); border-radius:17px; background:var(--soft); color:var(--muted); font-size:14px; line-height:1.55; }
    a { margin-top:22px; display:inline-flex; min-height:48px; align-items:center; padding:12px 18px; border-radius:999px; color:#fff; background:var(--ink); font-size:13px; font-weight:720; text-decoration:none; }
    @media(max-width:520px){body{padding:14px}main{border-radius:23px}.status{margin-top:34px}}
    @media(prefers-color-scheme:dark){:root{--ink:#f2f7f5;--muted:#aabbb5;--line:#31433d;--surface:rgba(23,32,29,.96);--soft:#20302b;--status:${success ? '#8ce0c4' : '#ffb58e'};--status-soft:${success ? '#173d32' : '#4a2819'}}body{background:radial-gradient(circle at 14% 12%,rgba(213,54,112,.16),transparent 31rem),radial-gradient(circle at 88% 88%,rgba(49,153,121,.14),transparent 34rem),#0f1513}main{border-color:#2c3d37;box-shadow:0 28px 90px rgba(0,0,0,.26)}a{color:#15201c;background:#8ce0c4}}
  </style>
</head>
<body data-health-gateway-status="${success ? 'connected' : 'error'}">
  <main>
    <div class="brand"><img src="/app-icon.png" alt="" width="39" height="39"><span>Health Gateway</span></div>
    <div class="status" aria-hidden="true">${symbol}</div>
    <p class="eyebrow">${eyebrow}</p>
    <h1>${safeTitle}</h1>
    <p class="lead">${safeLead}</p>
    <p class="detail">${safeDetail}</p>
    <a href="${safeActionUrl}" rel="noreferrer">${safeActionLabel}&nbsp; →</a>
  </main>
  ${autoClose ? '<script>window.setTimeout(() => window.close(), 1200);</script>' : ''}
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function browserCommand(url) {
  if (platform() === 'darwin') return { command: 'open', args: [url] };
  if (platform() === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: [url] };
}

export async function openBrowser(url) {
  const { command, args } = browserCommand(url);
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export class HealthGatewayOAuth {
  constructor({
    fetchImpl = globalThis.fetch,
    credentialPath = defaultCredentialPath(),
    launchBrowser = openBrowser,
    iconPath = join(pluginRoot, 'assets', 'app-icon.png'),
    origin = HEALTH_GATEWAY_ORIGIN,
    resource = HEALTH_GATEWAY_ENDPOINT,
    clientName = 'Health Gateway for Codex',
    now = () => Date.now()
  } = {}) {
    this.fetch = fetchImpl;
    this.credentialPath = credentialPath;
    this.launchBrowser = launchBrowser;
    this.iconPath = iconPath;
    this.origin = origin;
    this.resource = resource;
    this.clientName = clientName;
    this.now = now;
    this.authorizationPromise = null;
  }

  async accessToken({ forceRefresh = false } = {}) {
    const credentials = await readCredentials(this.credentialPath);
    if (!forceRefresh && credentials.accessToken && credentials.expiresAt > this.now() + TOKEN_EXPIRY_SKEW_MS) {
      return credentials.accessToken;
    }
    if (credentials.refreshToken && credentials.clientId) {
      try {
        const refreshed = await this.exchangeRefreshToken(credentials);
        await writeCredentials(this.credentialPath, refreshed);
        return refreshed.accessToken;
      } catch (error) {
        if (error.oauthCode !== 'invalid_grant' && error.oauthCode !== 'invalid_client') {
          throw error;
        }
      }
    }
    if (!this.authorizationPromise) {
      this.authorizationPromise = this.authorize().finally(() => {
        this.authorizationPromise = null;
      });
    }
    const authorized = await this.authorizationPromise;
    return authorized.accessToken;
  }

  async exchangeRefreshToken(credentials) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      client_id: credentials.clientId,
      scope: OAUTH_SCOPE,
      resource: this.resource
    });
    const response = await this.fetch(`${this.origin}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body
    });
    const token = await readJsonResponse(response, 'refresh your secure connection');
    return this.normalizedCredentials(token, {
      clientId: credentials.clientId,
      redirectUri: credentials.redirectUri,
      refreshToken: credentials.refreshToken
    });
  }

  async authorize() {
    const icon = await readFile(this.iconPath).catch(() => null);
    const state = base64Url(randomBytes(32));
    const pkce = createPkce();
    let settle;
    const completion = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    let completed = false;
    let clientId;
    let redirectUri;

    const server = createServer(async (request, response) => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && requestUrl.pathname === '/app-icon.png' && icon) {
        response.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        });
        response.end(icon);
        return;
      }
      if (request.method !== 'GET' || requestUrl.pathname !== '/oauth/callback') {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }
      if (completed) {
        this.sendStatus(response, 409, renderBrandedStatusPage({
          kind: 'error',
          title: 'This connection link was already used.',
          lead: 'Return to your AI assistant to continue.',
          detail: 'If the connection did not finish, start Connect again to open a fresh, one-time sign-in link.'
        }));
        return;
      }
      completed = true;
      const oauthError = requestUrl.searchParams.get('error');
      if (oauthError) {
        const denied = oauthError === 'access_denied';
        const error = friendlyError(denied
          ? 'Health Gateway connection was cancelled.'
          : 'Health Gateway could not complete the secure connection.');
        this.sendStatus(response, 400, renderBrandedStatusPage({
          kind: 'error',
          title: denied ? 'Connection cancelled' : 'Connection wasn’t completed',
          lead: denied ? 'No health data was shared.' : 'Your health data remains private and no connection was created.',
          detail: 'Return to your AI assistant and choose Connect again when you are ready.'
        }));
        settle.reject(error);
        server.close();
        return;
      }
      if (requestUrl.searchParams.get('state') !== state) {
        this.sendStatus(response, 400, renderBrandedStatusPage({
          kind: 'error',
          title: 'This connection link is not valid.',
          lead: 'Health Gateway stopped the sign-in to protect your account.',
          detail: 'Return to your AI assistant and choose Connect again to create a fresh secure link.'
        }));
        settle.reject(friendlyError('Health Gateway rejected an invalid connection state.'));
        server.close();
        return;
      }
      const code = requestUrl.searchParams.get('code');
      if (!code) {
        this.sendStatus(response, 400, renderBrandedStatusPage({
          kind: 'error',
          title: 'The connection code is missing.',
          lead: 'Your health data remains private and no connection was created.',
          detail: 'Return to your AI assistant and choose Connect again to restart the secure sign-in.'
        }));
        settle.reject(friendlyError('Health Gateway did not receive a connection code.'));
        server.close();
        return;
      }
      try {
        const credentials = await this.exchangeAuthorizationCode({ code, clientId, redirectUri, verifier: pkce.verifier });
        await writeCredentials(this.credentialPath, credentials);
        this.sendStatus(response, 200, renderBrandedStatusPage({
          kind: 'success',
          title: 'Health Gateway is connected',
          lead: 'Your AI assistant can now securely read the Apple Health data you chose to sync.',
          detail: 'Return to your AI assistant and try asking: “How many steps have I taken today?”',
          actionLabel: 'Explore prompt ideas',
          actionUrl: 'https://healthgateway.app/prompts',
          autoClose: true
        }));
        settle.resolve(credentials);
      } catch (error) {
        this.sendStatus(response, 502, renderBrandedStatusPage({
          kind: 'error',
          title: 'We couldn’t finish connecting.',
          lead: 'Your health data remains private and no connection was created.',
          detail: 'Return to your AI assistant and choose Connect again. If this repeats, visit the connection guide for help.'
        }));
        settle.reject(error);
      } finally {
        server.close();
      }
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;

    try {
      clientId = await this.registerClient(redirectUri);
      const authorizationUrl = new URL(`${this.origin}/oauth/authorize`);
      authorizationUrl.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: OAUTH_SCOPE,
        state,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        resource: this.resource
      }).toString();
      await this.launchBrowser(authorizationUrl.toString());
    } catch (error) {
      completed = true;
      server.close();
      throw friendlyError('Health Gateway could not open the secure sign-in. Visit https://healthgateway.app/setup for help.', {
        cause: error
      });
    }

    const timeout = setTimeout(() => {
      if (!completed) {
        completed = true;
        server.close();
        settle.reject(friendlyError('Health Gateway sign-in timed out. Choose Connect again to restart.'));
      }
    }, AUTH_TIMEOUT_MS);
    timeout.unref?.();
    try {
      return await completion;
    } finally {
      clearTimeout(timeout);
    }
  }

  sendStatus(response, statusCode, html) {
    response.writeHead(statusCode, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      pragma: 'no-cache',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    });
    response.end(html);
  }

  async registerClient(redirectUri) {
    const response = await this.fetch(`${this.origin}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: this.clientName,
        client_uri: 'https://healthgateway.app',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: OAUTH_SCOPE
      })
    });
    const client = await readJsonResponse(response, 'start the secure connection');
    if (typeof client.client_id !== 'string' || !client.client_id) {
      throw friendlyError('Health Gateway returned an invalid connection registration.');
    }
    return client.client_id;
  }

  async exchangeAuthorizationCode({ code, clientId, redirectUri, verifier }) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: this.resource
    });
    const response = await this.fetch(`${this.origin}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body
    });
    const token = await readJsonResponse(response, 'finish the secure connection');
    return this.normalizedCredentials(token, { clientId, redirectUri });
  }

  normalizedCredentials(token, previous) {
    if (typeof token.access_token !== 'string' || !token.access_token) {
      throw friendlyError('Health Gateway did not return a usable access token.');
    }
    const expiresIn = Number.isFinite(Number(token.expires_in)) ? Math.max(60, Number(token.expires_in)) : 3600;
    return {
      version: 1,
      clientId: previous.clientId,
      redirectUri: previous.redirectUri,
      accessToken: token.access_token,
      refreshToken: typeof token.refresh_token === 'string' && token.refresh_token
        ? token.refresh_token
        : previous.refreshToken,
      scope: typeof token.scope === 'string' ? token.scope : OAUTH_SCOPE,
      expiresAt: this.now() + expiresIn * 1000,
      savedAt: new Date(this.now()).toISOString()
    };
  }
}

export class HealthGatewayBridge {
  constructor({
    endpoint = HEALTH_GATEWAY_ENDPOINT,
    fetchImpl = globalThis.fetch,
    oauth = new HealthGatewayOAuth({ fetchImpl })
  } = {}) {
    this.endpoint = endpoint;
    this.fetch = fetchImpl;
    this.oauth = oauth;
    this.protocolVersion = null;
  }

  async forward(message) {
    if (message?.method === 'initialize' && typeof message?.params?.protocolVersion === 'string') {
      this.protocolVersion = message.params.protocolVersion;
    }
    let token = await this.oauth.accessToken();
    let response = await this.request(message, token);
    if (response.status === 401) {
      token = await this.oauth.accessToken({ forceRefresh: true });
      response = await this.request(message, token);
    }
    if (response.status === 202 || response.status === 204) {
      return [];
    }
    if (!response.ok) {
      throw friendlyError('Health Gateway could not complete this request. Check your connection and try again.', {
        statusCode: response.status
      });
    }
    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();
    if (contentType.includes('text/event-stream')) {
      return body.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter((line) => line && line !== '[DONE]')
        .map((line) => JSON.parse(line));
    }
    if (!body) return [];
    return [JSON.parse(body)];
  }

  request(message, token) {
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'user-agent': `Health-Gateway-Bridge/${BRIDGE_VERSION}`
    };
    if (this.protocolVersion) {
      headers['mcp-protocol-version'] = this.protocolVersion;
    }
    return this.fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(message)
    });
  }
}

function rpcError(message, error) {
  if (!Object.hasOwn(message ?? {}, 'id') || message.id == null) return null;
  return {
    jsonrpc: '2.0',
    id: message.id,
    error: {
      code: -32000,
      message: error?.message?.startsWith('Health Gateway')
        ? error.message
        : 'Health Gateway ran into a connection problem. Please try again.'
    }
  };
}

export async function runBridge({ input = process.stdin, output = process.stdout, errorOutput = process.stderr, bridge = new HealthGatewayBridge() } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let queue = Promise.resolve();
  for await (const line of lines) {
    if (!line.trim()) continue;
    queue = queue.then(async () => {
      let message;
      try {
        message = JSON.parse(line);
        const responses = await bridge.forward(message);
        for (const response of responses) {
          output.write(`${JSON.stringify(response)}\n`);
        }
      } catch (error) {
        const response = rpcError(message, error);
        if (response) output.write(`${JSON.stringify(response)}\n`);
        errorOutput.write(`Health Gateway: ${error?.message?.startsWith('Health Gateway') ? error.message : 'A secure connection error occurred.'}\n`);
      }
    });
  }
  await queue;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runBridge().catch((error) => {
    process.stderr.write(`Health Gateway could not start: ${error.message}\n`);
    process.exitCode = 1;
  });
}

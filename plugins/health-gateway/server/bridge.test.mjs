import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  HealthGatewayBridge,
  HealthGatewayOAuth,
  renderBrandedStatusPage,
  writeCredentials
} from './bridge.mjs';

test('branded completion and recovery pages give a useful next step', () => {
  const success = renderBrandedStatusPage({
    kind: 'success',
    title: 'Health Gateway is connected',
    lead: 'Your AI assistant is ready.',
    detail: 'Return to your AI assistant.'
  });
  const failure = renderBrandedStatusPage({
    kind: 'error',
    title: 'Connection cancelled',
    lead: 'No health data was shared.',
    detail: 'Choose Connect again.'
  });

  assert.match(success, /Health Gateway is connected/);
  assert.match(success, /data-health-gateway-status="connected"/);
  assert.match(failure, /No health data was shared/);
  assert.match(failure, /View connection guide/);
  assert.doesNotMatch(`${success}${failure}`, /return to the CLI|Authentication complete|Authorization successful/i);
});

test('OAuth credentials are stored with owner-only permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'health-gateway-bridge-'));
  const path = join(directory, 'credentials.json');
  await writeCredentials(path, { accessToken: 'secret', refreshToken: 'refresh' });
  const details = await stat(path);

  assert.equal(details.mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    accessToken: 'secret',
    refreshToken: 'refresh'
  });
});

test('interactive OAuth exchanges the code before showing branded success', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'health-gateway-oauth-'));
  const credentialPath = join(directory, 'credentials.json');
  const requests = [];
  let callbackHtml = '';
  let callbackComplete;
  const callbackCompletion = new Promise((resolve) => {
    callbackComplete = resolve;
  });
  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith('/oauth/register')) {
      requests.push({ url: value, body: JSON.parse(options.body) });
      return Response.json({ client_id: 'client_123' }, { status: 201 });
    }
    if (value.endsWith('/oauth/token')) {
      const body = new URLSearchParams(options.body);
      requests.push({ url: value, body: Object.fromEntries(body) });
      return Response.json({
        access_token: 'access_123',
        refresh_token: 'refresh_123',
        expires_in: 3600,
        scope: 'health.read'
      });
    }
    return globalThis.fetch(url, options);
  };
  const oauth = new HealthGatewayOAuth({
    fetchImpl,
    credentialPath,
    iconPath: join(directory, 'missing-icon.png'),
    origin: 'https://auth.example',
    resource: 'https://resource.example/mcp',
    launchBrowser: async (authorizationUrl) => {
      const url = new URL(authorizationUrl);
      assert.equal(url.origin, 'https://auth.example');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      const callback = new URL(url.searchParams.get('redirect_uri'));
      callback.searchParams.set('code', 'code_123');
      callback.searchParams.set('state', url.searchParams.get('state'));
      setImmediate(async () => {
        const response = await globalThis.fetch(callback);
        callbackHtml = await response.text();
        callbackComplete();
      });
    }
  });

  assert.equal(await oauth.accessToken(), 'access_123');
  await callbackCompletion;
  assert.match(callbackHtml, /Health Gateway is connected/);
  assert.match(callbackHtml, /How many steps have I taken today/);
  assert.equal(requests[0].body.client_name, 'Health Gateway for Codex');
  assert.equal(requests[1].body.grant_type, 'authorization_code');
  assert.equal(requests[1].body.code, 'code_123');
  assert.ok(requests[1].body.code_verifier);
  const saved = JSON.parse(await readFile(credentialPath, 'utf8'));
  assert.equal(saved.refreshToken, 'refresh_123');
});

test('refresh tokens rotate and avoid interactive sign-in', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'health-gateway-refresh-'));
  const credentialPath = join(directory, 'credentials.json');
  await writeCredentials(credentialPath, {
    version: 1,
    clientId: 'client_123',
    redirectUri: 'http://127.0.0.1/callback',
    accessToken: 'expired_access',
    refreshToken: 'old_refresh',
    expiresAt: 1
  });
  let browserOpened = false;
  const oauth = new HealthGatewayOAuth({
    credentialPath,
    launchBrowser: async () => { browserOpened = true; },
    fetchImpl: async (_url, options) => {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('refresh_token'), 'old_refresh');
      return Response.json({
        access_token: 'fresh_access',
        refresh_token: 'new_refresh',
        expires_in: 3600,
        scope: 'health.read'
      });
    }
  });

  assert.equal(await oauth.accessToken(), 'fresh_access');
  assert.equal(browserOpened, false);
  const saved = JSON.parse(await readFile(credentialPath, 'utf8'));
  assert.equal(saved.refreshToken, 'new_refresh');
});

test('bridge forwards MCP messages and retries once after an expired access token', async () => {
  const tokens = ['expired', 'fresh'];
  const tokenCalls = [];
  const requestHeaders = [];
  const bridge = new HealthGatewayBridge({
    endpoint: 'https://resource.example/mcp',
    oauth: {
      accessToken: async (options = {}) => {
        tokenCalls.push(options);
        return tokens.shift();
      }
    },
    fetchImpl: async (_url, options) => {
      requestHeaders.push(options.headers);
      if (requestHeaders.length === 1) return new Response('', { status: 401 });
      return Response.json({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    }
  });

  const responses = await bridge.forward({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25' }
  });
  assert.deepEqual(responses, [{ jsonrpc: '2.0', id: 1, result: { ok: true } }]);
  assert.deepEqual(tokenCalls, [{}, { forceRefresh: true }]);
  assert.equal(requestHeaders[0].authorization, 'Bearer expired');
  assert.equal(requestHeaders[1].authorization, 'Bearer fresh');
  assert.equal(requestHeaders[1]['mcp-protocol-version'], '2025-11-25');
});

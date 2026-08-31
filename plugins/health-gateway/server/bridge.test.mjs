import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
      assert.equal(url.searchParams.getAll('resource').length, 0);
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
  assert.equal(requests[1].body.resource, 'https://resource.example/mcp');
  const saved = JSON.parse(await readFile(credentialPath, 'utf8'));
  assert.equal(saved.refreshToken, 'refresh_123');
});

test('simultaneous plugin processes open only one authorization window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'health-gateway-single-flight-'));
  const credentialPath = join(directory, 'credentials.json');
  let authorizationWindows = 0;
  let registrations = 0;
  let tokenExchanges = 0;
  let callbackCompletion;
  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith('/oauth/register')) {
      registrations += 1;
      return Response.json({ client_id: 'client_shared' }, { status: 201 });
    }
    if (value.endsWith('/oauth/token')) {
      tokenExchanges += 1;
      return Response.json({
        access_token: 'access_shared',
        refresh_token: 'refresh_shared',
        expires_in: 3600,
        scope: 'health.read'
      });
    }
    return globalThis.fetch(url, options);
  };
  const launchBrowser = async (authorizationUrl) => {
    authorizationWindows += 1;
    const url = new URL(authorizationUrl);
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('code', 'code_shared');
    callback.searchParams.set('state', url.searchParams.get('state'));
    callbackCompletion = new Promise((resolve, reject) => {
      setTimeout(async () => {
        try {
          const response = await globalThis.fetch(callback);
          await response.text();
          resolve();
        } catch (error) {
          reject(error);
        }
      }, 75);
    });
  };
  const clients = Array.from({ length: 32 }, () => new HealthGatewayOAuth({
    fetchImpl,
    credentialPath,
    iconPath: join(directory, 'missing-icon.png'),
    origin: 'https://auth.example',
    resource: 'https://resource.example/mcp',
    launchBrowser
  }));

  const tokens = await Promise.all(clients.map((client) => client.accessToken()));
  await callbackCompletion;

  assert.deepEqual(new Set(tokens), new Set(['access_shared']));
  assert.equal(authorizationWindows, 1);
  assert.equal(registrations, 1);
  assert.equal(tokenExchanges, 1);
  await assert.rejects(
    stat(`${credentialPath}.authorization.lock`),
    (error) => error?.code === 'ENOENT'
  );
});

test('separate bridge processes share one authorization owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'health-gateway-process-lock-'));
  const credentialPath = join(directory, 'credentials.json');
  const launchMarkerPath = join(directory, 'authorization-windows.txt');
  const bridgeUrl = pathToFileURL(join(import.meta.dirname, 'bridge.mjs')).href;
  const worker = `
    import { appendFile } from 'node:fs/promises';
    import { HealthGatewayOAuth, writeCredentials } from ${JSON.stringify(bridgeUrl)};
    const [credentialPath, launchMarkerPath] = process.argv.slice(1);
    const oauth = new HealthGatewayOAuth({ credentialPath });
    oauth.authorize = async () => {
      await appendFile(launchMarkerPath, 'window\\n');
      await new Promise((resolve) => setTimeout(resolve, 500));
      const credentials = {
        accessToken: 'shared_process_access',
        refreshToken: 'shared_process_refresh',
        expiresAt: Date.now() + 3_600_000
      };
      await writeCredentials(credentialPath, credentials);
      return credentials;
    };
    if (await oauth.accessToken() !== 'shared_process_access') process.exitCode = 1;
  `;

  await Promise.all(Array.from({ length: 8 }, () => runNodeWorker(worker, [
    credentialPath,
    launchMarkerPath
  ])));

  assert.equal((await readFile(launchMarkerPath, 'utf8')).trim().split('\n').length, 1);
  await assert.rejects(
    stat(`${credentialPath}.authorization.lock`),
    (error) => error?.code === 'ENOENT'
  );
});

test('cancelled authorization does not cause waiting processes to open more windows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'health-gateway-cancelled-flight-'));
  const credentialPath = join(directory, 'credentials.json');
  let authorizationWindows = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/oauth/register')) {
      return Response.json({ client_id: 'client_cancelled' }, { status: 201 });
    }
    return globalThis.fetch(url);
  };
  const launchBrowser = async (authorizationUrl) => {
    authorizationWindows += 1;
    const url = new URL(authorizationUrl);
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('error', 'access_denied');
    callback.searchParams.set('state', url.searchParams.get('state'));
    setTimeout(async () => {
      const response = await globalThis.fetch(callback);
      await response.text();
    }, 75);
  };
  const clients = Array.from({ length: 32 }, () => new HealthGatewayOAuth({
    fetchImpl,
    credentialPath,
    iconPath: join(directory, 'missing-icon.png'),
    origin: 'https://auth.example',
    resource: 'https://resource.example/mcp',
    launchBrowser
  }));

  const results = await Promise.allSettled(clients.map((client) => client.accessToken()));

  assert.ok(results.every((result) => result.status === 'rejected'));
  assert.equal(authorizationWindows, 1);
  await assert.rejects(
    stat(`${credentialPath}.authorization.lock`),
    (error) => error?.code === 'ENOENT'
  );
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

function runNodeWorker(code, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', code, ...args], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(new Error(signal
        ? `bridge worker exited from signal ${signal}`
        : `bridge worker exited with code ${exitCode ?? 1}: ${stderr}`));
    });
  });
}

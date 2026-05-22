#!/usr/bin/env node
'use strict';

/**
 * Live reproduction harness for the #76 follow-up gate failure
 * (request-time boundary).
 *
 *   Bridge IS catching connectDefault per-site failure, but the response
 *   synthesized for the cached initialize comes out as CallToolResult shape
 *   (content[] + isError:true) instead of InitializeResult shape
 *   (protocolVersion + capabilities + serverInfo).
 *
 * What this script does:
 *   1. Spins up a tiny localhost HTTP server that responds to OAuth discovery
 *      probes (.well-known/oauth-authorization-server +
 *      .well-known/oauth-protected-resource) with valid metadata. The bridge
 *      needs discovery to succeed so the request-time path is reached;
 *      discovery failure would surface the connect-time path covered by #81.
 *   2. Writes a synthetic wp-sites.json fixture with a single OAuth site
 *      whose `auth_status` is `'expired'` and whose `access_token_expires_at`
 *      is in the past. With this state, `lib/auth/token-manager.js#refresh`
 *      throws RefreshError synchronously at line 147 — no HTTP call to the
 *      token endpoint, no keychain reads required for the failure path.
 *   3. Cold-spawns the bridge as a child process pointed at the fixture.
 *   4. Sends a JSON-RPC `initialize` request over the bridge's stdin.
 *   5. Captures the bridge's stdout response.
 *   6. Reports the captured request + response bytes verbatim, then asserts
 *      the response shape (InitializeResult, NOT CallToolResult).
 *
 * Run:
 *   node test/manual/repro-76-followup.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execSync, spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BRIDGE_BIN = path.join(REPO_ROOT, 'abilities-mcp.js');

function jsonOk(res, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function generateSelfSignedCert(tmp) {
  // Discovery refuses plain HTTP unless `allowInsecure` is plumbed all the way
  // through ConnectionPool — and the bridge bootstrap doesn't pass that flag
  // today (out of scope for this PR). Workaround: use HTTPS with a self-signed
  // cert and spawn the bridge with NODE_TLS_REJECT_UNAUTHORIZED=0 so discovery
  // accepts it.
  const keyPath = path.join(tmp, 'key.pem');
  const certPath = path.join(tmp, 'cert.pem');
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" ` +
    `-days 1 -subj "/CN=127.0.0.1" ` +
    `-addext "subjectAltName=IP:127.0.0.1,DNS:localhost" 2>/dev/null`,
    { stdio: 'pipe' }
  );
  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
}

function startMockSite(tmp) {
  return new Promise((resolve) => {
    const tlsOpts = generateSelfSignedCert(tmp);
    const server = https.createServer(tlsOpts, (req, res) => {
      const u = new URL(req.url, `https://${req.headers.host}`);
      const origin = `https://${req.headers.host}`;
      if (u.pathname === '/.well-known/oauth-authorization-server') {
        return jsonOk(res, {
          issuer: origin,
          authorization_endpoint: `${origin}/oauth/authorize`,
          token_endpoint: `${origin}/oauth/token`,
          registration_endpoint: `${origin}/oauth/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (u.pathname === '/.well-known/oauth-protected-resource') {
        return jsonOk(res, {
          resource: `${origin}/wp-json/mcp/abilities-mcp-adapter-default-server`,
          authorization_servers: [origin],
        });
      }
      // Anything else — 404 (the bridge should never reach here in this
      // reproduction; refresh() throws synchronously before any HTTP call).
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `https://127.0.0.1:${port}` });
    });
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abilities-mcp-repro-76-'));
  const configPath = path.join(tmp, 'wp-sites.json');

  const { server, origin } = await startMockSite(tmp);
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const futureDate = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();

  const config = {
    defaultSite: 'wicked-community',
    sites: {
      'wicked-community': {
        url: origin,
        label: 'wicked-community (synthetic)',
        mcp_resource: `${origin}/wp-json/mcp/abilities-mcp-adapter-default-server`,
        auth: {
          method: 'oauth',
          client_id: 'synthetic-client',
          access_token_ref: 'ref:abilities-mcp:wicked-community/access',
          refresh_token_ref: 'ref:abilities-mcp:wicked-community/refresh',
          access_token_expires_at: yesterday,    // forces _isWithinRefreshWindow=true
          refresh_token_expires_at: futureDate,  // not actually checked
        },
        // The auth_status that triggers refresh() to throw RefreshError
        // synchronously at lib/auth/token-manager.js:147 — no HTTP, no
        // keychain reads on the failing path.
        auth_status: 'expired',
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

  console.log(`-- mock discovery server: ${origin}`);
  console.log(`-- synthetic config:      ${configPath}`);
  console.log('');

  const bridge = spawn('node', [
    BRIDGE_BIN,
    `--config=${configPath}`,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Self-signed cert on the mock — accept it for this synthetic harness.
      // The bridge in production verifies certs normally; this only relaxes
      // verification for the spawned harness child.
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      ABILITIES_MCP_DEBUG: '0',
    },
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  bridge.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString(); });
  bridge.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

  // Send `initialize` after the bridge has had a moment to set up its stdin
  // handler + complete the bootstrap (which on this path includes the OAuth
  // discovery probe to the mock server).
  const initializeRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'repro-76-followup', version: '1.0' },
    },
  };

  // Wait for the bridge to print its config-source line on stderr — that's
  // the explicit signal that loadConfig has completed.
  await new Promise((resolve) => {
    const onData = () => {
      if (/Config source/i.test(stderrBuf) || /loaded:/i.test(stderrBuf) ||
          stderrBuf.split('\n').length > 2) {
        bridge.stderr.off('data', onData);
        resolve();
      }
    };
    bridge.stderr.on('data', onData);
    setTimeout(resolve, 3000);  // hard cap so the script can't hang
  });

  // Send initialize and wait for the response (single-line JSON on stdout).
  const requestBytes = JSON.stringify(initializeRequest) + '\n';
  bridge.stdin.write(requestBytes);

  const responseLine = await new Promise((resolve) => {
    const tick = () => {
      const idx = stdoutBuf.indexOf('\n');
      if (idx >= 0) return resolve(stdoutBuf.slice(0, idx));
      setTimeout(tick, 50);
    };
    tick();
    setTimeout(() => resolve(stdoutBuf || '<timeout — no response>'), 8000);
  });

  bridge.stdin.end();
  bridge.kill('SIGTERM');
  await new Promise((r) => bridge.once('exit', r));
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('=== STDIN (request) ===');
  console.log(requestBytes.trim());
  console.log('');
  console.log('=== STDOUT (response) ===');
  console.log(responseLine);
  console.log('');
  console.log('=== STDERR (bridge log — operator-visible degraded-mode advisory) ===');
  console.log(stderrBuf.trim());
  console.log('');

  let parsed;
  try { parsed = JSON.parse(responseLine); }
  catch (err) {
    console.error(`FAIL: response is not valid JSON: ${err.message}`);
    process.exit(2);
  }

  const errors = [];
  if (!parsed.result) errors.push('response.result missing');
  if (parsed.result) {
    if (typeof parsed.result.protocolVersion !== 'string') {
      errors.push(`result.protocolVersion: expected string, got ${typeof parsed.result.protocolVersion}`);
    }
    if (typeof parsed.result.capabilities !== 'object' || parsed.result.capabilities === null) {
      errors.push(`result.capabilities: expected object, got ${typeof parsed.result.capabilities}`);
    }
    if (typeof parsed.result.serverInfo !== 'object' || parsed.result.serverInfo === null) {
      errors.push(`result.serverInfo: expected object, got ${typeof parsed.result.serverInfo}`);
    }
    if (parsed.result.content !== undefined) {
      errors.push('result.content present — that is CallToolResult shape (the gate-violating shape from the operator reproduction)');
    }
    if (parsed.result.isError !== undefined) {
      errors.push('result.isError present — that is CallToolResult shape (the gate-violating shape from the operator reproduction)');
    }
  }

  if (errors.length > 0) {
    console.error('=== GATE VIOLATED ===');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log('=== GATE SATISFIED ===');
  console.log('  - response.result.protocolVersion: present (string)');
  console.log('  - response.result.capabilities:    present (object)');
  console.log('  - response.result.serverInfo:      present (object)');
  console.log('  - response.result.content / isError: absent (correct — InitializeResult shape, not CallToolResult)');
}

main().catch((err) => {
  console.error('repro harness failed:', err);
  process.exit(2);
});

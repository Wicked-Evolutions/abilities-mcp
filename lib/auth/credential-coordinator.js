'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { makeRef, parseRef, resolveRef } = require('./secret-store');
const { RefreshError } = require('./errors');

const SECRET_SERVICE = 'abilities-mcp';
const PAIR_VERSION = 1;
const LOCK_STALE_MS = 120_000;

function _randomId() {
  return crypto.randomBytes(16).toString('hex');
}

function _identityFromLegacy(accessRef, refreshRef) {
  return crypto.createHash('sha256')
    .update(`${accessRef}\u0000${refreshRef}`)
    .digest('hex');
}

function _stateRoot() {
  const base = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || os.homedir())
    : (process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'));
  return path.join(base, 'abilities-mcp', 'oauth-coordination');
}

function _assertPair(pair, expectedGeneration) {
  if (!pair || typeof pair !== 'object' || pair.version !== PAIR_VERSION ||
      typeof pair.generation !== 'string' || pair.generation.length < 16 ||
      typeof pair.access_token !== 'string' || typeof pair.refresh_token !== 'string') {
    throw new RefreshError('Committed credential pair is unavailable or malformed', {
      code: 'credential_pair_unavailable', state: 'refreshing',
    });
  }
  if (expectedGeneration && pair.generation !== expectedGeneration) {
    throw new RefreshError('Committed credential pair generation does not match configuration', {
      code: 'credential_generation_mismatch', state: 'refreshing',
    });
  }
  return pair;
}

/**
 * Coordinates the bridge-local persistence of an OAuth access/refresh pair.
 * It intentionally stores one JSON pair in an OS keychain entry: a config
 * pointer can therefore never expose a reader to half of a rotated pair.
 */
class CredentialCoordinator {
  constructor(args) {
    if (!args || !args.secretStore) throw new Error('CredentialCoordinator requires secretStore');
    this._store = args.secretStore;
    this._configPath = args.configPath || null;
    this._siteId = args.siteId || null;
    this._now = (args.deps && args.deps.now) || (() => Date.now());
    this._stateRoot = (args.deps && args.deps.stateRoot) || _stateRoot();
  }

  static identityForAuth(auth) {
    if (auth && typeof auth.credential_identity === 'string' && auth.credential_identity.length >= 16) {
      return auth.credential_identity;
    }
    if (!auth || !auth.access_token_ref || !auth.refresh_token_ref) return null;
    return _identityFromLegacy(auth.access_token_ref, auth.refresh_token_ref);
  }

  static decodePair(raw, generation) {
    let pair;
    try { pair = JSON.parse(raw); }
    catch {
      throw new RefreshError('Committed credential pair is unavailable or malformed', {
        code: 'credential_pair_unavailable', state: 'refreshing',
      });
    }
    return _assertPair(pair, generation);
  }

  async readPair(auth) {
    if (!auth || !auth.credential_pair_ref) return null;
    const raw = await resolveRef(this._store, auth.credential_pair_ref);
    return CredentialCoordinator.decodePair(raw, auth.credential_generation);
  }

  /**
   * Prepare a new inactive pair slot. The caller must publish the returned
   * non-secret fields in one config write before using the pair.
   */
  async preparePair(args) {
    if (!args || !args.tokens || typeof args.tokens.access_token !== 'string' ||
        typeof args.tokens.refresh_token !== 'string') {
      throw new Error('preparePair requires access_token and refresh_token');
    }
    const identity = args.credentialIdentity || CredentialCoordinator.identityForAuth(args.auth);
    if (!identity) throw new Error('preparePair requires credential identity');
    const currentSlot = args.auth && args.auth.credential_pair_slot === 'a' ? 'a' : 'b';
    const slot = currentSlot === 'a' ? 'b' : 'a';
    const generation = _randomId();
    const account = `${identity}/credential-pair/${slot}`;
    const pair = {
      version: PAIR_VERSION,
      generation,
      access_token: args.tokens.access_token,
      refresh_token: args.tokens.refresh_token,
      access_token_expires_at: args.accessTokenExpiresAt,
      refresh_token_expires_at: args.refreshTokenExpiresAt || null,
      authorization_expires_at: args.authorizationExpiresAt || null,
      next_refresh_at: args.nextRefreshAt || null,
    };
    await this._store.set(SECRET_SERVICE, account, JSON.stringify(pair));
    return {
      credential_identity: identity,
      credential_generation: generation,
      credential_pair_slot: slot,
      credential_pair_ref: makeRef(SECRET_SERVICE, account),
      access_token_expires_at: pair.access_token_expires_at,
      refresh_token_expires_at: pair.refresh_token_expires_at,
      authorization_expires_at: pair.authorization_expires_at,
      next_refresh_at: pair.next_refresh_at,
    };
  }

  async withCredentialLock(identity, operation, fn) {
    const root = path.join(this._stateRoot, crypto.createHash('sha256').update(identity).digest('hex'));
    const lockPath = `${root}.lock`;
    await fsp.mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
    const owner = { nonce: _randomId(), pid: process.pid, operation, started_at: new Date(this._now()).toISOString() };
    try {
      await fsp.mkdir(lockPath, { mode: 0o700 });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const stat = await fsp.stat(lockPath).catch(() => null);
      if (stat && this._now() - stat.mtimeMs > LOCK_STALE_MS) {
        // Never steal a possibly-live process's lock. PID reuse/liveness is
        // deliberately conservative: an ambiguous owner remains busy.
        let meta = null;
        try { meta = JSON.parse(await fsp.readFile(path.join(lockPath, 'owner.json'), 'utf8')); } catch {}
        let alive = true;
        if (meta && Number.isInteger(meta.pid)) {
          try { process.kill(meta.pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
        }
        if (!alive) {
          await fsp.rm(lockPath, { recursive: true, force: true });
          await fsp.mkdir(lockPath, { mode: 0o700 });
        } else {
          throw new RefreshError('OAuth credential operation is already in progress', {
            code: 'credential_operation_busy', state: 'refreshing',
          });
        }
      } else {
        throw new RefreshError('OAuth credential operation is already in progress', {
          code: 'credential_operation_busy', state: 'refreshing',
        });
      }
    }
    await fsp.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
    try { return await fn(owner); }
    finally {
      const raw = await fsp.readFile(path.join(lockPath, 'owner.json'), 'utf8').catch(() => null);
      if (raw) {
        try { if (JSON.parse(raw).nonce === owner.nonce) await fsp.rm(lockPath, { recursive: true, force: true }); } catch {}
      }
    }
  }
}

module.exports = { CredentialCoordinator, PAIR_VERSION, SECRET_SERVICE };

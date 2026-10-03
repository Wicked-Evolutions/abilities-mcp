'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { makeRef, resolveRef } = require('./secret-store');
const { RefreshError } = require('./errors');

const SECRET_SERVICE = 'abilities-mcp';
const PAIR_VERSION = 1;
const REFRESH_RECOVERY_MS = 25_000;

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

function _authFromSite(site) {
  const auth = site && site.auth || {};
  return {
    credentialPairRef: auth.credential_pair_ref,
    credentialGeneration: auth.credential_generation,
    credentialIdentity: auth.credential_identity,
    credentialPairSlot: auth.credential_pair_slot,
    accessTokenRef: auth.access_token_ref,
    refreshTokenRef: auth.refresh_token_ref,
    accessTokenExpiresAt: auth.access_token_expires_at,
    refreshTokenExpiresAt: auth.refresh_token_expires_at,
    authorizationExpiresAt: auth.authorization_expires_at,
    nextRefreshAt: auth.next_refresh_at,
    refreshExpirySource: auth.refresh_expiry_source,
    clientId: auth.client_id,
    mcpResource: site && site.mcp_resource,
  };
}

function _sameGeneration(auth, generation) {
  // Coordinator snapshots are camelCase; raw config objects are snake_case.
  // The generation fence must compare the same value in both paths.
  const current = auth && (auth.credentialGeneration || auth.credential_generation);
  return (current || null) === (generation || null);
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
    // Internal deterministic-test seam. Production callers do not provide it.
    this._lockHooks = (args.deps && args.deps.lockHooks) || null;
  }

  get hasConfig() { return !!this._configPath && !!this._siteId; }

  forSite(siteId) {
    return new CredentialCoordinator({
      secretStore: this._store,
      configPath: this._configPath,
      siteId,
      deps: { now: this._now, stateRoot: this._stateRoot, lockHooks: this._lockHooks },
    });
  }

  static identityForAuth(auth) {
    const configuredIdentity = auth && (auth.credential_identity || auth.credentialIdentity);
    if (typeof configuredIdentity === 'string' && configuredIdentity.length >= 16) {
      return configuredIdentity;
    }
    const accessRef = auth && (auth.access_token_ref || auth.accessTokenRef);
    const refreshRef = auth && (auth.refresh_token_ref || auth.refreshTokenRef);
    if (!accessRef || !refreshRef) return null;
    return _identityFromLegacy(accessRef, refreshRef);
  }

  static newIdentity() {
    return crypto.randomBytes(32).toString('hex');
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
    const slot = args.slot || (currentSlot === 'a' ? 'b' : 'a');
    const generation = args.generation || _randomId();
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

  /**
   * Execute a very short whole-config mutation. This is deliberately a
   * separate lock from the credential lock: network/browser work must never
   * hold a config lock. The mutation receives a freshly parsed config, so a
   * writer cannot publish a stale whole-file snapshot over another site.
   */
  async withConfigCommitLock(operation, fn, opts = {}) {
    if (!this._configPath) return fn(null);
    const realPath = await fsp.realpath(this._configPath).catch(() => path.resolve(this._configPath));
    const lockPath = path.join(path.dirname(realPath), '.abilities-mcp-coordination',
      `${crypto.createHash('sha256').update(realPath).digest('hex')}.config.lock`);
    return this._withLock(lockPath, operation, async (owner) => {
      let config;
      try { config = JSON.parse(await fsp.readFile(realPath, 'utf8')); }
      catch (err) {
        if (err.code === 'ENOENT' && typeof opts.initialConfig === 'function') {
          config = opts.initialConfig();
        } else {
        throw new RefreshError(`Cannot read OAuth configuration: ${err.message}`, {
          code: 'credential_config_unavailable', state: 'refreshing', cause: err,
        });
        }
      }
      const result = await fn({ owner, config, realPath, existed: fs.existsSync(realPath) });
      if (result && result.write) {
        await this._assertOwnership(lockPath, owner);
        const { _atomicWrite } = require('./config-migration');
        await _atomicWrite(realPath, config);
      }
      return result && result.value;
    });
  }

  async claimOwnership(identity, siteId = this._siteId) {
    if (!this._configPath || !siteId) return;
    const realPath = await fsp.realpath(this._configPath).catch(() => path.resolve(this._configPath));
    const registry = path.join(this._stateRoot, 'ownership');
    const file = path.join(registry, `${crypto.createHash('sha256').update(identity).digest('hex')}.json`);
    await fsp.mkdir(registry, { recursive: true, mode: 0o700 });
    const existing = await fsp.readFile(file, 'utf8').then(JSON.parse).catch((err) => {
      if (err && err.code === 'ENOENT') return null;
      throw new RefreshError('OAuth credential ownership registry is unreadable', {
        code: 'credential_ownership_unavailable', state: 'refreshing', cause: err,
      });
    });
    const wanted = { config_path: realPath, site_id: siteId, credential_identity: identity };
    if (existing && (existing.config_path !== wanted.config_path || existing.site_id !== wanted.site_id)) {
      throw new RefreshError('This credential identity is already owned by another configured site', {
        code: 'shared_credential_config_unsupported', state: 'refreshing',
      });
    }
    if (!existing) {
      const tmp = `${file}.${process.pid}.${_randomId()}.tmp`;
      try {
        await fsp.writeFile(tmp, JSON.stringify(wanted), { mode: 0o600, flag: 'wx' });
        await fsp.rename(tmp, file);
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        if (err.code !== 'EEXIST') throw err;
        return this.claimOwnership(identity, siteId);
      }
    }
  }

  /** Reserve the inactive slot and record the unknown-commit state before a
   * refresh HTTP request. It contains no secret material. */
  async beginRefresh(siteAuth) {
    if (!this.hasConfig) return null;
    const identity = siteAuth.credentialIdentity || CredentialCoordinator.identityForAuth({
      credential_identity: siteAuth.credentialIdentity,
      access_token_ref: siteAuth.accessTokenRef,
      refresh_token_ref: siteAuth.refreshTokenRef,
    });
    if (!identity) throw new RefreshError('OAuth credential identity is unavailable', {
      code: 'credential_identity_unavailable', state: 'refreshing',
    });
    await this.claimOwnership(identity);
    return this.withConfigCommitLock('reserve-refresh', async ({ config }) => {
      const site = config.sites && config.sites[this._siteId];
      const auth = _authFromSite(site);
      if (!site || !_sameGeneration(auth, siteAuth.credentialGeneration)) {
        throw new RefreshError('OAuth credentials changed in another process', {
          code: 'credential_generation_changed', state: 'refreshing',
        });
      }
      if (site.auth.refresh_attempt) {
        throw new RefreshError('The preceding OAuth refresh outcome is unknown', {
          code: 'unknown_refresh_outcome', state: 'refreshing',
        });
      }
      const slot = auth.credentialPairSlot === 'a' ? 'b' : 'a';
      const generation = _randomId();
      const account = `${identity}/credential-pair/${slot}`;
      const start = this._now();
      const marker = {
        nonce: _randomId(), base_generation: auth.credentialGeneration || null,
        credential_identity: identity, credential_pair_slot: slot,
        credential_pair_ref: makeRef(SECRET_SERVICE, account), credential_generation: generation,
        request_started_at: new Date(start).toISOString(),
        recovery_deadline_at: new Date(start + REFRESH_RECOVERY_MS).toISOString(), attempt_count: 0,
      };
      site.auth.refresh_attempt = marker;
      return { write: true, value: marker };
    });
  }

  async recordRefreshAttempt(marker) {
    if (!marker || !this.hasConfig) return;
    return this.withConfigCommitLock('record-refresh-attempt', async ({ config }) => {
      const auth = config.sites && config.sites[this._siteId] && config.sites[this._siteId].auth;
      if (!auth || !auth.refresh_attempt || auth.refresh_attempt.nonce !== marker.nonce) {
        throw new RefreshError('OAuth refresh was superseded by another process', {
          code: 'credential_generation_changed', state: 'refreshing',
        });
      }
      if (this._now() >= Date.parse(marker.recovery_deadline_at) || auth.refresh_attempt.attempt_count >= 2) {
        throw new RefreshError('OAuth refresh outcome is unknown; reauthorization is required', {
          code: 'unknown_refresh_outcome', state: 'refreshing',
        });
      }
      auth.refresh_attempt.attempt_count += 1;
      return { write: true };
    });
  }

  async commitRefresh(marker, siteAuth, tokens, expiry) {
    if (!marker || !this.hasConfig) return null;
    const metadata = {
      access_token_expires_at: expiry.accessTokenExpiresAt,
      refresh_token_expires_at: expiry.refreshTokenExpiresAt || null,
      authorization_expires_at: expiry.authorizationExpiresAt || null,
      next_refresh_at: expiry.nextRefreshAt || null,
      refresh_expiry_source: expiry.expirySource,
    };
    // Persist non-secret response metadata before the protected pair. This is
    // the only recovery information required to publish a verified pair.
    await this.withConfigCommitLock('prepare-refresh-publication', async ({ config }) => {
      const site = config.sites && config.sites[this._siteId];
      const auth = site && site.auth;
      if (!auth || !auth.refresh_attempt || auth.refresh_attempt.nonce !== marker.nonce ||
          !_sameGeneration(_authFromSite(site), marker.base_generation)) {
        throw new RefreshError('OAuth refresh was superseded by another process', {
          code: 'credential_generation_changed', state: 'refreshing',
        });
      }
      auth.refresh_attempt.prepared_metadata = metadata;
      return { write: true };
    });
    const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : siteAuth._refreshToken;
    await this.preparePair({
      auth: { credential_identity: marker.credential_identity, credential_pair_slot: siteAuth.credentialPairSlot },
      credentialIdentity: marker.credential_identity, generation: marker.credential_generation, slot: marker.credential_pair_slot,
      tokens: { access_token: tokens.access_token, refresh_token: refreshToken },
      accessTokenExpiresAt: metadata.access_token_expires_at,
      refreshTokenExpiresAt: metadata.refresh_token_expires_at,
      authorizationExpiresAt: metadata.authorization_expires_at,
      nextRefreshAt: metadata.next_refresh_at,
    });
    return this._publishPrepared(marker);
  }

  async recoverPrepared(siteAuth) {
    if (!this.hasConfig) return null;
    let marker = null;
    await this.withConfigCommitLock('inspect-refresh-recovery', async ({ config }) => {
      const auth = config.sites && config.sites[this._siteId] && config.sites[this._siteId].auth;
      marker = auth && auth.refresh_attempt || null;
      return { write: false };
    });
    if (!marker) return null;
    try {
      const pair = await this.readPair({ credential_pair_ref: marker.credential_pair_ref, credential_generation: marker.credential_generation });
      if (!marker.prepared_metadata) throw new Error('missing prepared metadata');
      return this._publishPrepared(marker, pair);
    } catch (err) {
      if (this._now() < Date.parse(marker.recovery_deadline_at)) return { retry: true, marker };
      throw new RefreshError('OAuth refresh outcome is unknown; run reauth', {
        code: 'unknown_refresh_outcome', state: 'refreshing', cause: err,
      });
    }
  }

  /**
   * Reload and validate the pair used for every ordinary request. This is the
   * fence that makes an external reauthorization visible to a long-lived MCP
   * process before it sends either a valid access token or a refresh token.
   */
  async readValidatedSnapshot(siteAuth) {
    if (!this.hasConfig) return siteAuth;
    let current = siteAuth;
    const identity = CredentialCoordinator.identityForAuth(current);
    if (!identity) throw new RefreshError('OAuth credential identity is unavailable', {
      code: 'credential_identity_unavailable', state: 'refreshing',
    });
    const snapshot = await this.withCredentialLock(identity, 'read-credential-snapshot', async () => {
      await this.claimOwnership(identity);
      const recovered = await this.recoverPrepared(current);
      let auth;
      const configResult = await this.withConfigCommitLock('read-credential-snapshot', async ({ config }) => {
        const site = config.sites && config.sites[this._siteId];
        if (!site || !site.auth) throw new RefreshError('OAuth site was removed from configuration', {
          code: 'credential_config_unavailable', state: 'refreshing',
        });
        auth = { ..._authFromSite(site), authStatus: site.auth_status || 'active' };
        if (auth.credentialIdentity && auth.credentialIdentity !== identity) {
          return { write: false, value: { __relock: { ...siteAuth, ...auth } } };
        }
        // A different active generation always wins; do not let the cached
        // process use its stale client or secret after external reauth.
        if (siteAuth.credentialGeneration && !_sameGeneration(auth, siteAuth.credentialGeneration) && !auth.credentialGeneration) {
          throw new RefreshError('OAuth credential generation became invalid', {
            code: 'credential_generation_changed', state: 'refreshing',
          });
        }
        return { write: false };
      });
      if (configResult && configResult.__relock) return configResult;
      current = { ...siteAuth, ...auth };
      if (current.credentialPairRef) {
        const pair = await this.readPair({
          credential_pair_ref: current.credentialPairRef,
          credential_generation: current.credentialGeneration,
        });
        current._accessToken = pair.access_token;
        current._refreshToken = pair.refresh_token;
      }
      // A marker without a complete pair is intentionally not erased. If
      // access remains usable callers may continue; a later refresh consumes
      // the same bounded recovery marker rather than reusing an old token.
      current._refreshAttempt = recovered && recovered.marker || null;
      return current;
    });
    // Never read a replacement identity while holding the old identity lock.
    // Re-enter after that lock releases and revalidate under the new lock.
    if (snapshot && snapshot.__relock) return this.readValidatedSnapshot(snapshot.__relock);
    return snapshot;
  }

  async _publishPrepared(marker, pair = null) {
    return this.withConfigCommitLock('publish-refresh', async ({ config }) => {
      const site = config.sites && config.sites[this._siteId];
      const auth = site && site.auth;
      const current = auth && auth.refresh_attempt;
      if (!auth || !current || current.nonce !== marker.nonce ||
          current.credential_generation !== marker.credential_generation || !current.prepared_metadata ||
          !_sameGeneration(_authFromSite(site), marker.base_generation)) {
        throw new RefreshError('OAuth prepared credentials were superseded', {
          code: 'credential_generation_changed', state: 'refreshing',
        });
      }
      if (!pair) await this.readPair({ credential_pair_ref: marker.credential_pair_ref, credential_generation: marker.credential_generation });
      Object.assign(auth, current.prepared_metadata, {
        credential_identity: marker.credential_identity,
        credential_pair_ref: marker.credential_pair_ref,
        credential_generation: marker.credential_generation,
        credential_pair_slot: marker.credential_pair_slot,
      });
      delete auth.access_token_ref;
      delete auth.refresh_token_ref;
      delete auth.refresh_attempt;
      site.auth_status = 'active';
      return { write: true, value: _authFromSite(site) };
    });
  }

  async withCredentialLock(identity, operation, fn) {
    const lockPath = path.join(this._stateRoot, `${crypto.createHash('sha256').update(identity).digest('hex')}.credential.lock`);
    return this._withLock(lockPath, operation, fn);
  }

  async _withLock(lockPath, operation, fn) {
    const root = lockPath.replace(/\.lock$/, '');
    await fsp.mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
    const owner = { nonce: _randomId(), pid: process.pid, operation, started_at: new Date(this._now()).toISOString() };
    try {
      await fsp.mkdir(lockPath, { mode: 0o700 });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Check a known-dead owner immediately: waiting for a stale-age floor
      // would consume the 25-second replay recovery budget. Ambiguous or live
      // owners are never stolen, even after a long pause.
      let meta = null;
      try { meta = JSON.parse(await fsp.readFile(path.join(lockPath, 'owner.json'), 'utf8')); } catch {}
      if (!meta || typeof meta.nonce !== 'string' || !Number.isInteger(meta.pid)) {
        throw new RefreshError('OAuth lock recovery was interrupted before an owner was recorded. Stop all bridge processes, remove only the empty coordination lock, then retry.', {
          code: 'credential_recovery_interrupted', state: 'refreshing',
        });
      }
      let dead = false;
      if (meta && Number.isInteger(meta.pid)) {
        try { process.kill(meta.pid, 0); } catch (e) { dead = e.code === 'ESRCH'; }
      }
      if (!dead) {
        throw new RefreshError('OAuth credential operation is already in progress', {
          code: 'credential_operation_busy', state: 'refreshing',
        });
      }
      await this._runLockHook('afterDeadOwnerRead', { lockPath, owner: meta });
      // Claim *inside* the observed directory using the dead owner nonce.
      // All reclaimers use the same marker; none may move the containing lock
      // until it owns that marker and has revalidated the owner.
      const claim = path.join(lockPath, `reclaim.${meta.nonce}`);
      try { await fsp.mkdir(claim, { mode: 0o700 }); }
      catch (claimErr) {
        throw new RefreshError('OAuth lock recovery is already in progress. Stop all bridge processes before manual recovery if it remains interrupted.', {
          code: 'credential_recovery_interrupted', state: 'refreshing', cause: claimErr,
        });
      }
      let revalidated = null;
      try { revalidated = JSON.parse(await fsp.readFile(path.join(lockPath, 'owner.json'), 'utf8')); } catch {}
      if (!revalidated || revalidated.nonce !== meta.nonce || revalidated.pid !== meta.pid) {
        await fsp.rm(claim, { recursive: true, force: true }).catch(() => {});
        throw new RefreshError('OAuth credential operation is already in progress', {
          code: 'credential_operation_busy', state: 'refreshing',
        });
      }
      const tombstone = `${lockPath}.dead.${_randomId()}`;
      try { await fsp.rename(lockPath, tombstone); }
      catch (renameErr) {
        if (renameErr.code === 'ENOENT' || renameErr.code === 'EEXIST') {
          throw new RefreshError('OAuth credential operation is already in progress', {
            code: 'credential_operation_busy', state: 'refreshing',
          });
        }
        throw renameErr;
      }
      await this._runLockHook('afterDeadOwnerMoved', { lockPath, tombstone, owner: meta });
      try { await fsp.mkdir(lockPath, { mode: 0o700 }); }
      catch (mkdirErr) {
        // A normal contender may have acquired the temporarily absent path.
        // Do not delete or replace it; retain the tombstone for explicit,
        // stopped-process recovery.
        throw new RefreshError('OAuth lock recovery was interrupted. Stop all bridge processes before manual recovery; no credentials or config were changed.', {
          code: 'credential_recovery_interrupted', state: 'refreshing', cause: mkdirErr,
        });
      }
      await fsp.rm(tombstone, { recursive: true, force: true }).catch(() => {});
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

  async _assertOwnership(lockPath, owner) {
    const raw = await fsp.readFile(path.join(lockPath, 'owner.json'), 'utf8').catch(() => null);
    if (!raw) throw new RefreshError('OAuth coordination lock ownership was lost', {
      code: 'credential_operation_busy', state: 'refreshing',
    });
    try {
      if (JSON.parse(raw).nonce === owner.nonce) return;
    } catch {}
    throw new RefreshError('OAuth coordination lock ownership was lost', {
      code: 'credential_operation_busy', state: 'refreshing',
    });
  }

  async _runLockHook(name, details) {
    const hook = this._lockHooks && this._lockHooks[name];
    if (typeof hook === 'function') await hook(details);
  }
}

module.exports = { CredentialCoordinator, PAIR_VERSION, SECRET_SERVICE };

'use strict';

// Test-only preload. It replaces only the operating-system keychain wrapper;
// the entrypoint still uses the production ConnectionPool, coordinator,
// discovery client, OAuth transport, and router.
const Module = require('node:module');
const fs = require('node:fs');
const originalLoad = Module._load;
const values = new Map();

class FixtureSecretStore {
  async get(service, account) {
    if (values.has(`${service}/${account}`)) return values.get(`${service}/${account}`);
    if (service !== 'abilities-mcp') return null;
    return account.endsWith('/access') ? 'fixture-access' : 'fixture-refresh';
  }

  async set(service, account, value) {
    if (process.env.FIXTURE_PERSIST_PATH) {
      fs.appendFileSync(process.env.FIXTURE_PERSIST_PATH, `started ${Date.now()} ${service}/${account}\n`);
    }
    const delay = Number(process.env.FIXTURE_PERSIST_DELAY_MS || 0);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    values.set(`${service}/${account}`, value);
    if (process.env.FIXTURE_PERSIST_PATH) {
      fs.appendFileSync(process.env.FIXTURE_PERSIST_PATH, `settled ${Date.now()} ${service}/${account}\n`);
    }
  }

  async delete() { return true; }
  async findAll() { return []; }
}

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === './lib/auth/keychain-secret-store' || request === './auth/keychain-secret-store' || request === './keychain-secret-store') {
    return { KeychainSecretStore: FixtureSecretStore };
  }
  return originalLoad.call(this, request, parent, isMain);
};

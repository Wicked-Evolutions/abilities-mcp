'use strict';

const { CredentialCoordinator } = require('../../../lib/auth/credential-coordinator');
const { MemorySecretStore } = require('../../../lib/auth/memory-secret-store');

const [stateRoot, identity, holdMs] = process.argv.slice(2);
const coordinator = new CredentialCoordinator({
  secretStore: new MemorySecretStore(),
  deps: { stateRoot },
});

(async () => {
  try {
    await coordinator.withCredentialLock(identity, 'test', async () => {
      process.stdout.write('locked\n');
      if (Number(holdMs) > 0) await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
    });
    process.stdout.write('released\n');
  } catch (err) {
    process.stdout.write(`error:${err.code || 'unknown'}\n`);
    process.exitCode = 2;
  }
})();

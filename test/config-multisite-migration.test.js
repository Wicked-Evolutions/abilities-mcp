'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { migrateMisplacedMultisiteBlocks } = require('../lib/config');

/**
 * Bridge-boot migration for Issue #77.
 *
 * `migrateMisplacedMultisiteBlocks(config)` is called from `loadConfigFile`
 * after wp-sites.json is parsed. It mutates `config.sites[*].multisite` in
 * place: subsite-rooted blocks (blocks whose entries point at a parent domain
 * of the owning site's hostname) are dropped iff the corresponding
 * network-root URL is also a configured site. Blocks are LEFT INTACT when the
 * network-root entry is absent — operators upgrading without yet adding the
 * network-root URL keep their dot-notation routing as fallback.
 *
 * On-disk wp-sites.json is NOT rewritten; the migration is in-memory only and
 * runs on every boot (idempotent — second boot finds nothing to drop).
 *
 * Reproduces the failure shape from #77 step 5: the operator's wp-sites.json
 * had multisite blocks on each subsite entry but NOT on the network-root
 * entry. That distinction matters for the "leave intact" branch — see the
 * "network-root absent" test below.
 */

function rootSite() {
  return {
    url: 'https://wickedevolutions.com',
    label: 'wickedevolutions.com',
    auth: { method: 'oauth' },
  };
}

function subsiteSite(host, multisiteBlock) {
  const s = {
    url: `https://${host}`,
    label: host,
    auth: { method: 'oauth' },
  };
  if (multisiteBlock) s.multisite = multisiteBlock;
  return s;
}

// Reproduces the 3-subsite-block shape from #77 reproduction context:
// each subsite carries a multisite block listing the network from its
// own perspective (containing the network-root host as one entry).
function subsiteRootedBlock() {
  return {
    wickedevolutions: 'https://wickedevolutions.com',
    test1: 'https://test1.wickedevolutions.com',
    knowledge: 'https://knowledge.wickedevolutions.com',
  };
}

describe('migrateMisplacedMultisiteBlocks (#77)', () => {
  it('drops subsite-rooted block when network-root entry IS configured', () => {
    const config = {
      sites: {
        'wickedevolutions': rootSite(),
        'wicked-community': subsiteSite('community.wickedevolutions.com', subsiteRootedBlock()),
      },
    };
    const messages = migrateMisplacedMultisiteBlocks(config);

    assert.equal(config.sites['wicked-community'].multisite, undefined,
      'subsite-rooted block must be dropped when network root is also configured');
    assert.equal(messages.length, 1);
    assert.match(messages[0], /wicked-community/);
    assert.match(messages[0], /wickedevolutions/);
    assert.match(messages[0], /#77/);
  });

  it('drops subsite-rooted blocks across multiple subsites — one message per drop', () => {
    // Mirrors the #77 reproduction context: three subsites each carrying their
    // own subsite-rooted block, network root also configured.
    const config = {
      sites: {
        'wickedevolutions': rootSite(),
        'wicked-community': subsiteSite('community.wickedevolutions.com', subsiteRootedBlock()),
        'wicked-test1': subsiteSite('test1.wickedevolutions.com', subsiteRootedBlock()),
        'wicked-knowledge': subsiteSite('knowledge.wickedevolutions.com', subsiteRootedBlock()),
      },
    };
    const messages = migrateMisplacedMultisiteBlocks(config);

    assert.equal(config.sites['wicked-community'].multisite, undefined);
    assert.equal(config.sites['wicked-test1'].multisite, undefined);
    assert.equal(config.sites['wicked-knowledge'].multisite, undefined);
    assert.equal(messages.length, 3);
  });

  it('LEAVES block intact when network-root entry is ABSENT (operator needs it for routing)', () => {
    // No 'wickedevolutions' entry — operator's only path to dot-notation
    // routing is the misplaced subsite block. Migration must preserve it
    // until the operator adds the network-root URL.
    const config = {
      sites: {
        'wicked-community': subsiteSite('community.wickedevolutions.com', subsiteRootedBlock()),
      },
    };
    const messages = migrateMisplacedMultisiteBlocks(config);

    assert.deepEqual(config.sites['wicked-community'].multisite, subsiteRootedBlock(),
      'block must remain intact byte-equivalent when network root is not configured');
    assert.equal(messages.length, 0);
  });

  it('does NOT touch a properly-rooted block (no parent-domain entry in the block)', () => {
    // Network-root entry has a multisite block whose entries are all proper
    // subsites of the root. No entry in the block has a hostname that's a
    // parent of the root's hostname → not subsite-rooted → leave alone.
    const properBlock = {
      community: 'https://community.wickedevolutions.com',
      test1: 'https://test1.wickedevolutions.com',
    };
    const config = {
      sites: {
        'wickedevolutions': { ...rootSite(), multisite: properBlock },
      },
    };
    const messages = migrateMisplacedMultisiteBlocks(config);

    assert.deepEqual(config.sites['wickedevolutions'].multisite, properBlock);
    assert.equal(messages.length, 0);
  });

  it('idempotent — second run on a migrated config is a no-op', () => {
    const config = {
      sites: {
        'wickedevolutions': rootSite(),
        'wicked-community': subsiteSite('community.wickedevolutions.com', subsiteRootedBlock()),
      },
    };
    const m1 = migrateMisplacedMultisiteBlocks(config);
    const m2 = migrateMisplacedMultisiteBlocks(config);
    assert.equal(m1.length, 1);
    assert.equal(m2.length, 0, 'second migration on an already-migrated config emits no messages');
  });

  it('empty / malformed config — no-op, no throw', () => {
    assert.deepEqual(migrateMisplacedMultisiteBlocks(null), []);
    assert.deepEqual(migrateMisplacedMultisiteBlocks({}), []);
    assert.deepEqual(migrateMisplacedMultisiteBlocks({ sites: null }), []);
    assert.deepEqual(migrateMisplacedMultisiteBlocks({ sites: {} }), []);
  });

  it('mixed: drops subsite blocks but preserves a properly-rooted block on the network-root entry', () => {
    // Realistic post-fix state: operator added the network root after upgrading;
    // network root has a proper block (built from its own perspective), subsites
    // still carry their old subsite-rooted blocks. Migration drops only the
    // misplaced ones.
    const properBlock = {
      community: 'https://community.wickedevolutions.com',
      test1: 'https://test1.wickedevolutions.com',
    };
    const config = {
      sites: {
        'wickedevolutions': { ...rootSite(), multisite: properBlock },
        'wicked-community': subsiteSite('community.wickedevolutions.com', subsiteRootedBlock()),
      },
    };
    const messages = migrateMisplacedMultisiteBlocks(config);

    assert.deepEqual(config.sites['wickedevolutions'].multisite, properBlock,
      'properly-rooted block on network-root entry is preserved');
    assert.equal(config.sites['wicked-community'].multisite, undefined,
      'subsite-rooted block on subsite entry is dropped');
    assert.equal(messages.length, 1);
  });
});

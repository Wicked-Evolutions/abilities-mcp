#!/usr/bin/env node
'use strict';

// Simulate CLI args so config.js doesn't crash
process.argv = ['node', 'abilities-mcp.js'];

const { HttpTransport } = require('./lib/transports/http-transport');

// Monkey-patch _post to trace session handling
const origPost = HttpTransport.prototype._post;
HttpTransport.prototype._post = function(body) {
  var msg = JSON.parse(body);
  var method = msg.method || ('call:' + (msg.params && msg.params.name));
  process.stderr.write('>>> POST ' + method + ' sid=' + (this.sessionId ? 'YES' : 'no') + ' tok=' + (this.sessionToken ? 'YES' : 'no') + '\n');
  return origPost.call(this, body).then(function(r) {
    process.stderr.write('<<< HTTP ' + r.statusCode + ' len=' + r.body.length + ' sid=' + (this.sessionId ? 'YES' : 'no') + ' tok=' + (this.sessionToken ? 'YES' : 'no') + '\n');
    return r;
  }.bind(this));
};

const { loadConfig } = require('./lib/config');
const { ConnectionPool } = require('./lib/connection-pool');

var config = loadConfig({});
var log = function() { process.stderr.write('[pool] ' + Array.from(arguments).join(' ') + '\n'); };
var pool = new ConnectionPool(config, log);

(async function() {
  var transport = pool._createTransport(config.defaultSite, null);
  transport.onMessage = function(parsed, raw) {
    if (parsed && parsed.result && parsed.result.tools) {
      process.stderr.write('=== TOOLS RECEIVED: ' + parsed.result.tools.length + ' ===\n');
    } else if (parsed && parsed.result && parsed.result.protocolVersion) {
      process.stderr.write('=== INIT RESPONSE OK ===\n');
    } else if (parsed && parsed.error) {
      process.stderr.write('=== ERROR: ' + parsed.error.message + ' ===\n');
    } else {
      process.stderr.write('=== MSG: ' + JSON.stringify(parsed).substring(0, 300) + ' ===\n');
    }
  };
  await transport.connect();

  process.stderr.write('\n--- Step 1: initialize ---\n');
  transport.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1.0'}}}));

  await new Promise(function(r) { setTimeout(r, 5000); });

  process.stderr.write('\n--- Step 2: initialized notification ---\n');
  transport.send(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'}));

  await new Promise(function(r) { setTimeout(r, 3000); });

  process.stderr.write('\n--- Step 3: tools/list ---\n');
  transport.send(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'}));

  await new Promise(function(r) { setTimeout(r, 15000); });

  process.stderr.write('\nDone.\n');
  process.exit(0);
})();

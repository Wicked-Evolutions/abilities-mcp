#!/usr/bin/env node
'use strict';

var spawn = require('child_process').spawn;
var proc = spawn('node', ['wp-abilities-mcp.js'], {
  cwd: __dirname,
  stdio: ['pipe', 'pipe', 'pipe']
});

var responses = [];
var buffer = '';

proc.stderr.on('data', function(d) {
  process.stderr.write('[bridge-stderr] ' + d.toString());
});

proc.stdout.on('data', function(d) {
  buffer += d.toString();
  var lines = buffer.split('\n');
  buffer = lines.pop(); // keep incomplete line
  lines.forEach(function(line) {
    if (!line.trim()) return;
    try {
      var parsed = JSON.parse(line);
      responses.push(parsed);
      if (parsed.result && parsed.result.tools) {
        console.log('TOOLS:', parsed.result.tools.length);
        parsed.result.tools.slice(0, 5).forEach(function(t) { console.log(' -', t.name); });
      } else if (parsed.result && parsed.result.protocolVersion) {
        console.log('INIT OK:', parsed.result.protocolVersion);
      } else if (parsed.error) {
        console.log('ERROR:', parsed.error.message);
      } else {
        console.log('RESP:', JSON.stringify(parsed).substring(0, 200));
      }
    } catch(e) {
      console.log('RAW:', line.substring(0, 200));
    }
  });
});

function send(obj) {
  var s = JSON.stringify(obj);
  console.log('\n>>> SENDING:', obj.method || obj.id);
  proc.stdin.write(s + '\n');
}

// Step 1: initialize
send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'bridge-test',version:'1.0'}}});

// Step 2: wait, then send initialized
setTimeout(function() {
  send({jsonrpc:'2.0',method:'notifications/initialized'});
}, 3000);

// Step 3: wait, then send tools/list
setTimeout(function() {
  send({jsonrpc:'2.0',id:2,method:'tools/list'});
}, 6000);

// Step 4: timeout and report
setTimeout(function() {
  console.log('\n=== FINAL STATE ===');
  console.log('Total responses:', responses.length);
  responses.forEach(function(r, i) {
    if (r.result && r.result.tools) {
      console.log('Response', i, ': tools/list with', r.result.tools.length, 'tools');
    } else if (r.error) {
      console.log('Response', i, ': ERROR:', r.error.message);
    } else {
      console.log('Response', i, ': id=' + r.id);
    }
  });
  proc.kill();
  process.exit(0);
}, 30000);

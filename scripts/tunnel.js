#!/usr/bin/env node
'use strict';
/* Puts the local vault on a public https URL using Cloudflare's free
 * quick tunnel. Nothing to sign up for; the URL lives as long as this runs. */
const { spawn, spawnSync } = require('child_process');

const PORT = Number(process.env.PORT) || 4477;
const target = 'http://localhost:' + PORT;

function have(cmd) {
  const probe = spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
  return probe.status === 0;
}

if (!have('cloudflared')) {
  console.error('\n  cloudflared install nahi hai.\n');
  console.error('  Windows par ek baar ye chala lijiye:\n');
  console.error('      winget install --id Cloudflare.cloudflared\n');
  console.error('  Ya direct download: https://github.com/cloudflare/cloudflared/releases/latest');
  console.error('  (cloudflared-windows-amd64.exe download karke PATH me daal dijiye)\n');
  process.exit(1);
}

console.log('\n  Tunnel khul raha hai for ' + target + ' ...\n');
const proc = spawn('cloudflared', ['tunnel', '--url', target, '--no-autoupdate'], {
  shell: process.platform === 'win32',
});

let announced = false;
function scan(chunk) {
  const text = chunk.toString();
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (match && !announced) {
    announced = true;
    const url = match[0];
    console.log('\n  ============================================================');
    console.log('   PUBLIC LINK:  ' + url);
    console.log('   Share links:  ' + url + '/s/<token>');
    console.log('  ============================================================');
    console.log('\n  Ye window band mat kijiye. Band karte hi link band ho jayega.\n');
  }
}
proc.stdout.on('data', scan);
proc.stderr.on('data', scan);
proc.on('exit', (code) => {
  console.log('\n  Tunnel band ho gaya (exit ' + code + ').');
  process.exit(code || 0);
});
process.on('SIGINT', () => proc.kill());

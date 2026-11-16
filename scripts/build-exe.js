#!/usr/bin/env node
// Builds the helper as a single executable with no Node.js needed to run it
// (Node "single executable application", SEA). It builds for the OS it runs on:
// run it on Windows to get a .exe (the GitHub Actions workflow does exactly that).
//
//   npm install
//   node scripts/build-exe.js            -> dist/pokebonk-presence-helper(.exe)
//
// Optional: set DISCORD_CLIENT_ID to embed a default Application ID, so users don't need a config.json.
//   --blob-only    stop after creating the SEA blob (no injection); handy for debugging.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const blobOnly = process.argv.includes('--blob-only');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const outName = 'pokebonk-presence-helper' + (isWin ? '.exe' : '');
const outFile = path.join(dist, outName);
const blobFile = path.join(dist, 'sea-prep.blob');
// Fixed value defined by Node's SEA documentation.
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const step = (msg) => console.log(`\n==> ${msg}`);
function fail(msg) {
  console.error(`\nError: ${msg}`);
  process.exit(1);
}

// --- 0. Node version: SEA assets need 20.12+ ---
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  fail(`Node.js 20.12 or newer is required to build the executable (this is ${process.version}).`);
}

// --- 1. Clean dist ---
step('Preparing dist/');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// --- 2. Main script: the helper without its shebang line (it is not needed inside the executable) ---
const mainFile = path.join(dist, 'main.js');
const source = fs.readFileSync(path.join(root, 'helper', 'server.js'), 'utf8').replace(/^#!.*\r?\n/, '');
fs.writeFileSync(mainFile, source);

// --- 3. SEA config (+ optional embedded default Application ID) ---
const config = {
  main: mainFile,
  output: blobFile,
  disableExperimentalSEAWarning: true,
};
const clientId = (process.env.DISCORD_CLIENT_ID || '').trim();
if (clientId) {
  if (!/^\d{15,25}$/.test(clientId)) fail('DISCORD_CLIENT_ID must be a long number (the Application ID).');
  const assetFile = path.join(dist, 'default-config.json');
  fs.writeFileSync(assetFile, JSON.stringify({ clientId }));
  config.assets = { 'default-config.json': assetFile };
  console.log('Embedding the default Application ID from DISCORD_CLIENT_ID.');
} else {
  console.log('No DISCORD_CLIENT_ID set: users will need a config.json or the DISCORD_CLIENT_ID variable.');
}
const configFile = path.join(dist, 'sea-config.json');
fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

// --- 4. Create the blob ---
step('Creating the SEA blob');
execFileSync(process.execPath, ['--experimental-sea-config', configFile], { stdio: 'inherit' });
if (!fs.existsSync(blobFile)) fail('The SEA blob was not created.');
console.log(`Blob: ${(fs.statSync(blobFile).size / 1024).toFixed(0)} KB`);
if (blobOnly) {
  console.log('\n--blob-only: stopping here.');
  process.exit(0);
}

// --- 5. Copy the Node binary ---
step(`Copying the Node binary to ${path.relative(root, outFile)}`);
fs.copyFileSync(process.execPath, outFile);
if (!isWin) fs.chmodSync(outFile, 0o755);

// Remove the existing signature first (the injection invalidates it anyway). Best effort.
if (isMac) {
  try { execFileSync('codesign', ['--remove-signature', outFile], { stdio: 'inherit' }); } catch (_) { /* ignore */ }
} else if (isWin) {
  try { execFileSync('signtool', ['remove', '/s', outFile], { stdio: 'ignore' }); } catch (_) { /* signtool not on PATH: fine */ }
}

// --- 5b. Optional custom icon (assets/icon.ico). Only possible when building on Windows. ---
// Done BEFORE the injection. A failure here is cosmetic, so it only warns.
const iconFile = path.join(root, 'assets', 'icon.ico');
if (!fs.existsSync(iconFile)) {
  console.log('\nNo assets/icon.ico: the executable keeps the default Node.js icon.');
} else if (!isWin) {
  console.log('\nassets/icon.ico found, but icons can only be applied when building on Windows: skipping.');
} else {
  step('Applying assets/icon.ico (rcedit)');
  // rcedit may be CommonJS or ESM depending on its version, so load it with a dynamic import.
  const applyIcon = `
    import('rcedit')
      .then((m) => (m.default || m.rcedit || m)(process.argv[1], { icon: process.argv[2] }))
      .then(() => process.exit(0))
      .catch((e) => { console.error(e); process.exit(1); });`;
  try {
    execFileSync(process.execPath, ['-e', applyIcon, outFile, iconFile], { stdio: 'inherit', cwd: root });
  } catch (_) {
    console.warn('Warning: could not apply the icon, continuing with the default Node.js icon.');
  }
}

// --- 6. Inject the blob with postject ---
step('Injecting the blob (postject)');
let postjectCli;
try {
  const pkgPath = require.resolve('postject/package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin.postject;
  postjectCli = path.join(path.dirname(pkgPath), bin);
} catch (_) {
  fail('postject is not installed. Run "npm install" first.');
}
const args = [postjectCli, outFile, 'NODE_SEA_BLOB', blobFile, '--sentinel-fuse', SENTINEL_FUSE];
if (isMac) args.push('--macho-segment-name', 'NODE_SEA');
execFileSync(process.execPath, args, { stdio: 'inherit' });

if (isMac) execFileSync('codesign', ['--sign', '-', outFile], { stdio: 'inherit' });

step('Done');
console.log(`${path.relative(root, outFile)}  (${(fs.statSync(outFile).size / 1024 / 1024).toFixed(0)} MB)`);

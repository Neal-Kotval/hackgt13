import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Only explicit build outputs and runtime dependencies enter the distributable.
export function copyRuntimeTree(name, fromDirectory, destination) {
  const require = createRequire(path.join(fromDirectory, 'package.json'));
  const source = path.dirname(require.resolve(`${name}/package.json`));
  const target = path.join(destination, 'node_modules', name);
  if (existsSync(target)) return;
  const manifest = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));
  cpSync(source, target, {
    recursive: true,
    dereference: true,
    filter: file => !file.endsWith('.node') && !path.relative(source, file).split(path.sep).includes('node_modules'),
  });
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    copyRuntimeTree(dependency, source, destination);
  }
}

// A configured release has a public backend default; developer builds retain localhost.
// Keep the origin separate from secrets and honor explicit runtime overrides.
export function createPackagedBootstrap(serverUrl) {
  if (!serverUrl?.trim()) return null;
  let url;
  try { url = new URL(serverUrl.trim()); }
  catch { throw new Error('ALTO_DESKTOP_SERVER_URL must be an HTTPS origin (HTTP is allowed only on loopback).'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ALTO_DESKTOP_SERVER_URL must be a credential-free HTTPS origin without a path, query, or fragment (HTTP is allowed only on loopback).');
  }
  return `if (!process.env.AGENTCLOUD_URL && !process.env.BETTER_AUTH_URL) {\n  process.env.AGENTCLOUD_URL = ${JSON.stringify(url.origin)};\n}\nawait import('./dist-electron/main.js');\n`;
}

export function packageMacOS(desktop) {
  const bootstrap = createPackagedBootstrap(process.env.ALTO_DESKTOP_SERVER_URL);
  if (process.platform !== 'darwin') throw new Error('DMG packaging requires macOS.');
  for (const file of ['dist/index.html', 'dist-electron/main.js', 'dist-electron/preload.cjs', 'cli/alto.mjs']) {
    if (!existsSync(path.join(desktop, file))) throw new Error(`Missing ${file}; build desktop and include the alto CLI first.`);
  }
  const metadata = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8'));
  const require = createRequire(path.join(desktop, 'package.json'));
  const electronApp = path.resolve(require('electron'), '../../..');
  const output = path.resolve(desktop, '../artifacts/desktop');
  mkdirSync(output, { recursive: true });
  const dmg = path.join(output, `alto-${metadata.version}-macos-${process.arch}.dmg`);
  if (existsSync(dmg)) throw new Error(`Artifact already exists: ${dmg}. Move it before packaging again.`);
  const staging = mkdtempSync(path.join(output, '.package-'));
  const bundle = path.join(staging, 'alto.app');
  try {
    execFileSync('/usr/bin/ditto', [electronApp, bundle]);
    const resources = path.join(bundle, 'Contents/Resources');
    rmSync(path.join(resources, 'default_app.asar'), { force: true });
    const app = path.join(resources, 'app');
    mkdirSync(app);
    for (const directory of ['dist', 'dist-electron', 'cli']) cpSync(path.join(desktop, directory), path.join(app, directory), { recursive: true, dereference: true });
    if (bootstrap) writeFileSync(path.join(app, 'bootstrap.mjs'), bootstrap);
    writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, main: bootstrap ? 'bootstrap.mjs' : metadata.main, type: 'module' }, null, 2));
    copyRuntimeTree('ssh2', desktop, app);
    mkdirSync(path.join(resources, 'bin'));
    cpSync(path.join(desktop, 'scripts/alto-launcher'), path.join(resources, 'bin/alto'));
    const plist = path.join(bundle, 'Contents/Info.plist');
    const edit = command => execFileSync('/usr/libexec/PlistBuddy', ['-c', command, plist]);
    edit('Set :CFBundleIdentifier com.agentcloud.desktop');
    edit('Set :CFBundleName alto');
    edit('Set :CFBundleDisplayName alto');
    edit(`Set :CFBundleShortVersionString ${metadata.version}`);
    edit(`Set :CFBundleVersion ${metadata.version}`);
    edit('Add :CFBundleURLTypes array');
    edit('Add :CFBundleURLTypes:0 dict');
    edit('Add :CFBundleURLTypes:0:CFBundleURLName string alto environment links');
    edit('Add :CFBundleURLTypes:0:CFBundleURLSchemes array');
    edit('Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string agentcloud');
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'pipe' });
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'pipe' });
    // Check the real bundled Node runtime and copied dependency before publishing.
    execFileSync(path.join(bundle, 'Contents/MacOS/Electron'), ['-e', 'require("ssh2")'], { cwd: app, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe' });
    execFileSync(path.join(resources, 'bin/alto'), ['--help'], { stdio: 'pipe' });
    symlinkSync('/Applications', path.join(staging, 'Applications'));
    writeFileSync(path.join(staging, 'Install CLI.txt'), 'Drag alto.app to Applications and launch it. Sign in, then run:\n\n/Applications/alto.app/Contents/Resources/bin/alto install\n\nAdd ~/.local/bin to your PATH if prompted. Run alto --help for commands.\n\nThis development build is ad-hoc signed, not Developer ID signed or notarized.\n');
    execFileSync('/usr/bin/hdiutil', ['create', '-volname', 'alto', '-srcfolder', staging, '-format', 'UDZO', dmg], { stdio: 'inherit' });
    console.log(`Created ${dmg} (ad-hoc signed; not notarized).`);
    return dmg;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) packageMacOS(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

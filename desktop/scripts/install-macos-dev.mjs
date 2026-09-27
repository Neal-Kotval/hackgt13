// Local development bundle: macOS URL handlers cannot retain `electron .` arguments.
// This is deliberately a development launcher, not a distributable release.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('This launcher is for macOS. Use npm run dev on other platforms.');
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const file of ['dist/index.html', 'dist-electron/main.js', 'dist-electron/preload.cjs']) {
  if (!existsSync(path.join(desktop, file))) throw new Error('Build desktop first: npm run build');
}
const require = createRequire(path.join(desktop, 'package.json'));
const source = process.env.AGENTCLOUD_ELECTRON_APP || path.resolve(require('electron'), '../../..');
if (!existsSync(path.join(source, 'Contents/MacOS/Electron'))) throw new Error('Electron.app is missing. Run npm rebuild electron.');
const applications = path.join(homedir(), 'Applications');
mkdirSync(applications, { recursive: true });
const destination = path.join(applications, 'alto Development.app');
const running = execFileSync('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8' }).split('\n');
if (running.some(command => command.trim() === path.join(destination, 'Contents/MacOS/Electron'))) {
  throw new Error('Quit alto Development before reinstalling it. Your saved chats and account will be preserved.');
}
const staging = mkdtempSync(path.join(applications, '.alto-dev-'));
const bundle = path.join(staging, 'alto Development.app');
try {
  execFileSync('/usr/bin/ditto', [source, bundle]);
  const plist = path.join(bundle, 'Contents/Info.plist');
  const edit = command => execFileSync('/usr/libexec/PlistBuddy', ['-c', command, plist], { stdio: 'pipe' });
  edit('Set :CFBundleIdentifier com.agentcloud.desktop.development');
  edit('Set :CFBundleName alto Development');
  edit('Set :CFBundleDisplayName alto Development');
  try { edit('Delete :CFBundleURLTypes'); } catch { /* Fresh Electron has none. */ }
  edit('Add :CFBundleURLTypes array');
  edit('Add :CFBundleURLTypes:0 dict');
  edit('Add :CFBundleURLTypes:0:CFBundleURLName string alto environment links');
  edit('Add :CFBundleURLTypes:0:CFBundleURLSchemes array');
  edit('Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string agentcloud');
  // Loading resources/app makes this an app launch, even when macOS passes no argv.
  symlinkSync(desktop, path.join(bundle, 'Contents/Resources/app'), 'dir');
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', bundle], { stdio: 'pipe' });
  // Replace only this installer-owned development bundle after successful staging.
  if (existsSync(destination)) {
    const id = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(destination, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
    if (id !== 'com.agentcloud.desktop.development') throw new Error('Refusing to replace an unrelated application.');
    rmSync(destination, { recursive: true });
  }
  renameSync(bundle, destination);
  execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', destination]);
  execFileSync('/usr/bin/open', [destination]);
  console.log(`Installed ${destination}. Keep this worktree to run the development app.`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyRuntimeTree } from '../scripts/package-macos.mjs';

const desktop = fileURLToPath(new URL('..', import.meta.url));

test('launcher works through relative and absolute symlinks and paths with spaces', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'alto packaging '));
  try {
    const contents = path.join(directory, 'alto test.app/Contents');
    const bin = path.join(contents, 'Resources/bin');
    mkdirSync(bin, { recursive: true });
    mkdirSync(path.join(contents, 'MacOS'));
    const launcher = path.join(bin, 'alto');
    cpSync(path.join(desktop, 'scripts/alto-launcher'), launcher);
    writeFileSync(path.join(contents, 'MacOS/Electron'), '#!/bin/sh\nprintf "%s\\n" "$ELECTRON_RUN_AS_NODE" "$ALTO_LAUNCHER_PATH" "$@"\n', { mode: 0o755 });
    symlinkSync(launcher, path.join(directory, 'absolute'));
    symlinkSync('absolute', path.join(directory, 'relative'));
    const result = execFileSync(path.join(directory, 'relative'), ['ssh', 'box id', '--', 'echo hello'], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(result, ['1', realpathSync(launcher), realpathSync(bin) + '/../app/cli/alto.mjs', 'ssh', 'box id', '--', 'echo hello']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('copied ssh2 tree loads independently without optional native binaries', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'alto runtime '));
  try {
    copyRuntimeTree('ssh2', desktop, directory);
    assert.ok(existsSync(path.join(directory, 'node_modules/ssh2/package.json')));
    assert.ok(!existsSync(path.join(directory, 'node_modules/cpu-features')));
    const result = execFileSync(process.execPath, ['-e', 'console.log(typeof require("ssh2").Client)'], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.trim(), 'function');
    assert.ok(readFileSync(path.join(directory, 'node_modules/ssh2/LICENSE'), 'utf8').length > 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

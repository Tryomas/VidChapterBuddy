import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export function parseBase(value) {
  const base = value.trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(base) || base.split('.').some(n => Number(n) > 65535)) {
    throw new Error('version.txt must contain a major.minor version, such as 1.0 (components at most 65535).');
  }
  return base;
}
export function releaseVersion(cwd = process.cwd()) {
  const base = parseBase(readFileSync(join(cwd, 'version.txt'), 'utf8'));
  const commits = git(cwd, 'rev-list', '--first-parent', 'HEAD').split('\n');
  let patch = 0;
  for (const commit of commits) {
    let previous;
    try { previous = git(cwd, 'show', `${commit}:version.txt`); }
    catch { break; } // Earlier commits predate this version scheme.
    if (previous !== base) {
      if (/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(previous)) {
        const [a, b] = base.split('.').map(Number), [x, y] = previous.split('.').map(Number);
        if (a < x || (a === x && b <= y)) throw new Error('The version base must increase when changing version.txt. Do not reuse an earlier base.');
      }
      break;
    }
    patch++;
  }
  patch = Math.max(0, patch - 1); // The commit establishing the base is major.minor.0.
  if (patch > 65535) throw new Error('Increment the major.minor base in version.txt before exceeding 65535 mainline commits.');
  return `${base}.${patch}`;
}
export function stampVersion(cwd, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version.');
  for (const file of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json']) {
    const path = join(cwd, file), data = JSON.parse(readFileSync(path, 'utf8'));
    data.version = version;
    if (file === 'package-lock.json') data.packages[''].version = version;
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  }
  const manifest = join(cwd, 'src-tauri/Cargo.toml');
  let toml = readFileSync(manifest, 'utf8');
  const pattern = /(\[package\][\s\S]*?\nversion\s*=\s*)"[^"]+"/;
  if (!pattern.test(toml)) throw new Error('Application Cargo version not found.');
  writeFileSync(manifest, toml.replace(pattern, `$1"${version}"`));
  const lock = join(cwd, 'src-tauri/Cargo.lock');
  let found = 0;
  const contents = readFileSync(lock, 'utf8').replace(/\[\[package\]\][\s\S]*?(?=\n\[\[package\]\]|$)/g, block => {
    if (!/^name = "vidchapterbuddy"$/m.test(block)) return block;
    found++;
    return block.replace(/^version = "[^"]+"$/m, `version = "${version}"`);
  });
  if (found !== 1) throw new Error('Expected exactly one application entry in Cargo.lock.');
  writeFileSync(lock, contents);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = releaseVersion();
  if (process.argv.includes('--write')) stampVersion(process.cwd(), version);
  console.log(version);
}

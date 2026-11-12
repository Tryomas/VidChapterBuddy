import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseBase, releaseVersion, stampVersion } from '../scripts/release-version.mjs';
import { GitHub, collectInstallers, publish } from '../scripts/github-release.mjs';

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'vidchapterbuddy-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function repository(t: { after: (fn: () => void) => void }) {
  const dir = fixture(t);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Release Test'); git('config', 'user.email', 'release@example.invalid'); git('config', 'core.autocrlf', 'false');
  const commit = (message: string) => { git('add', '--all'); git('commit', '-q', '--allow-empty', '-m', message); };
  commit('Initial source predates version scheme');
  writeFileSync(join(dir, 'version.txt'), '1.0\n'); commit('Establish release base [skip ci]');
  return { dir, git, commit };
}

test('mainline commits increment deterministically and repeated runs keep the version', t => {
  const { dir, commit } = repository(t);
  assert.equal(releaseVersion(dir), '1.0.0');
  commit('First release'); assert.equal(releaseVersion(dir), '1.0.1');
  assert.equal(releaseVersion(dir), '1.0.1');
  commit('Second release'); assert.equal(releaseVersion(dir), '1.0.2');
});
test('a merged branch counts once regardless of its internal commits', t => {
  const { dir, git, commit } = repository(t);
  git('switch', '-c', 'feature'); commit('Feature work'); commit('Feature polish');
  git('switch', 'main'); git('merge', '--no-ff', 'feature', '-m', 'Merge reviewed change');
  assert.equal(releaseVersion(dir), '1.0.1');
});
test('base increases reset the patch; whitespace never reuses a release number', t => {
  const { dir, commit } = repository(t);
  writeFileSync(join(dir, 'version.txt'), '1.0  \n'); commit('Whitespace edit'); assert.equal(releaseVersion(dir), '1.0.1');
  writeFileSync(join(dir, 'version.txt'), '1.1\n'); commit('New minor'); assert.equal(releaseVersion(dir), '1.1.0');
  commit('Fix'); assert.equal(releaseVersion(dir), '1.1.1');
  writeFileSync(join(dir, 'version.txt'), '1.0\n'); commit('Accidental rollback'); assert.throws(() => releaseVersion(dir), /must increase/);
});
test('invalid version bases are rejected before packaging', () => {
  for (const value of ['1.0.1', '01.0', '-1.0', '1.x', '65536.0']) assert.throws(() => parseBase(value));
  assert.equal(parseBase('1.0\n'), '1.0');
});
test('every application manifest is stamped without changing dependency versions', t => {
  const dir = fixture(t); mkdirSync(join(dir, 'src-tauri'));
  for (const file of ['package.json', 'src-tauri/tauri.conf.json']) writeFileSync(join(dir, file), JSON.stringify({ version: '0.1.2' }));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ version: '0.1.2', packages: { '': { version: '0.1.2' }, 'node_modules/example': { version: '2.0.0' } } }));
  writeFileSync(join(dir, 'src-tauri/Cargo.toml'), '[package]\nname = "vidchapterbuddy"\nversion = "0.1.2"\n[dependencies]\nexample = "2.0.0"\n');
  writeFileSync(join(dir, 'src-tauri/Cargo.lock'), '[[package]]\nname = "example"\nversion = "2.0.0"\n\n[[package]]\nname = "vidchapterbuddy"\nversion = "0.1.2"\n');
  stampVersion(dir, '1.0.3');
  for (const file of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json']) assert.equal(JSON.parse(readFileSync(join(dir, file), 'utf8')).version, '1.0.3');
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].version, '1.0.3'); assert.equal(lock.packages['node_modules/example'].version, '2.0.0');
  const cargo = readFileSync(join(dir, 'src-tauri/Cargo.lock'), 'utf8');
  assert.match(cargo, /name = "vidchapterbuddy"\nversion = "1.0.3"/); assert.match(cargo, /name = "example"\nversion = "2.0.0"/);
});
const names = ['VidChapterBuddy_1.0.1.AppImage', 'vidchapterbuddy_1.0.1.deb', 'VidChapterBuddy-1.0.1.rpm', 'vidchapterbuddy_1.0.1_x64-setup.exe', 'VidChapterBuddy_1.0.1_universal.dmg'];
test('only a complete matching installer set produces the checksum file', async t => {
  const dir = fixture(t), input = join(dir, 'downloads'), output = join(dir, 'assets'); mkdirSync(input);
  for (const name of names) writeFileSync(join(input, name), `installer:${name}`);
  const assets = await collectInstallers(input, output, '1.0.1'); assert.equal(assets.length, 6);
  const sums = readFileSync(join(output, 'SHA256SUMS.txt'), 'utf8');
  for (const name of names) assert.ok(sums.includes(`${createHash('sha256').update(`installer:${name}`).digest('hex')}  ${name}`));
  await assert.rejects(collectInstallers(input, output, '1.0.2'), /Expected exactly one/);
  rmSync(join(input, names[4])); await assert.rejects(collectInstallers(input, output, '1.0.1'), /Expected exactly one/);
});
const sha = 'a'.repeat(40);
function fake(options: { private?: boolean; wrongTag?: boolean; published?: boolean; draft?: boolean; missingAsset?: boolean } = {}) {
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  const assets = [...names, 'SHA256SUMS.txt'];
  const client = new GitHub('owner/repository', 'test-token', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace('/repos/owner/repository', ''), method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined; calls.push({ path, method, body });
    let status = 200, value: unknown;
    if (!path) value = { private: options.private ?? true };
    else if (path.startsWith('/git/ref/tags/')) {
      if (options.wrongTag || options.published) value = { object: { type: 'commit', sha: options.wrongTag ? 'b'.repeat(40) : sha } };
      else { status = 404; value = {}; }
    } else if (path.startsWith('/releases/tags/')) {
      if (options.published || options.draft) value = { id: 1, draft: !options.published, target_commitish: sha };
      else { status = 404; value = {}; }
    } else if (path === '/releases' && method === 'POST') value = { id: 1, draft: true };
    else if (path.includes('/assets')) value = (options.missingAsset ? assets.slice(1) : assets).map(name => ({ name, state: 'uploaded', size: 100 }));
    else if (method === 'PATCH') value = { id: 1, draft: false, html_url: 'https://github.com/owner/repository/releases/tag/v1.0.1' };
    else throw new Error(`Unexpected API path ${path}`);
    return new Response(JSON.stringify(value), { status });
  });
  return { client, calls, assets };
}
test('public repositories and conflicting tags fail before any upload', async () => {
  for (const options of [{ private: false }, { wrongTag: true }]) {
    const { client, calls, assets } = fake(options);
    await assert.rejects(publish(client, '1.0.1', sha, assets, () => assert.fail('Must not upload')));
    assert.ok(calls.every(c => c.method === 'GET'));
  }
});
test('failed uploads or missing assets leave the release unpublished', async () => {
  const failed = fake(); await assert.rejects(publish(failed.client, '1.0.1', sha, failed.assets, () => { throw new Error('Upload failed'); }));
  assert.ok(!failed.calls.some(c => c.method === 'PATCH'));
  const missing = fake({ missingAsset: true }); await assert.rejects(publish(missing.client, '1.0.1', sha, missing.assets, () => {}), /asset missing/);
  assert.ok(!missing.calls.some(c => c.method === 'PATCH'));
});
test('complete drafts publish after upload and reruns never replace published assets', async () => {
  for (const draft of [false, true]) {
    const state = fake({ draft }); let uploaded = false;
    const result = await publish(state.client, '1.0.1', sha, state.assets, (_tag: string, files: string[]) => { assert.equal(files.length, 6); uploaded = true; });
    assert.equal(result.draft, false); assert.ok(uploaded);
    assert.deepEqual(state.calls.find(c => c.method === 'PATCH')?.body, { draft: false, make_latest: 'legacy' });
    assert.equal(state.calls.filter(c => c.method === 'POST').length, draft ? 0 : 1);
  }
  const done = fake({ published: true }); await publish(done.client, '1.0.1', sha, done.assets, () => assert.fail('Published binaries must remain unchanged'));
  assert.ok(done.calls.every(c => c.method === 'GET'));
});

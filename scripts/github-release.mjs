import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, appendFileSync, copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseVersion } from './release-version.mjs';

export class GitHub {
  constructor(repository, token, fetcher = fetch) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) throw new Error('Repository and GitHub token are required.');
    this.repository = repository; this.token = token; this.fetcher = fetcher;
  }
  async api(path = '', { method = 'GET', body, missing = false } = {}) {
    const response = await this.fetcher(`https://api.github.com/repos/${this.repository}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2026-03-10', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${path || '/'} failed (${response.status}).`);
    return response.status === 204 ? null : response.json();
  }
  async inspect(version, sha) {
    if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('A committed release version and full commit SHA are required.');
    const repository = await this.api();
    if (repository.private !== true) throw new Error('Release publishing is restricted to a private repository.');
    const tag = `v${version}`;
    let reference = await this.api(`/git/ref/tags/${tag}`, { missing: true });
    let object = reference?.object;
    for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) object = (await this.api(`/git/tags/${object.sha}`)).object;
    if (object && (object.type !== 'commit' || object.sha !== sha)) throw new Error(`${tag} already points at a different commit. Refusing to overwrite it.`);
    const release = await this.api(`/releases/tags/${tag}`, { missing: true });
    if (release && !object && !release.draft) throw new Error('Published release has no verifiable commit tag.');
    if (release?.draft && release.target_commitish !== sha) throw new Error('Existing draft targets a different commit.');
    return { tag, release, published: !!release && !release.draft };
  }
}
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
}
export async function collectInstallers(input, output, version) {
  const candidates = walk(input);
  const patterns = [/\.AppImage$/, /\.deb$/, /\.rpm$/, /-setup\.exe$/, /\.dmg$/];
  const files = patterns.map(pattern => {
    const matches = candidates.filter(file => pattern.test(basename(file)));
    if (matches.length !== 1 || !basename(matches[0]).includes(version)) throw new Error(`Expected exactly one ${pattern} installer for version ${version}.`);
    return matches[0];
  });
  mkdirSync(output, { recursive: true });
  const sums = [];
  const assets = [];
  for (const source of files) {
    const destination = resolve(output, basename(source));
    copyFileSync(source, destination);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(destination)) hash.update(chunk);
    sums.push(`${hash.digest('hex')}  ${basename(destination)}`); assets.push(destination);
  }
  const checksum = resolve(output, 'SHA256SUMS.txt');
  writeFileSync(checksum, `${sums.sort().join('\n')}\n`);
  return [...assets, checksum];
}
export async function publish(client, version, sha, assets, upload) {
  const state = await client.inspect(version, sha);
  if (state.published) return state.release; // Never replace already-published binaries.
  const release = state.release ?? await client.api('/releases', { method: 'POST', body: {
    tag_name: state.tag, target_commitish: sha, name: `VidChapterBuddy ${version}`, draft: true,
    generate_release_notes: true, make_latest: 'false'
  } });
  await upload(state.tag, assets);
  const uploaded = await client.api(`/releases/${release.id}/assets?per_page=100`);
  for (const asset of assets) if (!uploaded.some(item => item.name === basename(asset) && item.state === 'uploaded' && item.size > 0)) throw new Error(`Release asset missing: ${basename(asset)}. Draft left unpublished.`);
  // Legacy selection uses semantic versions so a slower older run cannot become the latest release.
  return client.api(`/releases/${release.id}`, { method: 'PATCH', body: { draft: false, make_latest: 'legacy' } });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = releaseVersion(), sha = process.env.GITHUB_SHA;
  const client = new GitHub(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN);
  if (process.argv.includes('--prepare')) {
    const state = await client.inspect(version, sha);
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${state.tag}\npublished=${state.published}\n`);
    console.log(`${state.tag}: ${state.published ? 'already published; skipping duplicate builds' : 'ready to build'}`);
  } else {
    const assets = await collectInstallers('downloaded-installers', 'release-assets', version);
    const release = await publish(client, version, sha, assets, (tag, paths) => execFileSync('gh', ['release', 'upload', tag, ...paths, '--repo', client.repository, '--clobber'], { stdio: 'inherit' }));
    console.log(release.html_url);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Published [VidChapterBuddy ${version}](${release.html_url}) with five installers and SHA-256 checksums.\n`);
  }
}

import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const {version} = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const tag = `v${version}`;
const repository = 'RoyAdas/CodeStudio';
const commit = process.env.GITHUB_SHA;
if (process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_REF !== `refs/heads/release/${tag}` || !/^[a-f0-9]{40}$/.test(commit || '') || !process.env.GITHUB_TOKEN) throw Error('Use the verified release workflow on its matching release branch.');
const root = `https://api.github.com/repos/${repository}`;
const headers = {'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'CodeStudio-release'};
async function api(url, {method='GET', body, binary, optional=false}={}) {
  const response = await fetch(url, {method, headers:{...headers,...(binary ? {'Content-Type':'application/octet-stream'} : body ? {'Content-Type':'application/json'} : {})}, body:binary || (body ? JSON.stringify(body) : undefined), signal:AbortSignal.timeout(binary ? 180000 : 45000)});
  if (optional && response.status === 404) return null;
  if (!response.ok) throw Error(`GitHub ${method} ${new URL(url).pathname}: HTTP ${response.status}`);
  return response.status === 204 ? null : await response.json();
}
const source = await api(`${root}/git/commits/${commit}`);
const currentRef = await api(`${root}/git/ref/tags/${tag}`, {optional:true});
let oldCommit;
if (currentRef) {
  oldCommit = currentRef.object.type === 'tag' ? (await api(currentRef.object.url)).object.sha : currentRef.object.sha;
  if (oldCommit !== commit) throw Error('An existing version points to different source. Publish a new version instead.');
}
let release = await api(`${root}/releases/tags/${tag}`, {optional:true});
if (!release) {
  const releases = await api(`${root}/releases?per_page=100`);
  release = releases.find(value => value.tag_name === tag);
}
if (release?.immutable) throw Error('This release is immutable; publish a new version.');
const notes = await readFile(new URL(`../docs/release-notes/${tag}.md`, import.meta.url), 'utf8');
if (!release) release = await api(`${root}/releases`, {method:'POST',body:{tag_name:tag,target_commitish:commit,name:`CodeStudio ${tag}`,body:notes,draft:true,prerelease:false}});
const upload = release.upload_url.split('{')[0];
if (!upload.startsWith(`https://uploads.github.com/repos/${repository}/releases/`)) throw Error('Unexpected upload destination.');
const files = [];
for (const name of [`CodeStudio-${tag}-windows-x64.zip`, 'SHA256SUMS.txt']) {
  const bytes = await readFile(new URL(`../releases/${name}`, import.meta.url));
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (name.endsWith('.zip')) {
    const sums = await readFile(new URL('../releases/SHA256SUMS.txt', import.meta.url), 'utf8');
    if (!sums.includes(`${digest.slice(7)}  ${name}`)) throw Error('Package checksum file differs.');
  }
  files.push({name,bytes,digest});
}
for (const file of files) {
  const stagedName = `${file.name}.uploading-${file.digest.slice(7)}`;
  for (let attempt=0;attempt<4;attempt++) {
    release = await api(release.url);
    const final = release.assets.find(asset=>asset.name===file.name);
    if (final?.state==='uploaded' && final.size===file.bytes.length && final.digest===file.digest) {file.asset=final;break;}
    let asset = release.assets.find(asset=>asset.name===stagedName);
    if (asset?.state==='starter' && asset.size===0) {await api(asset.url,{method:'DELETE'});asset=null;}
    try {
      asset ||= await api(`${upload}?name=${encodeURIComponent(stagedName)}`,{method:'POST',binary:file.bytes});
      if (asset.state!=='uploaded' || asset.size!==file.bytes.length || asset.digest!==file.digest) throw Error('Asset bytes or checksum differ.');
      file.asset=asset;break;
    } catch (error) { if (attempt===3) throw error; await delay(2000*(attempt+1)); }
  }
  if (!file.asset) throw Error('Asset upload did not complete.');
  console.log(`Verified uploaded ${file.name}: ${file.digest}`);
}
// All validation and both uploads precede changes to the public version.
if (oldCommit !== commit) {
  const fresh = await api(`${root}/git/ref/tags/${tag}`,{optional:true});
  if ((fresh?.object.sha || null)!==(currentRef?.object.sha || null)) throw Error('Version tag changed during publication.');
  const object = await api(`${root}/git/tags`,{method:'POST',body:{tag,message:`CodeStudio ${tag}\n`,object:commit,type:'commit',tagger:source.committer}});
  await api(currentRef ? `${root}/git/refs/tags/${tag}` : `${root}/git/refs`,{method:currentRef?'PATCH':'POST',body:currentRef?{sha:object.sha,force:true}:{ref:`refs/tags/${tag}`,sha:object.sha}});
}
for (const file of files) {
  if (file.asset.name===file.name) continue;
  release = await api(release.url);
  const old = release.assets.find(asset=>asset.name===file.name);
  if (old) await api(old.url,{method:'DELETE'});
  await api(file.asset.url,{method:'PATCH',body:{name:file.name}});
}
release=await api(release.url,{method:'PATCH',body:{name:`CodeStudio ${tag}`,body:notes,draft:false,prerelease:false,make_latest:'true'}});
for (const file of files) {
  const asset=release.assets.find(asset=>asset.name===file.name);
  if (asset?.state!=='uploaded' || asset.size!==file.bytes.length || asset.digest!==file.digest) throw Error('Final public asset verification failed.');
}
// Retries may leave fully verified uploads from earlier ZIP timestamps.
release=await api(release.url);
for (const asset of release.assets) {
  if (files.some(file=>asset.name.startsWith(`${file.name}.uploading-`) && /^[a-f0-9]{64}$/.test(asset.name.slice(`${file.name}.uploading-`.length)))) await api(asset.url,{method:'DELETE'});
}
release=await api(release.url);
console.log(JSON.stringify({release:release.html_url,tag,commit,assets:release.assets.map(({name,digest})=>({name,digest}))},null,2));

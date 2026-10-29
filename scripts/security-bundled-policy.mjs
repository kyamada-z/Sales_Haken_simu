// The original validators remain unchanged. Only the reviewed initial tree may
// introduce bundled CSS; every later candidate uses the original same-major rules.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifestChange, validateLockfile } from './security-policy.mjs';

const args = process.argv.slice(2);
function get(key) { const i=args.indexOf(key); assert(i>=0 && args[i+1], `Missing ${key}`); return args[i+1]; }
const candidate = resolve(get('--repo'));
const trusted = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scope = JSON.parse(readFileSync(get('--scope'), 'utf8'));
const read=(repo,sha,path)=>JSON.parse(execFileSync('git',['-C',repo,'show',`${sha}:${path}`],{encoding:'utf8'}));
assert(/^[0-9a-f]{40}$/.test(scope.head) && /^[0-9a-f]{40}$/.test(scope.base) && /^[0-9a-f]{40}$/.test(scope.trusted));
assert.equal(execFileSync('git',['-C',trusted,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),scope.trusted);
if(scope.mode === 'bootstrap') {
  assert.equal(scope.base,'2b1ed2a0b7875375facd755e704d5c410b9a23ff');
  for(const path of ['package.json','package-lock.json']) {
    assert.deepEqual(read(candidate,scope.head,path),read(trusted,scope.trusted,path));
  }
  console.log('Reviewed bootstrap packages are exact immutable verifier bytes; the full frozen-tree gate is required separately.');
} else {
  assert.equal(scope.mode,'release');
  for(const [repo,base] of [[trusted,scope.trusted],[candidate,scope.base]]) {
    validateManifestChange(read(repo,base,'package.json'),read(candidate,scope.head,'package.json'));
    validateLockfile(read(repo,base,'package.json'),read(candidate,scope.head,'package.json'),read(repo,base,'package-lock.json'),read(candidate,scope.head,'package-lock.json'));
  }
  console.log('Original same-major validators passed against the immutable bundled-CSS baseline and current main base.');
}

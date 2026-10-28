import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  evaluateRepository,
  parseBaseArgument,
  parseChangedPaths,
  validateChangedPaths,
  validateManifestChange,
  validateLockfile,
} from './security-policy.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'security-policy.mjs');
const SHA = 'a'.repeat(40);
const manifest = () => ({
  name: 'policy-test', version: '1.0.0', type: 'module',
  scripts: { build: 'node build.mjs' }, engines: { node: '24.x' },
  dependencies: { example: '^1.2.3' }, devDependencies: { tooling: '~2.3.4' },
});
const clone = (value) => JSON.parse(JSON.stringify(value));
function lockfile(value = manifest(), actual = {}) {
  const packages = { '': { name: value.name, version: value.version, dependencies: clone(value.dependencies), devDependencies: clone(value.devDependencies) } };
  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, spec] of Object.entries(value[section] ?? {})) {
      const version = actual[name] ?? spec.replace(/^[~^]/, '');
      packages[`node_modules/${name}`] = { version, resolved: `https://registry.npmjs.org/${name}/-/${name}.tgz`, integrity: 'sha512-dGVzdA==' };
    }
  }
  return { name: value.name, version: value.version, lockfileVersion: 3, packages };
}

test('allows exact patch and same-major minor updates in both sections', () => {
  const before = manifest();
  const after = clone(before);
  after.dependencies.example = '1.2.4';
  after.devDependencies.tooling = '2.4.0';
  assert.equal(validateManifestChange(before, after).length, 2);
});

test('allows exact pinning of the existing minimum version', () => {
  const before = manifest();
  const after = clone(before);
  after.dependencies.example = '1.2.3';
  assert.equal(validateManifestChange(before, after).length, 1);
});

test('ignores object key ordering and accepts unchanged manifests', () => {
  const before = manifest();
  const after = Object.fromEntries(Object.entries(before).reverse());
  assert.deepEqual(validateManifestChange(before, after), []);
});

for (const [label, target] of [
  ['major upgrade', '2.0.0'],
  ['major downgrade', '0.9.9'],
  ['minor downgrade', '1.1.99'],
  ['patch downgrade', '1.2.2'],
  ['prerelease', '1.2.4-beta.1'],
  ['build metadata', '1.2.4+build.1'],
  ['URL', 'https://example.invalid/package.tgz'],
  ['git URL', 'git+https://example.invalid/repo.git'],
  ['caret range', '^1.2.4'],
  ['tilde range', '~1.2.4'],
  ['wildcard', '1.2.x'],
  ['tag', 'latest'],
  ['leading zero', '1.02.4'],
  ['non-string version', 124],
]) {
  test(`rejects ${label}`, () => {
    const before = manifest();
    const after = clone(before);
    after.dependencies.example = target;
    assert.throws(() => validateManifestChange(before, after));
  });
}

test('rejects unsupported previous dependency specifications when updating', () => {
  const before = manifest();
  before.dependencies.example = '>=1.2.3';
  const after = clone(before);
  after.dependencies.example = '1.2.4';
  assert.throws(() => validateManifestChange(before, after), /before/);
});

for (const [label, mutate] of [
  ['script addition', (value) => { value.scripts.postinstall = 'run-something'; }],
  ['engine change', (value) => { value.engines.node = '26.x'; }],
  ['name change', (value) => { value.name = 'different'; }],
  ['version change', (value) => { value.version = '1.0.1'; }],
  ['new top-level field', (value) => { value.overrides = { example: '1.2.4' }; }],
  ['dependency addition', (value) => { value.dependencies.added = '1.0.0'; }],
  ['dependency deletion', (value) => { delete value.dependencies.example; }],
  ['section deletion', (value) => { delete value.devDependencies; }],
  ['non-object section', (value) => { value.devDependencies = []; }],
  ['dependency section move', (value) => {
    value.devDependencies.example = value.dependencies.example;
    delete value.dependencies.example;
  }],
]) {
  test(`rejects ${label}`, () => {
    const before = manifest();
    const after = clone(before);
    mutate(after);
    assert.throws(() => validateManifestChange(before, after));
  });
}

test('does not lose precision for large version components', () => {
  const before = manifest();
  before.dependencies.example = '1.2.9007199254740993';
  const after = clone(before);
  after.dependencies.example = '1.2.9007199254740992';
  assert.throws(() => validateManifestChange(before, after), /Downgrade/);
});

test('parses NUL paths and rejects filenames containing newlines', () => {
  assert.deepEqual(parseChangedPaths(Buffer.from('package.json\0package-lock.json\0')), ['package.json', 'package-lock.json']);
  assert.deepEqual(parseChangedPaths(Buffer.alloc(0)), []);
  assert.throws(() => parseChangedPaths('package.json\n'), /NUL/);
  assert.throws(() => parseChangedPaths('package.json\0\0'), /empty/);
  const paths = parseChangedPaths(Buffer.from('package.json\nREADME.md\0'));
  assert.throws(() => validateChangedPaths(paths), /outside allowed/);
});

test('rejects forbidden, nested and lookalike paths', () => {
  validateChangedPaths(['package.json', 'package-lock.json']);
  for (const path of ['README.md', '.github/workflows/build.yml', 'sub/package.json', './package.json', 'package.json ']) {
    assert.throws(() => validateChangedPaths([path]), /outside allowed/);
  }
});

test('requires a full hexadecimal base SHA and refuses option injection', () => {
  assert.equal(parseBaseArgument(['--base', SHA.toUpperCase()]), SHA);
  for (const args of [[], ['--base'], ['--base', 'main'], ['--base', 'a'.repeat(39)], ['--base', 'g'.repeat(40)], ['--base', '--help'], ['--base', SHA, '--other']]) {
    assert.throws(() => parseBaseArgument(args), /Usage/);
  }
});

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'security-policy-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Policy test');
  const writeManifest = (value) => writeFileSync(join(cwd, 'package.json'), JSON.stringify(value, null, 2) + '\n');
  const commit = () => { git('add', '--all'); git('commit', '--quiet', '--no-gpg-sign', '-m', 'test'); return git('rev-parse', 'HEAD'); };
  writeManifest(manifest());
  const base = commit();
  const run = (args = ['--base', base]) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { cwd, git, base, writeManifest, commit, run };
}

test('CLI allows a committed dependency update and lockfile', (t) => {
  const repo = repository(t);
  const value = manifest(); value.dependencies.example = '1.3.0';
  repo.writeManifest(value);
  writeFileSync(join(repo.cwd, 'package-lock.json'), JSON.stringify(lockfile(value)) + '\n');
  repo.commit();
  const result = repo.run();
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.eligible, true);
  assert.equal(parsed.changes[0].to, '1.3.0');
  assert.equal(parsed.lockfile.status, 'checked');
  assert.equal(parsed.lockfile.baseline, 'manifest-fallback');
  assert.deepEqual(parsed.paths, ['package-lock.json', 'package.json']);
});

test('CLI exits 1 for a forbidden file, including a newline filename', (t) => {
  const repo = repository(t);
  writeFileSync(join(repo.cwd, 'package.json\nREADME.md'), 'forbidden\n');
  repo.commit();
  const result = repo.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside allowed/);
});

test('CLI exits 1 for a script change', (t) => {
  const repo = repository(t);
  const value = manifest(); value.scripts.postinstall = 'unexpected';
  repo.writeManifest(value); repo.commit();
  const result = repo.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside dependencies/);
});

test('CLI exits 1 for invalid or unknown base SHAs', (t) => {
  const repo = repository(t);
  for (const base of ['--help', 'f'.repeat(40)]) {
    const result = repo.run(['--base', base]);
    assert.equal(result.status, 1);
  }
});

test('evaluates committed HEAD rather than uncommitted working files', (t) => {
  const repo = repository(t);
  const value = manifest(); value.dependencies.example = '1.2.4';
  repo.writeManifest(value); repo.commit();
  const uncommitted = clone(value); uncommitted.scripts.postinstall = 'not-in-HEAD';
  repo.writeManifest(uncommitted);
  assert.equal(evaluateRepository(repo.base, repo.cwd).changes[0].to, '1.2.4');
});

test('CLI rejects an invalid package.json in HEAD', (t) => {
  const repo = repository(t);
  writeFileSync(join(repo.cwd, 'package.json'), '{invalid json\n'); repo.commit();
  const result = repo.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid package.json/);
});

test('importing the module has no CLI output or exit side effects', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./security-policy.mjs', import.meta.url).href)});`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.ok(readFileSync(script, 'utf8').includes('execFileSync'));
});

test('reports an absent HEAD lockfile as no-lock without reading the working tree', (t) => {
  const repo = repository(t);
  writeFileSync(join(repo.cwd, 'package-lock.json'), 'not committed');
  assert.equal(evaluateRepository(repo.base, repo.cwd).lockfile.status, 'no-lock');
});

test('checks direct resolved versions against the committed baseline lockfile', (t) => {
  const repo = repository(t);
  const before = manifest();
  writeFileSync(join(repo.cwd, 'package-lock.json'), JSON.stringify(lockfile(before, { example: '1.5.0' })));
  const base = repo.commit();
  const after = clone(before); after.dependencies.example = '1.6.0';
  repo.writeManifest(after);
  writeFileSync(join(repo.cwd, 'package-lock.json'), JSON.stringify(lockfile(after)));
  repo.commit();
  const result = repo.run(['--base', base]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.lockfile.baseline, 'resolved-versions');
  assert.deepEqual(parsed.lockfile.directResolvedChanges, [{ name: 'example', from: '1.5.0', to: '1.6.0' }]);
});

test('rejects an actual resolved downgrade hidden by a caret lower bound', (t) => {
  const repo = repository(t);
  const before = manifest();
  writeFileSync(join(repo.cwd, 'package-lock.json'), JSON.stringify(lockfile(before, { example: '1.5.0' })));
  const base = repo.commit();
  const after = clone(before); after.dependencies.example = '1.3.0';
  repo.writeManifest(after);
  writeFileSync(join(repo.cwd, 'package-lock.json'), JSON.stringify(lockfile(after)));
  repo.commit();
  const result = repo.run(['--base', base]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Resolved downgrade/);
});

for (const [label, mutate, pattern] of [
  ['v2 lockfile', (lock) => { lock.lockfileVersion = 2; }, /lockfileVersion 3/],
  ['missing root entry', (lock) => { delete lock.packages['']; }, /root entry/],
  ['file URL', (lock) => { lock.packages['node_modules/example'].resolved = 'file:../example'; }, /registry.npmjs.org/],
  ['git URL', (lock) => { lock.packages['node_modules/example'].resolved = 'git+https://github.com/example/pkg'; }, /registry.npmjs.org/],
  ['plain HTTP URL', (lock) => { lock.packages['node_modules/example'].resolved = 'http://registry.npmjs.org/example.tgz'; }, /registry.npmjs.org/],
  ['private host', (lock) => { lock.packages['node_modules/example'].resolved = 'https://private.invalid/example.tgz'; }, /registry.npmjs.org/],
  ['lookalike host', (lock) => { lock.packages['node_modules/example'].resolved = 'https://registry.npmjs.org.attacker.invalid/example.tgz'; }, /registry.npmjs.org/],
  ['credential URL', (lock) => { lock.packages['node_modules/example'].resolved = 'https://user@registry.npmjs.org/example.tgz'; }, /registry.npmjs.org/],
  ['missing integrity', (lock) => { delete lock.packages['node_modules/example'].integrity; }, /requires integrity/],
  ['empty integrity', (lock) => { lock.packages['node_modules/example'].integrity = ' '; }, /requires integrity/],
  ['linked dependency', (lock) => { lock.packages['node_modules/example'].link = true; }, /Linked packages/],
  ['root specification mismatch', (lock) => { lock.packages[''].dependencies.example = '1.2.4'; }, /specifications differ/],
  ['missing direct dependency', (lock) => { delete lock.packages['node_modules/example']; }, /missing from HEAD/],
  ['exact manifest mismatch', (lock) => { lock.packages[''].dependencies.example = '1.2.3'; lock.packages['node_modules/example'].version = '1.2.2'; }, /specifications differ/],
  ['resolved major change', (lock) => { lock.packages['node_modules/example'].version = '2.0.0'; }, /does not satisfy/],
]) {
  test(`CLI rejects ${label}`, (t) => {
    const repo = repository(t);
    const value = lockfile(); mutate(value);
    writeFileSync(join(repo.cwd, 'package-lock.json'), JSON.stringify(value)); repo.commit();
    const result = repo.run();
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, pattern);
  });
}

test('validates transitive resolved URLs as well as direct dependency URLs', () => {
  const value = lockfile();
  value.packages['node_modules/example/node_modules/transitive'] = { version: '1.0.0', resolved: 'https://private.invalid/transitive.tgz', integrity: 'sha512-dGVzdA==' };
  assert.throws(() => validateLockfile(manifest(), manifest(), null, value), /registry.npmjs.org/);
});

test('records install scripts without rejecting entries; npm ci must use ignore-scripts', () => {
  const value = lockfile(); value.packages['node_modules/example'].hasInstallScript = true;
  const result = validateLockfile(manifest(), manifest(), null, value);
  assert.deepEqual(result.installationScriptsPresent, ['node_modules/example']);
  assert.equal(result.requiresIgnoreScripts, true);
});

test('requires exact resolved versions to match exact manifest specifications', () => {
  const value = manifest(); value.dependencies.example = '1.2.4';
  const lock = lockfile(value); lock.packages['node_modules/example'].version = '1.2.3';
  assert.throws(() => validateLockfile(value, value, null, lock), /does not satisfy/);
});

test('rejects a missing direct dependency in an existing baseline lockfile', () => {
  const baseline = lockfile(); delete baseline.packages['node_modules/example'];
  assert.throws(() => validateLockfile(manifest(), manifest(), baseline, lockfile()), /missing from base/);
});

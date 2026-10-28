import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ALLOWED_PATHS = new Set(['package.json', 'package-lock.json']);
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies'];
const SHA_PATTERN = /^[a-fA-F0-9]{40}$/;
const RELEASE_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function reject(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read git's NUL-separated path output without treating newlines as separators. */
export function parseChangedPaths(output) {
  const text = Buffer.isBuffer(output) ? output.toString('utf8') : output;
  if (typeof text !== 'string') reject('Changed paths must be NUL-separated text.');
  if (text === '') return [];
  if (!text.endsWith('\0')) reject('Changed-path output is not NUL-terminated.');
  const paths = text.slice(0, -1).split('\0');
  if (paths.some((path) => path === '')) reject('Changed-path output contains an empty path.');
  return paths;
}

export function validateChangedPaths(paths) {
  for (const path of paths) {
    if (!ALLOWED_PATHS.has(path)) reject(`Change outside allowed files: ${JSON.stringify(path)}`);
  }
}

function versionParts(value, allowRange, label) {
  if (typeof value !== 'string') reject(`${label} must be a version string.`);
  const release = allowRange ? value.replace(/^[~^]/, '') : value;
  const match = RELEASE_PATTERN.exec(release);
  if (!match) {
    reject(`${label} must be ${allowRange ? 'X.Y.Z, ^X.Y.Z, or ~X.Y.Z' : 'an exact X.Y.Z release'}: ${JSON.stringify(value)}`);
  }
  return match.slice(1).map((part) => BigInt(part));
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function dependencies(manifest, section) {
  if (!Object.hasOwn(manifest, section)) return {};
  const value = manifest[section];
  if (!isObject(value)) reject(`${section} must be an object.`);
  return value;
}

/**
 * A narrow release-eligibility policy, not a claim that same-major updates
 * are safe. Tests, advisory validation, and deployment checks remain separate.
 */
export function validateManifestChange(before, after) {
  if (!isObject(before) || !isObject(after)) reject('package.json must contain an object.');

  const nonDependencies = (manifest) => Object.fromEntries(
    Object.entries(manifest).filter(([key]) => !DEPENDENCY_SECTIONS.includes(key)),
  );
  if (!isDeepStrictEqual(nonDependencies(before), nonDependencies(after))) {
    reject('Fields outside dependencies/devDependencies must not change.');
  }

  const changes = [];
  for (const section of DEPENDENCY_SECTIONS) {
    if (Object.hasOwn(before, section) !== Object.hasOwn(after, section)) {
      reject(`Adding or removing the ${section} section is not allowed.`);
    }
    const oldDependencies = dependencies(before, section);
    const newDependencies = dependencies(after, section);
    const oldNames = Object.keys(oldDependencies).sort();
    const newNames = Object.keys(newDependencies).sort();
    if (!isDeepStrictEqual(oldNames, newNames)) {
      reject(`Adding or removing packages in ${section} is not allowed.`);
    }

    for (const name of oldNames) {
      const from = oldDependencies[name];
      const to = newDependencies[name];
      if (from === to) continue;
      const oldVersion = versionParts(from, true, `${section}.${name} before`);
      const newVersion = versionParts(to, false, `${section}.${name} after`);
      if (oldVersion[0] !== newVersion[0]) reject(`Major-version change is not allowed: ${name}.`);
      if (compareVersions(newVersion, oldVersion) < 0) reject(`Downgrade is not allowed: ${name}.`);
      changes.push({ section, name, from, to });
    }
  }
  return changes;
}

export function parseBaseArgument(args) {
  if (args.length !== 2 || args[0] !== '--base' || !SHA_PATTERN.test(args[1])) {
    reject('Usage: node scripts/security-policy.mjs --base <40-character commit SHA>');
  }
  return args[1].toLowerCase();
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readJson(revision, path, cwd, optional = false) {
  if (optional && git(['ls-tree', '--name-only', '-z', revision, '--', path], cwd).length === 0) return null;
  const content = git(['show', '--no-textconv', `${revision}:${path}`], cwd);
  try {
    return JSON.parse(content.toString('utf8'));
  } catch {
    reject(`Invalid ${path} JSON at ${revision}.`);
  }
}

function requireLockfileShape(lock, label) {
  if (!isObject(lock) || lock.lockfileVersion !== 3 || !isObject(lock.packages) || !isObject(lock.packages[''])) {
    reject(`${label} must be a lockfileVersion 3 lockfile with packages and a root entry.`);
  }
}

function validateResolvedSpecification(specification, resolvedVersion, label) {
  const requested = versionParts(specification, true, `${label} specification`);
  const actual = versionParts(resolvedVersion, false, `${label} resolved version`);
  const order = compareVersions(actual, requested);
  const prefix = specification[0];
  let matches = order === 0;
  if (prefix === '~') matches = order >= 0 && actual[0] === requested[0] && actual[1] === requested[1];
  if (prefix === '^') {
    matches = order >= 0 && actual[0] === requested[0]
      && (requested[0] !== 0n || (actual[1] === requested[1] && (requested[1] !== 0n || actual[2] === requested[2])));
  }
  if (!matches) reject(`Direct dependency does not satisfy manifest specification: ${label}.`);
  return actual;
}

export function validateLockfile(beforeManifest, afterManifest, beforeLock, afterLock) {
  if (afterLock === null) {
    return { status: 'no-lock', baseline: beforeLock === null ? 'no-lock' : 'present', note: 'Manifest-only fallback; production npm ci must reject a missing lockfile.' };
  }
  requireLockfileShape(afterLock, 'HEAD package-lock.json');
  if (beforeLock !== null) requireLockfileShape(beforeLock, 'Base package-lock.json');
  const installationScriptsPresent = [];
  for (const [path, entry] of Object.entries(afterLock.packages)) {
    if (!isObject(entry)) reject(`Invalid lockfile package entry: ${path}.`);
    if (entry.link === true) reject(`Linked packages are outside the registry-only policy: ${path}.`);
    if (Object.hasOwn(entry, 'resolved')) {
      let url;
      try { url = new URL(entry.resolved); } catch { reject(`Invalid resolved URL: ${path}.`); }
      if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://registry.npmjs.org/')
        || url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.port || url.username || url.password || url.hash) {
        reject(`Resolved package URL must use https://registry.npmjs.org/: ${path}.`);
      }
      if (typeof entry.integrity !== 'string' || entry.integrity.trim() === '') reject(`Resolved package requires integrity: ${path}.`);
    }
    if (entry.hasInstallScript === true) installationScriptsPresent.push(path);
  }

  const directResolvedChanges = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const declared = dependencies(afterManifest, section);
    const locked = dependencies(afterLock.packages[''], section);
    if (!isDeepStrictEqual(declared, locked)) reject(`HEAD manifest and lockfile root ${section} specifications differ.`);
    for (const [name, specification] of Object.entries(declared)) {
      const path = `node_modules/${name}`;
      const current = afterLock.packages[path];
      if (!isObject(current)) reject(`Direct dependency is missing from HEAD lockfile: ${name}.`);
      const actual = validateResolvedSpecification(specification, current.version, name);
      if (beforeLock !== null) {
        const old = beforeLock.packages[path];
        if (!isObject(old)) reject(`Direct dependency is missing from base lockfile: ${name}.`);
        validateResolvedSpecification(dependencies(beforeManifest, section)[name], old.version, `base ${name}`);
        const previous = versionParts(old.version, false, `Base resolved version for ${name}`);
        if (actual[0] !== previous[0]) reject(`Resolved major-version change is not allowed: ${name}.`);
        if (compareVersions(actual, previous) < 0) reject(`Resolved downgrade is not allowed: ${name}.`);
        if (old.version !== current.version) directResolvedChanges.push({ name, from: old.version, to: current.version });
      }
    }
  }
  return {
    status: 'checked', baseline: beforeLock === null ? 'manifest-fallback' : 'resolved-versions',
    entriesChecked: Object.keys(afterLock.packages).length,
    installationScriptsPresent, requiresIgnoreScripts: true, directResolvedChanges,
  };
}

export function evaluateRepository(base, cwd = process.cwd()) {
  if (typeof base !== 'string' || !SHA_PATTERN.test(base)) reject('Base must be a 40-character commit SHA.');
  git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], cwd);
  const paths = parseChangedPaths(git([
    'diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', base, 'HEAD', '--',
  ], cwd));
  validateChangedPaths(paths);
  // Compare immutable revisions so the manifest and the path diff refer to
  // the same proposed commit; uncommitted working files are not evaluated.
  const beforeManifest = readJson(base, 'package.json', cwd);
  const afterManifest = readJson('HEAD', 'package.json', cwd);
  const changes = validateManifestChange(beforeManifest, afterManifest);
  const lockfile = validateLockfile(beforeManifest, afterManifest,
    readJson(base, 'package-lock.json', cwd, true), readJson('HEAD', 'package-lock.json', cwd, true));
  return {
    eligible: true,
    base: base.toLowerCase(),
    paths,
    changes,
    lockfile,
    note: 'Policy eligibility does not guarantee security or absence of regressions.',
  };
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const base = parseBaseArgument(process.argv.slice(2));
    console.log(JSON.stringify(evaluateRepository(base), null, 2));
  } catch (error) {
    console.error(`Security policy rejected the change: ${error.message}`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
/**
 * Dependency-free sanity check for this package.
 *
 * Parse shipped files and cross-check the manifest wiring the Harness loader
 * relies on. Behavior is tested separately by `npm test`; parsing alone does
 * not establish runtime compatibility. Nothing here imports Harness packages,
 * so this runs in a bare checkout with no `npm install`.
 *
 * Checks:
 *  1. every JavaScript file parses (ESM for the Host half, script for the Client)
 *  2. every JSON file parses
 *  3. package.json exports/files/dsh.bundle.patch point at files that exist
 *  4. the Client bundle's module id matches the package name
 *  5. the Host half exports the `inject` and `apply` the loader requires
 *
 * Exit code 0 when every check passes, 1 otherwise.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

/** Record one failed assertion. */
function fail(message) {
  failures.push(message)
}

/** Read one file relative to the package root. */
function read(relative) {
  return readFileSync(join(root, relative), 'utf8')
}

/** Require one file relative to the package root to exist. */
function requireFile(relative, why) {
  if (!existsSync(join(root, relative))) fail(`missing ${relative} (${why})`)
  else notes.push(`ok   ${relative}`)
}

// 1. JavaScript parses.
//
// Both halves are PARSED, never executed. `node --check` picks the grammar from
// the package's own `"type": "module"`, so the Host half is checked as ESM and
// the Client half — which is a classic script — is compiled in-process.
try {
  const { execFileSync } = await import('node:child_process')
  execFileSync(process.execPath, ['--check', join(root, 'src/index.js')], { stdio: 'pipe' })
  notes.push('ok   src/index.js parses as ESM')
} catch (error) {
  const stderr = error?.stderr?.toString?.().trim() ?? ''
  fail(`src/index.js does not parse: ${stderr || error.message}`)
}

try {
  // The Client half is a classic script: it calls a browser global at top level,
  // so it is compiled (not run) to prove syntax without providing that global.
  new vm.Script(read('src/client.js'), { filename: 'src/client.js' })
  notes.push('ok   src/client.js parses as a script')
} catch (error) {
  fail(`src/client.js does not parse: ${error.message}`)
}

// 2. JSON parses.
for (const relative of ['package.json', 'locale/en.json', 'locale/zh.json']) {
  try {
    JSON.parse(read(relative))
    notes.push(`ok   ${relative} parses`)
  } catch (error) {
    fail(`${relative} does not parse: ${error.message}`)
  }
}

// 3. Manifest wiring points at real files.
const manifest = JSON.parse(read('package.json'))
requireFile(manifest.main, 'main')
requireFile(manifest.dsh.bundle.patch, 'dsh.bundle.patch')
requireFile('README.md', 'package documentation')
requireFile('LICENSE', 'license text')
for (const [key, target] of Object.entries(manifest.exports ?? {})) {
  if (target.includes('*')) {
    // A wildcard export maps a directory; require the directory itself.
    const dir = target.slice(0, target.indexOf('*'))
    requireFile(dir, `exports["${key}"]`)
    continue
  }
  requireFile(target.replace(/^\.\//u, ''), `exports["${key}"]`)
}
for (const entry of manifest.files ?? []) {
  if (!entry.includes('*')) {
    requireFile(entry, 'files[]')
    continue
  }
  const directory = dirname(entry)
  const suffix = entry.slice(entry.lastIndexOf('*') + 1)
  const matches = existsSync(join(root, directory)) && readdirSync(join(root, directory)).filter((name) => name.endsWith(suffix))
  if (!matches || matches.length === 0) fail(`no files match ${entry} (files[])`)
}
for (const relative of readdirSync(join(root, 'scripts')).filter((name) => name.endsWith('.mjs'))) {
  const { execFileSync } = await import('node:child_process')
  try {
    execFileSync(process.execPath, ['--check', join(root, 'scripts', relative)], { stdio: 'pipe' })
    notes.push(`ok   scripts/${relative} parses`)
  } catch (error) {
    fail(`scripts/${relative} does not parse: ${error.message}`)
  }
}

// 4. The Client module id must equal the package name: the loader keys the
//    factory by it and the profile's patch row resolves the same string.
const clientSource = read('src/client.js')
const idMatch = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/u.exec(clientSource)
if (idMatch === null) {
  fail('src/client.js does not declare a __ModuleLoader__.load({ id })')
} else if (idMatch[1] !== manifest.name) {
  fail(`Client module id "${idMatch[1]}" does not match package name "${manifest.name}"`)
} else {
  notes.push(`ok   Client module id matches package name (${manifest.name})`)
}

// 5. The Host half exports what the loader calls.
const hostSource = read('src/index.js')
if (!/export\s+const\s+inject\s*=/u.test(hostSource)) fail('src/index.js does not export `inject`')
else notes.push('ok   Host exports `inject`')
if (!/export\s+function\s+apply\s*\(/u.test(hostSource)) fail('src/index.js does not export `apply(ctx)`')
else notes.push('ok   Host exports `apply(ctx)`')

for (const note of notes) console.log(note)
if (failures.length > 0) {
  console.error('')
  for (const failure of failures) console.error(`FAIL ${failure}`)
  console.error(`\n${failures.length} check(s) failed`)
  process.exitCode = 1
} else {
  console.log(`\nall checks passed (${notes.length})`)
}

#!/usr/bin/env node
'use strict';

// Reproduce the historical fork's shipped browser bundle from the included
// source. The separate lockfile pins the historical build inputs; it does not
// change the application's dependencies.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.argv.length !== 3) {
  throw new Error('Usage: node rebuild.cjs <new-output-file>');
}
const output = path.resolve(process.argv[2]);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'petuja-openpgp-rebuild-'));
const source = path.join(temporary, 'source');
const overrides = path.join(temporary, 'overrides');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, cwd, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
    shell: process.platform === 'win32' && command === npm,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}

try {
  fs.mkdirSync(source);
  for (const name of ['src', 'package.json', 'package-lock.json', 'rollup.config.js']) {
    fs.cpSync(path.join(__dirname, name), path.join(source, name), { recursive: true });
  }
  fs.cpSync(path.join(__dirname, 'rebuild-deps'), overrides, { recursive: true });
  const install = ['ci', '--ignore-scripts', '--no-audit', '--no-fund'];
  run(npm, install, source);
  run(npm, install, overrides);

  const modules = path.join(source, 'node_modules');
  const nestedPolyfill = path.join(modules, '@openpgp/web-stream-tools/node_modules/web-streams-polyfill');
  const savedPolyfill = path.join(temporary, 'web-streams-polyfill');
  if (JSON.parse(fs.readFileSync(path.join(nestedPolyfill, 'package.json'))).version !== '3.0.3') {
    throw new Error('Unexpected historical web-streams-polyfill version');
  }
  fs.cpSync(nestedPolyfill, savedPolyfill, { recursive: true });
  for (const name of ['@openpgp/web-stream-tools', 'bn.js', 'hash.js', 'inherits', 'rollup']) {
    const destination = path.join(modules, name);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(path.join(overrides, 'node_modules', name), destination, { recursive: true });
  }
  fs.mkdirSync(path.dirname(nestedPolyfill), { recursive: true });
  fs.cpSync(savedPolyfill, nestedPolyfill, { recursive: true });

  // Upstream's banner contains the current date. Fix it to the date of the
  // historical build so rebuilding produces the same bytes.
  const clock = path.join(temporary, 'fixed-date.cjs');
  fs.writeFileSync(clock, `const OriginalDate = Date;\nconst instant = OriginalDate.parse('2024-03-15T12:00:00.000Z');\nglobal.Date = class extends OriginalDate {\n  constructor(...args) { if (args.length) super(...args); else super(instant); }\n  static now() { return instant; }\n};\n`);
  fs.mkdirSync(path.join(source, 'dist'));
  run(process.execPath, ['--require', clock, path.join(modules, 'rollup/dist/bin/rollup'), '--config'], source, {
    npm_config_build_only: '',
    TZ: 'UTC',
  });
  // The shipped historical bundle uses these equivalent normalizations.
  const built = fs.readFileSync(path.join(source, 'dist/openpgp.js'), 'utf8')
    .replace(/new Error\(/g, 'Error(')
    .replace(/[\t ]+(\r?\n)/g, '$1');
  fs.writeFileSync(output, built, { flag: 'wx' });
  console.log(`Rebuilt OpenPGP.js at ${output}`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

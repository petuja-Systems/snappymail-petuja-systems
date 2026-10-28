import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { rollup } from 'rollup';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => readFile(path.join(root, relative), 'utf8');
const soundsDirectory = path.join(root, 'snappymail/v/0.0.0/static/sounds');
const expectedSoundIds = ['alert', 'chime', 'new-mail', 'ping'];

async function loadAudioModule(supportedFormat) {
  const modules = new Map([
    ['Common/Links', `export const staticLink = path => globalThis.__notificationSoundHarness.staticLink(path);`],
    ['Common/Globals', `
      export const doc = globalThis.__notificationSoundHarness.doc;
      export const SettingsGet = key => globalThis.__notificationSoundHarness.settings[key];
      export const fireEvent = (...args) => globalThis.__notificationSoundHarness.events.push(args);
      export const addEventsListener = () => {};
    `],
    ['External/ko', `
      export function addObservablesTo(target, values) {
        for (const [key, initial] of Object.entries(values)) {
          let value = initial;
          target[key] = function (next) {
            if (arguments.length) value = next;
            return value;
          };
        }
      }
    `]
  ]);

  const plugin = {
    name: 'notification-audio-test-stubs',
    resolveId(source) {
      return modules.has(source) ? '\0notification-sounds:' + source : null;
    },
    load(id) {
      return modules.get(id.replace('\0notification-sounds:', ''));
    }
  };

  const bundle = await rollup({
    input: path.join(root, 'dev/Common/Audio.js'),
    plugins: [plugin]
  });
  const { output } = await bundle.generate({ format: 'es' });
  await bundle.close();

  const audioObjects = [];
  const harness = {
    settings: { NotificationSound: 'chime' },
    events: [],
    audioObjects,
    staticLink: asset => '/static/' + asset,
    doc: { addEventListener() {}, removeEventListener() {} }
  };
  const previous = {
    harness: globalThis.__notificationSoundHarness,
    window: globalThis.window,
    Audio: globalThis.Audio,
    addEventListener: globalThis.addEventListener
  };
  globalThis.__notificationSoundHarness = harness;
  globalThis.window = {
    AudioContext: class {
      state = 'running';
      resume() { return Promise.resolve(); }
    }
  };
  globalThis.Audio = class {
    constructor() {
      this.src = '';
      this.paused = true;
      this.playCount = 0;
      audioObjects.push(this);
    }
    canPlayType(type) {
      if (supportedFormat === 'mp3' && type.startsWith('audio/mpeg')) return 'probably';
      if (supportedFormat === 'ogg' && type.startsWith('audio/ogg')) return 'probably';
      return '';
    }
    pause() { this.paused = true; }
    play() { this.paused = false; this.playCount += 1; return Promise.resolve(); }
  };
  globalThis.addEventListener = () => {};

  let audioModule;
  try {
    const encoded = Buffer.from(output[0].code).toString('base64');
    audioModule = await import(`data:text/javascript;base64,${encoded}#${supportedFormat}`);
  } catch (error) {
    if (undefined === previous.harness) delete globalThis.__notificationSoundHarness;
    else globalThis.__notificationSoundHarness = previous.harness;
    if (undefined === previous.window) delete globalThis.window;
    else globalThis.window = previous.window;
    if (undefined === previous.Audio) delete globalThis.Audio;
    else globalThis.Audio = previous.Audio;
    if (undefined === previous.addEventListener) delete globalThis.addEventListener;
    else globalThis.addEventListener = previous.addEventListener;
    throw error;
  }

  return {
    SMAudio: audioModule.SMAudio,
    harness,
    cleanup() {
      if (undefined === previous.harness) delete globalThis.__notificationSoundHarness;
      else globalThis.__notificationSoundHarness = previous.harness;
      if (undefined === previous.window) delete globalThis.window;
      else globalThis.window = previous.window;
      if (undefined === previous.Audio) delete globalThis.Audio;
      else globalThis.Audio = previous.Audio;
      if (undefined === previous.addEventListener) delete globalThis.addEventListener;
      else globalThis.addEventListener = previous.addEventListener;
    }
  };
}

test('asset basenames discover the four unchanged sound IDs in sorted order', async () => {
  const assets = await readdir(soundsDirectory);
  const discovered = assets.filter(asset => asset.endsWith('.mp3'))
    .map(asset => path.basename(asset, '.mp3')).sort();
  assert.deepEqual(discovered, expectedSoundIds);

  for (const id of expectedSoundIds) {
    for (const extension of ['mp3', 'ogg']) {
      const assetPath = path.join(soundsDirectory, `${id}.${extension}`);
      assert.ok((await stat(assetPath)).size > 0, `${id}.${extension} exists and is non-empty`);
    }
  }

  const actions = await read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions.php');
  assert.match(actions, /'NotificationSound'\s*=>\s*'new-mail'/);
  assert.match(actions, /glob\(APP_VERSION_ROOT_PATH\s*\.\s*'static\/sounds\/\*\.mp3'\)/);
  assert.match(actions, /basename\(\$file,\s*'\.mp3'\)/);
});

test('the existing selector and preference path accept a choice without changing defaults or old values', async () => {
  const template = await read('snappymail/v/0.0.0/app/templates/Views/User/SettingsGeneral.html');
  const settings = await read('dev/Settings/User/General.js');
  const serverSettings = await read('snappymail/v/0.0.0/app/libraries/RainLoop/Actions/User.php');

  assert.match(template, /options:\s*notificationSounds,\s*value:\s*notificationSound/);
  assert.match(settings, /this\.notificationSound\s*=\s*ko\.observable\(SettingsGet\('NotificationSound'\)\)/);
  assert.match(settings, /notificationSound:\s*value\s*=>\s*\{\s*Remote\.saveSetting\('NotificationSound',\s*value\);\s*Settings\.set\('NotificationSound',\s*value\);/);
  assert.match(serverSettings, /setSettingsFromParams\(\$oSettings,\s*'NotificationSound',\s*'string'\)/);
});

test('preview and real notifications use the canonical Audio.js path and resolve MP3/Ogg assets', async () => {
  const inbox = await read('dev/Stores/User/Messagelist.js');
  const settings = await read('dev/Settings/User/General.js');
  assert.match(settings, /testSoundNotification\(\)\s*\{\s*SMAudio\.playNotification\(true\);/);
  assert.match(inbox, /SMAudio\.playNotification\(\);/);

  for (const format of ['mp3', 'ogg']) {
    const { SMAudio, harness, cleanup } = await loadAudioModule(format);
    try {
      assert.ok(harness.audioObjects[0], 'Audio.js created its shared media player');

      SMAudio.playNotification(true);
      const notificationPlayer = harness.audioObjects[1];
      assert.ok(notificationPlayer, 'Audio.js created its lazy notification player');
      assert.equal(notificationPlayer.src, `/static/sounds/chime.${format}`);
      assert.equal(notificationPlayer.playCount, 1, 'the settings preview plays the selected sound');

      SMAudio.notifications(true);
      SMAudio.playNotification();
      assert.equal(notificationPlayer.src, `/static/sounds/chime.${format}`);
      assert.equal(notificationPlayer.playCount, 2, 'the real notification uses the same selected asset');

      harness.settings.NotificationSound = 'legacy-sound-id';
      SMAudio.playNotification(true);
      assert.equal(notificationPlayer.src, `/static/sounds/legacy-sound-id.${format}`,
        'unknown persisted IDs retain the existing filename-resolution behavior');
    } finally {
      cleanup();
    }
  }
});

test('the new sound remains same-origin and does not add an audio runtime dependency', async () => {
  const audio = await read('dev/Common/Audio.js');
  const csp = await read('snappymail/v/0.0.0/app/libraries/snappymail/http/csp.php');
  const packageJson = JSON.parse(await read('package.json'));
  const generator = await read('scripts/generate-notification-chime.py');

  assert.match(audio, /Links\.staticLink\('sounds\/'\s*\+/);
  assert.match(csp, /media-src[^\n]*'self'/);
  assert.doesNotMatch(JSON.stringify(packageJson.dependencies) + JSON.stringify(packageJson.devDependencies), /ffmpeg|lame|vorbis/i);
  assert.match(generator, /^import (?:argparse|math|struct|wave|Path)/m);
  assert.doesNotMatch(generator, /https?:\/\//i);
});

'use strict';
// Coverage for pure helpers in screen.js: WS URL building, arrangement
// resolution/defaulting, panel-prefs snapshot/migration, range clamping.
// Runs under the org reusable CI as `node tests/screen.test.js`.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function makeLocalStorage() {
    const store = new Map();
    return {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
    };
}

// screen.js only needs these DOM entry points to exist while its IIFE
// evaluates — no test asserts on rendering, so the bodies are deliberately
// inert. One shared no-op keeps that intent in a single place.
const noop = () => { /* inert DOM stub — see comment above */ };

function makeDocumentStub(onAddEventListener = noop) {
    return {
        getElementById: () => null,
        addEventListener: onAddEventListener,
        body: { appendChild: noop },
        createElement: () => ({
            style: {},
            classList: { add: noop, remove: noop },
            addEventListener: noop,
            appendChild: noop,
            setAttribute: noop,
        }),
        readyState: 'loading',
    };
}

const PLUGIN_PATH = path.join(__dirname, '..', 'screen.js');

function loadPlugin() {
    delete require.cache[require.resolve(PLUGIN_PATH)];
    return require(PLUGIN_PATH);
}

function freshPlugin({ search = '', protocol = 'http:' } = {}) {
    const location = { search, host: 'localhost:8420', protocol };
    global.window = { location, addEventListener: noop };
    global.document = makeDocumentStub();
    global.localStorage = makeLocalStorage();
    global.location = location;
    return loadPlugin();
}

test('getWsUrl decodes percent-encoded filenames and builds a ws:// URL', () => {
    const { getWsUrl } = freshPlugin();
    assert.equal(
        getWsUrl('sloppak%2Fperfouts.sloppak', 0),
        'ws://localhost:8420/ws/highway/sloppak/perfouts.sloppak?arrangement=0');
});

test('getWsUrl omits the arrangement param when undefined', () => {
    const { getWsUrl } = freshPlugin();
    assert.equal(getWsUrl('song.sloppak'), 'ws://localhost:8420/ws/highway/song.sloppak');
});

test('getWsUrl uses wss:// under https', () => {
    const { getWsUrl } = freshPlugin({ protocol: 'https:' });
    assert.match(getWsUrl('a.sloppak', 1), /^wss:\/\//);
});

test('getWsUrl translates a local dropdown position to the arrangement\'s true server index', () => {
    const mod = freshPlugin();
    // Server-sorted order (Lead, Rhythm, Bass) differs from original storage
    // order: Rhythm is stored at index 2, Bass at index 0.
    mod._setArrangementsForTest([
        { name: 'Lead', index: 1 },
        { name: 'Rhythm', index: 2 },
        { name: 'Bass', index: 0 },
    ]);
    assert.equal(
        mod.getWsUrl('song.sloppak', 1),
        'ws://localhost:8420/ws/highway/song.sloppak?arrangement=2');
    assert.equal(
        mod.getWsUrl('song.sloppak', 2),
        'ws://localhost:8420/ws/highway/song.sloppak?arrangement=0');
});

test('getWsUrl falls back to the supplied position when .index is unavailable', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }, { name: 'Rhythm' }]);
    assert.equal(
        mod.getWsUrl('song.sloppak', 1),
        'ws://localhost:8420/ws/highway/song.sloppak?arrangement=1');
});

test('resolveArrIndex is case-insensitive and finds by name', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }, { name: 'Rhythm' }, { name: 'Bass' }]);
    assert.equal(mod.resolveArrIndex('rhythm'), 1);
    assert.equal(mod.resolveArrIndex('BASS'), 2);
    assert.equal(mod.resolveArrIndex('nope'), -1);
});

test('resolveArrIndex treats special modes as non-arrangements', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }]);
    assert.equal(mod.resolveArrIndex(''), -1);
    assert.equal(mod.resolveArrIndex(null), -1);
    assert.equal(mod.resolveArrIndex('__lyrics__'), -1); // LYRICS_VALUE sentinel used at runtime; harmless if it isn't this literal
    assert.equal(mod.resolveArrIndex('__viz__:jumpingtab:Lead'), -1);
    // splitscreen#47: the retired __jumping_tab__ sentinel is no longer
    // special-cased here (migratePanelPrefs rewrites it before it can reach
    // resolveArrIndex) — it just falls through to no name match, same -1.
    assert.equal(mod.resolveArrIndex('__jumping_tab__:0'), -1);
});

test('getDefaultArrangements prioritizes lead/rhythm/bass then fills and wraps', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([
        { name: 'Bass Guitar' }, { name: 'Rhythm Guitar' }, { name: 'Lead Guitar' }, { name: 'Extra' },
    ]);
    // indices: 0=bass, 1=rhythm, 2=lead, 3=extra
    assert.deepEqual(mod.getDefaultArrangements(2), [2, 1]); // lead, rhythm
    assert.deepEqual(mod.getDefaultArrangements(4), [2, 1, 0, 3]); // lead, rhythm, bass, extra
    assert.deepEqual(mod.getDefaultArrangements(5), [2, 1, 0, 3, 2]); // wraps around
});

test('getDefaultArrangements falls back to arrangement order with no named matches', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Arr A' }, { name: 'Arr B' }]);
    assert.deepEqual(mod.getDefaultArrangements(2), [0, 1]);
});

test('_ctlRange fills defaults for missing/non-finite bounds', () => {
    const { _ctlRange } = freshPlugin();
    assert.deepEqual(_ctlRange({}), { lo: 0, hi: 1, st: 0.05 });
    assert.deepEqual(_ctlRange({ min: -1, max: 2, step: 0.1 }), { lo: -1, hi: 2, st: 0.1 });
    assert.deepEqual(_ctlRange({ min: NaN, max: Infinity }), { lo: 0, hi: 1, st: 0.05 });
});

test('panelToPrefs encodes a plain arrangement panel', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }]);
    const panel = {
        arrIndex: 0,
        hw: { getInverted: () => false, getLefty: () => false, getMastery: () => 0.5 },
        bar: { style: { display: '' } },
    };
    const prefs = mod.panelToPrefs(panel);
    assert.equal(prefs.arrName, 'Lead');
    assert.equal(prefs.inverted, false);
    assert.equal(prefs.mastery, 0.5);
    assert.equal(prefs.barHidden, false);
});

test('panelToPrefs encodes lyrics mode', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }]);
    const panel = {
        arrIndex: 0, lyricsMode: true, lyricsOverlayOn: true,
        hw: { getInverted: () => true, getLefty: () => true, getMastery: () => 0 },
        bar: { style: { display: 'none' } },
    };
    const prefs = mod.panelToPrefs(panel);
    assert.equal(prefs.arrName, '__lyrics__'); // LYRICS_VALUE sentinel captured verbatim
    assert.equal(prefs.lyrics, true);
    assert.equal(prefs.barHidden, true);
});

test('panelToPrefs encodes viz mode with the underlying arrangement name', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }, { name: 'Bass' }]);
    const panel = {
        arrIndex: 1, vizMode: 'highway_3d',
        hw: { getInverted: () => false, getLefty: () => false, getMastery: () => 0 },
        bar: { style: { display: '' } },
    };
    const prefs = mod.panelToPrefs(panel);
    assert.equal(prefs.arrName, '__viz__:highway_3d:Bass');
});

// splitscreen#47: window.createJumpingTabPane (and window.createTabView) no
// longer exist — jumpingtab migrated to the setRenderer/viz-factory contract
// (resolved via vizFactory()'s feedBackViz_/slopsmithViz_ prefix walk —
// jumpingtab v3.0.0 still only exports the legacy slopsmithViz_ name)
// rather than the retired standalone-pane factory, so a panel running it is
// just an ordinary viz-mode panel now — panelToPrefs never sees a
// jumpingTabMode field to special-case.
test('panelToPrefs encodes a jumpingtab panel via the generic viz path, not a jumping-tab sentinel', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }]);
    const panel = {
        arrIndex: 0, vizMode: 'jumpingtab',
        hw: { getInverted: () => false, getLefty: () => false, getMastery: () => 0 },
        bar: { style: { display: '' } },
    };
    const prefs = mod.panelToPrefs(panel);
    assert.equal(prefs.arrName, '__viz__:jumpingtab:Lead');
});

test('migratePanelPrefs passes through non-array input unchanged', () => {
    const { migratePanelPrefs } = freshPlugin();
    assert.equal(migratePanelPrefs(null), null);
    assert.equal(migratePanelPrefs('nope'), 'nope');
});

test('migratePanelPrefs resets lyrics on first migration (v<2) and preserves other fields', () => {
    const { migratePanelPrefs } = freshPlugin();
    const out = migratePanelPrefs([{ arrName: 'Lead', lyrics: true, inverted: true }]);
    assert.equal(out[0].lyrics, false);
    assert.equal(out[0].inverted, true);
});

test('migratePanelPrefs migrates the legacy 3D-highway sentinel prefix', () => {
    const { migratePanelPrefs } = freshPlugin();
    const out = migratePanelPrefs([{ arrName: '__3d_highway__:Lead', lyrics: false }]);
    assert.equal(out[0].arrName, '__viz__:highway_3d:Lead');
});

// splitscreen#47: __jumping_tab__:<arr> drove the retired
// window.createJumpingTabPane standalone-pane factory. jumpingtab migrated
// to the setRenderer/viz-factory contract, so old prefs land on the generic
// viz path instead — the same __viz__:<id>:<arr> shape highway_3d/piano use.
test('migratePanelPrefs migrates the legacy jumping-tab sentinel onto the generic viz path', () => {
    const { migratePanelPrefs } = freshPlugin();
    const out = migratePanelPrefs([{ arrName: '__jumping_tab__:Lead', lyrics: false }]);
    assert.equal(out[0].arrName, '__viz__:jumpingtab:Lead');
});

test('migratePanelPrefs leaves an already-migrated viz arrName untouched', () => {
    const { migratePanelPrefs } = freshPlugin();
    const out = migratePanelPrefs([{ arrName: '__viz__:jumpingtab:Lead', lyrics: false }]);
    assert.equal(out[0].arrName, '__viz__:jumpingtab:Lead');
});

test('migratePanelPrefs does not reset lyrics once already migrated to v2', () => {
    global.location = { search: '', host: 'x', protocol: 'http:' };
    const mod = freshPlugin();
    global.localStorage.setItem('splitscreenPrefsMigrationV', '2');
    const out = mod.migratePanelPrefs([{ arrName: 'Lead', lyrics: true }]);
    assert.equal(out[0].lyrics, true);
});

// ── LAN share helpers (splitscreen#21) ──

test('ROOM_KEY_ALPHABET excludes every lookalike glyph', () => {
    const { ROOM_KEY_ALPHABET } = freshPlugin();
    for (const c of '0O1IlLuU') {
        assert.equal(ROOM_KEY_ALPHABET.indexOf(c.toUpperCase()), -1, `alphabet must not contain ${c}`);
    }
});

test('generateRoomKey emits 6 chars drawn from the alphabet', () => {
    const mod = freshPlugin();
    for (let i = 0; i < 20; i++) {
        const key = mod.generateRoomKey();
        assert.equal(key.length, 6);
        for (const c of key) assert.notEqual(mod.ROOM_KEY_ALPHABET.indexOf(c), -1);
    }
});

test('normalizeRoomKey is case-insensitive, trims, and rejects junk', () => {
    const { normalizeRoomKey } = freshPlugin();
    assert.equal(normalizeRoomKey('k7tr4m'), 'K7TR4M');
    assert.equal(normalizeRoomKey('  K7TR4M  '), 'K7TR4M');
    assert.equal(normalizeRoomKey('K7TR4'), null);      // too short
    assert.equal(normalizeRoomKey('K7TR4MM'), null);    // too long
    assert.equal(normalizeRoomKey('K7TR40'), null);     // 0 not in alphabet
    assert.equal(normalizeRoomKey('K7TR4O'), null);     // O not in alphabet
    assert.equal(normalizeRoomKey(null), null);
    assert.equal(normalizeRoomKey(undefined), null);
    assert.equal(normalizeRoomKey(123456), null);
});

test('ensureRoomKey persists a key and returns the same one thereafter', () => {
    const mod = freshPlugin();
    const first = mod.ensureRoomKey();
    assert.equal(mod.normalizeRoomKey(first), first);
    assert.equal(mod.ensureRoomKey(), first);
    assert.equal(global.localStorage.getItem('splitscreenRoomKey'), first);
});

test('ensureRoomKey replaces an invalid stored key', () => {
    const mod = freshPlugin();
    global.localStorage.setItem('splitscreenRoomKey', 'not a key!!');
    const key = mod.ensureRoomKey();
    assert.notEqual(key, 'not a key!!');
    assert.equal(mod.normalizeRoomKey(key), key);
});

test('buildShareUrl joins origin and key, stripping trailing slashes', () => {
    const { buildShareUrl } = freshPlugin();
    assert.equal(buildShareUrl('http://192.168.1.20:8000', 'K7TR4M'), 'http://192.168.1.20:8000/?ss=K7TR4M');
    assert.equal(buildShareUrl('http://192.168.1.20:8000/', 'K7TR4M'), 'http://192.168.1.20:8000/?ss=K7TR4M');
});

test('getSyncUrl targets the core relay endpoint, wss under https', () => {
    assert.equal(freshPlugin().getSyncUrl('K7TR4M'), 'ws://localhost:8420/ws/sync/K7TR4M');
    assert.equal(freshPlugin({ protocol: 'https:' }).getSyncUrl('K7TR4M'), 'wss://localhost:8420/ws/sync/K7TR4M');
});

test('makeRemoteFollowerCfg builds a remote FOLLOWER with detect stripped', () => {
    const { makeRemoteFollowerCfg } = freshPlugin();
    const cfg = makeRemoteFollowerCfg({
        type: 'config',
        filename: 'song.sloppak',
        cfg: {
            // `mode` uses the _captureMode() encoding (`viz:<pluginId>`), the
            // shape a real relay config carries — NOT the saved-prefs
            // `__viz__:` sentinel form.
            arrangement: 2, mode: 'viz:highway_3d', inverted: 1, lefty: true,
            mastery: 0.7, lyrics: true, barHidden: true, name: 'Lead',
            detectChannel: 'left', detectDeviceName: 'Scarlett', detectVerifierOffsetMs: 40,
        },
    }, 'lan-abc');
    assert.equal(cfg.remote, true);
    assert.equal(cfg.popupId, 'lan-abc');
    assert.equal(cfg.filename, 'song.sloppak');
    assert.equal(cfg.arrangement, 2);
    assert.equal(cfg.mode, 'viz:highway_3d');
    assert.equal(cfg.inverted, true);
    assert.equal(cfg.lefty, true);
    assert.equal(cfg.mastery, 0.7);
    assert.equal(cfg.lyrics, true);
    assert.equal(cfg.barHidden, true);
    assert.equal(cfg.name, 'Lead');
    // Viewers are passive mirrors — never inherit the host's mic bindings.
    assert.equal(cfg.detectChannel, 'mono');
    assert.equal(cfg.detectDeviceName, '');
    assert.equal(cfg.detectVerifierOffsetMs, 0);
});

test('makeRemoteFollowerCfg defaults sanely on a minimal config message', () => {
    const { makeRemoteFollowerCfg } = freshPlugin();
    const cfg = makeRemoteFollowerCfg({ type: 'config', filename: 'x.sloppak' }, '');
    assert.equal(cfg.remote, true);
    assert.equal(cfg.arrangement, 0);
    assert.equal(cfg.mode, '2d');
    assert.equal(cfg.inverted, false);
    assert.equal(Number.isNaN(cfg.mastery), true);
});

test('loading with ?ss=<key> under the node test harness does not boot or throw', () => {
    // Modern node DOES ship a global WebSocket, so the runtime gates the
    // remote-join boot (and share auto-resume) behind _nodeTestEnv — this
    // pins that the module loads inertly under the harness and still
    // exports its helpers, rather than opening real sockets / building DOM.
    const mod = freshPlugin({ search: '?ss=k7tr4m' });
    assert.equal(typeof mod.getSyncUrl, 'function');
});

// ── LAYOUTS / applyLayoutStyle (splitscreen#1: CSS grid fix for the
// non-interactive-panel bug) ──────────────────────────────────────────────
test('multi-panel layouts (tri/quad/five/six) are CSS grid, not flex-wrap', () => {
    const { LAYOUTS } = freshPlugin();
    for (const key of ['tri-top', 'tri-bottom', 'quad', 'five', 'six']) {
        assert.equal(LAYOUTS[key].style, 'grid', `${key} should use grid`);
        assert.ok(Number.isInteger(LAYOUTS[key].cols) && LAYOUTS[key].cols > 0, `${key}.cols`);
        assert.ok(Number.isInteger(LAYOUTS[key].rows) && LAYOUTS[key].rows > 0, `${key}.rows`);
        assert.ok(LAYOUTS[key].cols * LAYOUTS[key].rows >= LAYOUTS[key].panels,
            `${key} grid (${LAYOUTS[key].cols}x${LAYOUTS[key].rows}) must fit its ${LAYOUTS[key].panels} panels`);
    }
    // top-bottom/left-right stay flex (2-panel layouts never hit the
    // %-height-in-flex-wrap ambiguity since they don't wrap onto a 2nd row).
    assert.equal(LAYOUTS['top-bottom'].style, 'flex-col');
    assert.equal(LAYOUTS['left-right'].style, 'flex-row');
});

test('applyLayoutStyle sets a grid template sized from cols/rows for quad', () => {
    const { applyLayoutStyle } = freshPlugin();
    const container = { style: {} };
    applyLayoutStyle(container, 'quad');
    assert.match(container.style.cssText, /display:grid/);
    assert.match(container.style.cssText, /grid-template-columns:repeat\(2,1fr\)/);
    assert.match(container.style.cssText, /grid-template-rows:repeat\(2,1fr\)/);
});

test('applyLayoutStyle uses a 6-column grid for five, 3-column for six', () => {
    const { applyLayoutStyle } = freshPlugin();
    const five = { style: {} };
    applyLayoutStyle(five, 'five');
    assert.match(five.style.cssText, /grid-template-columns:repeat\(6,1fr\)/);
    assert.match(five.style.cssText, /grid-template-rows:repeat\(2,1fr\)/);

    const six = { style: {} };
    applyLayoutStyle(six, 'six');
    assert.match(six.style.cssText, /grid-template-columns:repeat\(3,1fr\)/);
    assert.match(six.style.cssText, /grid-template-rows:repeat\(2,1fr\)/);
});

test('applyLayoutStyle still uses flex for the 2-panel layouts', () => {
    const { applyLayoutStyle } = freshPlugin();
    const topBottom = { style: {} };
    applyLayoutStyle(topBottom, 'top-bottom');
    assert.match(topBottom.style.cssText, /display:flex/);
    assert.equal(topBottom.style.flexDirection, 'column');

    const leftRight = { style: {} };
    applyLayoutStyle(leftRight, 'left-right');
    assert.match(leftRight.style.cssText, /display:flex/);
    assert.equal(leftRight.style.flexDirection, 'row');
});

test('_bestFitLayout picks the smallest layout with room, and caps at six', () => {
    const { _bestFitLayout } = freshPlugin();
    assert.equal(_bestFitLayout(1), 'top-bottom');
    assert.equal(_bestFitLayout(2), 'top-bottom');
    assert.equal(_bestFitLayout(3), 'tri-top');
    assert.equal(_bestFitLayout(4), 'quad');
    assert.equal(_bestFitLayout(5), 'five');
    assert.equal(_bestFitLayout(6), 'six');
    assert.equal(_bestFitLayout(7), 'six'); // nothing bigger — caller must truncate
});

test('deterministic frame coordination waits for a compatible panel without starting a no-op loop', () => {
    const src = require('node:fs').readFileSync(PLUGIN_PATH, 'utf8');
    assert.match(src, /let _deterministicFramesActive = false;/);
    assert.match(src, /_deterministicFramesActive = true;[\s\S]{0,500}!panels\.some\(_canDriveFrames\)/,
        'coordinator must remain active while waiting for a compatible panel');
    assert.match(src, /_splitFrameRaf != null \|\| _deterministicFrameTicking \|\| !panels\.some\(_canDriveFrames\)/,
        'no rAF should be armed until a panel can be driven');
    const recreate = src.slice(src.indexOf('function recreatePanelHighway'));
    assert.ok(recreate.indexOf('panel.hw = hw;') < recreate.indexOf('_startDeterministicFrames();'),
        'a recreated compatible highway must be attached before it retries arming the coordinator');
});

test('deterministic frame coordination contains panel failures and schedules from finally', () => {
    const src = require('node:fs').readFileSync(PLUGIN_PATH, 'utf8');
    const start = src.indexOf('function _startDeterministicFrames()');
    const end = src.indexOf('function _stopDeterministicFrames()', start);
    const fn = src.slice(start, end);
    assert.match(fn, /try \{[\s\S]{0,160}panel\.hw\.renderFrame\(frameTime, frameId\);[\s\S]{0,160}catch \(err\)/);
    assert.match(fn, /finally \{[\s\S]{0,180}_deterministicFrameTicking = false;[\s\S]{0,180}requestAnimationFrame\(tick\)/);
});

test('offline export suspends live sync and paints every panel at one chart time', () => {
    const src = require('node:fs').readFileSync(PLUGIN_PATH, 'utf8');
    const start = src.indexOf('beginOfflineRender()');
    const end = src.indexOf('// Identify a panel', start);
    const api = src.slice(start, end);
    assert.match(api, /_offlineRenderActive = true;[\s\S]{0,120}_pauseLiveTimeSyncForOfflineRender\(\)/);
    assert.match(api, /panels\.every\(\(panel\) => panel\.hw && typeof panel\.hw\.renderFrameAt === 'function'\)/);
    assert.match(api, /for \(const panel of panels\) \{[\s\S]{0,200}panel\.hw\.renderFrameAt\(time\)/);
    assert.match(api, /_offlineRenderActive = false;[\s\S]{0,120}startTimeSync\(\)/);
});

// ── Reload idempotency (plugin-runtime-idempotent.v1) ─────────────────────
// The Host may re-execute screen.js on plugin reload. A second evaluation
// must not run ANY top-level statement with observable side effects: not
// just the shared-global hooks (before the guard, playSong got wrapped
// around the already-wrapped version and every listener was added twice),
// but also the settings-sync wiring, the LAN-share resume, and the
// follower boot — all of which would build state no live hook reads.
test('re-evaluating screen.js installs its global hooks exactly once', () => {
    const counts = { resize: 0, beforeunload: 0, pointerdown: 0 };
    const tally = (ev) => { if (ev in counts) counts[ev] += 1; };
    const location = { search: '', host: 'localhost:8420', protocol: 'http:' };

    // Deliberately NOT freshPlugin(): it builds a new window per call, and a
    // reload is precisely the case where one window survives two evaluations.
    global.window = { location, addEventListener: tally };
    global.document = makeDocumentStub(tally);
    global.localStorage = makeLocalStorage();
    global.location = location;

    // The settings-sync block wires a change handler onto this control. A
    // second evaluation re-wiring it is the subtler half of the bug: the new
    // handler mutates state that run #1's live playSong wrapper never reads,
    // so "Always Split" would silently stop working after a reload.
    let settingsWirings = 0;
    global.document.getElementById = (id) => (
        id === 'splitscreen-default-layout'
            ? { value: '', addEventListener: () => { settingsWirings += 1; } }
            : null
    );

    // Sentinel — only its identity matters, so the body stays empty.
    const originalPlaySong = async function originalPlaySong() { /* sentinel */ };
    window.playSong = originalPlaySong;

    loadPlugin();
    assert.notEqual(window.playSong, originalPlaySong, 'first load should wrap playSong');
    assert.equal(settingsWirings, 1, 'first load should wire the settings control once');
    const afterFirst = { ...counts };
    const wrappedOnce = window.playSong;

    loadPlugin();

    assert.deepEqual(counts, afterFirst, 'second evaluation must not re-add listeners');
    assert.equal(window.playSong, wrappedOnce, 'second evaluation must not re-wrap playSong');
    assert.equal(settingsWirings, 1, 'second evaluation must not re-wire settings handlers');
});

// ── screen:changing teardown decision (replaces the old window.showScreen
// patch — see CLAUDE.md "Hooks into core") ─────────────────────────────────

test('_shouldTeardownOnScreenChange tears down split only when active and leaving the player screen', () => {
    const mod = freshPlugin();
    mod._setActiveForTest(true);
    assert.equal(mod._shouldTeardownOnScreenChange('settings'), true,
        'navigating away from the player while split is active should tear down');
    assert.equal(mod._shouldTeardownOnScreenChange('player'), false,
        'staying on/returning to the player must never tear down');
});

test('_shouldTeardownOnScreenChange is a no-op when split is inactive', () => {
    const mod = freshPlugin();
    mod._setActiveForTest(false);
    assert.equal(mod._shouldTeardownOnScreenChange('settings'), false);
});

// ── follower audio.paused shim ──────────────────────────────────────────────

test('_installFollowerAudioShim: audio.paused tracks _followerPlaying, not a hardcoded false', () => {
    const mod = freshPlugin();
    const audio = {};
    mod._installFollowerAudioShim(audio);

    mod._setFollowerPlayingForTest(false);
    assert.equal(audio.paused, true, 'paused main window should read as paused in the follower');

    mod._setFollowerPlayingForTest(true);
    assert.equal(audio.paused, false, 'playing main window should read as not-paused in the follower');
});

// ── LAN share teardown (stopLanShare) ──────────────────────────────────────
// stopLanShare() sends a terminal 'share-ended' message directly against the
// captured WebSocket rather than via _lanSend() (which silently drops any
// message whenever the socket isn't OPEN) — every viewer's only terminal
// signal is share-ended, so dropping it on a Stop click that lands mid-
// reconnect used to leave every viewer hello-polling forever.

class FakeWebSocket {
    constructor(readyState) {
        this.readyState = readyState;
        this.sent = [];
        this.closed = false;
        this._listeners = {};
    }
    send(data) {
        // Real WebSockets throw InvalidStateError synchronously when
        // readyState !== OPEN(1) — mirror that so tests can't assert a
        // delivery that couldn't happen in a real browser.
        if (this.readyState !== 1) {
            throw new DOMException('WebSocket is not open', 'InvalidStateError');
        }
        this.sent.push(data);
    }
    close() { this.closed = true; }
    addEventListener(type, cb, opts) {
        this._listeners[type] = { cb, opts };
    }
    fireOpen() {
        this.readyState = 1; // mirror the real transition to OPEN
        const l = this._listeners.open;
        if (l) l.cb();
    }
    fireError() {
        const l = this._listeners.error;
        if (l) l.cb();
    }
}

test('stopLanShare sends share-ended and closes immediately when the socket is OPEN', () => {
    const mod = freshPlugin();
    const ws = new FakeWebSocket(1); // OPEN
    mod._setLanShareForTest({ key: 'ABC123', cfg: null, ws, retryTimer: null, backoffMs: 1000 });

    mod.stopLanShare();

    assert.equal(mod._getLanShareForTest(), null, '_lanShare must be nulled synchronously');
    assert.deepEqual(ws.sent.map((s) => JSON.parse(s)), [{ type: 'share-ended' }]);
    assert.equal(ws.closed, true);
});

test('stopLanShare waits for a CONNECTING socket to open before sending share-ended', () => {
    const mod = freshPlugin();
    const ws = new FakeWebSocket(0); // CONNECTING
    mod._setLanShareForTest({ key: 'ABC123', cfg: null, ws, retryTimer: null, backoffMs: 1000 });

    const originalSetTimeout = global.setTimeout;
    global.setTimeout = () => 0; // never fire the 1500ms fallback in this test
    try {
        mod.stopLanShare();
        assert.equal(mod._getLanShareForTest(), null, '_lanShare must be nulled synchronously');
        assert.equal(ws.sent.length, 0, 'must not send before the socket actually opens');
        assert.equal(ws.closed, false, 'must not close before the goodbye is sent');

        ws.fireOpen();

        assert.deepEqual(ws.sent.map((s) => JSON.parse(s)), [{ type: 'share-ended' }]);
        assert.equal(ws.closed, true);
    } finally {
        global.setTimeout = originalSetTimeout;
    }
});

test('stopLanShare closes (but cannot deliver) a CONNECTING socket that never opens by the timeout', () => {
    // A real WebSocket still at CONNECTING throws InvalidStateError on
    // send() — the fallback's try/catch swallows that, so this path can
    // only guarantee the socket gets closed, never that the goodbye is
    // actually delivered. Assert the close-only outcome rather than
    // message delivery (which FakeWebSocket.send() now also refuses to
    // fake past readyState 1).
    const mod = freshPlugin();
    const ws = new FakeWebSocket(0); // CONNECTING, never opens
    mod._setLanShareForTest({ key: 'ABC123', cfg: null, ws, retryTimer: null, backoffMs: 1000 });

    const originalSetTimeout = global.setTimeout;
    let timeoutCb = null;
    global.setTimeout = (cb) => { timeoutCb = cb; return 0; };
    try {
        mod.stopLanShare();
        assert.equal(ws.sent.length, 0);

        timeoutCb();

        assert.equal(ws.sent.length, 0, 'send() throws at CONNECTING — no message can have been delivered');
        assert.equal(ws.closed, true);
    } finally {
        global.setTimeout = originalSetTimeout;
    }
});

test('stopLanShare opens a temporary socket to deliver share-ended when there is no live socket at all', () => {
    // ws:null means the relay connection had already dropped and Stop
    // landed in the gap before the scheduled reconnect fired. Previously
    // this was a silent no-op, abandoning every viewer with no terminal
    // signal. Now it opens a short-lived socket of its own just to
    // deliver the goodbye.
    const mod = freshPlugin();
    const opened = [];
    const originalWebSocket = global.WebSocket;
    global.WebSocket = function (url) {
        const ws = new FakeWebSocket(0); // CONNECTING, like a real fresh socket
        ws.url = url;
        opened.push(ws);
        return ws;
    };
    // The code also schedules a real 1.5s fallback timeout alongside the
    // 'open' listener; left unstubbed it still fires for real after this
    // test's assertions complete, holding the runner open for no reason.
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = () => 0;
    try {
        mod._setLanShareForTest({ key: 'ABC123', cfg: null, ws: null, retryTimer: null, backoffMs: 1000 });

        assert.doesNotThrow(() => mod.stopLanShare());
        assert.equal(mod._getLanShareForTest(), null);
        assert.equal(opened.length, 1, 'must open exactly one temporary socket');
        assert.match(opened[0].url, /\/ws\/sync\/ABC123$/);

        opened[0].fireOpen();

        assert.deepEqual(opened[0].sent.map((s) => JSON.parse(s)), [{ type: 'share-ended' }]);
        assert.equal(opened[0].closed, true);
    } finally {
        global.WebSocket = originalWebSocket;
        global.setTimeout = originalSetTimeout;
    }
});

test('stopLanShare still clears the persisted share flags when the temp WebSocket constructor throws', () => {
    // A throwing `new WebSocket(...)` (e.g. a malformed URL -> SyntaxError)
    // must not skip the localStorage cleanup below it — otherwise
    // _maybeResumeLanShare() re-arms a share on the next page load that the
    // user explicitly stopped. Every other branch's cleanup is
    // unconditional; this one must be too.
    const mod = freshPlugin();
    const originalWebSocket = global.WebSocket;
    global.WebSocket = function () { throw new DOMException('bad url', 'SyntaxError'); };
    try {
        localStorage.setItem('splitscreenLanShareActive', 'true');
        localStorage.setItem('splitscreenLanShareCfg', JSON.stringify({ some: 'cfg' }));
        mod._setLanShareForTest({ key: 'ABC123', cfg: null, ws: null, retryTimer: null, backoffMs: 1000 });

        assert.doesNotThrow(() => mod.stopLanShare());

        assert.equal(localStorage.getItem('splitscreenLanShareActive'), null);
        assert.equal(localStorage.getItem('splitscreenLanShareCfg'), null);
    } finally {
        global.WebSocket = originalWebSocket;
    }
});

test('stopLanShare tolerates no WebSocket support at all when there is no live socket', () => {
    const mod = freshPlugin();
    const originalWebSocket = global.WebSocket;
    delete global.WebSocket;
    try {
        mod._setLanShareForTest({ key: 'ABC123', cfg: null, ws: null, retryTimer: null, backoffMs: 1000 });
        assert.doesNotThrow(() => mod.stopLanShare());
        assert.equal(mod._getLanShareForTest(), null);
    } finally {
        global.WebSocket = originalWebSocket;
    }
});

test('stopLanShare clears a pending reconnect timer so it cannot fire after teardown', () => {
    // ws:null also drives the temp-reconnect branch (see the tests above) —
    // must stub global.WebSocket here too, or this runs against Node's real
    // WebSocket, which internally uses the (here mocked) global clearTimeout
    // for its own connection bookkeeping and pollutes `cleared` with an
    // unrelated call before this assertion ever runs.
    const mod = freshPlugin();
    const originalWebSocket = global.WebSocket;
    global.WebSocket = function (url) {
        const ws = new FakeWebSocket(0);
        ws.url = url;
        return ws;
    };
    // Same reasoning as the test above: stub away the real 1.5s fallback
    // timer the temp-reconnect branch schedules, so this test stays instant.
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = () => 0;
    let cleared = null;
    const originalClearTimeout = global.clearTimeout;
    global.clearTimeout = (id) => { cleared = id; };
    try {
        mod._setLanShareForTest({ key: 'ABC123', cfg: null, ws: null, retryTimer: 'sentinel-timer-id', backoffMs: 1000 });
        mod.stopLanShare();
        assert.equal(cleared, 'sentinel-timer-id');
    } finally {
        global.clearTimeout = originalClearTimeout;
        global.WebSocket = originalWebSocket;
        global.setTimeout = originalSetTimeout;
    }
});

// ── LAN share lifecycle beyond stopLanShare (splitscreen#55) ──────────────
// The teardown branches are covered above; this block reaches the rest of the
// host-side lifecycle: startLanShare (config capture + connect), _lanSend's
// ~20 Hz throttling vs the ≤60 Hz BroadcastChannel leg, the hello→config
// exchange, _maybeResumeLanShare crash-recovery, and Regenerate rotation.
//
// A shared const host: the module runs real Node only. startLanShare and
// _maybeResumeLanShare call _ensureMainBroadcasterAndListener→_ssChannel(),
// and Node DOES ship a global BroadcastChannel whose live instance would hold
// the event loop open — so those tests delete the global to route _ssChannel
// down its null path (mirroring how _nodeTestEnv gates the boot elsewhere).
//
// Most tests here stub the same handful of globals, so they run their body
// through withGlobals() below — a try/finally that installs the overrides and
// restores the originals after, regardless of how the body exits. Each test
// still declares its own override map so the globals that actually matter to
// it stay visible at the call site.

// FAKE_PANEL flows through _lanCaptureCfg → _captureFollowerConfig: a live
// panel with per-panel note-detect bindings that must NOT reach viewers.
const fakePanel = () => ({
    arrIndex: 2,
    hw: { getInverted: () => false, getLefty: () => true, getMastery: () => 0.7 },
    lyricsOverlayOn: true,
    bar: { style: { display: 'none' } },
    detectChannel: 'left',
    detectDeviceName: 'Scarlett',
    detectVerifierOffsetMs: 40,
});

// _ssChannel's null path and the no-WebSocket-support path both need the
// global ABSENT, so `undefined` in an overrides map means "delete"; anything
// else is installed for the body and restored afterwards.
function withGlobals(overrides, body) {
    const originals = new Map(Object.keys(overrides).map((k) => [k, global[k]]));
    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete global[key];
        else global[key] = value;
    }
    try {
        return body();
    } finally {
        for (const [key, original] of originals) {
            if (original === undefined) delete global[key];
            else global[key] = original;
        }
    }
}

// Installs a fake WebSocket that records every relay socket the plugin opens,
// so tests can assert URLs/lifecycle without touching the real network. Used
// via the `WebSocket` key of a withGlobals() overrides map.
function fakeRelaySocket(opened) {
    return function (url) {
        const ws = new FakeWebSocket(0); // CONNECTING, like a real fresh socket
        ws.url = url;
        opened.push(ws);
        return ws;
    };
}

test('startLanShare captures the shared cfg with detect stripped, connects to the relay, and persists the share flags', () => {
    const mod = freshPlugin();
    const opened = [];
    withGlobals({
        BroadcastChannel: undefined, // absent → _ssChannel's null path — see section comment
        WebSocket: fakeRelaySocket(opened),
    }, () => {
        assert.equal(mod.startLanShare(fakePanel()), true);

        assert.equal(opened.length, 1, 'must open exactly one relay socket');
        const share = mod._getLanShareForTest();
        assert.equal(share.key, localStorage.getItem('splitscreenRoomKey'), 'share key is the ensured room key');
        assert.equal(opened[0].url, mod.getSyncUrl(share.key));
        assert.equal(share.ws, opened[0]);

        assert.equal(localStorage.getItem('splitscreenLanShareActive'), 'true');
        const cfg = JSON.parse(localStorage.getItem('splitscreenLanShareCfg'));
        assert.equal(cfg.arrangement, 2);
        assert.equal(cfg.mode, '2d');
        assert.equal(cfg.inverted, 0);
        assert.equal(cfg.lefty, 1);
        assert.equal(cfg.mastery, 0.7);
        assert.equal(cfg.lyrics, true);
        assert.equal(cfg.barHidden, true);
        // Detect fields are force-stripped to inert values — viewers are
        // passive mirrors and must never inherit the host's mic bindings.
        assert.equal(cfg.detectChannel, 'mono');
        assert.equal(cfg.detectDeviceName, '');
        assert.equal(cfg.detectVerifierOffsetMs, 0);
    });
});

test('startLanShare returns false without WebSocket support and touches no share state', () => {
    const mod = freshPlugin();
    withGlobals({
        WebSocket: undefined, // absence is the no-WebSocket-support path
        // _showMainToast enters its try/catch only because this Node has no
        // global requestAnimationFrame. If one lands, the body proceeds to
        // schedule a 3.5s removal timer that would call el.remove() on a stub
        // element with none — stub setTimeout so that path can never become
        // live, whatever globals the runtime gains.
        setTimeout: () => 0,
    }, () => {
        assert.equal(mod.startLanShare(fakePanel()), false);
        assert.equal(mod._getLanShareForTest(), null);
        assert.equal(localStorage.getItem('splitscreenLanShareActive'), null);
        assert.equal(localStorage.getItem('splitscreenLanShareCfg'), null);
        assert.equal(localStorage.getItem('splitscreenRoomKey'), null);
    });
});

test('_lanSend throttles time frames to LAN_TIME_MIN_INTERVAL_MS and forwards playstate unthrottled', () => {
    const mod = freshPlugin();
    const ws = new FakeWebSocket(1); // OPEN
    mod._setLanShareForTest({ key: 'ABC123', cfg: null, ws, retryTimer: null, backoffMs: 1000 });

    // performance.now() counts monotonic ms since navigation start. A share
    // started within its first LAN_TIME_MIN_INTERVAL_MS of page load would
    // see the first frame dropped (now - 0 < interval) — benign — but the
    // 10000ms base below models the long-lived-tab norm and keeps that first
    // send through, matching real usage.
    let fakeNow = 10000;
    withGlobals({ performance: { now: () => fakeNow } }, () => {
        mod._lanSend({ type: 'time', t: 1 });
        assert.equal(ws.sent.length, 1);

        fakeNow += mod.LAN_TIME_MIN_INTERVAL_MS - 1;
        mod._lanSend({ type: 'time', t: 2 });
        assert.equal(ws.sent.length, 1, 'time frame inside the 50ms window must be dropped');

        fakeNow += 1;   // exactly 50ms after the previous send
        mod._lanSend({ type: 'time', t: 3 });
        assert.equal(ws.sent.length, 2, 'time frame sent once the window has elapsed');

        mod._lanSend({ type: 'playstate', playing: true });
        assert.equal(ws.sent.length, 3, 'playstate is a control message, never throttled');
        assert.deepEqual(ws.sent.map((s) => JSON.parse(s)), [
            { type: 'time', t: 1 },
            { type: 'time', t: 3 },
            { type: 'playstate', playing: true },
        ]);
    });
});

test('_lanSend drops every message while the socket is not OPEN', () => {
    const mod = freshPlugin();
    const ws = new FakeWebSocket(0); // CONNECTING — send() would throw InvalidStateError
    mod._setLanShareForTest({ key: 'ABC123', cfg: null, ws, retryTimer: null, backoffMs: 1000 });
    assert.doesNotThrow(() => mod._lanSend({ type: 'playstate', playing: true }));
    assert.equal(ws.sent.length, 0);
});

test('the host answers a viewer hello with a config once a file is loaded, and stays silent before', () => {
    const mod = freshPlugin();
    const audio = { currentTime: 12.5, paused: false, addEventListener: () => {} };
    const doc = global.document;
    const opened = [];
    withGlobals({
        document: { ...doc, getElementById: (id) => (id === 'audio' ? audio : null) },
        BroadcastChannel: undefined, // absent → _ssChannel's null path — see section comment
        WebSocket: fakeRelaySocket(opened),
        setInterval: () => 0, // the audio element arms the 60Hz broadcaster — must not run for real
    }, () => {
        mod._setCurrentFilenameForTest(null); // explicitly: no song loaded yet
        assert.equal(mod.startLanShare(fakePanel()), true);
        const ws = opened[0];
        ws.fireOpen();               // readyState 1 — _lanSend requires it

        ws.onmessage({ data: JSON.stringify({ type: 'hello', popupId: 'lan-abc' }) });
        assert.equal(ws.sent.length, 0, 'no config before a song is loaded — the viewer must hello-poll');

        mod._setCurrentFilenameForTest('song%20one.sloppak');
        ws.onmessage({ data: JSON.stringify({ type: 'hello', popupId: 'lan-abc' }) });

        assert.equal(ws.sent.length, 1);
        const cfg = JSON.parse(ws.sent[0]);
        assert.equal(cfg.type, 'config');
        assert.equal(cfg.popupId, 'lan-abc');
        assert.equal(cfg.filename, 'song%20one.sloppak');
        assert.equal(cfg.t, 12.5);
        assert.equal(cfg.playing, true);
        assert.equal(cfg.cfg.arrangement, 2);
        assert.equal(cfg.cfg.detectChannel, 'mono', 'the config viewers receive must have detect stripped');

        audio.paused = true;
        ws.onmessage({ data: JSON.stringify({ type: 'hello', popupId: 'lan-abc' }) });
        assert.equal(JSON.parse(ws.sent[ws.sent.length - 1]).playing, false,
            'config must track the host audio pause state');

        // A bare hello without a popupId still gets a (scoped-to-nobody) config.
        ws.onmessage({ data: JSON.stringify({ type: 'hello' }) });
        assert.equal(JSON.parse(ws.sent[ws.sent.length - 1]).popupId, '');

        assert.doesNotThrow(() => ws.onmessage({ data: 'not-json{' }));
        assert.equal(ws.sent.length, 3, 'garbage frames must be ignored, not sent or thrown');
    });
});

test('the 60Hz broadcaster posts every time frame locally while the LAN leg is throttled to ~20Hz', () => {
    const mod = freshPlugin();

    const posted = [];
    const FakeBC = function () {};
    FakeBC.prototype.postMessage = function (msg) { posted.push(msg); };
    FakeBC.prototype.close = function () {};

    let t = 0;
    const audio = { get currentTime() { return t; }, paused: false, addEventListener: () => {} };
    const doc = global.document;

    let intervalCb = null;
    const opened = [];

    // Long-lived-tab base (see the _lanSend throttle test): fakeNow sits far
    // above `_lanLastTimeSentPerf`'s 0 initializer, so the very first frame
    // goes through and the gate only starts pushing frames out from the
    // second send onward.
    let fakeNow = 10000;

    withGlobals({
        BroadcastChannel: FakeBC,
        document: { ...doc, getElementById: (id) => (id === 'audio' ? audio : null) },
        setInterval: (cb) => { intervalCb = cb; return 12345; },
        WebSocket: fakeRelaySocket(opened),
        performance: { now: () => fakeNow },
    }, () => {
        // A live popup keeps the local BroadcastChannel leg posting every
        // tick; the relay leg is the one LAN_TIME_MIN_INTERVAL_MS gates.
        mod._setPopupsForTest([['p1', { popup: { closed: false } }]]);
        assert.equal(mod.startLanShare(null), true);
        opened[0].fireOpen();

        for (let i = 0; i < 10; i++) {
            t += 0.02;
            fakeNow += 16;    // ~62Hz ticks
            intervalCb();
        }

        const lanTimes = opened[0].sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'time');
        assert.equal(posted.length, 10, 'every tick reaches the local BroadcastChannel');
        // Ticks land at 10016, 10032, …, 10160ms; first send @10016, then
        // every tick ≥50ms after the last → 10080 and 10144. 3 LAN frames.
        assert.equal(lanTimes.length, 3, 'the relay sees only frames ≥50ms apart');
    });
});

// ── _maybeResumeLanShare (crash/reload recovery) ─────────────────────────────
test('_maybeResumeLanShare re-arms a share from persisted flags and reconnects on the saved key', () => {
    const mod = freshPlugin();
    localStorage.setItem('splitscreenLanShareActive', 'true');
    localStorage.setItem('splitscreenLanShareCfg', JSON.stringify({ arrangement: 3, mode: 'viz:highway_3d', detectChannel: 'left' }));

    const opened = [];
    withGlobals({
        BroadcastChannel: undefined, // absent → _ssChannel's null path — see section comment
        WebSocket: fakeRelaySocket(opened),
    }, () => {
        mod._maybeResumeLanShare();
        const share = mod._getLanShareForTest();
        assert.ok(share, 'must re-arm the share');
        assert.equal(opened.length, 1);
        assert.equal(share.ws, opened[0]);
        assert.match(opened[0].url, /\/ws\/sync\/[A-Z0-9]{6}$/, 'reconnect uses the persisted room key');
        assert.deepEqual(share.cfg, { arrangement: 3, mode: 'viz:highway_3d', detectChannel: 'left' });
    });
});

test('_maybeResumeLanShare tolerates a corrupt persisted cfg and still re-arms', () => {
    const mod = freshPlugin();
    localStorage.setItem('splitscreenLanShareActive', 'true');
    localStorage.setItem('splitscreenLanShareCfg', '{not json');
    withGlobals({
        BroadcastChannel: undefined, // absent → _ssChannel's null path — see section comment
        WebSocket: function () { return new FakeWebSocket(0); },
    }, () => {
        mod._maybeResumeLanShare();
        const share = mod._getLanShareForTest();
        assert.ok(share, 'an unparseable cfg must not stop the recovery');
        assert.equal(share.cfg, null, 'the unparseable cfg falls back to null');
    });
});

test('_maybeResumeLanShare does nothing without the persisted active flag', () => {
    const mod = freshPlugin();
    mod._maybeResumeLanShare();
    assert.equal(mod._getLanShareForTest(), null);
});

test('_maybeResumeLanShare does not clobber an already-running share', () => {
    const mod = freshPlugin();
    localStorage.setItem('splitscreenLanShareActive', 'true');
    const ws = new FakeWebSocket(1);
    mod._setLanShareForTest({ key: 'K7TR4M', cfg: null, ws, retryTimer: null, backoffMs: 1000 });

    mod._maybeResumeLanShare();

    assert.equal(mod._getLanShareForTest().ws, ws, 'the live socket must be untouched');
});

test('_maybeResumeLanShare does nothing without WebSocket support', () => {
    const mod = freshPlugin();
    localStorage.setItem('splitscreenLanShareActive', 'true');
    withGlobals({
        WebSocket: undefined, // absence is the no-WebSocket-support path
    }, () => {
        mod._maybeResumeLanShare();
        assert.equal(mod._getLanShareForTest(), null);
    });
});

// ── Room-key Regenerate rotation ─────────────────────────────────────────────
// The settings-sync block wires the Regenerate handler during screen.js's
// evaluation, so the stub elements must be in place BEFORE the module loads.
// freshPlugin() builds a fresh document per call, so a post-hoc override is
// invisible to the load — build the stub by hand instead (same pattern as the
// reload-idempotency test).
function loadPluginWithRoomKeyElements() {
    const location = { search: '', host: 'localhost:8420', protocol: 'http:' };
    global.window = { location, addEventListener: noop };
    global.document = makeDocumentStub();
    const captured = { regenHandler: null };
    const roomKeyEl = { textContent: '' };
    global.document.getElementById = (id) => {
        switch (id) {
            case 'splitscreen-room-key':
                return roomKeyEl;
            case 'splitscreen-room-key-regen':
                return { addEventListener: (ev, cb) => { if (ev === 'click') captured.regenHandler = cb; } };
            default:
                return null;
        }
    };
    global.localStorage = makeLocalStorage();
    global.location = location;
    return { mod: loadPlugin(), roomKeyEl, getRegenHandler: () => captured.regenHandler };
}

test('Regenerate rotates the stored key and stops a live share with share-ended', () => {
    const { mod, roomKeyEl, getRegenHandler } = loadPluginWithRoomKeyElements();

    const oldKey = mod.ensureRoomKey();
    assert.ok(mod.normalizeRoomKey(oldKey));
    assert.equal(roomKeyEl.textContent, oldKey, 'the key display shows the ensured key');

    const ws = new FakeWebSocket(1);
    mod._setLanShareForTest({ key: oldKey, cfg: null, ws, retryTimer: null, backoffMs: 1000 });
    localStorage.setItem('splitscreenLanShareActive', 'true');

    assert.equal(typeof getRegenHandler(), 'function', 'Regenerate must be wired when the elements exist');
    // The handler calls _showMainToast (stopping a live share) — same
    // future-rAF robustness stub as the startLanShare no-WebSocket test.
    withGlobals({ setTimeout: () => 0 }, () => {
        assert.doesNotThrow(() => getRegenHandler()());

        const newKey = localStorage.getItem('splitscreenRoomKey');
        assert.ok(mod.normalizeRoomKey(newKey), 'rotated key must be valid');
        assert.notEqual(newKey, oldKey, 'the key must actually rotate');
        assert.equal(roomKeyEl.textContent, newKey, 'the display must follow the stored key');
        assert.equal(mod._getLanShareForTest(), null, 'any live share must be stopped');
        assert.deepEqual(ws.sent.map((s) => JSON.parse(s)), [{ type: 'share-ended' }], 'the terminal goodbye must be delivered');
        assert.equal(localStorage.getItem('splitscreenLanShareActive'), null);
    });
});

test('Regenerate rotates the stored key even when no share is active', () => {
    const { mod, roomKeyEl, getRegenHandler } = loadPluginWithRoomKeyElements();

    const oldKey = mod.ensureRoomKey();
    getRegenHandler()();

    const newKey = localStorage.getItem('splitscreenRoomKey');
    assert.notEqual(newKey, oldKey);
    assert.ok(mod.normalizeRoomKey(newKey));
    assert.equal(roomKeyEl.textContent, newKey);
    assert.equal(mod._getLanShareForTest(), null);
});

// ── Follower bus handler, redock deferral, popup-closed reaping (splitscreen#54) ──
// _followerBusHandler is the shared dispatch for both follower transports
// (BroadcastChannel popups and the LAN relay). These tests drive it directly
// with synthetic messages rather than standing up a real channel/socket.

function makeFollowerDocumentStub() {
    return {
        getElementById: () => null,
        addEventListener: noop,
        body: { appendChild: noop },
        createElement: () => ({
            style: {},
            classList: { add: noop, remove: noop },
            addEventListener: noop,
            appendChild: noop,
            setAttribute: noop,
            querySelector: () => null,
        }),
        readyState: 'loading',
    };
}

function makeFollowerPanel(overrides = {}) {
    return Object.assign({
        lyricsMode: false,
        hw: { setTime: noop },
    }, overrides);
}

test('_followerBusHandler routes a time message to the follower clock and fans it out to panels', () => {
    const mod = freshPlugin();
    let sawTime = null;
    const panel = makeFollowerPanel({ hw: { setTime: (t) => { sawTime = t; } } });
    mod._setPanelsForTest([panel]);
    mod._followerBusHandler({ type: 'time', t: 12.5, playing: true });
    assert.equal(sawTime, 12.5);
    assert.equal(mod._getFollowerCurrentTimeForTest(), 12.5);
    assert.equal(mod._getFollowerPlayingForTest(), true);
});

test('_followerBusHandler ignores a time message with a non-finite t', () => {
    const mod = freshPlugin();
    mod._setFollowerPlayingForTest(false);
    mod._followerBusHandler({ type: 'time', t: NaN, playing: true });
    assert.equal(mod._getFollowerPlayingForTest(), false);
});

test('_followerBusHandler routes a playstate message to _onFollowerPlayState', () => {
    const mod = freshPlugin();
    mod._followerBusHandler({ type: 'playstate', playing: true });
    assert.equal(mod._getFollowerPlayingForTest(), true);
    mod._followerBusHandler({ type: 'playstate', playing: false });
    assert.equal(mod._getFollowerPlayingForTest(), false);
});

test('_followerBusHandler with no msg or while orphaned is a no-op', () => {
    const mod = freshPlugin();
    assert.doesNotThrow(() => mod._followerBusHandler(null));
    mod._setFollowerOrphanedForTest(true);
    mod._setFollowerPlayingForTest(false);
    mod._followerBusHandler({ type: 'playstate', playing: true });
    assert.equal(mod._getFollowerPlayingForTest(), false, 'orphaned handler must ignore further messages');
});

test('_followerBusHandler main-closed on a local popup orphans it (not remote)', () => {
    const mod = freshPlugin();
    mod._setFollowerForTest({ remote: false });
    mod._setPanelsForTest([]);
    assert.equal(mod._getFollowerOrphanedForTest(), false);
    mod._followerBusHandler({ type: 'main-closed' });
    assert.equal(mod._getFollowerOrphanedForTest(), true);
});

test('_followerBusHandler main-closed on a remote viewer shows the waiting overlay instead of orphaning', () => {
    global.window = { location: { search: '', host: 'localhost:8420', protocol: 'http:' }, addEventListener: noop };
    global.document = makeFollowerDocumentStub();
    global.localStorage = makeLocalStorage();
    global.location = global.window.location;
    // _showRemoteWaiting arms a 3s hello-poll setInterval; stub it out so it
    // never fires and never keeps the test process alive.
    const originalSetInterval = global.setInterval;
    global.setInterval = () => 0;
    try {
        const mod = loadPlugin();
        mod._setFollowerForTest({ remote: true });
        mod._followerBusHandler({ type: 'main-closed' });
        assert.equal(mod._getFollowerOrphanedForTest(), false, 'a remote viewer must not orphan on main-closed');
        assert.equal(mod._getRemoteWaitingShownForTest(), true);
    } finally {
        global.setInterval = originalSetInterval;
    }
});

test('_followerBusHandler share-ended orphans a remote viewer with the terminal overlay', () => {
    global.window = { location: { search: '', host: 'localhost:8420', protocol: 'http:' }, addEventListener: noop };
    global.document = makeFollowerDocumentStub();
    global.localStorage = makeLocalStorage();
    global.location = global.window.location;
    const mod = loadPlugin();
    mod._setFollowerForTest({ remote: true });
    mod._followerBusHandler({ type: 'share-ended' });
    assert.equal(mod._getFollowerOrphanedForTest(), true);
});

test('_followerBusHandler share-ended on a local popup is a no-op (only meaningful for remote viewers)', () => {
    const mod = freshPlugin();
    mod._setFollowerForTest({ remote: false });
    mod._followerBusHandler({ type: 'share-ended' });
    assert.equal(mod._getFollowerOrphanedForTest(), false);
});

test('_followerBusHandler song-changed triggers a rebuild only when the filename actually differs', () => {
    const mod = freshPlugin();
    mod._setCurrentFilenameForTest('a.sloppak');
    mod._setFollowerPlayingForTest(true);
    // Same filename as currentFilename — _followerBusHandler's own guard
    // must skip calling _handleFollowerSongChange entirely. If it regressed,
    // the rebuild would flip `_followerPlaying` to false synchronously (its
    // first side effect), so asserting it stays true pins the skip.
    mod._followerBusHandler({ type: 'song-changed', filename: 'a.sloppak' });
    assert.equal(mod._getFollowerPlayingForTest(), true,
        'same-filename song-changed must not enter the rebuild path');
});

// ── _handleFollowerSongChange single-flight guard ───────────────────────────
// A second call while a rebuild is "in flight" must coalesce into the
// pending filename rather than starting a second overlapping rebuild.

test('_handleFollowerSongChange does nothing once the follower is orphaned', async () => {
    const mod = freshPlugin();
    mod._setFollowerOrphanedForTest(true);
    mod._setFollowerPlayingForTest(true);
    // The rebuild's first side effect is `_followerPlaying = false` (before
    // any await, so it lands even if loadSongInFollower's internal errors are
    // swallowed). Asserting it stays true pins the orphaned early return.
    await mod._handleFollowerSongChange('new.sloppak');
    assert.equal(mod._getFollowerPlayingForTest(), true,
        'an orphaned follower must not enter the rebuild path');
});

test('_handleFollowerSongChange coalesces a second filename while a rebuild is in flight', async () => {
    const mod = freshPlugin();
    mod._setFollowerRebuildBusyForTest(true);
    await mod._handleFollowerSongChange('latest.sloppak');
    assert.equal(mod._getFollowerPendingFilenameForTest(), 'latest.sloppak',
        'the later change must be retained for the current rebuild to consume');
});

test('_handleFollowerSongChange drains the parked filename into a rebuild once one finishes', async () => {
    const mod = freshPlugin();
    const playSongCalls = [];
    global.window.playSong = async (f) => { playSongCalls.push(f); };
    // The harness rebuild fails fast (no `highway` global) and the plugin
    // logs-and-continues — silence the expected noise so the run stays clean.
    const origError = console.error;
    console.error = noop;
    try {
        mod._setCurrentFilenameForTest('current.sloppak');
        mod._setFollowerRebuildBusyForTest(true);
        await mod._handleFollowerSongChange('latest.sloppak');
        assert.equal(mod._getFollowerPendingFilenameForTest(), 'latest.sloppak',
            'the later change must be parked while the rebuild is in flight');

        // A fresh change runs a full rebuild once the in-flight one finishes;
        // its finally must consume the parked filename and re-invoke it
        // instead of dropping it.
        mod._setFollowerRebuildBusyForTest(false);
        await mod._handleFollowerSongChange('first.sloppak');
        await new Promise((r) => setImmediate(r)); // let the fire-and-forget recursion finish
        assert.equal(mod._getFollowerPendingFilenameForTest(), null,
            'the drain must consume the parked filename');
        assert.ok(playSongCalls.includes('latest.sloppak'),
            'the parked filename must be re-invoked, not dropped');
        assert.ok(playSongCalls.includes('first.sloppak'),
            'the driving rebuild must also run');
    } finally {
        delete global.window.playSong;
        console.error = origError;
    }
});

test('the drain skips re-invoking a parked filename that is already the current song', async () => {
    const mod = freshPlugin();
    const playSongCalls = [];
    global.window.playSong = async (f) => { playSongCalls.push(f); };
    const origError = console.error;
    console.error = noop;
    try {
        mod._setCurrentFilenameForTest('latest.sloppak');
        mod._setFollowerRebuildBusyForTest(true);
        await mod._handleFollowerSongChange('latest.sloppak');
        assert.equal(mod._getFollowerPendingFilenameForTest(), 'latest.sloppak',
            'the later change must be parked while the rebuild is in flight');

        mod._setFollowerRebuildBusyForTest(false);
        await mod._handleFollowerSongChange('first.sloppak');
        assert.equal(mod._getFollowerPendingFilenameForTest(), null,
            'the drain must still consume the parked filename');
        assert.ok(playSongCalls.includes('first.sloppak'),
            'the driving rebuild must run');
        assert.ok(!playSongCalls.includes('latest.sloppak'),
            'a parked filename equal to the current song must not trigger a redundant rebuild');
    } finally {
        delete global.window.playSong;
        console.error = origError;
    }
});

test('follower interpolation derives the observed playback rate and stops at the extrapolation cap', () => {
    const oldRaf = global.requestAnimationFrame;
    const oldCancelRaf = global.cancelAnimationFrame;
    const oldPerformance = global.performance;
    let now = 1000;
    let tick = null;
    let nextFrame = 0;
    global.requestAnimationFrame = (cb) => { tick = cb; return ++nextFrame; };
    global.cancelAnimationFrame = noop;
    global.performance = { now: () => now };
    try {
        const mod = freshPlugin();
        const seen = [];
        mod._setPanelsForTest([makeFollowerPanel({ hw: { setTime: (t) => seen.push(t) } })]);
        mod._onFollowerTimeMessage(4, true);
        now = 1250;
        mod._onFollowerTimeMessage(4.5, true); // 0.5 s media / 0.25 s wall = 2x
        mod._startFollowerInterp();
        now = 1500;
        tick();
        assert.equal(mod._getFollowerCurrentTimeForTest(), 5,
            'the rAF estimate must use the observed 2x rate between broadcasts');
        assert.equal(seen.at(-1), 5);

        now = 3600; // 2.35 s since the last anchor: beyond the 2 s safety cap
        tick();
        assert.equal(mod._getFollowerPlayingForTest(), false,
            'the follower must stop extrapolating after the safety cap');
        assert.equal(mod._getFollowerCurrentTimeForTest(), 5,
            'the capped frame must not advance the playhead further');
        mod._stopFollowerInterp();
    } finally {
        global.requestAnimationFrame = oldRaf;
        global.cancelAnimationFrame = oldCancelRaf;
        global.performance = oldPerformance;
    }
});

test('the main BroadcastChannel listener defers docked messages and drops closed popups', () => {
    const oldBroadcastChannel = global.BroadcastChannel;
    let channel = null;
    global.BroadcastChannel = class {
        constructor() { channel = this; }
    };
    try {
        const mod = freshPlugin();
        mod._setPopupsForTest([['docked', { popup: {} }], ['closed', { popup: {} }]]);
        mod._setStartingForTest(true);
        mod._ensureMainBroadcasterAndListener();
        channel.onmessage({ data: { type: 'docked', popupId: 'docked', finalState: { arrName: 'Bass' } } });
        channel.onmessage({ data: { type: 'closed', popupId: 'closed' } });
        assert.deepEqual(mod._getPendingRedocksForTest(), [{ popupId: 'docked', finalState: { arrName: 'Bass' }, finalStates: null }]);
        assert.equal(mod._getPopupsForTest().has('docked'), true,
            'a queued redock keeps its popup entry until the start finishes');
        assert.equal(mod._getPopupsForTest().has('closed'), false,
            'a plain closed message releases its popup entry immediately');
    } finally {
        global.BroadcastChannel = oldBroadcastChannel;
    }
});

test('a closed message for a popup with a queued redock keeps its entry', () => {
    const oldBroadcastChannel = global.BroadcastChannel;
    let channel = null;
    global.BroadcastChannel = class {
        constructor() { channel = this; }
    };
    try {
        const mod = freshPlugin();
        mod._setPopupsForTest([['docked', { popup: {} }]]);
        mod._setStartingForTest(true);
        mod._ensureMainBroadcasterAndListener();
        // `docked` while a start is in flight defers the redock; an old popup
        // build then also posts `closed` for the same popupId. The
        // belt-and-suspenders guard must not drop the entry the deferred
        // redock needs.
        channel.onmessage({ data: { type: 'docked', popupId: 'docked', finalState: { arrName: 'Bass' } } });
        channel.onmessage({ data: { type: 'closed', popupId: 'docked' } });
        assert.equal(mod._getPendingRedocksForTest().length, 1,
            'the docked message must still be queued for the deferred redock');
        assert.equal(mod._getPopupsForTest().has('docked'), true,
            'a closed after a queued redock must not drop the entry the deferred redock needs');
    } finally {
        global.BroadcastChannel = oldBroadcastChannel;
    }
});

// ── _redockPanel deferral while a start is in flight ────────────────────────

test('_redockPanel defers into _pendingRedocks when a start is in flight', () => {
    const mod = freshPlugin();
    mod._setStartingForTest(true);
    mod._setPopupsForTest([['pop-1', { popup: {} }]]);
    mod._redockPanel('pop-1', { some: 'state' }, null);
    const pending = mod._getPendingRedocksForTest();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].popupId, 'pop-1');
    assert.deepEqual(pending[0].finalState, { some: 'state' });
    // Must NOT have dropped the popups entry yet — the deferred call needs it.
    assert.ok(mod._getPopupsForTest().has('pop-1'));
});

test('_redockPanel drops the popups entry immediately when no start is in flight', () => {
    const mod = freshPlugin();
    mod._setStartingForTest(false);
    mod._setCurrentFilenameForTest(null); // no song loaded -> bails after deleting the entry
    mod._setPopupsForTest([['pop-2', { popup: {} }]]);
    mod._redockPanel('pop-2', null, null);
    assert.equal(mod._getPopupsForTest().has('pop-2'), false);
    assert.equal(mod._getPendingRedocksForTest().length, 0);
});

test('_redockPanel is a no-op for an unknown popupId', () => {
    const mod = freshPlugin();
    mod._setStartingForTest(false);
    mod._setPopupsForTest([]);
    assert.doesNotThrow(() => mod._redockPanel('does-not-exist', null, null));
});

// ── Popup crash reaping in the broadcaster tick ─────────────────────────────
// _startPopupBroadcaster's setInterval reaps popups whose window closed
// without firing beforeunload (crash / force-quit), by checking `popup.closed`.

function makeBroadcasterDocumentStub(audio) {
    return {
        getElementById: (id) => (id === 'audio' ? audio : null),
        addEventListener: noop,
        body: { appendChild: noop },
        createElement: () => ({
            style: {}, classList: { add: noop, remove: noop }, addEventListener: noop,
            appendChild: noop, setAttribute: noop, querySelector: () => null,
        }),
        readyState: 'loading',
    };
}

test('_startPopupBroadcaster reaps a popup whose window closed without a beforeunload/closed message', () => {
    const audio = { currentTime: 1, paused: false, addEventListener: noop };
    global.window = { location: { search: '', host: 'localhost:8420', protocol: 'http:' }, addEventListener: noop };
    global.document = makeBroadcasterDocumentStub(audio);
    global.localStorage = makeLocalStorage();
    global.location = global.window.location;

    let tick = null;
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    global.setInterval = (fn) => { tick = fn; return 42; };
    global.clearInterval = noop;
    global.BroadcastChannel = function () { this.postMessage = noop; };

    try {
        const mod = loadPlugin();
        mod._setPopupsForTest([
            ['live', { popup: { closed: false } }],
            ['dead', { popup: { closed: true } }],
        ]);
        mod._startPopupBroadcaster();
        assert.ok(tick, 'setInterval should have armed the broadcaster tick');
        tick(); // simulate one broadcaster interval firing
        const popups = mod._getPopupsForTest();
        assert.equal(popups.has('dead'), false, 'a popup reporting closed:true must be reaped');
        assert.equal(popups.has('live'), true, 'a still-open popup must not be reaped');
    } finally {
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
        delete global.BroadcastChannel;
    }
});

test('_startPopupBroadcaster stops itself once every popup is reaped and there is no LAN share', () => {
    const audio = { currentTime: 1, paused: false, addEventListener: noop };
    global.window = { location: { search: '', host: 'localhost:8420', protocol: 'http:' }, addEventListener: noop };
    global.document = makeBroadcasterDocumentStub(audio);
    global.localStorage = makeLocalStorage();
    global.location = global.window.location;

    let tick = null;
    let cleared = null;
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    global.setInterval = (fn) => { tick = fn; return 99; };
    global.clearInterval = (id) => { cleared = id; };
    global.BroadcastChannel = function () { this.postMessage = noop; };

    try {
        const mod = loadPlugin();
        mod._setPopupsForTest([['dead', { popup: { closed: true } }]]);
        mod._startPopupBroadcaster();
        tick();
        assert.equal(cleared, 99, 'broadcaster interval must be cleared once the last popup is reaped');
    } finally {
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
        delete global.BroadcastChannel;
    }
});

// ── Per-panel viz controls persistence (_vizPanelGet/_vizPanelSet) ───────────
// splitscreen#56: test coverage for the per-panel localStorage key scheme
// (h3d_bg_panel<N>_<key>), the global fallback (h3d_bg_<key>), the re-fire
// of window.h3dBgSet<Key> on every write, and getPanelControlsFor +
// buildVizPopover descriptor resolution.

// buildVizPopover exercises real DOM mutation (createElement/appendChild/
// style.cssText/textContent/checked/etc.), so it needs a richer document
// stub than makeDocumentStub()'s inert no-op element. This helper builds
// elements that record their created children and honor the property writes
// buildVizPopover performs — enough to assert the control types and to fire
// the onchange/oninput handlers that drive the round-trip into localStorage.
function makeVizElementStub(tag) {
    const el = {
        tagName: tag.toUpperCase(),
        style: {},
        classList: { add: noop, remove: noop },
        addEventListener: noop,
        appendChild: (child) => { el.children.push(child); },
        setAttribute: noop,
        textContent: '',
        value: '',
        checked: false,
        min: '',
        max: '',
        step: '',
        type: tag === 'input' ? 'text' : '',
        onchange: null,
        oninput: null,
        innerHTML: '',
        dataset: {},
        closest: () => null,
        remove: noop,
        replaceWith: noop,
        children: [],
    };
    return el;
}
function makeVizDocumentStub() {
    return {
        getElementById: () => null,
        addEventListener: noop,
        body: { appendChild: noop },
        createElement: (tag) => makeVizElementStub(tag),
        readyState: 'loading',
    };
}
function freshVizPlugin({ search = '', protocol = 'http:' } = {}) {
    const location = { search, host: 'localhost:8420', protocol };
    global.window = { location, addEventListener: noop };
    global.document = makeVizDocumentStub();
    global.localStorage = makeLocalStorage();
    global.location = location;
    return loadPlugin();
}

const VIZ_CTL = {
    palette:         { key: 'palette',         label: 'Palette',                type: 'select', default: 'default', options: [{ id: 'default', label: 'Default' }, { id: 'neon', label: 'Neon' }, { id: 'pastel', label: 'Pastel' }] },
    cameraSmoothing: { key: 'cameraSmoothing', label: 'Camera smoothing (X-pan)', type: 'range',  default: 0.5, min: 0, max: 1, step: 0.05 },
    cameraLockLow:   { key: 'cameraLockLow',   label: 'Lock camera at frets 1–12', type: 'toggle', default: false },
    cameraLockZoom:  { key: 'cameraLockZoom',  label: 'Locked zoom (In ↔ Out)',  type: 'range',  default: 0.5, min: 0, max: 1, step: 0.05 },
};

test('capability settings expose controls for any visualization and stay scoped to renderer instances', () => {
    const mod = freshVizPlugin();
    const controls = [{ key: 'handFilter', label: 'Hands', type: 'select', default: 'both',
        options: [{ id: 'both', label: 'Both' }, { id: 'left', label: 'LH' }, { id: 'right', label: 'RH' }] }];
    window.feedBack = { vizDomain: { snapshot: () => ({ providers: [{ id: 'piano', settings: controls }] }) } };
    const calls = [[], []];
    const panels = calls.map((list) => ({ vizMode: 'piano', vizRenderer: {
        applySetting: (key, value) => list.push([key, value]),
    } }));
    mod._setPanelsForTest(panels);
    assert.equal(mod.getPanelControlsFor('piano'), controls);
    mod._vizPanelSet('piano', 0, controls[0], 'left');
    mod._vizPanelSet('piano', 1, controls[0], 'right');
    assert.deepEqual(calls, [[['handFilter', 'left']], [['handFilter', 'right']]]);
    assert.equal(mod._vizPanelGet('piano', 0, controls[0]), 'left');
    assert.equal(mod._vizPanelGet('piano', 1, controls[0]), 'right');
    assert.equal(localStorage.getItem('piano_hand_filter'), null);
});

test('null visualization snapshot leaves controls unavailable without throwing', () => {
    const mod = freshVizPlugin();
    window.feedBack = { vizDomain: { snapshot: () => null } };
    assert.equal(mod.getPanelControlsFor('piano'), null);
    const panel = { vizMode: 'piano', vizRenderer: { applySetting: () => { throw Error('unexpected'); } } };
    mod._setPanelsForTest([panel]);
    assert.doesNotThrow(() => mod._restoreVizSettings(panel));
});

test('capability setting changes do not persist when the renderer rejects them', () => {
    const mod = freshPlugin();
    const ctl = { key: 'handFilter', type: 'select', default: 'both' };
    window.feedBack = { vizDomain: { snapshot: () => ({ providers: [{ id: 'piano', settings: [ctl] }] }) } };
    mod._setPanelsForTest([{ vizMode: 'piano', vizRenderer: { applySetting: () => { throw Error('failed'); } } }]);
    const oldError = console.error;
    console.error = noop;
    try { mod._vizPanelSet('piano', 0, ctl, 'left'); } finally { console.error = oldError; }
    assert.equal(mod._vizPanelGet('piano', 0, ctl), 'both');
});

test('capability settings restore into a replacement renderer for the same panel', () => {
    const mod = freshPlugin();
    const ctl = { key: 'handFilter', type: 'select', default: 'both' };
    window.feedBack = { vizDomain: { snapshot: () => ({ providers: [{ id: 'piano', settings: [ctl] }] }) } };
    const first = { vizMode: 'piano', vizRenderer: { applySetting: noop } };
    mod._setPanelsForTest([first]);
    mod._vizPanelSet('piano', 0, ctl, 'left');
    const restored = [];
    // The replacement renderer is a new panel object, but it adopts the saved
    // identity (prefs.vizId) — that's what carries the values across.
    const replacement = { vizMode: 'piano', vizId: first.vizId, vizRenderer: {
        applySetting: (key, value) => restored.push([key, value]),
    } };
    mod._setPanelsForTest([replacement]);
    mod._restoreVizSettings(replacement);
    assert.deepEqual(restored, [['handFilter', 'left']]);
});

test('a panel keeps its own viz overrides when a preceding panel is removed', () => {
    const mod = freshPlugin();
    const ctl = { key: 'handFilter', type: 'select', default: 'both' };
    window.feedBack = { vizDomain: { snapshot: () => ({ providers: [{ id: 'piano', settings: [ctl] }] }) } };
    const survivor = { vizMode: 'piano', vizRenderer: { applySetting: noop } };
    mod._setPanelsForTest([{ vizMode: 'piano', vizRenderer: { applySetting: noop } }, survivor]);
    mod._vizPanelSet('piano', 1, ctl, 'left');
    // Pop-out / rebuild compacts the array — the survivor moves from slot 1 to 0.
    mod._setPanelsForTest([survivor]);
    assert.equal(mod._vizPanelGet('piano', 0, ctl), 'left');
    const restored = [];
    survivor.vizRenderer = { applySetting: (key, value) => restored.push([key, value]) };
    mod._restoreVizSettings(survivor);
    assert.deepEqual(restored, [['handFilter', 'left']]);
    mod._vizPanelSet('piano', 0, ctl, 'right');
    assert.equal(mod._vizPanelGet('piano', 0, ctl), 'right');
});

test('a provider refresh restores and reveals controls on a panel built before providers existed', () => {
    const mod = freshVizPlugin();
    const ctl = { key: 'handFilter', label: 'Hands', type: 'select', default: 'both',
        options: [{ id: 'both', label: 'Both' }, { id: 'left', label: 'LH' }] };
    // Previous session: providers published, the user picked a value.
    let providers = [{ id: 'piano', settings: [ctl] }];
    window.feedBack = { vizDomain: { snapshot: () => ({ providers }) } };
    const previous = { vizMode: 'piano', vizRenderer: { applySetting: noop } };
    mod._setPanelsForTest([previous]);
    mod._vizPanelSet('piano', 0, ctl, 'left');
    const savedVizId = previous.vizId;
    assert.ok(savedVizId, 'writing a declared control mints a stable panel identity');

    // New session: core loads plugin scripts before it publishes providers, so
    // the panel initializes against an empty snapshot and adopts its saved id.
    providers = [];
    const restored = [];
    const panel = {
        vizMode: 'piano',
        vizId: savedVizId,
        vizSettingsBtn: { style: {} },
        vizPopover: makeVizElementStub('div'),
        vizRenderer: { applySetting: (key, value) => restored.push([key, value]) },
    };
    mod._setPanelsForTest([panel]);
    mod._showVizControls(panel, 'piano');
    mod._restoreVizSettings(panel);
    assert.equal(panel.vizSettingsBtn.style.display, 'none');
    assert.deepEqual(restored, []);

    // The refresh lands after panel init — the panel must catch up on its own.
    providers = [{ id: 'piano', settings: [ctl] }];
    mod._reconcileVizProviders();
    assert.equal(panel.vizSettingsBtn.style.display, '');
    assert.ok(panel.vizPopover.children.length > 0, 'popover must be built on refresh');
    assert.deepEqual(restored, [['handFilter', 'left']]);
});

test('_reconcileVizProviders leaves non-viz panels and plugins without declarations alone', () => {
    const mod = freshVizPlugin();
    window.feedBack = { vizDomain: { snapshot: () => ({ providers: [{ id: 'piano' }] }) } };
    const btn = { style: {} };
    const plain = { vizSettingsBtn: btn };
    const undeclared = { vizMode: 'piano', vizSettingsBtn: { style: {} }, vizPopover: makeVizElementStub('div') };
    mod._setPanelsForTest([plain, undeclared]);
    assert.doesNotThrow(() => mod._reconcileVizProviders());
    assert.equal(btn.style.display, undefined);
    assert.equal(undeclared.vizSettingsBtn.style.display, undefined);
});

// ── _vizPanelGet ─────────────────────────────────────────────────────────────

test('_vizPanelGet reads the panel-specific key when present', () => {
    const mod = freshPlugin();
    global.localStorage.setItem('h3d_bg_panel0_palette', 'neon');
    assert.equal(mod._vizPanelGet('highway_3d', 0, VIZ_CTL.palette), 'neon');
});

test('_vizPanelGet prefers panel-specific over global key', () => {
    const mod = freshPlugin();
    global.localStorage.setItem('h3d_bg_palette', 'pastel');
    global.localStorage.setItem('h3d_bg_panel0_palette', 'neon');
    assert.equal(mod._vizPanelGet('highway_3d', 0, VIZ_CTL.palette), 'neon');
});

test('_vizPanelGet falls back to the global key when panel-specific is absent', () => {
    const mod = freshPlugin();
    global.localStorage.setItem('h3d_bg_palette', 'pastel');
    assert.equal(mod._vizPanelGet('highway_3d', 0, VIZ_CTL.palette), 'pastel');
});

test('_vizPanelGet returns the descriptor default when neither key is set', () => {
    const mod = freshPlugin();
    assert.equal(mod._vizPanelGet('highway_3d', 0, VIZ_CTL.palette), 'default');
});

test('_vizPanelGet parses toggle values as booleans (true/1/false/0)', () => {
    const mod = freshPlugin();
    global.localStorage.setItem('h3d_bg_panel0_cameraLockLow', 'true');
    assert.equal(mod._vizPanelGet('highway_3d', 0, VIZ_CTL.cameraLockLow), true);
    global.localStorage.setItem('h3d_bg_panel0_cameraLockLow', '1');
    assert.equal(mod._vizPanelGet('highway_3d', 0, VIZ_CTL.cameraLockLow), true);
    global.localStorage.setItem('h3d_bg_panel0_cameraLockLow', 'false');
    assert.equal(mod._vizPanelGet('highway_3d', 0, VIZ_CTL.cameraLockLow), false);
    global.localStorage.setItem('h3d_bg_panel0_cameraLockLow', '0');
    assert.equal(mod._vizPanelGet('highway_3d', 0, VIZ_CTL.cameraLockLow), false);
});

test('_vizPanelGet coerces unrecognized toggle strings to false, not the descriptor default', () => {
    const mod = freshPlugin();
    global.localStorage.setItem('h3d_bg_panel0_cameraLockLow', 'garbage');
    // Descriptor default is true, so a regression that returns the default for
    // unrecognized strings would fail here — only 'true'/'1' coerce to true
    // (matching _vizPanelGet's v === 'true' || v === '1').
    const ctl = { key: 'cameraLockLow', label: 'Lock camera at frets 1–12', type: 'toggle', default: true };
    assert.equal(mod._vizPanelGet('highway_3d', 0, ctl), false);
});

test('_vizPanelGet clamps range values to the descriptor bounds', () => {
    const mod = freshPlugin();
    global.localStorage.setItem('h3d_bg_panel0_cameraSmoothing', '1.5');
    assert.equal(mod._vizPanelGet('highway_3d', 0, VIZ_CTL.cameraSmoothing), 1); // clamped to max
    global.localStorage.setItem('h3d_bg_panel0_cameraSmoothing', '-0.5');
    assert.equal(mod._vizPanelGet('highway_3d', 0, VIZ_CTL.cameraSmoothing), 0); // clamped to min
});

test('_vizPanelGet returns default for non-numeric range values', () => {
    const mod = freshPlugin();
    global.localStorage.setItem('h3d_bg_panel0_cameraSmoothing', 'notanumber');
    assert.equal(mod._vizPanelGet('highway_3d', 0, VIZ_CTL.cameraSmoothing), 0.5);
});

test('_vizPanelGet applies _ctlRange defaults when min/max/step are omitted from the descriptor', () => {
    const mod = freshPlugin();
    global.localStorage.setItem('h3d_bg_panel0_bareRange', '2.0');
    const ctl = { key: 'bareRange', type: 'range', default: 0.5 };
    // _ctlRange defaults: lo=0, hi=1, st=0.05 → 2.0 clamps to 1
    assert.equal(mod._vizPanelGet('highway_3d', 0, ctl), 1);
    global.localStorage.setItem('h3d_bg_panel0_bareRange', '-3');
    assert.equal(mod._vizPanelGet('highway_3d', 0, ctl), 0);
});

// ── _vizPanelSet ─────────────────────────────────────────────────────────────

test('_vizPanelSet writes only the panel-specific localStorage key', () => {
    const mod = freshPlugin();
    mod._vizPanelSet('highway_3d', 0, VIZ_CTL.palette, 'neon');
    assert.equal(global.localStorage.getItem('h3d_bg_panel0_palette'), 'neon');
    // Global key must NOT be touched
    assert.equal(global.localStorage.getItem('h3d_bg_palette'), null);
});

test('_vizPanelSet writes to the correct per-panel index', () => {
    const mod = freshPlugin();
    mod._vizPanelSet('highway_3d', 2, VIZ_CTL.cameraLockLow, true);
    assert.equal(global.localStorage.getItem('h3d_bg_panel2_cameraLockLow'), 'true');
    assert.equal(global.localStorage.getItem('h3d_bg_panel0_cameraLockLow'), null);
});

test('_vizPanelSet re-fires the plugin setter with the GLOBAL value (not the panel value)', () => {
    const mod = freshPlugin();
    let firedWith = null;
    window.h3dBgSetPalette = (v) => { firedWith = v; };
    global.localStorage.setItem('h3d_bg_palette', 'pastel');
    mod._vizPanelSet('highway_3d', 0, VIZ_CTL.palette, 'neon');
    assert.equal(firedWith, 'pastel', 'setter must re-fire with the global value so the plugin\'s change event runs');
});

test('_vizPanelSet re-fires toggle setter with a coerced boolean from the global', () => {
    const mod = freshPlugin();
    let firedWith = null;
    window.h3dBgSetCameraLockLow = (v) => { firedWith = v; };
    global.localStorage.setItem('h3d_bg_cameraLockLow', 'true');
    mod._vizPanelSet('highway_3d', 0, VIZ_CTL.cameraLockLow, true);
    assert.equal(firedWith, true);
});

test('_vizPanelSet re-fires range setter with a parsed float from the global', () => {
    const mod = freshPlugin();
    let firedWith = null;
    window.h3dBgSetCameraSmoothing = (v) => { firedWith = v; };
    global.localStorage.setItem('h3d_bg_cameraSmoothing', '0.75');
    mod._vizPanelSet('highway_3d', 0, VIZ_CTL.cameraSmoothing, 0.3);
    assert.equal(firedWith, 0.75);
});

test('_vizPanelSet uses the descriptor default for the setter re-fire when the global key is absent', () => {
    const mod = freshPlugin();
    let firedWith = null;
    window.h3dBgSetPalette = (v) => { firedWith = v; };
    mod._vizPanelSet('highway_3d', 0, VIZ_CTL.palette, 'neon');
    assert.equal(firedWith, 'default');
});

test('_vizPanelSet does not throw and skips the setter when the plugin is not loaded', () => {
    const mod = freshPlugin();
    assert.doesNotThrow(() => mod._vizPanelSet('highway_3d', 0, VIZ_CTL.palette, 'neon'));
    assert.equal(global.localStorage.getItem('h3d_bg_panel0_palette'), 'neon');
});

// ── getPanelControlsFor ─────────────────────────────────────────────────────

test('getPanelControlsFor returns null for plugins without per-panel controls', () => {
    const mod = freshPlugin();
    assert.equal(mod.getPanelControlsFor('piano'), null);
    assert.equal(mod.getPanelControlsFor('jumpingtab'), null);
    assert.equal(mod.getPanelControlsFor('unknown'), null);
});

test('getPanelControlsFor returns the built-in highway_3d descriptor (4 controls)', () => {
    const mod = freshPlugin();
    const ctrls = mod.getPanelControlsFor('highway_3d');
    assert.ok(Array.isArray(ctrls));
    assert.equal(ctrls.length, 4);
    const keys = ctrls.map(c => c.key);
    assert.deepEqual(keys, ['palette', 'cameraSmoothing', 'cameraLockLow', 'cameraLockZoom']);
    assert.equal(ctrls[0].type, 'select');
    assert.equal(ctrls[1].type, 'range');
    assert.equal(ctrls[2].type, 'toggle');
    assert.equal(ctrls[3].type, 'range');
});

test('getPanelControlsFor uses the plugin-published panelControls when present', () => {
    const mod = freshVizPlugin();
    window.feedBackViz_highway_3d = function () {};
    window.feedBackViz_highway_3d.panelControls = [
        { key: 'custom', label: 'Custom', type: 'toggle', default: true },
    ];
    const ctrls = mod.getPanelControlsFor('highway_3d');
    assert.deepEqual(ctrls, [{ key: 'custom', label: 'Custom', type: 'toggle', default: true }]);
});

test('getPanelControlsFor treats an empty plugin-published panelControls as an opt-out', () => {
    const mod = freshVizPlugin();
    window.feedBackViz_highway_3d = function () {};
    window.feedBackViz_highway_3d.panelControls = [];
    const ctrls = mod.getPanelControlsFor('highway_3d');
    assert.deepEqual(ctrls, []);
});

test('getPanelControlsFor prefers feedBackViz_ prefix over the legacy slopsmithViz_ prefix', () => {
    const mod = freshVizPlugin();
    window.slopsmithViz_highway_3d = function () {};
    window.slopsmithViz_highway_3d.panelControls = [
        { key: 'legacy', label: 'Legacy', type: 'toggle', default: false },
    ];
    window.feedBackViz_highway_3d = function () {};
    window.feedBackViz_highway_3d.panelControls = [
        { key: 'current', label: 'Current', type: 'toggle', default: true },
    ];
    const ctrls = mod.getPanelControlsFor('highway_3d');
    assert.deepEqual(ctrls, [{ key: 'current', label: 'Current', type: 'toggle', default: true }]);
});

// ── buildVizPopover ──────────────────────────────────────────────────────────

test('buildVizPopover clears the popover and appends a title row plus one control row per descriptor entry', () => {
    const mod = freshVizPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }]);

    const pop = makeVizElementStub('div');
    pop.innerHTML = '<stale>';
    const panel = { vizPopover: pop, vizMode: 'highway_3d' };
    mod._setPanelsForTest([panel]);

    mod.buildVizPopover(panel, 'highway_3d');

    assert.equal(pop.innerHTML, '', 'popover content must be cleared before rebuilding');
    // title (1) + palette (select) + cameraSmoothing (range) + cameraLockLow (toggle) + cameraLockZoom (range)
    assert.equal(pop.children.length, 5);
});

test('buildVizPopover creates a select with the correct options for a select control', () => {
    const mod = freshVizPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }]);
    global.localStorage.setItem('h3d_bg_palette', 'neon');

    const pop = makeVizElementStub('div');
    const panel = { vizPopover: pop, vizMode: 'highway_3d' };
    mod._setPanelsForTest([panel]);

    const created = [];
    global.document.createElement = (tag) => { const el = makeVizElementStub(tag); created.push(el); return el; };

    mod.buildVizPopover(panel, 'highway_3d');

    const selectEl = created.find(el => el.tagName === 'SELECT');
    assert.ok(selectEl, 'should create a select with 3 option elements');
    // The value should be sourced from _vizPanelGet (falls back to global 'neon')
    assert.equal(selectEl.value, 'neon');
    // Simulate the user picking 'midnight' — the onchange handler reads sel.value
    selectEl.value = 'midnight';
    selectEl.onchange();
    assert.equal(global.localStorage.getItem('h3d_bg_panel0_palette'), 'midnight');
});

test('buildVizPopover creates a range input honoring _ctlRange defaults and fires oninput', () => {
    const mod = freshVizPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }]);

    const pop = makeVizElementStub('div');
    const panel = { vizPopover: pop, vizMode: 'highway_3d' };
    mod._setPanelsForTest([panel]);

    const created = [];
    global.document.createElement = (tag) => { const el = makeVizElementStub(tag); created.push(el); return el; };

    mod.buildVizPopover(panel, 'highway_3d');

    const rangeEl = created.find(el => el.type === 'range');
    assert.ok(rangeEl, 'should create a range input');
    assert.equal(rangeEl.min, '0');
    assert.equal(rangeEl.max, '1');
    assert.equal(rangeEl.step, '0.05');
    assert.equal(rangeEl.value, '0.5'); // default cameraSmoothing

    // Fire oninput — should write the panel pref
    rangeEl.value = '0.8';
    rangeEl.oninput();
    assert.equal(global.localStorage.getItem('h3d_bg_panel0_cameraSmoothing'), '0.8');
});

test('buildVizPopover creates a checkbox for toggle controls and fires onchange', () => {
    const mod = freshVizPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }]);
    // Pre-set the panel-specific value so we can verify the checkbox reads it
    global.localStorage.setItem('h3d_bg_panel0_cameraLockLow', 'true');

    const pop = makeVizElementStub('div');
    const panel = { vizPopover: pop, vizMode: 'highway_3d' };
    mod._setPanelsForTest([panel]);

    const created = [];
    global.document.createElement = (tag) => { const el = makeVizElementStub(tag); created.push(el); return el; };

    mod.buildVizPopover(panel, 'highway_3d');

    const checkboxEl = created.find(el => el.type === 'checkbox');
    assert.ok(checkboxEl, 'should create a checkbox input for toggle controls');
    assert.equal(checkboxEl.checked, true, 'checkbox should reflect the saved panel-specific value');

    // Fire onchange (checkbox was toggled off)
    checkboxEl.checked = false;
    checkboxEl.onchange();
    assert.equal(global.localStorage.getItem('h3d_bg_panel0_cameraLockLow'), 'false');
});

test('buildVizPopover re-fires the plugin setter when its onchange handler runs', () => {
    const mod = freshVizPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }]);

    let firedWith = null;
    window.h3dBgSetCameraLockLow = (v) => { firedWith = v; };
    // Global is 'true' so the setter re-fire should pass `true`
    global.localStorage.setItem('h3d_bg_cameraLockLow', 'true');

    const pop = makeVizElementStub('div');
    const panel = { vizPopover: pop, vizMode: 'highway_3d' };
    mod._setPanelsForTest([panel]);

    const created = [];
    global.document.createElement = (tag) => { const el = makeVizElementStub(tag); created.push(el); return el; };

    mod.buildVizPopover(panel, 'highway_3d');

    const checkboxEl = created.find(el => el.type === 'checkbox');
    checkboxEl.checked = true;
    checkboxEl.onchange();

    assert.equal(firedWith, true, 'onchange should re-fire the plugin setter with the global value');
});

test('buildVizPopover uses _ctlRange defaults for a range control with no min/max/step in the descriptor', () => {
    const mod = freshVizPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }]);
    delete window.feedBackViz_highway_3d;

    // Inject a custom control set via the plugin-published panelControls
    window.feedBackViz_highway_3d = function () {};
    window.feedBackViz_highway_3d.panelControls = [
        { key: 'bareRange', label: 'Bare', type: 'range', default: 0.5 },
    ];

    const pop = makeVizElementStub('div');
    const panel = { vizPopover: pop, vizMode: 'highway_3d' };
    mod._setPanelsForTest([panel]);

    const created = [];
    global.document.createElement = (tag) => { const el = makeVizElementStub(tag); created.push(el); return el; };

    mod.buildVizPopover(panel, 'highway_3d');

    const rangeEl = created.find(el => el.type === 'range');
    assert.ok(rangeEl);
    assert.equal(rangeEl.min, '0');   // _ctlRange default lo
    assert.equal(rangeEl.max, '1');   // _ctlRange default hi
    assert.equal(rangeEl.step, '0.05'); // _ctlRange default st
    assert.equal(rangeEl.value, '0.5'); // descriptor default
});

test('buildVizPopover bails when the panel is not in the panels array', () => {
    const mod = freshVizPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }]);
    mod._setPanelsForTest([]); // empty — the panel is not registered

    const pop = makeVizElementStub('div');
    const panel = { vizPopover: pop, vizMode: 'highway_3d' };

    mod.buildVizPopover(panel, 'highway_3d');

    assert.equal(pop.children.length, 0, 'popover should be empty when the panel is not registered');
});

test('buildVizPopover bails when getPanelControlsFor returns null', () => {
    const mod = freshVizPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }]);

    const pop = makeVizElementStub('div');
    const panel = { vizPopover: pop, vizMode: 'piano' };
    mod._setPanelsForTest([panel]);

    mod.buildVizPopover(panel, 'piano');

    assert.equal(pop.children.length, 0, 'popover should be empty when there are no per-panel controls');
});

// ── sizeCanvases() (splitscreen#52) ─────────────────────────────────────────
// Covers the invariants documented in screen.js's own inline comment above
// the function (controlsH derivation — player-footer > player-controls >
// 50px default — the section-map top offset, passing each panel a
// precomputed {rect, barH} rather than letting it measure itself, skipping
// lyrics panels, and always resizing a chordsOverlay when present).

function makeSizeCanvasesDocumentStub(elements) {
    return {
        getElementById: (id) => elements[id] || null,
        addEventListener: noop,
        body: { appendChild: noop },
        createElement: () => ({
            style: {}, classList: { add: noop, remove: noop }, addEventListener: noop,
            appendChild: noop, setAttribute: noop,
        }),
        readyState: 'loading',
    };
}

function makeSizeCanvasesPanel(overrides = {}) {
    const resizeCalls = [];
    return Object.assign({
        lyricsMode: false,
        panelDiv: { getBoundingClientRect: () => ({ width: 400, height: 300 }) },
        bar: { style: { display: '' }, offsetHeight: 28 },
        hw: { resize: (measured) => resizeCalls.push(measured) },
        _resizeCalls: resizeCalls,
    }, overrides);
}

test('sizeCanvases is a no-op with no wrap or no panels', () => {
    const mod = freshPlugin();
    mod._setWrapForTest(null);
    mod._setPanelsForTest([makeSizeCanvasesPanel()]);
    assert.doesNotThrow(() => mod.sizeCanvases());

    mod._setWrapForTest({ style: {} });
    mod._setPanelsForTest([]);
    assert.doesNotThrow(() => mod.sizeCanvases());
});

test('sizeCanvases prefers #player-footer height over #player-controls, falling back to 50px', () => {
    const mod = freshPlugin();
    global.document = makeSizeCanvasesDocumentStub({
        'player-footer': { offsetHeight: 80 },
        'player-controls': { offsetHeight: 40 },
    });
    const wrap = { style: {} };
    mod._setWrapForTest(wrap);
    mod._setPanelsForTest([makeSizeCanvasesPanel()]);
    mod.sizeCanvases();
    assert.equal(wrap.style.bottom, '80px', 'player-footer height wins when present');
});

test('sizeCanvases falls back to #player-controls when no #player-footer exists', () => {
    const mod = freshPlugin();
    global.document = makeSizeCanvasesDocumentStub({
        'player-controls': { offsetHeight: 40 },
    });
    const wrap = { style: {} };
    mod._setWrapForTest(wrap);
    mod._setPanelsForTest([makeSizeCanvasesPanel()]);
    mod.sizeCanvases();
    assert.equal(wrap.style.bottom, '40px');
});

test('sizeCanvases defaults controlsH to 50px when neither chrome element exists', () => {
    const mod = freshPlugin();
    global.document = makeSizeCanvasesDocumentStub({});
    const wrap = { style: {} };
    mod._setWrapForTest(wrap);
    mod._setPanelsForTest([makeSizeCanvasesPanel()]);
    mod.sizeCanvases();
    assert.equal(wrap.style.bottom, '50px');
});

test('sizeCanvases offsets the wrap top by #section-map height when present', () => {
    const mod = freshPlugin();
    global.document = makeSizeCanvasesDocumentStub({
        'player-controls': { offsetHeight: 40 },
        'section-map': { offsetHeight: 22 },
    });
    const wrap = { style: {} };
    mod._setWrapForTest(wrap);
    mod._setPanelsForTest([makeSizeCanvasesPanel()]);
    mod.sizeCanvases();
    assert.equal(wrap.style.top, '22px');
});

test('sizeCanvases defaults the wrap top to 0px without a #section-map', () => {
    const mod = freshPlugin();
    global.document = makeSizeCanvasesDocumentStub({ 'player-controls': { offsetHeight: 40 } });
    const wrap = { style: {} };
    mod._setWrapForTest(wrap);
    mod._setPanelsForTest([makeSizeCanvasesPanel()]);
    mod.sizeCanvases();
    assert.equal(wrap.style.top, '0px');
});

test('sizeCanvases passes each panel a precomputed {rect, barH}, measured before any writes', () => {
    const mod = freshPlugin();
    global.document = makeSizeCanvasesDocumentStub({ 'player-controls': { offsetHeight: 40 } });
    mod._setWrapForTest({ style: {} });
    const panel = makeSizeCanvasesPanel();
    mod._setPanelsForTest([panel]);
    mod.sizeCanvases();
    assert.equal(panel._resizeCalls.length, 1);
    assert.deepEqual(panel._resizeCalls[0].rect, { width: 400, height: 300 });
    assert.equal(panel._resizeCalls[0].barH, 28, 'visible bar contributes its offsetHeight');
});

test('sizeCanvases treats a hidden bar as 0 height and defaults an unmeasured offsetHeight to 28', () => {
    const mod = freshPlugin();
    global.document = makeSizeCanvasesDocumentStub({ 'player-controls': { offsetHeight: 40 } });
    mod._setWrapForTest({ style: {} });
    const hidden = makeSizeCanvasesPanel({ bar: { style: { display: 'none' }, offsetHeight: 28 } });
    const unmeasured = makeSizeCanvasesPanel({ bar: { style: { display: '' }, offsetHeight: 0 } });
    mod._setPanelsForTest([hidden, unmeasured]);
    mod.sizeCanvases();
    assert.equal(hidden._resizeCalls[0].barH, 0, 'display:none bar must not contribute height');
    assert.equal(unmeasured._resizeCalls[0].barH, 28, 'a falsy offsetHeight (0) falls back to the 28px default');
});

test('sizeCanvases skips hw.resize entirely for a lyrics-mode panel', () => {
    const mod = freshPlugin();
    global.document = makeSizeCanvasesDocumentStub({ 'player-controls': { offsetHeight: 40 } });
    mod._setWrapForTest({ style: {} });
    const panel = makeSizeCanvasesPanel({ lyricsMode: true });
    mod._setPanelsForTest([panel]);
    mod.sizeCanvases();
    assert.equal(panel._resizeCalls.length, 0, 'a lyrics-mode panel must not be measured or resized');
});

test('sizeCanvases resizes a chordsOverlay when present, regardless of lyrics mode', () => {
    const mod = freshPlugin();
    global.document = makeSizeCanvasesDocumentStub({ 'player-controls': { offsetHeight: 40 } });
    mod._setWrapForTest({ style: {} });
    let overlayResized = 0;
    const panel = makeSizeCanvasesPanel({ lyricsMode: true, chordsOverlay: { resize: () => { overlayResized++; } } });
    mod._setPanelsForTest([panel]);
    mod.sizeCanvases();
    assert.equal(overlayResized, 1, 'chordsOverlay.resize() must run even for a lyrics-mode panel');
});

test('sizeCanvases resizes every panel independently in a multi-panel layout', () => {
    const mod = freshPlugin();
    global.document = makeSizeCanvasesDocumentStub({ 'player-controls': { offsetHeight: 40 } });
    mod._setWrapForTest({ style: {} });
    const p1 = makeSizeCanvasesPanel({ panelDiv: { getBoundingClientRect: () => ({ width: 200, height: 150 }) } });
    const p2 = makeSizeCanvasesPanel({ panelDiv: { getBoundingClientRect: () => ({ width: 300, height: 250 }) } });
    mod._setPanelsForTest([p1, p2]);
    mod.sizeCanvases();
    assert.equal(p1._resizeCalls[0].rect.width, 200);
    assert.equal(p2._resizeCalls[0].rect.width, 300);
});

test('sizeCanvases measures every panel before writing any resize (no interleaved read-write-read-write)', () => {
    // The function's own comment claims all layout READS happen before any
    // WRITE, to avoid one forced layout flush per panel. A regression to a
    // single per-panel loop (measure-then-resize-then-measure-then-resize)
    // wouldn't be caught by checking resize() call *arguments* alone — it
    // needs an ordering assertion across panels.
    const mod = freshPlugin();
    global.document = makeSizeCanvasesDocumentStub({ 'player-controls': { offsetHeight: 40 } });
    mod._setWrapForTest({ style: {} });
    const ops = [];
    const makeInstrumentedPanel = (name) => ({
        lyricsMode: false,
        panelDiv: { getBoundingClientRect: () => { ops.push(`measure:${name}`); return { width: 100, height: 100 }; } },
        bar: { style: { display: '' }, offsetHeight: 28 },
        hw: { resize: () => { ops.push(`resize:${name}`); } },
    });
    const p1 = makeInstrumentedPanel('p1');
    const p2 = makeInstrumentedPanel('p2');
    mod._setPanelsForTest([p1, p2]);
    mod.sizeCanvases();
    const firstResizeIdx = ops.indexOf('resize:p1');
    const lastMeasureIdx = Math.max(ops.indexOf('measure:p1'), ops.indexOf('measure:p2'));
    assert.ok(lastMeasureIdx < firstResizeIdx,
        `all measurements must complete before the first resize write; got order: ${ops.join(', ')}`);
});

// ── Render-mode / per-panel viz lifecycle (splitscreen#53) ──────────────────
// _showVizControls/_hideVizControls own the "Viz ⚙" button + popover visible
// only in viz mode, and recreatePanelHighway discards the old highway
// instance (stopping it, transferring inverted/lefty/mastery, replacing the
// canvas element) before installing a fresh one — the mechanism enterVizMode/
// exitVizMode/arrangement-switching all build on.

function makeVizLifecyclePanel(overrides = {}) {
    return Object.assign({
        vizSettingsBtn: { style: {} },
        vizPopover: { style: {}, innerHTML: '<stale>' },
    }, overrides);
}

test('_showVizControls hides the button when the plugin has no per-panel controls', () => {
    const mod = freshPlugin();
    const panel = makeVizLifecyclePanel();
    mod._showVizControls(panel, 'piano'); // no descriptor for 'piano'
    assert.equal(panel.vizSettingsBtn.style.display, 'none');
    assert.equal(panel.vizPopover.innerHTML, '');
});

test('_showVizControls shows the button and builds the popover when controls exist', () => {
    const mod = freshVizPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }]);
    const pop = makeVizElementStub('div');
    const panel = { vizSettingsBtn: { style: {} }, vizPopover: pop, vizMode: 'highway_3d' };
    mod._setPanelsForTest([panel]);
    mod._showVizControls(panel, 'highway_3d');
    assert.equal(panel.vizSettingsBtn.style.display, '');
    assert.ok(pop.children.length > 0, 'popover must be populated for a plugin with controls');
});

test('_showVizControls treats an empty plugin-published panelControls as an opt-out (hides, same as no descriptor)', () => {
    const mod = freshVizPlugin();
    window.feedBackViz_highway_3d = function () {};
    window.feedBackViz_highway_3d.panelControls = [];
    const panel = makeVizLifecyclePanel();
    mod._showVizControls(panel, 'highway_3d');
    assert.equal(panel.vizSettingsBtn.style.display, 'none');
});

test('_showVizControls is a no-op when the panel has no vizSettingsBtn at all', () => {
    const mod = freshPlugin();
    const panel = { vizPopover: { style: {}, innerHTML: '' } };
    assert.doesNotThrow(() => mod._showVizControls(panel, 'highway_3d'));
});

test('_hideVizControls hides the button and empties the popover', () => {
    const mod = freshPlugin();
    const panel = makeVizLifecyclePanel();
    panel.vizSettingsBtn.style.display = '';
    panel.vizPopover.style.display = '';
    mod._hideVizControls(panel);
    assert.equal(panel.vizSettingsBtn.style.display, 'none');
    assert.equal(panel.vizPopover.style.display, 'none');
    assert.equal(panel.vizPopover.innerHTML, '');
});

test('_hideVizControls tolerates a panel with no button or popover', () => {
    const mod = freshPlugin();
    assert.doesNotThrow(() => mod._hideVizControls({}));
});

test('_closeAllVizPopovers hides every panel\'s popover without touching panels that have none', () => {
    const mod = freshPlugin();
    const p1 = { vizPopover: { style: { display: '' } } };
    const p2 = { vizPopover: null };
    const p3 = { vizPopover: { style: { display: '' } } };
    mod._setPanelsForTest([p1, p2, p3]);
    assert.doesNotThrow(() => mod._closeAllVizPopovers());
    assert.equal(p1.vizPopover.style.display, 'none');
    assert.equal(p3.vizPopover.style.display, 'none');
});

// ── recreatePanelHighway ─────────────────────────────────────────────────────

function makeFakeHighway(overrides = {}) {
    return Object.assign({
        _stopped: false,
        stop() { this._stopped = true; },
        getInverted: () => false,
        getLefty: () => false,
        getMastery: () => 0.5,
        getRenderScale: () => 1,
        setInverted: noop,
        setLefty: noop,
        setLyricsVisible: noop,
        setMastery: noop,
        setRenderer: noop,
        init: noop,
        resize: noop,
    }, overrides);
}

function makeCanvasStub() {
    let replaced = null;
    return {
        style: { cssText: 'width:100%;height:100%;display:block;' },
        replaceWith(next) { replaced = next; },
        _getReplacedWith: () => replaced,
    };
}

test('recreatePanelHighway stops the old highway before the replacement is created and installed', () => {
    // Codex review finding on PR #61: checking final state alone (stopped ===
    // true, panel.hw === newHw) doesn't pin WHEN stop() happens — moving it
    // to just before hw.init() left both assertions green. Record an
    // operation log instead and assert 'stop' precedes every replacement step.
    const mod = freshVizPlugin();
    const ops = [];
    const oldHw = makeFakeHighway({ stop() { ops.push('old.stop'); } });
    let newHw;
    global.createHighway = () => {
        ops.push('createHighway');
        newHw = makeFakeHighway({ init: (c) => { ops.push('init:' + (c === panel.canvas ? 'newCanvas' : 'other')); } });
        return newHw;
    };
    const oldCanvas = makeCanvasStub();
    const panel = {
        hw: oldHw, canvas: oldCanvas,
        panelDiv: { getBoundingClientRect: () => ({ width: 100, height: 100 }) },
        bar: { style: { display: '' }, offsetHeight: 28 },
    };
    try {
        mod.recreatePanelHighway(panel);
        assert.equal(ops[0], 'old.stop', `old.stop() must happen before anything else; got order: ${ops.join(', ')}`);
        assert.ok(ops.indexOf('old.stop') < ops.indexOf('createHighway'), 'stop must precede creating the replacement highway');
        assert.ok(ops.indexOf('old.stop') < ops.indexOf('init:newCanvas'), 'stop must precede installing the replacement');
        assert.equal(panel.hw, newHw, 'the panel must now reference the fresh highway');
    } finally {
        delete global.createHighway;
    }
});

test('recreatePanelHighway replaces the canvas element and initializes the NEW highway against it, not the old one', () => {
    // Codex review finding on PR #61: the original test never checked what
    // hw.init() was actually called with — an implementation that replaced
    // the DOM element but still initialized against the detached oldCanvas
    // (leaving the highway attached to a context-locked, unrendered element)
    // passed unchanged.
    const mod = freshVizPlugin();
    let initedWith = null;
    global.createHighway = () => makeFakeHighway({ init: (c) => { initedWith = c; } });
    const oldCanvas = makeCanvasStub();
    const panel = {
        hw: makeFakeHighway(), canvas: oldCanvas,
        panelDiv: { getBoundingClientRect: () => ({ width: 100, height: 100 }) },
        bar: { style: { display: '' }, offsetHeight: 28 },
    };
    try {
        mod.recreatePanelHighway(panel);
        assert.notEqual(panel.canvas, oldCanvas, 'a fresh canvas element must replace the old one');
        assert.equal(oldCanvas._getReplacedWith(), panel.canvas, 'replaceWith must have been called with the new canvas');
        assert.equal(initedWith, panel.canvas, 'hw.init() must be called with the NEW canvas, not the detached old one');
        assert.notEqual(initedWith, oldCanvas, 'the highway must never be initialized against the old, now-detached canvas');
    } finally {
        delete global.createHighway;
    }
});

test('recreatePanelHighway transfers inverted/lefty/mastery from the old highway to the new one', () => {
    const mod = freshVizPlugin();
    const oldHw = makeFakeHighway({ getInverted: () => true, getLefty: () => true, getMastery: () => 0.75 });
    let seenInverted = null, seenLefty = null, seenMastery = null;
    const newHw = makeFakeHighway({
        setInverted: (v) => { seenInverted = v; },
        setLefty: (v) => { seenLefty = v; },
        setMastery: (v) => { seenMastery = v; },
    });
    global.createHighway = () => newHw;
    const panel = {
        hw: oldHw, canvas: makeCanvasStub(),
        panelDiv: { getBoundingClientRect: () => ({ width: 100, height: 100 }) },
        bar: { style: { display: '' }, offsetHeight: 28 },
    };
    try {
        mod.recreatePanelHighway(panel);
        assert.equal(seenInverted, true);
        assert.equal(seenLefty, true);
        assert.equal(seenMastery, 0.75);
    } finally {
        delete global.createHighway;
    }
});

test('recreatePanelHighway pre-installs a supplied renderer before init (context-type lock)', () => {
    const mod = freshVizPlugin();
    const order = [];
    const newHw = makeFakeHighway({
        setRenderer: (r) => { order.push('setRenderer:' + r); },
        init: () => { order.push('init'); },
    });
    global.createHighway = () => newHw;
    const panel = {
        hw: makeFakeHighway(), canvas: makeCanvasStub(),
        panelDiv: { getBoundingClientRect: () => ({ width: 100, height: 100 }) },
        bar: { style: { display: '' }, offsetHeight: 28 },
    };
    try {
        mod.recreatePanelHighway(panel, { preInstallRenderer: 'fake-renderer' });
        assert.deepEqual(order, ['setRenderer:fake-renderer', 'init'],
            'setRenderer must run before init so the canvas locks to the right context type');
    } finally {
        delete global.createHighway;
    }
});

test('recreatePanelHighway does not call setRenderer when no renderer is supplied', () => {
    const mod = freshVizPlugin();
    let setRendererCalled = false;
    const newHw = makeFakeHighway({ setRenderer: () => { setRendererCalled = true; } });
    global.createHighway = () => newHw;
    const panel = {
        hw: makeFakeHighway(), canvas: makeCanvasStub(),
        panelDiv: { getBoundingClientRect: () => ({ width: 100, height: 100 }) },
        bar: { style: { display: '' }, offsetHeight: 28 },
    };
    try {
        mod.recreatePanelHighway(panel);
        assert.equal(setRendererCalled, false);
    } finally {
        delete global.createHighway;
    }
});

test('recreatePanelHighway always turns off the highway-native lyrics flag (the panel-owned overlay is the single lyrics display)', () => {
    const mod = freshVizPlugin();
    let seenLyricsVisible = 'unset';
    const newHw = makeFakeHighway({ setLyricsVisible: (v) => { seenLyricsVisible = v; } });
    global.createHighway = () => newHw;
    const panel = {
        hw: makeFakeHighway(), canvas: makeCanvasStub(),
        panelDiv: { getBoundingClientRect: () => ({ width: 100, height: 100 }) },
        bar: { style: { display: '' }, offsetHeight: 28 },
    };
    try {
        mod.recreatePanelHighway(panel);
        assert.equal(seenLyricsVisible, false);
    } finally {
        delete global.createHighway;
    }
});

// The remaining #53 coverage deliberately drives the public UI handlers via
// the Node host.  The stubs below record lifecycle calls without attempting
// to emulate a browser canvas or a real WebSocket.
function makeModeCanvas() {
    let replacement = null;
    return {
        style: { cssText: 'width:100%;height:100%;display:block;', display: '' },
        replaceWith(next) { replacement = next; },
        _replacement: () => replacement,
    };
}

function makeModePanel(hw) {
    const button = () => ({ style: {}, onclick: null, disabled: false });
    const panelDiv = makeVizElementStub('div');
    panelDiv.getBoundingClientRect = () => ({ width: 100, height: 100 });
    return {
        hw,
        canvas: makeModeCanvas(),
        panelDiv,
        bar: { style: { display: '' }, offsetHeight: 28 },
        select: makeVizElementStub('select'),
        arrName: { textContent: '' },
        invertBtn: button(), leftyBtn: button(), lyricsBtn: button(), chordsBtn: button(),
        detectBtn: button(), channelBtn: button(),
        masteryHeading: { style: {} }, masterySlider: Object.assign(button(), { value: '100' }),
        masteryLabel: { style: {}, textContent: '' },
        popOutBtn: button(), vizSettingsBtn: button(), vizPopover: makeVizElementStub('div'),
        updateInvertStyle: noop, updateLeftyStyle: noop, updateLyricsStyle: noop, updateChordsStyle: noop,
    };
}

function withModeRuntime(fn) {
    const vizFactoryNames = ['feedBackViz_webgl', 'feedBackViz_twod'];
    const saved = {
        WebSocket: global.WebSocket,
        requestAnimationFrame: global.requestAnimationFrame,
        cancelAnimationFrame: global.cancelAnimationFrame,
        createHighway: global.createHighway,
        vizFactories: vizFactoryNames.map((name) => ({
            name,
            present: Object.prototype.hasOwnProperty.call(window, name),
            value: window[name],
        })),
    };
    global.WebSocket = class { close() {} };
    global.requestAnimationFrame = () => 1;
    global.cancelAnimationFrame = noop;
    try { fn(); }
    finally {
        global.WebSocket = saved.WebSocket;
        global.requestAnimationFrame = saved.requestAnimationFrame;
        global.cancelAnimationFrame = saved.cancelAnimationFrame;
        global.createHighway = saved.createHighway;
        for (const factory of saved.vizFactories) {
            if (factory.present) window[factory.name] = factory.value;
            else delete window[factory.name];
        }
    }
}

test('withModeRuntime restores overridden viz factories and removes factories that were absent', () => {
    freshVizPlugin();
    const originalWebgl = () => ({ original: true });
    window.feedBackViz_webgl = originalWebgl;
    delete window.feedBackViz_twod;

    withModeRuntime(() => {
        window.feedBackViz_webgl = () => ({ replacement: true });
        window.feedBackViz_twod = () => ({ temporary: true });
    });

    assert.equal(window.feedBackViz_webgl, originalWebgl);
    assert.equal(Object.prototype.hasOwnProperty.call(window, 'feedBackViz_twod'), false);
});

test('lyrics and viz modes are mutually exclusive across a single panel', () => withModeRuntime(() => {
    const mod = freshVizPlugin();
    mod._setCurrentFilenameForTest('song.sloppak');
    mod._setArrangementsForTest([{ name: 'Lead' }]);
    const oldHw = makeFakeHighway({ connect: noop });
    const panel = makeModePanel(oldHw);
    const initialCanvas = panel.canvas;
    mod._setPanelsForTest([panel]);

    mod.enterLyricsMode(panel);
    assert.equal(panel.lyricsMode, true);
    assert.equal(panel.canvas.style.display, 'none');
    assert.equal(oldHw._stopped, true, 'lyrics mode stops the normal highway');

    const replacement = makeFakeHighway({ connect: noop });
    global.createHighway = () => replacement;
    window.feedBackViz_webgl = () => ({ kind: 'webgl' });
    mod.enterVizMode(panel, 'webgl');
    assert.equal(panel.lyricsMode, false, 'entering viz exits the lyrics pane first');
    assert.equal(panel.vizMode, 'webgl');
    assert.notEqual(panel.canvas, initialCanvas, 'viz gets a fresh highway canvas after leaving lyrics mode');

    mod.enterLyricsMode(panel);
    assert.equal(panel.vizMode, null, 'entering lyrics exits the visualization first');
    assert.equal(panel.lyricsMode, true);
}));

test('a viz arrangement switch replaces the canvas for each 2D/WebGL context-type swap', () => withModeRuntime(() => {
    const mod = freshVizPlugin();
    mod._setCurrentFilenameForTest('song.sloppak');
    mod._setArrangementsForTest([{ name: 'Lead' }, { name: 'Rhythm' }]);
    const calls = [];
    const initial = makeFakeHighway({ connect: noop, setRenderer: (r) => calls.push(['clear', r]) });
    const panel = makeModePanel(initial);
    panel.arrIndex = 0;
    mod._setPanelsForTest([panel]);
    window.feedBackViz_webgl = () => ({ context: 'webgl' });
    window.feedBackViz_twod = () => ({ context: '2d' });
    global.createHighway = () => makeFakeHighway({
        connect: noop,
        setRenderer: (r) => calls.push(r ? ['install', r.context] : ['clear', r]),
    });

    // initPanel owns the real select.onchange branch.  Its node-only export
    // is the narrow seam needed to exercise that branch deterministically.
    mod.initPanel(panel, 0, { arrName: '__viz__:webgl:Lead' });
    const firstCanvas = panel.canvas;
    panel.select.value = '__viz__:twod:1';
    panel.select.onchange();
    const secondCanvas = panel.canvas;
    panel.select.value = '__viz__:webgl:0';
    panel.select.onchange();

    assert.notEqual(secondCanvas, firstCanvas, 'WebGL → 2D must discard the context-locked canvas');
    assert.notEqual(panel.canvas, secondCanvas, '2D → WebGL must discard that replacement canvas too');
    assert.deepEqual(calls.filter(([kind, renderer]) => kind === 'clear' && renderer === null), [['clear', null], ['clear', null]],
        'each in-viz arrangement switch clears the outgoing renderer before replacement');
    assert.deepEqual(calls.filter(([kind]) => kind === 'install').map(([, context]) => context), ['2d', 'webgl'],
        'each fresh highway pre-installs the requested renderer before init');
    assert.equal(panel.arrIndex, 0);
    assert.equal(panel.vizMode, 'webgl');
}));

// ── Player-context overrides: patch semantics (splitscreen#50) ─────────────
// window.slopsmithSplitscreen.setPlayerContext(i, patch) must PATCH the
// panel's stored overrides, not replace them — otherwise an override set by
// one caller (e.g. a profile_id from one system) is silently dropped the
// next time a different caller patches an unrelated field (e.g. skill).

test('setPlayerContext merges a second patch onto the first instead of replacing it', () => {
    const mod = freshPlugin();
    const panel = { hw: {} };
    mod._setPanelsForTest([panel]);

    global.window.slopsmithSplitscreen.setPlayerContext(0, { profile_id: 'p1' });
    assert.equal(panel.playerContextOverrides.profile_id, 'p1');

    global.window.slopsmithSplitscreen.setPlayerContext(0, { skill: 'overall' });
    assert.equal(panel.playerContextOverrides.profile_id, 'p1',
        'a later patch for an unrelated field must not drop an earlier override');
    assert.equal(panel.playerContextOverrides.skill, 'overall');
});

test('setPlayerContext only touches keys present in the patch, leaving the rest untouched', () => {
    const mod = freshPlugin();
    const panel = { hw: {} };
    mod._setPanelsForTest([panel]);

    global.window.slopsmithSplitscreen.setPlayerContext(0, { profile_id: 'p1', instrument: 'bass' });
    global.window.slopsmithSplitscreen.setPlayerContext(0, { role: 'lead' });

    assert.deepEqual(panel.playerContextOverrides, { profile_id: 'p1', instrument: 'bass', role: 'lead' });
});

// ── _panelRole: vocal/karaoke arrangement detection (pullfrog, splitscreen#62) ──
// A vocals/karaoke arrangement running in a regular (non-lyrics) panel must be
// labeled { instrument: 'voice', role: 'karaoke' } to match core's own
// vocal/voice/karaoke normalization in player-identity.js — otherwise the
// published context mislabels it as a generic guitar instrumental and core's
// karaoke difficulty guard never engages for it.

test('_panelRole detects a vocals/karaoke arrangement name and labels it voice/karaoke', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Vocals' }]);
    const panel = { arrIndex: 0, lyricsMode: false };
    assert.deepEqual(mod._panelRole(panel), { instrument: 'voice', role: 'karaoke' });
});

test('_panelRole still returns the lyrics-mode karaoke role when lyricsMode is set', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }]);
    const panel = { arrIndex: 0, lyricsMode: true };
    assert.deepEqual(mod._panelRole(panel), { instrument: 'voice', role: 'karaoke' });
});

test('_panelRole does not misclassify an unrelated arrangement as karaoke', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Lead Guitar' }]);
    const panel = { arrIndex: 0, lyricsMode: false };
    assert.deepEqual(mod._panelRole(panel), { instrument: 'guitar', role: 'lead' });
});

// ── Panel lifecycle: startSplitScreen / initPanel / sizeCanvases call sites (splitscreen#52) ──
//
// CLAUDE.md's own "Common pitfalls" flags this exact ordering as fragile:
// "hw.resize override must be set before hw.init() — the override happens in
// startSplitScreen() before initPanel(). If you call initPanel first, the
// highway will size itself to the full window on init and clobber siblings."
// Nothing in the suite drove startSplitScreen() end-to-end before this
// section — everything else tests already-exported units in isolation
// (sizeCanvases, recreatePanelHighway) with hand-built panel fixtures.

function makeLifecycleEl(tag) {
    const el = {
        tagName: String(tag || 'div').toUpperCase(),
        style: {},
        classList: { add() {}, remove() {}, contains() { return false; } },
        children: [],
        parentNode: null,
        dataset: {},
        attributes: {},
        // getBoundingClientRect() (used for panelDiv sizing) and offsetHeight
        // (used for the mini bar's height) are deliberately independent
        // fields, not derived from each other — a real mini-bar is ~28-40px
        // tall, much shorter than its containing panel, and collapsing both
        // to the same number here would make barH == panel height, zeroing
        // out every computed canvas height regardless of whether the real
        // resize logic is correct.
        _rect: { width: 200, height: 200, top: 0, left: 0 },
        _offsetHeight: 28,
        appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
        insertBefore(child) { this.children.push(child); child.parentNode = this; return child; },
        removeChild(child) { this.children = this.children.filter(c => c !== child); return child; },
        remove() { if (this.parentNode) this.parentNode.removeChild(this); },
        replaceWith(next) {
            if (this.parentNode) {
                const idx = this.parentNode.children.indexOf(this);
                if (idx >= 0) this.parentNode.children[idx] = next;
                next.parentNode = this.parentNode;
            }
            this.parentNode = null;
        },
        addEventListener() {},
        removeEventListener() {},
        setAttribute(k, v) { this.attributes[k] = v; },
        getAttribute(k) { return this.attributes[k]; },
        getBoundingClientRect() { return this._rect; },
        get offsetHeight() { return this._offsetHeight; },
        get offsetWidth() { return this._rect.width; },
        contains() { return false; },
        closest() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        value: '', checked: false, textContent: '', innerHTML: '',
        options: [], selectedIndex: -1,
        onclick: null, onchange: null, oninput: null,
        getContext() { return {}; },
    };
    return el;
}

const LIFECYCLE_KNOWN_IDS = ['player', 'player-footer', 'player-controls', 'highway', 'section-map'];

function freshLifecyclePlugin({ arrangements } = {}) {
    const location = { search: '', host: 'localhost:8420', protocol: 'http:' };
    const registry = new Map();
    for (const id of LIFECYCLE_KNOWN_IDS) registry.set(id, makeLifecycleEl('div'));
    global.window = { location, addEventListener() {}, feedBack: null };
    global.location = location;
    global.document = {
        getElementById: (id) => registry.get(id) || null,
        addEventListener() {},
        body: makeLifecycleEl('body'),
        createElement: (tag) => makeLifecycleEl(tag),
        readyState: 'loading',
    };
    global.localStorage = makeLocalStorage();
    global.highway = {
        getSongInfo: () => ({
            arrangements: arrangements || [{ name: 'Lead', index: 0 }, { name: 'Rhythm', index: 1 }],
        }),
    };
    return loadPlugin();
}

// A fake highway whose init() records, at the moment it's called, whether
// hw.resize is STILL the original function this factory installed (tagged
// via `_original`) or has already been overwritten by startSplitScreen's
// `hw.resize = function (measured) {...}` override. This makes the ordering
// bug directly observable: a regression that calls initPanel() before
// installing the override would leave `_original` on `this.resize` at the
// moment init() runs.
function makeOrderTrackingHighway(ops, tag) {
    const originalResize = function originalResize() { ops.push({ tag, op: 'resize', original: true }); };
    originalResize._original = true;
    const hw = {
        resize: originalResize,
        init(canvas) {
            ops.push({
                tag, op: 'init', canvas,
                resizeStillOriginal: hw.resize && hw.resize._original === true,
            });
        },
        stop() { ops.push({ tag, op: 'stop' }); },
        connect() {}, getRenderScale: () => 1,
        getInverted: () => false, getLefty: () => false, getMastery: () => 1,
        setInverted() {}, setLefty() {}, setMastery() {}, setRenderer() {}, setLyricsVisible() {},
    };
    return hw;
}

test('startSplitScreen installs the panel-specific hw.resize override before calling hw.init()', async () => {
    const mod = freshLifecyclePlugin();
    const ops = [];
    let panelIndex = 0;
    global.createHighway = () => makeOrderTrackingHighway(ops, panelIndex++);
    try {
        await mod._getVizPluginsReadyForTest();
        await mod.startSplitScreen([0, 1]);
        const initOps = ops.filter(o => o.op === 'init');
        assert.equal(initOps.length, 2, 'hw.init() must run for both panels');
        for (const o of initOps) {
            assert.equal(o.resizeStillOriginal, false,
                `panel ${o.tag}: hw.resize must already be startSplitScreen's override by the time hw.init() runs — ` +
                'CLAUDE.md: "If you call initPanel first, the highway will size itself to the full window on init and clobber siblings."');
        }
    } finally {
        delete global.createHighway;
        await mod.stopSplitScreen();
    }
});

// ── rebuildLayout's _pendingRebuild deferral (splitscreen#54) ──────────────
// Part of #54's scope ("Main-side _pendingRedocks/_pendingRebuild deferral
// when a start is in flight") that had zero coverage — rebuildLayout itself
// was never exercised by the suite before this. A layout change requested
// while startSplitScreen is still awaiting (e.g. _vizPluginsReady) must not
// race the in-flight panel build by tearing it down immediately; it defers
// into _pendingRebuild and that start's own `finally` (screen.js ~line 3484)
// drains it once, restarting the layout for real.

test('rebuildLayout defers via _pendingRebuild when a start is in flight, drained once by that start\'s finally', async () => {
    const mod = freshLifecyclePlugin();
    let createHighwayCalls = 0;
    global.createHighway = () => {
        createHighwayCalls++;
        return {
            init() {}, stop() {}, connect() {}, resize() {}, getRenderScale: () => 1,
            getInverted: () => false, getLefty: () => false, getMastery: () => 1,
            setInverted() {}, setLefty() {}, setMastery() {}, setRenderer() {}, setLyricsVisible() {},
        };
    };
    try {
        await mod._getVizPluginsReadyForTest();
        const p = mod.startSplitScreen([0, 1]); // not awaited — still "starting"
        // `active` is also still false at this synchronous point (startSplitScreen
        // hasn't reached the panel-build loop yet), so a broken guard that drops
        // its `return` and falls through to the teardown/restart body would be
        // indistinguishable from a correct deferral by createHighwayCalls alone
        // (both stay 0, since the fall-through's own `if (wasActive) restart`
        // check also short-circuits on the same false `active`). teardownPanels()
        // itself, however, runs unconditionally on that fall-through path and
        // bumps _ssRealStopGen — so that counter is the one signal that actually
        // distinguishes "returned early" from "fell through and happened to no-op
        // downstream". Confirmed by mutation: dropping only the `return` (keeping
        // the `_pendingRebuild = true` assignment) left the createHighwayCalls-only
        // version of this assertion green.
        const stopGenBeforeRebuild = mod._getSsRealStopGenForTest();
        mod.rebuildLayout();
        assert.equal(mod._getPendingRebuildForTest(), true,
            'a rebuild requested mid-start must be recorded as pending, not run immediately');
        assert.equal(createHighwayCalls, 0, 'deferring must not tear down/rebuild before the in-flight start finishes');
        assert.equal(mod._getSsRealStopGenForTest(), stopGenBeforeRebuild,
            'the _starting guard must return before reaching teardownPanels() at all — falling through to it ' +
            'and merely no-op-ing downstream is not the same as deferring');

        await p;
        await new Promise((r) => setTimeout(r, 50)); // let the drained rebuild's fire-and-forget startSplitScreen settle
        assert.equal(mod._getPendingRebuildForTest(), false, 'the pending flag must be cleared once drained');
        assert.equal(createHighwayCalls, 4,
            'exactly one drained rebuild must run after the start finishes (2 panels for the initial start + 2 for the rebuild)');
    } finally {
        delete global.createHighway;
        await mod.stopSplitScreen();
    }
});

// Note: startSplitScreen's panel loop overwrites hw.resize with its OWN
// closure (the "installs the override" test above) before sizeCanvases()
// ever runs — so a fake highway's own resize() method never actually fires;
// sizeCanvases() always calls the real override. These two tests therefore
// observe the override's real side effect (panel.canvas.width/height being
// set from panelDiv.getBoundingClientRect() × getRenderScale()) rather than
// spying on a highway method that gets clobbered before it matters.

test('startSplitScreen calls sizeCanvases after every panel is initialized', async () => {
    const mod = freshLifecyclePlugin();
    global.createHighway = () => ({
        init() {}, stop() {}, connect() {}, getRenderScale: () => 2,
        getInverted: () => false, getLefty: () => false, getMastery: () => 1,
        setInverted() {}, setLefty() {}, setMastery() {}, setRenderer() {}, setLyricsVisible() {},
    });
    try {
        await mod._getVizPluginsReadyForTest();
        await mod.startSplitScreen([0, 1]);
        // Each fixture panelDiv reports a 200x200 rect (makeLifecycleEl's
        // default _rect) with no bar height override, so a regression that
        // dropped the sizeCanvases() call at the end of startSplitScreen
        // would leave canvas.width/height at their construction-time
        // defaults (0) instead of the scaled, resized values.
        for (const p of mod._getPanelsForTest()) {
            assert.ok(p.canvas.width > 0 && p.canvas.height > 0,
                'sizeCanvases must have resized this panel\'s canvas after start, not left it at its default 0x0');
        }
    } finally {
        delete global.createHighway;
        await mod.stopSplitScreen();
    }
});

test('toggleControlsVisibility calls sizeCanvases while split is active, not while inactive', async () => {
    const mod = freshLifecyclePlugin();
    global.createHighway = () => ({
        init() {}, stop() {}, connect() {}, getRenderScale: () => 1,
        getInverted: () => false, getLefty: () => false, getMastery: () => 1,
        setInverted() {}, setLefty() {}, setMastery() {}, setRenderer() {}, setLyricsVisible() {},
    });
    try {
        // Inactive: toggling must not throw or touch panel sizing (there is
        // no wrap/panels yet) — sizeCanvases()'s own `if (!wrap ...) return`
        // guard is what should make this safe.
        assert.doesNotThrow(() => mod.toggleControlsVisibility());

        await mod._getVizPluginsReadyForTest();
        await mod.startSplitScreen([0, 1]);
        const panel = mod._getPanelsForTest()[0];
        const afterStartWidth = panel.canvas.width;
        assert.ok(afterStartWidth > 0, 'sanity: starting split already resized the panel once');

        // Shrink the panel's reported rect, then toggle — if
        // toggleControlsVisibility() calls sizeCanvases() again, the new
        // (smaller) rect must be picked up; if the call were dropped, the
        // canvas would still report the original start-time size.
        panel.panelDiv._rect = { width: 50, height: 50, top: 0, left: 0 };
        mod.toggleControlsVisibility();
        assert.notEqual(panel.canvas.width, afterStartWidth,
            'toggling controls while active must call sizeCanvases again and pick up the new rect');
    } finally {
        delete global.createHighway;
        await mod.stopSplitScreen();
    }
});

test('initPanel sets the documented default panel object shape (mode flags null/false)', async () => {
    const mod = freshLifecyclePlugin();
    global.createHighway = () => ({
        resize() {}, init() {}, stop() {}, connect() {}, getRenderScale: () => 1,
        getInverted: () => false, getLefty: () => false, getMastery: () => 1,
        setInverted() {}, setLefty() {}, setMastery() {}, setRenderer() {}, setLyricsVisible() {},
    });
    try {
        await mod._getVizPluginsReadyForTest();
        await mod.startSplitScreen([0, 1]);
        // CLAUDE.md's panel object shape table: lyricsMode/vizMode start
        // false/null for a plain (non-lyrics, non-viz) arrangement pick.
        for (const p of mod._getPanelsForTest()) {
            assert.equal(p.lyricsMode, false, 'a normal-highway panel must not start in lyrics mode');
            assert.equal(p.lyricsPane, null);
            assert.equal(p.lyricsOverlay, null);
            assert.equal(p.lyricsOverlayOn, false);
            assert.equal(p.chordsOverlay, null);
            assert.equal(p.chordsOverlayOn, false);
            assert.equal(p.vizMode, null, 'a normal-highway panel must not start in viz mode');
        }
    } finally {
        delete global.createHighway;
        await mod.stopSplitScreen();
    }
});

// ── Panel render-mode transitions and mutual exclusivity (splitscreen#53) ──
//
// CLAUDE.md: "Each panel is always in exactly one of these modes. Flags are
// mutually exclusive: entering one exits the others." Nothing in the suite
// previously drove enterLyricsMode/enterVizMode/exitVizMode/exitLyricsMode
// directly — recreatePanelHighway (which these call internally) already has
// its own dedicated coverage; these tests target the mode-flag bookkeeping
// layer sitting on top of it.

function stubBrowserGlobalsForModeTransitions() {
    const originalWebSocket = global.WebSocket;
    const originalRaf = global.requestAnimationFrame;
    const originalCaf = global.cancelAnimationFrame;
    // createLyricsPane's connect() does `new WebSocket(...)` with no
    // try/catch and `requestAnimationFrame(render)` — neither exists in
    // bare Node, and modern Node DOES ship a real global WebSocket that
    // would otherwise attempt a genuine (doomed) network connection to
    // localhost:8420 (same class of hazard CLAUDE.md's "Test-env note"
    // documents for the remote-join path). Stub both for the duration.
    global.WebSocket = function (url) { return new FakeWebSocket(0); };
    global.requestAnimationFrame = () => 1;
    global.cancelAnimationFrame = () => {};
    return function restore() {
        global.WebSocket = originalWebSocket;
        global.requestAnimationFrame = originalRaf;
        global.cancelAnimationFrame = originalCaf;
    };
}

function makeFakeVizFactory({ contextType = '2d' } = {}) {
    const fn = () => ({
        contextType,
        init() {}, draw() {}, destroy() {}, resize() {},
    });
    return fn;
}

test('enterLyricsMode exits an active viz mode first (mutual exclusivity)', async () => {
    const mod = freshLifecyclePlugin();
    global.createHighway = () => ({
        init() {}, stop() {}, connect() {}, getRenderScale: () => 1,
        getInverted: () => false, getLefty: () => false, getMastery: () => 1,
        setInverted() {}, setLefty() {}, setMastery() {}, setRenderer() {}, setLyricsVisible() {},
    });
    global.window.feedBackViz_myviz = makeFakeVizFactory();
    const restore = stubBrowserGlobalsForModeTransitions();
    try {
        await mod._getVizPluginsReadyForTest();
        await mod.startSplitScreen([0, 1]);
        const panel = mod._getPanelsForTest()[0];

        mod.enterVizMode(panel, 'myviz');
        assert.equal(panel.vizMode, 'myviz', 'sanity: panel entered viz mode');
        assert.equal(panel.lyricsMode, false);

        mod.enterLyricsMode(panel);
        assert.equal(panel.lyricsMode, true, 'entering lyrics mode must actually take effect');
        assert.equal(panel.vizMode, null, 'entering lyrics mode must exit the prior viz mode, not stack on top of it');
    } finally {
        await mod.stopSplitScreen();
        restore();
        delete global.window.feedBackViz_myviz;
        delete global.createHighway;
    }
});

test('enterVizMode exits an active lyrics mode first (mutual exclusivity)', async () => {
    const mod = freshLifecyclePlugin();
    global.createHighway = () => ({
        init() {}, stop() {}, connect() {}, getRenderScale: () => 1,
        getInverted: () => false, getLefty: () => false, getMastery: () => 1,
        setInverted() {}, setLefty() {}, setMastery() {}, setRenderer() {}, setLyricsVisible() {},
    });
    global.window.feedBackViz_myviz = makeFakeVizFactory();
    const restore = stubBrowserGlobalsForModeTransitions();
    try {
        await mod._getVizPluginsReadyForTest();
        await mod.startSplitScreen([0, 1]);
        const panel = mod._getPanelsForTest()[0];

        mod.enterLyricsMode(panel);
        assert.equal(panel.lyricsMode, true, 'sanity: panel entered lyrics mode');

        mod.enterVizMode(panel, 'myviz');
        assert.equal(panel.vizMode, 'myviz', 'entering viz mode must actually take effect');
        assert.equal(panel.lyricsMode, false, 'entering viz mode must exit the prior lyrics mode, not stack on top of it');
    } finally {
        await mod.stopSplitScreen();
        restore();
        delete global.window.feedBackViz_myviz;
        delete global.createHighway;
    }
});

test('enterLyricsMode is a no-op when the panel is already in lyrics mode', async () => {
    const mod = freshLifecyclePlugin();
    global.createHighway = () => ({
        init() {}, stop() {}, connect() {}, getRenderScale: () => 1,
        getInverted: () => false, getLefty: () => false, getMastery: () => 1,
        setInverted() {}, setLefty() {}, setMastery() {}, setRenderer() {}, setLyricsVisible() {},
    });
    const restore = stubBrowserGlobalsForModeTransitions();
    try {
        await mod._getVizPluginsReadyForTest();
        await mod.startSplitScreen([0, 1]);
        const panel = mod._getPanelsForTest()[0];

        mod.enterLyricsMode(panel);
        const firstPane = panel.lyricsPane;
        assert.ok(firstPane, 'sanity: a lyrics pane was created');

        mod.enterLyricsMode(panel);
        assert.equal(panel.lyricsPane, firstPane,
            'a second enterLyricsMode call on an already-lyrics panel must not tear down and recreate the pane');
    } finally {
        await mod.stopSplitScreen();
        restore();
        delete global.createHighway;
    }
});

test('enterVizMode is a no-op when the panel is already in ANY viz mode, even a different plugin', async () => {
    // This is exactly why the panel.select.onchange handler has its own
    // separate in-place viz-to-viz switch branch instead of just calling
    // enterVizMode again — enterVizMode's own `if (panel.vizMode) return;`
    // guard makes a direct call a no-op regardless of which plugin is
    // requested, by design (mirrors the lyrics no-op guard above).
    const mod = freshLifecyclePlugin();
    global.createHighway = () => ({
        init() {}, stop() {}, connect() {}, getRenderScale: () => 1,
        getInverted: () => false, getLefty: () => false, getMastery: () => 1,
        setInverted() {}, setLefty() {}, setMastery() {}, setRenderer() {}, setLyricsVisible() {},
    });
    global.window.feedBackViz_vizA = makeFakeVizFactory();
    global.window.feedBackViz_vizB = makeFakeVizFactory();
    const restore = stubBrowserGlobalsForModeTransitions();
    try {
        await mod._getVizPluginsReadyForTest();
        await mod.startSplitScreen([0, 1]);
        const panel = mod._getPanelsForTest()[0];

        mod.enterVizMode(panel, 'vizA');
        assert.equal(panel.vizMode, 'vizA');

        mod.enterVizMode(panel, 'vizB');
        assert.equal(panel.vizMode, 'vizA', 'a direct enterVizMode call while already in viz mode must be a no-op');
    } finally {
        await mod.stopSplitScreen();
        restore();
        delete global.window.feedBackViz_vizA;
        delete global.window.feedBackViz_vizB;
        delete global.createHighway;
    }
});

test('the in-place viz-to-viz switch (panel.select.onchange) installs the new plugin, unlike a direct enterVizMode call', async () => {
    const mod = freshLifecyclePlugin();
    global.createHighway = () => ({
        init() {}, stop() {}, connect() {}, getRenderScale: () => 1,
        getInverted: () => false, getLefty: () => false, getMastery: () => 1,
        setInverted() {}, setLefty() {}, setMastery() {}, setRenderer() {}, setLyricsVisible() {},
    });
    global.window.feedBackViz_vizA = makeFakeVizFactory();
    global.window.feedBackViz_vizB = makeFakeVizFactory();
    const restore = stubBrowserGlobalsForModeTransitions();
    try {
        await mod._getVizPluginsReadyForTest();
        await mod.startSplitScreen([0, 1]);
        const panel = mod._getPanelsForTest()[0];

        mod.enterVizMode(panel, 'vizA');
        assert.equal(panel.vizMode, 'vizA', 'sanity: panel entered viz mode with vizA');

        panel.select.value = '__viz__:vizB:' + panel.arrIndex;
        panel.select.onchange();
        assert.equal(panel.vizMode, 'vizB',
            'the in-place select.onchange branch must actually switch plugins where a direct enterVizMode call would no-op');
    } finally {
        await mod.stopSplitScreen();
        restore();
        delete global.window.feedBackViz_vizA;
        delete global.window.feedBackViz_vizB;
        delete global.createHighway;
    }
});

// ── _handleFollowerSongChange single-flight coalescing (splitscreen#54) ────
// #59 covered the orphaned early-return only. These tests stand up a full
// (if minimal) follower rebuild stack — via the same makeLifecycleEl DOM
// stub startSplitScreen's lifecycle tests use, plus an 'audio' element and a
// stubbed window.playSong — so _handleFollowerSongChange's real body runs
// end to end instead of failing before its single-flight guard matters.
//
// window.playSong is the one signal that distinguishes "a rebuild actually
// ran for filename X" from "it didn't": loadSongInFollower awaits it first
// thing, so spying on it (via the plugin's own window.playSong wrapper,
// which calls through to whatever was on window.playSong before the plugin
// loaded) gives an ordered, per-filename trace of every rebuild that ran.
//
// BroadcastChannel must be deleted for these tests — buildFollowerLayout
// subscribes a real (non-remote) follower to `_ssChannel()`, and Node's
// real global BroadcastChannel keeps the event loop alive once opened,
// hanging the run (only visible under `node --test`; a script that calls
// process.exit() masks it). Same hazard the LAN-share section above
// documents for _ensureMainBroadcasterAndListener.

function freshFollowerRebuildPlugin(playSongCalls) {
    const registry = new Map();
    for (const id of [...LIFECYCLE_KNOWN_IDS, 'audio']) registry.set(id, makeLifecycleEl('div'));
    const audioEl = registry.get('audio');
    audioEl.muted = false;
    audioEl.volume = 1;
    audioEl.paused = true;
    audioEl.pause = function () { this.paused = true; };

    const location = { search: '', host: 'localhost:8420', protocol: 'http:' };
    global.window = {
        location, addEventListener() {}, feedBack: null,
        playSong: async (f) => { playSongCalls.push(f); },
    };
    global.location = location;
    global.document = {
        getElementById: (id) => registry.get(id) || null,
        addEventListener() {},
        body: makeLifecycleEl('body'),
        createElement: (tag) => makeLifecycleEl(tag),
        readyState: 'loading',
    };
    global.localStorage = makeLocalStorage();
    global.highway = {
        getSongInfo: () => ({ arrangements: [{ name: 'Lead', index: 0 }] }),
        setTime() {},
    };
    global.createHighway = () => ({
        init() {}, stop() {}, connect() {}, resize() {}, setTime() {},
        getRenderScale: () => 1,
        getInverted: () => false, getLefty: () => false, getMastery: () => 1,
        setInverted() {}, setLefty() {}, setMastery() {}, setRenderer() {}, setLyricsVisible() {},
    });
    return loadPlugin();
}

test('_handleFollowerSongChange coalesces a song-change that arrives mid-rebuild instead of starting a second overlapping rebuild', async () => {
    const originalRaf = global.requestAnimationFrame;
    const originalCaf = global.cancelAnimationFrame;
    const originalBC = global.BroadcastChannel;
    global.requestAnimationFrame = () => 1;
    global.cancelAnimationFrame = () => {};
    delete global.BroadcastChannel;

    const playSongCalls = [];
    try {
        const mod = freshFollowerRebuildPlugin(playSongCalls);
        await mod._getVizPluginsReadyForTest();
        mod._setPanelsForTest([]);
        mod._setWrapForTest(null);
        mod._setCurrentFilenameForTest('a.sloppak');
        mod._setFollowerForTest({ remote: false, popupId: 'p1' });
        mod._setFollowerOrphanedForTest(false);

        const p1 = mod._handleFollowerSongChange('b.sloppak');
        // Fired synchronously while call 1 is still busy (it doesn't hit its
        // own first await until inside loadSongInFollower's window.playSong
        // call) — must coalesce, not run immediately.
        mod._handleFollowerSongChange('c.sloppak');
        assert.equal(mod._getFollowerPendingFilenameForTest(), 'c.sloppak',
            'a song-change arriving while busy must be recorded as pending, not run');
        assert.equal(mod._getFollowerRebuildBusyForTest(), true, 'the first rebuild must still be marked busy');
        assert.deepEqual(playSongCalls, ['b.sloppak'], 'the pending filename must not start its own rebuild yet');

        await p1;
        await new Promise((r) => setTimeout(r, 50)); // let the coalesced follow-up rebuild run
        assert.deepEqual(playSongCalls, ['b.sloppak', 'c.sloppak'],
            'the coalesced filename must run exactly once, after the in-flight rebuild finishes');
        assert.equal(mod._getFollowerPendingFilenameForTest(), null);
    } finally {
        global.requestAnimationFrame = originalRaf;
        global.cancelAnimationFrame = originalCaf;
        if (originalBC === undefined) delete global.BroadcastChannel; else global.BroadcastChannel = originalBC;
    }
});

test('_handleFollowerSongChange keeps only the LATEST coalesced filename — an intermediate one is dropped', async () => {
    const originalRaf = global.requestAnimationFrame;
    const originalCaf = global.cancelAnimationFrame;
    const originalBC = global.BroadcastChannel;
    global.requestAnimationFrame = () => 1;
    global.cancelAnimationFrame = () => {};
    delete global.BroadcastChannel;

    const playSongCalls = [];
    try {
        const mod = freshFollowerRebuildPlugin(playSongCalls);
        await mod._getVizPluginsReadyForTest();
        mod._setPanelsForTest([]);
        mod._setWrapForTest(null);
        mod._setCurrentFilenameForTest('a.sloppak');
        mod._setFollowerForTest({ remote: false, popupId: 'p1' });
        mod._setFollowerOrphanedForTest(false);

        const p1 = mod._handleFollowerSongChange('b.sloppak');
        mod._handleFollowerSongChange('c.sloppak'); // coalesced, then overwritten
        mod._handleFollowerSongChange('d.sloppak'); // must replace 'c' as the pending filename
        assert.equal(mod._getFollowerPendingFilenameForTest(), 'd.sloppak');

        await p1;
        await new Promise((r) => setTimeout(r, 50));
        assert.deepEqual(playSongCalls, ['b.sloppak', 'd.sloppak'],
            'only the latest coalesced filename must run — an intermediate one arriving mid-rebuild is dropped, not queued');
    } finally {
        global.requestAnimationFrame = originalRaf;
        global.cancelAnimationFrame = originalCaf;
        if (originalBC === undefined) delete global.BroadcastChannel; else global.BroadcastChannel = originalBC;
    }
});

// ── Main-window docked/closed BroadcastChannel dispatch (splitscreen#54) ───
// _redockPanel itself is already covered directly. What's new here is the
// _ensureMainBroadcasterAndListener → ch.onmessage dispatcher that decides
// WHEN to call it (and when to drop a popups entry outright) from a raw
// 'docked'/'closed' message — that parsing/routing layer had no coverage.

function makeTrackingBC(instances) {
    return function FakeBC() {
        this.postMessage = noop;
        this.close = noop;
        instances.push(this);
    };
}

test('_ensureMainBroadcasterAndListener dispatches a docked message to _redockPanel with its finalState/finalStates', () => {
    const mod = freshPlugin();
    const instances = [];
    global.BroadcastChannel = makeTrackingBC(instances);
    try {
        mod._setStartingForTest(true); // forces _redockPanel to defer into _pendingRedocks, observable without a real restart
        mod._setPopupsForTest([['pop-1', { popup: {} }]]);
        mod._ensureMainBroadcasterAndListener();
        assert.equal(instances.length, 1);

        instances[0].onmessage({ data: { type: 'docked', popupId: 'pop-1', finalState: { some: 'state' }, finalStates: null } });

        const pending = mod._getPendingRedocksForTest();
        assert.equal(pending.length, 1);
        assert.equal(pending[0].popupId, 'pop-1');
        assert.deepEqual(pending[0].finalState, { some: 'state' },
            'the dispatcher must forward the message\'s finalState through to _redockPanel unchanged');
    } finally {
        delete global.BroadcastChannel;
    }
});

test('_ensureMainBroadcasterAndListener ignores a docked message for a popupId it doesn\'t know about', () => {
    const mod = freshPlugin();
    const instances = [];
    global.BroadcastChannel = makeTrackingBC(instances);
    try {
        mod._setStartingForTest(true);
        mod._setPopupsForTest([]); // no known popups
        mod._ensureMainBroadcasterAndListener();
        instances[0].onmessage({ data: { type: 'docked', popupId: 'unknown', finalState: null, finalStates: null } });
        assert.equal(mod._getPendingRedocksForTest().length, 0, 'an unrecognized popupId must not be redocked');
    } finally {
        delete global.BroadcastChannel;
    }
});

test('_ensureMainBroadcasterAndListener drops the popups entry on a closed message when no redock is pending', () => {
    const mod = freshPlugin();
    const instances = [];
    global.BroadcastChannel = makeTrackingBC(instances);
    try {
        mod._setPopupsForTest([['pop-2', { popup: {} }]]);
        mod._ensureMainBroadcasterAndListener();
        instances[0].onmessage({ data: { type: 'closed', popupId: 'pop-2' } });
        assert.equal(mod._getPopupsForTest().has('pop-2'), false);
    } finally {
        delete global.BroadcastChannel;
    }
});

test('_ensureMainBroadcasterAndListener does NOT drop the popups entry on a closed message when a redock is already pending for it', () => {
    const mod = freshPlugin();
    const instances = [];
    global.BroadcastChannel = makeTrackingBC(instances);
    try {
        // First, a 'docked' message arrives while a start is in flight, queuing
        // a pending redock for pop-3 without dropping the popups entry (per
        // _redockPanel's own deferral behavior, already covered elsewhere).
        mod._setStartingForTest(true);
        mod._setPopupsForTest([['pop-3', { popup: {} }]]);
        mod._ensureMainBroadcasterAndListener();
        instances[0].onmessage({ data: { type: 'docked', popupId: 'pop-3', finalState: null, finalStates: null } });
        assert.equal(mod._getPendingRedocksForTest().length, 1, 'sanity: a redock is now pending for pop-3');

        // An older-build popup belt-and-suspenders 'closed' post for the same
        // popup must NOT drop the entry — the pending redock still needs it.
        instances[0].onmessage({ data: { type: 'closed', popupId: 'pop-3' } });
        assert.equal(mod._getPopupsForTest().has('pop-3'), true,
            'a closed message must not drop a popups entry that already has a redock pending for it');
    } finally {
        delete global.BroadcastChannel;
    }
});

// ── Follower clock interpolation (splitscreen#54) ───────────────────────────
// _onFollowerTimeMessage derives _followerObservedRate from consecutive
// `time` broadcast deltas; _startFollowerInterp extrapolates
// _followerCurrentTime forward from that rate between broadcasts, capped at
// _FOLLOWER_MAX_EXTRAP_S. Only the basic time-set + playing-flag behavior of
// _followerBusHandler's 'time' branch was covered before this (see #59).

test('_onFollowerTimeMessage derives observedRate from consecutive time deltas (tracks the speed slider)', () => {
    const originalPerf = global.performance;
    let fakeNow = 1000;
    global.performance = { now: () => fakeNow };
    try {
        const mod = freshPlugin();
        mod._followerBusHandler({ type: 'time', t: 10, playing: true }); // first message — no prior anchor, rate stays default 1
        assert.equal(mod._getFollowerObservedRateForTest(), 1);

        fakeNow += 1000; // 1s of wall-clock later
        mod._followerBusHandler({ type: 'time', t: 11.5, playing: true }); // 1.5s of chart time in 1s of wall time
        assert.equal(mod._getFollowerObservedRateForTest(), 1.5);
    } finally {
        global.performance = originalPerf;
    }
});

test('_onFollowerTimeMessage resets observedRate to 1 on an out-of-band jump (seek forward, loop wrap, or a long gap)', () => {
    const originalPerf = global.performance;
    let fakeNow = 1000;
    global.performance = { now: () => fakeNow };
    try {
        const mod = freshPlugin();
        mod._followerBusHandler({ type: 'time', t: 10, playing: true });
        fakeNow += 1000;
        mod._followerBusHandler({ type: 'time', t: 11.5, playing: true }); // establishes rate 1.5
        assert.equal(mod._getFollowerObservedRateForTest(), 1.5);

        fakeNow += 1000;
        mod._followerBusHandler({ type: 'time', t: 200, playing: true }); // huge forward jump — a seek, not real playback speed
        assert.equal(mod._getFollowerObservedRateForTest(), 1, 'an out-of-band forward jump must snap the rate back to 1, not extrapolate the seek as a speed change');
    } finally {
        global.performance = originalPerf;
    }
});

test('_onFollowerTimeMessage resets observedRate to 1 on a backward seek', () => {
    const originalPerf = global.performance;
    let fakeNow = 1000;
    global.performance = { now: () => fakeNow };
    try {
        const mod = freshPlugin();
        mod._followerBusHandler({ type: 'time', t: 10, playing: true });
        fakeNow += 1000;
        mod._followerBusHandler({ type: 'time', t: 11.5, playing: true });
        assert.equal(mod._getFollowerObservedRateForTest(), 1.5);

        fakeNow += 1000;
        mod._followerBusHandler({ type: 'time', t: 2, playing: true }); // backward — a seek
        assert.equal(mod._getFollowerObservedRateForTest(), 1);
    } finally {
        global.performance = originalPerf;
    }
});

test('_startFollowerInterp extrapolates _followerCurrentTime forward using observedRate between time messages', () => {
    const originalPerf = global.performance;
    const originalRaf = global.requestAnimationFrame;
    const originalCaf = global.cancelAnimationFrame;
    let fakeNow = 1000;
    let tick = null;
    global.performance = { now: () => fakeNow };
    global.requestAnimationFrame = (fn) => { tick = fn; return 1; };
    global.cancelAnimationFrame = () => {};
    try {
        const mod = freshPlugin();
        let sawTime = null;
        mod._setPanelsForTest([makeFollowerPanel({ hw: { setTime: (t) => { sawTime = t; } } })]);

        mod._followerBusHandler({ type: 'time', t: 10, playing: true }); // anchor: t=10 at fakeNow=1000, rate=1 (no prior anchor)
        mod._startFollowerInterp();
        assert.ok(tick, 'requestAnimationFrame must have armed the extrapolation loop');

        fakeNow += 500; // half a second of wall-clock time passes with no new broadcast
        tick();
        assert.equal(mod._getFollowerCurrentTimeForTest(), 10.5, 'must extrapolate forward at the observed rate (1x here)');
        assert.equal(sawTime, 10.5, 'every non-lyrics panel must be fanned the extrapolated time');
    } finally {
        global.performance = originalPerf;
        global.requestAnimationFrame = originalRaf;
        global.cancelAnimationFrame = originalCaf;
    }
});

test('_startFollowerInterp stops extrapolating and flips _followerPlaying false once past _FOLLOWER_MAX_EXTRAP_S', () => {
    const originalPerf = global.performance;
    const originalRaf = global.requestAnimationFrame;
    const originalCaf = global.cancelAnimationFrame;
    let fakeNow = 1000;
    let tick = null;
    global.performance = { now: () => fakeNow };
    global.requestAnimationFrame = (fn) => { tick = fn; return 1; };
    global.cancelAnimationFrame = () => {};
    try {
        const mod = freshPlugin();
        mod._setPanelsForTest([]);
        mod._followerBusHandler({ type: 'time', t: 10, playing: true });
        mod._startFollowerInterp();

        fakeNow += 500;
        tick();
        assert.equal(mod._getFollowerCurrentTimeForTest(), 10.5);
        assert.equal(mod._getFollowerPlayingForTest(), true);

        fakeNow += 2500; // total wall gap since anchor now 3s, past the 2.0s backstop
        tick();
        assert.equal(mod._getFollowerPlayingForTest(), false,
            'extrapolating past _FOLLOWER_MAX_EXTRAP_S with no new broadcast must be treated as a dropped pause message');
        assert.equal(mod._getFollowerCurrentTimeForTest(), 10.5,
            'the clock must park at the last good estimate, not keep advancing past the backstop');
    } finally {
        global.performance = originalPerf;
        global.requestAnimationFrame = originalRaf;
        global.cancelAnimationFrame = originalCaf;
    }
});

test('_startFollowerInterp is idempotent — a second call while already running does not re-arm the rAF loop', () => {
    const originalRaf = global.requestAnimationFrame;
    const originalCaf = global.cancelAnimationFrame;
    let armCount = 0;
    global.requestAnimationFrame = () => { armCount++; return armCount; };
    global.cancelAnimationFrame = () => {};
    try {
        const mod = freshPlugin();
        mod._startFollowerInterp();
        assert.equal(armCount, 1);
        mod._startFollowerInterp();
        assert.equal(armCount, 1, 'a second call while the loop is already running must not schedule a second rAF');
    } finally {
        global.requestAnimationFrame = originalRaf;
        global.cancelAnimationFrame = originalCaf;
    }
});

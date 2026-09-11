# Split Screen Plugin — AI Agent Guide

All logic lives in a single IIFE in `screen.js`. There is no build step, no bundler, no imports. The plugin is loaded as a plain `<script>` tag by feedBack core, which means every global it needs (`highway`, `createHighway`, `window.playSong`, `window.feedBack`) must already be on `window` when the script executes.

## Module structure

```
screen.js
├── Constants (LAYOUTS, OFF_CLASS, ON_CLASS, sentinel values)
├── Module-level state (active, controlsHidden, layout, panels, wrap, …)
├── Settings sync (reads settings.html checkboxes/selects on load)
├── Panel prefs persistence (savePanelPrefs, loadPanelPrefs, resolveArrIndex)
├── Helpers (getWsUrl, getDefaultArrangements)
├── createLyricsPane()           — self-contained lyrics renderer
├── Layout builders              — createWrap, applyLayoutStyle, createPanel, sizeCanvases
├── Panel lifecycle              — populateSelect, initPanel, enter*/exit* mode functions
├── Panel interactions           — togglePanelTab, toggleDetect, cycleDetectChannel, switchPanelArrangement
├── Teardown / rebuild           — teardownPanels, rebuildLayout, captureCurrentPrefs
├── Start / stop                 — startSplitScreen, stopSplitScreen, toggle
├── Time sync                    — startTimeSync, stopTimeSync
├── Toolbar buttons              — createLayoutBtn, createHideBtn, createFloatingShowBtn,
│                                  togglePanelBar, toggleControlsVisibility, updateBtn, injectBtn
└── Hooks into core              — wraps window.playSong, listens for screen:changing
```

## Constants

| Constant | Value | Purpose |
|---|---|---|
| `LAYOUTS` | object | Maps layout key → `{ panels: N, style }` |
| `OFF_CLASS` | Tailwind string | Inactive button style (used for Split btn) |
| `ON_CLASS` | Tailwind string | Active button style (used for Split btn) |
| `STORAGE_KEY` | `'splitscreenPanelPrefs'` | Per-panel prefs in localStorage |
| `LYRICS_VALUE` | `'__lyrics__'` | Sentinel for lyrics-only pane in dropdown/prefs |
| `JUMPING_TAB_VALUE` | `'__jumping_tab__'` | Sentinel for jumping tab pane |
| `VIZ_PREFIX` | `'__viz__'` | Prefix for generic viz-plugin entries. Select value: `__viz__:<pluginId>:<arrIndex>`; saved pref: `__viz__:<pluginId>:<arrName>` |
| `DETECT_CHANNEL_CYCLE` | `['mono','left','right']` | Channel cycle order |
| `DETECT_CHANNEL_LABELS` | `{mono:'M',left:'L',right:'R'}` | Channel button labels |

## Module-level state

| Variable | Type | Description |
|---|---|---|
| `active` | bool | Whether splitscreen is currently showing |
| `controlsHidden` | bool | Whether the global `#player-controls` bar is hidden |
| `layout` | string | Current layout key (`'top-bottom'`, `'left-right'`, `'quad'`) |
| `autoReactivate` | bool | Re-enter split on next song if it was active |
| `alwaysSplit` | bool | Auto-enter split on every song |
| `panels` | array | Live panel records (see Panel object shape below) |
| `wrap` | element\|null | The `#splitscreen-wrap` div, or null when inactive |
| `currentFilename` | string\|null | The filename passed to the last `playSong` call |
| `arrangements` | array | Arrangement list from the last `song_info` WebSocket message |
| `vizPlugins` | array | `{id, name, …}` entries from `/api/plugins` where `type==='visualization'`. Populated once on page load via `fetchVizPlugins()`. Factory availability (`feedBackViz_<id>`, legacy `slopsmithViz_<id>`) is checked lazily in `populateSelect()`, not at fetch time. |
| `syncInterval` | id\|null | The `setInterval` handle for the time sync loop |
| `layoutBtn` | element\|null | The layout `<select>` injected into `#player-controls` |
| `hideBtn` | element\|null | The `▾ Bar` button injected into `#player-controls` |
| `floatBtn` | element\|null | The floating `▴ Controls` restore button appended to `#player` |

## localStorage keys

| Key | What it stores |
|---|---|
| `splitscreenLayout` | Active layout key |
| `splitscreenAutoReactivate` | `'true'`/`'false'` |
| `splitscreenAlwaysSplit` | `'true'`/`'false'` |
| `splitscreenPanelPrefs` | JSON array of per-panel pref objects (see below) |
| `splitscreenControlsHidden` | `'true'`/`'false'` — whether bottom controls bar was hidden |
| `splitscreenRoomKey` | Persistent 6-char LAN room key (splitscreen#21) — survives sessions so viewer bookmarks stay valid; rotated only via settings Regenerate |
| `splitscreenLanShareActive` | `'true'` while a LAN share is live — read on load to auto-resume the share after a crash/reload |
| `splitscreenLanShareCfg` | JSON of the shared panel's follower config (detect fields stripped) — what `config` replies carry |

### Panel pref object shape (in `splitscreenPanelPrefs`)

```js
{
  arrName: string,       // arrangement name, or LYRICS_VALUE / JUMPING_TAB_VALUE:arrName / VIZ_PREFIX:pluginId:arrName
  lyrics: bool,          // per-panel lyrics overlay toggle (top-anchored translucent band; works in any renderer)
  inverted: bool,        // panel invert state
  lefty: bool,           // panel left-handed-mode state (hw.getLefty/setLefty)
  detectChannel: string, // 'mono' | 'left' | 'right'
  barHidden: bool,       // whether the panel's mini control bar is hidden
  mastery: number,       // master-difficulty fraction 0..1 (0=easy, 1=full chart)
}
```

`lyrics` previously tracked the highway's built-in `setLyricsVisible()` (defaulted to true). The semantic switched in PR #36 to drive the panel-owned lyrics overlay (a translucent band layered above whatever renderer owns the canvas). `migratePanelPrefs` force-resets it to `false` once on first read of pre-PR-36 prefs (gated by `splitscreenPrefsMigrationV` localStorage key) so existing users don't inherit overlay-on everywhere.

Old `__3d_highway__:arrName` entries from pre-Wave C builds are migrated to `__viz__:highway_3d:arrName` on read by `migratePanelPrefs()`.

## Panel object shape

Each entry in `panels[]` is built with `Object.assign({ hw, arrIndex: 0 }, parts)` where `parts` comes from `createPanel()`. Properties set across the lifecycle:

```js
{
  // From createPanel():
  panelDiv,          // outer div.splitscreen-panel
  canvas,            // <canvas> for the highway
  bar,               // the mini control bar div (position:absolute, bottom:0)
  barToggleBtn,      // blue ▾/▴ Bar button (position:absolute, bottom:0, right:0, z-index:8)
  select,            // arrangement <select>
  arrName,           // <span> showing current arrangement name
  invertBtn,         // Invert toggle button
  updateInvertStyle, // fn(bool) — updates invertBtn appearance
  leftyBtn,          // Lefty (left-handed mode) toggle button
  updateLeftyStyle,  // fn(bool) — updates leftyBtn appearance
  lyricsBtn,         // Lyrics toggle button
  updateLyricsStyle, // fn(bool)
  tabBtn,            // Tab toggle button
  updateTabStyle,    // fn(bool)
  detectBtn,         // Detect toggle button
  updateDetectStyle, // fn(bool)
  channelBtn,        // M/L/R channel button
  vizSettingsBtn,    // "3D ⚙" button — shown only in viz mode when the viz plugin
                     //   has panel controls; opens vizPopover
  vizPopover,        // div.ss-viz-popover (child of panelDiv, position:absolute,
                     //   above the bar, z-index:9) — per-panel viz controls, built
                     //   lazily by buildVizPopover()

  // From startSplitScreen() / initPanel():
  hw,                // highway instance (createHighway())
  arrIndex,          // current arrangement index (integer)
  lyricsMode,        // bool — showing lyrics pane
  lyricsPane,        // { el, connect, destroy } | null
  jumpingTabMode,    // bool — showing jumping tab pane
  jumpingTabPane,    // pane object from createJumpingTabPane | null
  jumpingTabContainer, // the container div for the JT pane | null
  vizMode,           // string|null — plugin id of active viz renderer (e.g. 'highway_3d'), or null
  tabActive,         // bool — tab view overlay shown
  tabInstance,       // createTabView instance | null
  tabContainer,      // the container div for the tab view | null
  detectChannel,     // 'mono' | 'left' | 'right'
  detector,          // createNoteDetector instance | null
}
```

## Panel lifecycle

```
startSplitScreen()
  └─ createWrap()           — creates #splitscreen-wrap, inserts before #player-controls
  └─ applyLayoutStyle()     — sets flexDirection / flexWrap on the wrap
  └─ for each panel:
       createPanel()        — builds DOM (panelDiv, canvas, bar, buttons, barToggleBtn)
       createHighway()      — fresh highway instance from core
       hw.resize override   — sizes to panel BoundingClientRect minus bar height
       initPanel()          — sets mode booleans, wires button handlers, connects WebSocket
       barToggleBtn.onclick — wired after initPanel
       togglePanelBar()     — called if prefs.barHidden (restores hidden state)
  └─ sizeCanvases()         — sets wrap.style.bottom = controlsH, then hw.resize() each panel
  └─ startTimeSync()        — 60fps setInterval slaving panels to <audio>.currentTime

stopSplitScreen()
  └─ savePanelPrefs()
  └─ teardownPanels()       — destroys all sub-resources, removes wrap
  └─ restores #highway display, clears controls z-index / marginTop
  └─ if controlsHidden: restores controls display, resets controlsHidden = false
  └─ stopTimeSync()
```

**`startTimeSync`'s backgrounding exposure is not follower-specific.** Browsers
clamp/deprioritize `setInterval` in a backgrounded tab, and `startTimeSync` uses
the same `setInterval` mechanism as `_startPopupBroadcaster` (documented below,
under "Follower clock", as throttling to ~1 Hz when backgrounded). But
`startTimeSync` has no rAF-based interpolation fallback the way the follower
side does (`_startFollowerInterp`) — so if the **main window itself** is
backgrounded or minimized (e.g. the user has focused a popped-out follower
window on a second monitor), every in-window panel synced by `startTimeSync`
degrades to the browser's background-tab interval clamp too, with nothing to
smooth it over. This is a known, undocumented-until-now gap, not a bug fix
applied here — a real fix would need the same interpolation machinery the
follower side already has.

## Panel render modes

Each panel is always in exactly one of these modes. Flags are mutually exclusive: entering one exits the others.

### Normal highway (default)
- `lyricsMode=false`, `jumpingTabMode=false`, `vizMode=null`
- `canvas` is visible, highway runs its default 2D renderer
- `hw.connect(wsUrl, { onSongInfo: () => {} })` — empty `onSongInfo` prevents clobbering the main player's HUD

### Lyrics pane (`lyricsMode=true`)
- Highway stopped (`hw.stop()`), `canvas` hidden
- `lyricsPane = createLyricsPane(panelDiv)` — self-contained div with its own WebSocket and rAF loop
- Invert / Lyrics / Tab buttons hidden while in this mode
- `lyricsPane.connect(filename, 0)` opens WS, listens only for `lyrics` messages

### Jumping Tab pane (`jumpingTabMode=true`)
- Highway stopped, `canvas` hidden
- `jumpingTabContainer` div appended to `panelDiv`
- `pane = window.createJumpingTabPane({ container })` — external plugin factory
- `pane.connect(filename, arrIndex)` — async, wrapped in try/catch
- Invert / Lyrics / Tab buttons hidden

### Viz renderer (`vizMode = pluginId string`)
- Highway NOT stopped — it stays alive with its WebSocket and rAF loop
- `panel.hw.setRenderer(vizFactory(pluginId)())` installs the renderer. The factory global
  was renamed `slopsmithViz_<id>` -> `feedBackViz_<id>` in the feedBack rename, so
  `vizFactory(id)` walks `VIZ_FACTORY_PREFIXES = ['feedBackViz_', 'slopsmithViz_']` in that
  order and returns the first hit — current and legacy viz plugins both resolve.
  `hasVizFactory(id)` is the boolean form used for capability checks.
- `canvas` stays visible (renderer draws to it)
- Tab button hidden. A **"3D ⚙"** button (`vizSettingsBtn`) is shown if the viz plugin has per-panel controls (see "Per-panel viz controls" below); it opens `vizPopover` with those controls scoped to this panel. Other viz config still lives in the plugin's global settings UI.
- To exit: `recreatePanelHighway(panel)` discards the viz highway and installs a fresh 2D highway; `_hideVizControls(panel)` hides the button/popover
- **Canvas context-type lock:** the first `getContext('2d')` or `getContext('webgl')` call on a canvas locks it for its lifetime. Swapping renderers mid-session on the same canvas (e.g. 2D → WebGL → 2D) may not work without re-creating the canvas. The restore-on-load path is safe because `initPanel()` calls `panel.hw.setRenderer(factory())` **before** `hw.init(canvas)` when a viz pref is detected — so the canvas is initialised with the correct context type from the start. For mid-session 2D ↔ viz swaps (and viz-to-viz arrangement switches), `recreatePanelHighway(panel)` is called first to discard the previous highway instance before the new renderer takes over.

### Tab overlay (`tabActive=true`)
- Can coexist with normal highway mode (not with lyrics/JT/3D modes)
- `tabContainer` appended over the canvas (`z-index:2`)
- `createTabView({ container, getBeats, getCurrentTime })` — external plugin
- Canvas hidden while tab is active

## Per-panel viz controls (the "3D ⚙" popover)

When a panel is in viz mode, splitscreen shows a `vizSettingsBtn` ("3D ⚙") that opens `vizPopover` — a small popover with controls that override that viz plugin's settings **for this panel only**. The controls are generated from a descriptor, so adding a new per-panel option doesn't require touching the popover code.

- **Descriptor lookup** — `getPanelControlsFor(pluginId)` returns `null` for any plugin other than `highway_3d` (v1 — `_vizPanelGet`/`_vizPanelSet` are hard-wired to highway_3d's storage scheme + `window.h3dBgSet*` setters); for `highway_3d` it returns `vizFactory('highway_3d').panelControls` if exposed, else the built-in `VIZ_PANEL_CONTROLS.highway_3d` (`palette`, `cameraSmoothing`, `cameraLockLow`, `cameraLockZoom`). The viz-plugin-published list wins, so the plugin can keep the *list of controls* current without splitscreen edits — generalizing to other plugins later means extending the descriptor with per-plugin storage/setter info (or read/write fns) and dropping the gate. Each descriptor entry: `{ key, label, type:'toggle'|'range'|'select', default, min?, max?, step?, options? }` where `options` for `select` is `[{id,label}]`; for `range`, `min`/`max` default to `0`/`1` and `step` to `0.05` when omitted (`_ctlRange`). A plugin-published **empty array** is a valid override — it opts out of per-panel controls (`_showVizControls` hides the button on an empty list).
- **Storage** — per-panel values are written to the viz plugin's own per-panel keys, **not** `splitscreenPanelPrefs`. For `highway_3d`: `localStorage['h3d_bg_panel<N>_<key>']` (read by the plugin's `_bgReadSetting`, falling back to the global `h3d_bg_<key>`). `_vizPanelGet` / `_vizPanelSet` implement this; `_vizPanelSet` also re-fires `window.h3dBgSet<Key>(<currentGlobal>)` so the plugin's change event runs (instant rebuild for settings like `palette`; the 3D renderer also re-reads everything per frame, so even without the re-fire the panel key takes effect next frame). On reload, `enterVizMode` → `_showVizControls` → `buildVizPopover` re-reads the keys, so the popover reflects the saved per-panel state. The keys are never cleared on exit — `_hideVizControls` only hides the popover/button — so they persist indefinitely, **namespaced by panel slot** (`panel<N>`) rather than by session or song. They're inert only for a panel that never runs 3D again: if panel N later re-enables 3D viz (next session, next song, months later), it silently inherits whatever overrides were left in that slot. That per-slot persistence mirrors the original `h3d_bg_*` palette behavior and the rest of the panel prefs; to start a slot fresh, delete its `h3d_bg_panel<N>_*` keys from localStorage by hand.
- **Lifecycle** — `_showVizControls(panel, pluginId)` (builds the popover + shows the button) is called at the end of `enterVizMode` and the in-place viz-switch branch of `panel.select.onchange`. `_hideVizControls(panel)` (hides + empties) is called from `exitVizMode`, `enterLyricsMode`, `enterJumpingTabMode`. `togglePanelBar` closes the popover when hiding the bar (it's anchored to the bar height). A document-level capture `pointerdown` listener (`_closeAllVizPopovers`) closes any open popover on a click outside `.ss-viz-popover` / `[data-ss-viz-btn]`. The `vizSettingsBtn` click handler **rebuilds the popover from current localStorage every time it opens** — `_closeAllVizPopovers` / the outside-click handler only hide (don't empty), so the rebuild-on-open is the single point that guarantees the controls reflect any `h3d_bg_*` changes (e.g. via the plugin's own settings UI) made while the popover was closed.
- **Note for new viz plugins** that want per-panel controls: expose `window.feedBackViz_<id>.panelControls = [...]` and use the `*_panel<N>_*` localStorage convention the plugin already reads (or, if it uses a different scheme, the descriptor would need to carry `read`/`write` fns — not implemented in v1; only `highway_3d` is wired).

## `sizeCanvases()` — call it whenever layout space changes

```js
function sizeCanvases() {
  wrap.style.bottom = controls.offsetHeight + 'px'; // respects hidden controls
  for (const p of panels) {
    if (p.jumpingTabMode && p.jumpingTabPane) p.jumpingTabPane.resize();
    else if (!p.lyricsMode) p.hw.resize();
  }
}
```

**Must be called after:**
- Splitscreen activates (inside `startSplitScreen`)
- The global controls bar is hidden/shown (`toggleControlsVisibility`)
- Window resize (`window.addEventListener('resize', ...)`)
- Layout change (`rebuildLayout`)

`hw.resize` for each panel is overridden to size the canvas to `panelDiv.getBoundingClientRect()` minus the bar height. When the bar is hidden (`bar.style.display === 'none'`), `barH = 0` and the canvas fills the full panel.

## Controls bar hide/show system

Two independent levels:

**Global controls bar** (`#player-controls`)
- `▾ Bar` button (`hideBtn`) injected into `#player-controls` right of the layout picker, inside a wrapper div that carries `ml-auto` (Close button is moved into the same wrapper so it stays rightmost)
- `toggleControlsVisibility()`: toggles `controlsHidden`, sets `controls.style.display`, saves to `splitscreenControlsHidden` in localStorage, calls `sizeCanvases()`, calls `updateBtn()`
- When hidden: floating `▴ Controls` pill (`floatBtn`) appears at `position:absolute; bottom:8px; right:8px; z-index:20` in `#player`
- `stopSplitScreen()` always restores controls and resets `controlsHidden = false`
- On next `startSplitScreen()`, reads `splitscreenControlsHidden` from localStorage and calls `toggleControlsVisibility()` if true

**Per-panel mini bar** (`panel.bar`)
- `barToggleBtn`: `position:absolute; bottom:0; right:0; z-index:8` — always on top of the bar
- `togglePanelBar(panel)`: toggles `bar.style.display`, updates button text/style, calls `hw.resize()` or `jumpingTabPane.resize()`, calls `savePanelPrefs()`
- State persisted in `barHidden` field of `splitscreenPanelPrefs`
- Restored in `startSplitScreen()` by calling `togglePanelBar(panel)` if `panelPrefs.barHidden`

## Pop-out / follower windows

A panel can be detached into its own browser window (`⇱ Pop`) for multi-monitor use. `popOutPanel()` opens `/?ssFollower=1&popupId=…&filename=…&arrangement=…&mode=…&…` (panel state serialized into query params) with `window.open(url, popupId, 'popup,width=1280,height=420')`, removes the panel from the main layout, and rebuilds the remaining panels (or stops split if ≤1 remain). The popup loads the full app; the splitscreen IIFE parses the `ssFollower` flag once into `FOLLOWER` and, instead of the auto-Split UI, runs `bootFollowerMode()` → `loadSongInFollower()` → `buildFollowerLayout()`. The popup can split *itself* 1/2/2/4 via its own bottom toolbar (`rebuildFollowerLayout` / `FOLLOWER_LAYOUT_PANELS`). `dockFollowerPanel()` (the `⇲ Dock` button) posts `{type:'docked', popupId, finalState}` and `window.close()`s; the main window's `_redockPanel()` re-instates the panel.

**State channels:** URL params (one-way, at open time) → popup's `FOLLOWER` config. Everything live goes over `BroadcastChannel('slopsmith-ss')` (`_ssChannel()`, lazily opened in both windows, never closed — auto-closes on window unload). No `window.opener` use.

| Message | Direction | Meaning |
|---|---|---|
| `{type:'time', t, playing}` | main → popups | Audio playhead (broadcast only when `t` changes — skipped while paused) plus the current play/pause flag. Sent at ≤60 Hz by `_startPopupBroadcaster`. |
| `{type:'playstate', playing}` | main → popups | Explicit play/pause transition (from `<audio>` `play`/`pause` events). Needed because `time` messages stop entirely while paused. Best-effort in JUCE mode. |
| `{type:'song-changed', filename}` | main → popups | Main loaded a new song; popups rebuild via `_handleFollowerSongChange`. |
| `{type:'main-closed'}` | main → popups | Main window is unloading (`beforeunload`). Popups call `_onFollowerOrphaned()`: stop syncing, `teardownPanels()`, show a "main window closed" overlay. Best-effort. |
| `{type:'docked', popupId, finalState}` | popup → main | User clicked Dock (or closed the window after clicking it). Main re-docks the panel. |
| `{type:'closed', popupId}` | popup → main | Popup unloading without a Dock click (`beforeunload`). Main drops the `popups` entry; the panel is *not* re-added. |

**Follower clock.** The popup's `<audio>` is muted **and paused** (`_silenceFollowerAudio` — a muted-but-playing element still decodes for nothing; a `'play'` listener re-pauses it after any autoplay/src-swap). `audio.currentTime` is shimmed to `_followerCurrentTime`, and `audio.paused` is shimmed to `!_followerPlaying` (not a hardcoded `false`) so the lyrics/jumping-tab panes (which read `audio.currentTime` and gate animation on `!audio.paused`) — and any other code that reads `.paused` as a play/pause indicator — correctly track the main window's actual play state instead of running unconditionally. Between `time` broadcasts, `_startFollowerInterp()`'s rAF loop extrapolates `_followerCurrentTime` forward (`anchorT + observedRate·Δperf`) while `_followerPlaying` — so scrolling stays smooth even when the main tab is backgrounded and its broadcaster throttles to ~1 Hz. `observedRate` is derived from message Δt/Δwall (tracks the speed slider); out-of-band deltas (seek, loop wrap, long gap) reset it to 1 and the popup snaps to the broadcast value. Extrapolation is capped at `_FOLLOWER_MAX_EXTRAP_S` (2 s) past the last message as a backstop for a dropped `playstate:false`.

**Single-flight.** `_handleFollowerSongChange` is single-flight (`_followerRebuildBusy`): a song change arriving mid-rebuild is coalesced into `_followerPendingFilename` and the latest one runs after the current rebuild finishes — so rapid song skips in the main window don't spawn overlapping `playSong`/`buildFollowerLayout` runs in the popup. `rebuildFollowerLayout` (the layout `<select>`) bails and re-syncs the picker if a song-change rebuild is in flight. On the main side, `_redockPanel` defers (`_pendingRedocks`, drained in `startSplitScreen`'s `finally`, same pattern as `_pendingRebuild`) when a start is in flight, so a `docked` message landing during the post-pop-out rebuild doesn't tear down the half-built layout.

**Crash/force-close handling.** A popup that dies without firing `beforeunload` is reaped by `_startPopupBroadcaster`'s tick (`popup.closed` check); when the last popup is gone the broadcaster stops itself.

**Pop-out failure UX.** `popOutPanel` uses a non-blocking top-centre toast (`_showMainToast`) — never `alert()` — for "BroadcastChannel unsupported" / "popup blocked", and bails before mutating the layout, so the panel stays put.

**Caveats.** localStorage is shared between the windows; per-panel viz keys (e.g. `h3d_bg_panel<N>_*`) written by both are last-write-wins (acceptable). Because those keys are never cleared, a value written by a *different window's* panel N can silently resurface here when panel N next runs 3D viz. The `ss-follower` chrome-hiding CSS keys on hardcoded element ids — brittle if core renames them (deliberate tradeoff vs. chasing every id). A currently-popped-out panel is removed from `panels[]`, so it can't be popped again *while it's out* — but docking it back (`dockFollowerPanel` → `_redockPanel` → `startSplitScreen`) rebuilds it as a fresh, ordinary panel object in the layout, and nothing marks it as "already popped once": pop → dock → pop again works, repeatedly, for the same slot. Multiple *different* panels can be popped at once (tracked in the `popups` Map by `popupId`).

## LAN share / remote followers (splitscreen#21)

A second follower transport: the server's `/ws/sync/{session_id}` relay (feedBack#1030, core ≥ the #1032 merge) carries the SAME message protocol as the BroadcastChannel to browsers on **other machines**. `_followerBusHandler(msg)` is the shared dispatch for both transports; popups wire it to `ch.onmessage` in `buildFollowerLayout`, remote viewers wire it to the relay socket.

**Main side.** `📡 LAN` (per-panel, next to `⇱ Pop`; `panel.lanBtn`, main-window only) starts a share: `startLanShare(panel)` captures the panel's follower config **with detect fields stripped** into `_lanShare.cfg`, connects `_lanConnect()` to `/ws/sync/<room key>`, and opens the share dialog (`_showLanShareModal` — key big, join URLs from the desktop preload's `network.getLanAccess().urls` when available else `location.origin`, Copy, Stop). `_lanSend(msg)` mirrors every broadcast-channel post over the relay — `time` frames throttled to ~20 Hz (`LAN_TIME_MIN_INTERVAL_MS`); the local BC leg stays ≤60 Hz. The broadcaster now runs when `popups.size > 0 || _lanShare`. Relay-specific messages: viewers send `{type:'hello', popupId}`; the host answers each with `{type:'config', popupId, filename, cfg, t, playing}` (only once `currentFilename` exists — viewers hello-poll until then); `{type:'share-ended'}` is sent by `stopLanShare()` and is the ONLY terminal signal for viewers. Sharing is persistent: `_maybeResumeLanShare()` re-arms an active share at plugin load (crash/reload recovery), and the playSong wrapper re-arms the broadcaster.

**Viewer side.** `?ss=<key>` (and no `ssFollower`) parses into `REMOTE_JOIN` (via `normalizeRoomKey` — 6 chars, `ROOM_KEY_ALPHABET`, case-insensitive). `bootRemoteJoin()` shows the waiting overlay and connects; on the first `config` it builds `FOLLOWER = makeRemoteFollowerCfg(msg, popupId)` (**`FOLLOWER` is `let` now**; `remote: true`; detect stripped) and runs the normal `bootFollowerMode()` — chart data still streams per-panel over `/ws/highway` directly, only clock/session messages ride the relay. Reconnect: infinite backoff (1s→10s cap), re-`hello` on every open; `main-closed` puts a REMOTE viewer into the recoverable waiting overlay (host reload/relaunch auto-resumes), NOT the orphan overlay — only `share-ended` orphans it. Remote viewers hide the Dock button, never post `docked`/`closed`, and never bind input devices.

**Room key.** `ensureRoomKey()` — persistent per-install (`splitscreenRoomKey`), settings section displays it with Regenerate (rotating stops any live share). Alphabet `ABCDEFGHJKMNPQRSTVWXYZ23456789` (no 0/O/1/I/L/U) makes keys read-aloud-safe; `buildShareUrl(origin, key)` → `<origin>/?ss=<KEY>`.

**Test-env note.** The end-of-IIFE boot gates remote-join/share-resume behind `_nodeTestEnv` (modern node has a global `WebSocket`, so a capability check alone would open real sockets under `node tests/screen.test.js`).

## `playSong` wrapper and the `_onReady` race

The plugin wraps `window.playSong` to:
1. Stop any active splitscreen before the new song loads
2. Set `currentFilename` after the new song begins loading
3. Hook `highway._onReady` to grab `arrangements` and optionally auto-restart split

**The race:** async plugins (e.g. 3dhighway) can `await` inside the wrapper chain, allowing `ready` WebSocket messages to fire and clear `_onReady` before our hook runs. The poll fallback (checks every 200ms for up to 6 seconds) handles this case. Both paths set `handled = true` to ensure split is started at most once.

`injectBtn()` is called at the end of every `playSong` so the Split button is always present after the first song.

## DOM structure and z-index stack

```
#player  (position:fixed, inset:0, z-index:100)
  #highway              — default highway canvas, hidden (display:none) when splitscreen active
  #splitscreen-wrap     — position:absolute, top:0, left:0, right:0, bottom:{controlsH}px, z-index:3
    .splitscreen-panel  — each panel, position:relative, overflow:hidden
      <canvas>          — the highway canvas
      .bar              — position:absolute, bottom:0, z-index:7
      .ss-viz-popover   — position:absolute, right:4px, bottom:{barH+4}px, z-index:9 (viz mode; display:none unless opened)
      .barToggleBtn     — position:absolute, bottom:0, right:0, z-index:8
      [lyricsPane div]  — position:absolute, inset:0, bottom:{barH}px (lyrics mode)
      [jtContainer div] — position:absolute, inset:0, bottom:{barH}px (jumping tab mode)
      [tabContainer]    — position:absolute, inset:0, bottom:{barH}px, z-index:2 (tab overlay)
  #player-controls      — position:relative, z-index:10, margin-top:auto (while splitscreen active)
  [floatBtn]            — position:absolute, bottom:8px, right:8px, z-index:20 (when bar hidden)
```

### Hiding `#highway` and the `highway:visibility` contract

`startSplitScreen()` hides `#highway` with `display:none`; `stopSplitScreen()` (and the start-failure rollback) restores it. That single hide is all splitscreen does — core does the rest (slopsmith#246):

- Core's rAF reads `canvas.offsetParent === null` per tick. While the canvas is hidden it skips the highway's `renderer.draw()` (and the default 2D draw), so the hidden main highway isn't burning frames behind the panels.
- Core emits `highway:visibility` (`{ visible, canvas }` on `event.detail`) on transitions. Viz renderers that mount **sibling DOM** — e.g. 3D Highway's `.h3d-wrap` overlay, a sibling of `#highway` that `display:none` on the canvas doesn't cover — subscribe to that event (filtered by canvas identity, so splitscreen's per-panel instances don't toggle each other) and hide/show their own overlays. Splitscreen used to hand-hunt `:scope > .h3d-wrap` siblings of `#highway` and toggle them itself; that's gone — the viz owns its overlay's visibility now.
- Per-panel viz overlays don't need special handling: exiting viz mode on a panel (`exitVizMode` → `recreatePanelHighway`) discards the panel highway, which calls the renderer's `destroy()` and removes its overlay. A panel canvas hidden for lyrics/jumping-tab mode has no live viz renderer to leave anything painting.

Wants a core with the `highway:visibility` API (~slopsmith 0.2.7.1+) for the rAF skip and the overlay auto-hide — not a hard dependency. On an older core the plugin still runs; `display:none` on `#highway` just doesn't pause the hidden highway's draw loop, and a sibling-mounting viz overlay (3D Highway) may bleed through the panels. Update both together to fix that.

## External plugin integration points

The plugin capability-checks all external factories at runtime and gracefully disables the relevant button if the factory isn't loaded.

| Factory | Checked via | Used in |
|---|---|---|
| `window.createJumpingTabPane` | `typeof === 'function'` | `populateSelect()`, `enterJumpingTabMode()` |
| `window['feedBackViz_' + id]` (legacy `slopsmithViz_` fallback) | resolved via `fetchVizPlugins()` | `populateSelect()`, `enterVizMode()` — auto-discovered for any `type=visualization` plugin |
| `window.createTabView` | `typeof === 'function'` | `initPanel()` (wires tabBtn) |
| `window.createNoteDetector` | `typeof === 'function'` | `initPanel()` (wires detectBtn/channelBtn) |

The `{ onSongInfo: () => {} }` passed to `hw.connect()` suppresses the default behavior where receiving `song_info` would overwrite the main player's HUD, audio element, and arrangement dropdown. This is required for every panel WebSocket connection. See slopsmith issue #27.

## Adding a new panel mode

Follow the lyrics/jumping-tab pattern:
1. Add a sentinel constant (e.g. `const MY_MODE_VALUE = '__my_mode__'`)
2. Add a factory check in `populateSelect()` and push options with the sentinel as value prefix
3. Write `enterMyMode(panel)` and `exitMyMode(panel, arrIndex)` — mirror the existing enter/exit pairs: hide/show appropriate buttons, manage your DOM nodes and lifecycle, call `savePanelPrefs()` at the end
4. Add the sentinel prefix to `resolveArrIndex()` so it returns -1 (not treated as an arrangement name)
5. Handle the value prefix in `panel.select.onchange` inside `initPanel()`
6. Add mode flag and resource fields to the `panel` object inside `initPanel()` (init them to `false`/`null`)
7. Tear down in `teardownPanels()` — destroy resources and null refs
8. Add the `arrName` encoding in `savePanelPrefs()` and `captureCurrentPrefs()`
9. Add pref restoration in `startSplitScreen()` (the block that builds `arrDefaults`)
10. Update `sizeCanvases()` if your mode needs its own resize path (like jumping tab does)

## Common pitfalls

- **`hw.resize` override must be set before `hw.init()`** — the override happens in `startSplitScreen()` before `initPanel()`. If you call `initPanel` first, the highway will size itself to the full window on init and clobber siblings.
- **Never use `margin-left:auto` on bar buttons** — the bar is `flex-wrap:nowrap;overflow:hidden`. Auto margins cause button positions to shift when the bar is toggled. All buttons are left-to-right; the `barToggleBtn` is absolutely positioned outside the flex flow.
- **`sizeCanvases()` uses `controls.offsetHeight`** — when the controls bar is hidden (`display:none`), `offsetHeight` returns 0 and `wrap.style.bottom` becomes `'0px'`, filling the full viewport. This is correct and intentional.
- **The `onSongInfo: () => {}` empty callback is mandatory** — omitting it causes every panel's WebSocket `song_info` message to overwrite the main player's audio `src`, arrangement dropdown, and HUD.
- **Plugin load order** — screen.js loads alphabetically. Plugins that wrap `playSong` before splitscreen (alphabetically earlier names) run closer to the original; later-loading plugins run first. This affects the `_onReady` hookup timing.
- **`currentFilename` is always the percent-encoded form** — never raw. The grid renders `data-play="<encodeURIComponent(localFilename)>"`, v3's `songs.js` calls `playSong(encodeURIComponent(localFilename))`, and `player.start()` normalizes any raw name to encoded before calling `playSong` — so `decodeURIComponent(currentFilename)` never sees an unencoded name or a stray literal `%` (a real filename containing `%` arrives already percent-encoded, same as any other reserved character). `getWsUrl()` decodes internally for highway connections with this invariant documented inline (mirrors core `highway.js`'s own unconditional decode); other call sites (e.g. `togglePanelTab`'s tabview fetch) decode inside a `try`/`catch` that already wraps the whole request, so a violation of the invariant fails safely instead of throwing uncaught.
- **`rebuildLayout()` uses `captureCurrentPrefs()`** — this captures the live state of running panels. `savePanelPrefs()` also writes the same data to localStorage. They share the same object shape; `captureCurrentPrefs` just returns the array in memory instead of persisting it.

## Git and PR conventions

- **`got-feedBack/feedBack-plugin-splitscreen` is the canonical plugin repo.** This
  checkout (`get-flashbacks/feedBack-plugin-splitscreen`) is a fork of it. Keep changes
  portable: anything a user or the upstream project would read — the README's install
  instructions, links to feedBack or sibling plugins — points at `got-feedBack`, not at
  this fork. Redirecting those to the fork is what stops the plugin being useful to the
  repo it came from.
- Day-to-day work goes on feature branches off `main` in this fork, and PRs target this
  fork: `gh pr create --repo get-flashbacks/feedBack-plugin-splitscreen --base main --head <branch>`
  from inside the plugin directory.
- A fix that isn't fork-specific is worth opening upstream against
  `got-feedBack/feedBack-plugin-splitscreen` too — same idea as core's
  "upstream PRs retire debt" rule.
- Always branch from `origin/main`; there is no `upstream` remote configured here, so add
  one explicitly if you're preparing an upstream PR.

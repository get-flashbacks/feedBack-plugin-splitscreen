# Split Screen Plugin Constitution

The Split Screen plugin (id: `splitscreen`) renders 2–4 independent
highway panels side-by-side in the player, each showing a different
arrangement of the same song, all slaved to the shared `<audio>`
element. It supports popping a panel into a separate browser window
for multi-monitor practice setups.

## Core Principles

### I. One Sound Source, N Visualizers
There is exactly one playing `<audio>` at any time — the main
window's. Every panel and every popup follows this single time
source. Popups are muted; popped panels do not re-create audio
elements (`README.md:50-53`, `CLAUDE.md:228-256`).

### II. Per-Panel Independence
Each panel owns: its own `<canvas>`, its own highway WebSocket
(`/ws/highway/{filename}?arrangement={index}`), its own arrangement
selector, its own invert / lyrics / tab / detect / channel state.
No mutable state is shared between panels except the read-only audio
time tick.

### III. `onSongInfo: () => {}` is Mandatory
Every panel passes an empty `onSongInfo` callback to `hw.connect(...)`
to suppress the default behavior of overwriting the main player's
HUD, audio src, and arrangement dropdown when the panel's WebSocket
reports `song_info` (`CLAUDE.md:255-256`, slopsmith#27). Omitting
this is a guaranteed regression.

### IV. Idempotent, Capability-Checked External Plugins
The plugin checks for `window.createJumpingTabPane`,
`window.slopsmithViz_highway_3d`, `window.createTabView`,
`window.createNoteDetector` at runtime. Missing factories disable
the corresponding buttons; they are NEVER assumed present.

### V. Persisted Panel Prefs
Per-panel `arrName`, `lyrics`, `inverted`, `detectChannel`,
`barHidden` are saved to `localStorage` under `splitscreenPanelPrefs`.
Layout, auto-reactivate, always-split, and global controls visibility
have their own keys (see CLAUDE.md "localStorage keys"). Any new
per-panel state MUST be added to BOTH `savePanelPrefs()` and
`captureCurrentPrefs()` and restored in `startSplitScreen()`.

### VI. `sizeCanvases()` is the Single Resize Point
Any layout space change — splitscreen activate, controls bar
toggle, window resize, layout change — funnels through
`sizeCanvases()`. It positions the wrap, then `hw.resize()` /
`jumpingTabPane.resize()` per panel. Bypassing it produces drift.

### VII. Pop-Out via BroadcastChannel
A popped panel is the same Slopsmith app booted with `?ssFollower=1`
and panel config in the URL. Time is broadcast over
`BroadcastChannel('slopsmith-ss')`. The popup is muted; close ↔ dock
returns the panel to its origin slot in the main window.

### VIII. Mode Mutual Exclusion (Per Panel)
A panel is in exactly one of: normal highway, lyrics pane, jumping
tab pane, 3D highway. Tab overlay is the one allowed coexister with
normal highway only. Entering one mode MUST exit the others.

### IX. Idempotent Side-Effects
Every wrap of `playSong` and every event listener registration
(including the `screen:changing` listener) MUST be guarded against
re-evaluation. The Split button re-injection runs at the end of every
`playSong`, but injection itself is idempotent.

## Inheritance from Slopsmith Core

Uses `createHighway()`, `panel.hw.setRenderer(factory())` (slopsmith#36),
the global `<audio>` element, `window.playSong`, `window.feedBack`
(for the `screen:changing` event), `#highway`, `#player-controls`,
`#player`. The `_onReady` hookup race
(see CLAUDE.md "playSong wrapper") is mitigated with a 6-second
poll fallback at 200ms intervals.

## Governance

The fork lives at `topkoa/slopsmith-plugin-splitscreen`. Feature
branches base off `origin/main`, NEVER `upstream/main`. PRs target
`topkoa/...`. Constitution changes that touch the public
plugin-integration surface (Path 1 / Path 2 from README) must update
the README in the same PR.

**Version**: 1.4.0 | **Ratified**: 2026-05-09 | **Last Amended**: 2026-05-09

# Folder Drawer

An Obsidian plugin that folds the File Explorer's folders away behind a single
**FOLDERS** header, so the sidebar rests as the loose notes at the vault root —
the things still being worked out — with the library one click away.

Tap the header to bring the folders back. Nothing is hidden from Obsidian
itself: the folders stay in the tree, still searchable, still reachable from the
Quick Switcher, still the target of every link in the vault.

Works on desktop and on mobile.

## Install

The plugin is not in the community catalogue. Use
[BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install **BRAT** from Community Plugins and enable it.
2. Run **BRAT: Add a beta plugin for testing** from the command palette.
3. Paste `j1mmy2hang/obsidian-folder-drawer` and choose the latest version.
4. Enable **Folder Drawer** in Settings → Community Plugins.

BRAT will keep it up to date from this repo's releases.

To install by hand instead, copy `main.js`, `manifest.json` and `styles.css`
from the latest release into `<vault>/.obsidian/plugins/folder-drawer/`.

## Use

- **Tap or click the header** to open and close the drawer.
- **Toggle folder drawer** is in the command palette, so it can take a hotkey
  or sit on the mobile toolbar.

The open/closed state is remembered between sessions.

## How it works

Two decisions carry the whole plugin, and both come from the same fact:
**Obsidian's File Explorer is virtualised.** It builds only the rows near the
scroll window, and it chooses them from its own sorted model rather than from
whatever the stylesheet ends up drawing.

**The order is changed at the source, not in CSS.** `getSortedFolderItems` is
wrapped so files come back before folders. Reordering with CSS `order` works
only while the whole tree fits on screen — expand one real folder and the model
puts the notes far below the viewport, so it never builds them and they vanish
from the top of a sidebar that is supposedly showing them. Wrapping the sorter
keeps model, DOM, scroll height and rendering window agreeing with each other.
It wraps rather than replaces, so whichever sort order you have set still
decides the order *within* each group.

**The header is not a row.** On every render pass the virtualiser decides
exactly which elements the list may contain, and deletes anything it did not put
there. A header parked between the last note and the first folder is torn down
and rebuilt dozens of times a second while scrolling, and since the list's
cached heights are measured as the distance from one row's top to the next, a
foreign element between two rows lands in nobody's total. So the header rides
*inside* the first folder's row: that row opens a band above itself with
`padding-top`, and the header is positioned absolutely into the band, adding no
height of its own.

Both files are commented at length, in case any of this is useful elsewhere.

## On mobile

The File Explorer, its virtualiser and its sorter are the same code on iOS and
Android, so both mechanisms above hold as they are. What changes is the
hardware:

- **Touch targets.** The header's box is built from the same arithmetic
  Obsidian uses for a row — one line of text plus `--nav-item-padding` — so it
  is exactly as tall as the notes and folders around it, and grows with them
  when mobile scales `--nav-item-size` up. It already spans the full width of
  the sidebar, so the hit area is generous without being a special case.
- **Hover.** Hover styling is fenced behind `@media (hover: hover)`, because a
  tap on an element with a `:hover` rule latches it — the header would stay lit
  after every toggle. An `:active` state answers the press instead.
- **Long-press.** iOS raises a context menu and a selection callout from a held
  finger. Both are swallowed on the header, which is chrome, not content.
- **WebKit.** The drawer's height animation rests on
  `interpolate-size: allow-keywords`, which is what lets height animate to
  `auto` without hard-coding pixel heights. Obsidian on iOS renders through the
  system WebView, which may not have it. An `@supports not (...)` block takes
  the height transition back off the table there rather than leave it
  half-running, and the crossfade carries the toggle on its own — so the drawer
  opens in one beat instead of a stalled one. Everything else is unaffected.

## Elastic scrolling

On the desktop the File Explorer's list used to stop dead at both ends.
Chromium doesn't rubber-band inner scrollers — only the page itself — so a
sidebar hits its limit with a thud while every native list on the machine gives
a little.

The plugin adds the effect back. Push against either end and the list stretches
past its edge and settles back: 90ms out, 750ms home, with the give
proportional to how hard you pushed.

The behaviour and its tuning come from
[atomiks/elastic-scroll-polyfill](https://github.com/atomiks/elastic-scroll-polyfill)
(MIT), with three changes made for this host:

- **No wrapper.** The polyfill wraps the scroller's contents in a new element
  and moves that. Here the transform goes on the children already present,
  because an extra div between `.nav-files-container` and its child would land
  in the middle of this plugin's own selectors — the drawer collapses folders
  through `.nav-files-container > div > .tree-item.nav-folder`, and a wrapper
  pushes every one of those a level out of reach.
- **A pixel of tolerance on the edge test.** The polyfill checks the bottom as
  `scrollTop + offsetHeight >= scrollHeight`, exactly. That's right until the
  content lands on a fraction: browsers round `scrollHeight` up to a whole
  number while `scrollTop` clamps to the real maximum, so the two never meet.
  Measured here — `scrollHeight` 756, `clientHeight` 495, `scrollTop` pinned at
  260.5 — the bottom edge never registered at all.
- **The gate is the gesture, not the arrival.** The polyfill only bounces when
  `scrollTop` has moved since the last event, so it fires when you *arrive* at
  an edge and then never again — once you're resting there `scrollTop` stops
  changing and every further push is swallowed. Pushing against an edge that's
  already against you is exactly when a rubber band should give, so this re-arms
  after the wheel goes quiet: one bounce per push, and the next push gets
  another.

It runs only where it's needed. iOS and Android bounce inner scrollers
natively; **Chromium ships the same thing in 145**, so on a new enough build
this switches itself off and lets the browser do it properly (Obsidian is on
142 today); and elastic scrolling is an Apple idiom, so it stays off on Windows
and Linux, where it would read as a bug rather than a flourish.

It also won't engage on a list that isn't scrolling. The plugin adds a little
breathing room at both ends — 16px above, 40px below, the latter clearing a
bottom fade that would otherwise dissolve the last note just as you reach it —
and since padding counts towards `scrollHeight`, a list that fits its pane can
still report a few pixels of scroll that exist only because of it. That's
subtracted back out before deciding whether there's anything to bounce against.

The transform sits on elements the virtualiser doesn't rebuild, and moves them
all by the same amount — cached row heights are measured as the distance from
one row's top to the next, so translating everything together leaves every one
of those distances exactly as it was.

## Notes

- The plugin also sorts files above folders. That used to be a separate CSS
  snippet here; it is folded in, so enabling the plugin is the whole change and
  disabling it undoes the whole change.
- While it is off, the File Explorer looks exactly as Obsidian draws it. Every
  rule is gated on a `folder-drawer-active` class the plugin adds to `body`.

## Licence

MIT

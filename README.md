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

## Closing the drawer

Shutting the drawer from halfway down the folders used to teleport rather than
scroll. The tree is virtualised and the virtualiser owns the scroll height
through its pusher margins, so collapsing rows in CSS doesn't shrink
`scrollHeight` by a pixel — nothing *could* scroll, because as far as the
scroller was concerned nothing had got shorter. The height only dropped when
`invalidateAll()` recomputed at the end, and by then all that was left was to
clamp.

Measured from `scrollTop` 1744: a 385px jolt as the rows began to fold, then
nothing at all for ~300ms, then a 1359px slam to the top.

So the scroll is animated deliberately — out-cubic over 220ms, matching
`--folder-drawer-shut`, so the glide home and the fold read as one movement. It
targets the top because a shut drawer *is* the loose root notes, which is the
plugin's whole premise. `overflow-anchor` is switched off for the length of the
toggle as well: the jolt was Chromium's scroll anchoring compensating for rows
folding above the viewport, a correction nobody asked for on the one movement
the plugin animates itself.

## Notes

- The plugin also sorts files above folders. That used to be a separate CSS
  snippet here; it is folded in, so enabling the plugin is the whole change and
  disabling it undoes the whole change.
- While it is off, the File Explorer looks exactly as Obsidian draws it. Every
  rule is gated on a `folder-drawer-active` class the plugin adds to `body`.

## Licence

MIT

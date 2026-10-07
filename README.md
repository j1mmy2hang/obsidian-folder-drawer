# Folder Drawer

An Obsidian plugin that turns the File Explorer into two short lists:

- **the notes at the vault root**, the things still being worked out;
- a small **PROJECTS** heading, then every note marked `project/in-progress`,
  wherever it lives in the vault.

Folders leave the explorer. Nothing is hidden from Obsidian itself: every
folder and note is still searchable, reachable from the Quick Switcher, and the
target of every link in the vault. A root note that is also an active project
appears once, under Projects.

Works on desktop and on mobile.

> **2.0 changes what the plugin does.** Up to 1.5 it folded the folders behind a
> FOLDERS header. That header is gone; the same mechanism now carries the
> PROJECTS heading.

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

Put `project/in-progress` in a note's `descriptive` frontmatter list and it
moves under **Projects**; take it out and it goes back. Nested values count, so
`project/in-progress/film` does too. Empty the **Project property** setting to
use real tags (`#project/in-progress`, frontmatter or body) instead.

Settings → Folder Drawer:

- **Project tag**: which value lists a note under the heading.
- **Project property**: the frontmatter list to read it from (default
  `descriptive`). Empty means the note's tags.
- **Heading**: the heading's text.
- **Heading link**: a note the heading opens when clicked, e.g. an index of
  all your projects. A file name (found anywhere in the vault) or a vault path.
  Cmd/Ctrl-click opens it in a new tab. Leave it empty for a plain heading.

The explorer's own sort order orders both lists.

## How it works

Two decisions carry the whole plugin, and both come from the same fact:
**Obsidian's File Explorer is virtualised.** It builds only the rows near the
scroll window, and it chooses them from its own sorted model rather than from
whatever the stylesheet ends up drawing.

**The lists are changed at the source, not in CSS.** `getSortedFolderItems` is
wrapped: for the vault root it returns the loose notes and then the project
notes, which are the explorer's own items for those files, borrowed from their
folders (and each folder's list drops them, so no item has two parents). Reordering with CSS `order` works
only while the whole tree fits on screen — expand one real folder and the model
puts the notes far below the viewport, so it never builds them and they vanish
from the top of a sidebar that is supposedly showing them. Wrapping the sorter
keeps model, DOM, scroll height and rendering window agreeing with each other.
It wraps rather than replaces, so whichever sort order you have set still
decides the order within each list.

**The header is not a row.** On every render pass the virtualiser decides
exactly which elements the list may contain, and deletes anything it did not put
there. A header parked between two rows is torn down
and rebuilt dozens of times a second while scrolling, and since the list's
cached heights are measured as the distance from one row's top to the next, a
foreign element between two rows lands in nobody's total. So the heading rides
*inside* the first project note's row: that row opens a band above itself with
`padding-top`, and the heading is positioned absolutely into the band, adding no
height of its own.

Both files are commented at length, in case any of this is useful elsewhere.

## Notes

- Tagging or untagging a note is a metadata change, not a file change, so the
  plugin re-sorts the explorer itself, and only when the set of projects
  actually changed.
- On mobile the File Explorer lives in a drawer that starts closed, so its view
  is not built yet when plugins load. The plugin asks for the real view instead
  of waiting to be handed one.
- While the plugin is off, the File Explorer looks exactly as Obsidian draws it.

## Licence

MIT

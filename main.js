"use strict";

/*
 * Folder Drawer
 *
 * The File Explorer's folders fold away behind a single FOLDERS header, so
 * the sidebar rests as the loose notes at the vault root — the things still
 * being worked out — with the library one click away.
 *
 * Why this sorts rather than paints
 * ---------------------------------
 * Obsidian's File Explorer is virtualised: it only builds the rows near the
 * scroll window, and it decides which those are from its own sorted model,
 * not from what the stylesheet ends up drawing. Reordering with CSS `order`
 * therefore works only while the whole tree fits on screen. Expand one real
 * folder and the model says the notes — last in its order — are far below
 * the viewport, so it never builds them, and the notes vanish from the top
 * of a sidebar that is supposedly showing them.
 *
 * So the order is changed at the source: getSortedFolderItems is wrapped to
 * return files before folders. Obsidian then agrees with itself — model,
 * DOM, scroll height and rendering window all line up — and no CSS has to
 * lie about where anything is.
 *
 * Why the header is not a row
 * ---------------------------
 * That same virtualiser decides, on every render pass, exactly which
 * elements the list is allowed to contain: setChildrenInPlace deletes
 * anything it did not put there. A header parked between the last note and
 * the first folder is therefore removed and rebuilt several times a second
 * while scrolling — measured: 45 removals in one second — and because it
 * stands 44px tall, the content above the viewport keeps losing and
 * regaining 44px. The browser answers each loss by nudging scrollTop to
 * keep the view anchored, and that nudge is the jitter: three 44px jumps
 * in a single second of scrolling, measured before this was changed.
 *
 * Worse, the model cannot account for a row it does not know about. The
 * heights it caches are the distance from one row's top to the next, so a
 * foreign element sitting between two rows puts its height into nobody's
 * total, and the arithmetic that decides where to park the remaining rows
 * drifts from what the screen actually shows.
 *
 * So the header rides inside the first folder's row. That row opens a 44px
 * band above itself with padding-top, and the header is positioned
 * absolutely into the band, adding no height of its own. Obsidian rewrites
 * the children of .nav-folder-children, never of the row, so the header is
 * never touched; and because the band is part of a row the virtualiser
 * measures, it travels correctly every time that row is attached or
 * detached. Nothing moves that Obsidian does not already know about.
 *
 * Body classes set here, read by styles.css:
 *
 *   folder-drawer-active     the plugin is running, so the CSS may collapse
 *                            things; without it the explorer looks untouched
 *   folder-drawer-open       the drawer is open
 *   folder-drawer-animating  a toggle is in flight
 *
 * That last one matters more than it looks. A permanent `transition: height`
 * on the folder rows would animate every height change they ever make — so
 * expanding a subfolder would slide open and shove the rest of the sidebar
 * around, and Obsidian's scroll-into-view would be measuring a height that
 * is still moving. Arming motion only for the length of a toggle keeps the
 * drawer animated and leaves the tree behaving exactly as it always has.
 *
 * On phones and tablets
 * ---------------------
 * Nothing here is desktop-only: the File Explorer, its virtualiser and its
 * sorter are the same code on iOS and Android, so the two things this plugin
 * does — reorder at the source, park the header inside a row — hold as they
 * are. What changes is the hardware, and the differences are handled where
 * they belong:
 *
 *   - Touch, in styles.css. The header grows to a real tap target under
 *     `body.is-mobile`, hover styling is fenced behind `@media (hover: hover)`
 *     so a tap does not leave it stuck lit, and an `:active` state gives the
 *     press something to answer with.
 *   - WebKit, also in styles.css. `interpolate-size: allow-keywords` is what
 *     lets height animate to `auto`, and iOS renders through the system
 *     WebView, which may not have it. An `@supports not (...)` block drops
 *     the height transition there rather than leave it half-running; the
 *     crossfade carries the toggle instead.
 *   - Long-press, here. iOS answers a held finger with a context menu and a
 *     selection callout, and the header is a piece of chrome, not content.
 */

const { Plugin, setIcon } = require("obsidian");

const ACTIVE_CLASS = "folder-drawer-active";
const OPEN_CLASS = "folder-drawer-open";
const ANIM_CLASS = "folder-drawer-animating";
const HEADER_CLASS = "folder-drawer-header";
const SEAM_CLASS = "folder-drawer-seam";
const LABEL = "Folders";
const ANIM_MS = 340;

/* Duck-typed, like the sort below: the items hold TFile/TFolder, and only a
   folder carries children. */
const isFolderItem = (item) => !!(item && item.file && Array.isArray(item.file.children));

module.exports = class FolderDrawerPlugin extends Plugin {
  async onload() {
    const saved = await this.loadData();
    this.open = !!(saved && saved.open);
    this.headers = new WeakMap();

    document.body.classList.add(ACTIVE_CLASS);
    document.body.classList.toggle(OPEN_CLASS, this.open);

    /* Both of these wait for the layout. On a cold start plugins load before
       the workspace is built, so there is no File Explorer leaf yet and no
       prototype to patch — doing it here would silently do nothing and leave
       the folders on top. layout-change retries it for explorers that appear
       later, and patchSort is a no-op once it has taken. */
    this.app.workspace.onLayoutReady(() => this.refresh());
    this.registerEvent(this.app.workspace.on("layout-change", () => this.refresh()));

    this.addCommand({
      id: "toggle",
      name: "Toggle folder drawer",
      callback: () => this.setOpen(!this.open),
    });
  }

  onunload() {
    window.clearTimeout(this.animTimer);
    document.body.classList.remove(ACTIVE_CLASS, OPEN_CLASS, ANIM_CLASS);
    document.querySelectorAll("." + HEADER_CLASS).forEach((el) => el.remove());
    document.querySelectorAll("." + SEAM_CLASS).forEach((el) => el.classList.remove(SEAM_CLASS));
    this.restoreSort();
    this.resort();
    this.remeasure();
  }

  refresh() {
    this.patchSort();
    this.mountAll();
  }

  /* --- ordering -------------------------------------------------------- */

  /* Wrap the view's own sorter instead of replacing it: whatever sort order
     is set in the File Explorer still decides the order *within* each group,
     and only the grouping is flipped. */
  patchSort() {
    if (this.sortProto) return;

    const view = this.explorerViews()[0];
    if (!view) return;

    const proto = Object.getPrototypeOf(view);
    if (!proto || typeof proto.getSortedFolderItems !== "function") return;

    this.sortProto = proto;
    this.originalSort = proto.getSortedFolderItems;

    const original = this.originalSort;
    const plugin = this;
    proto.getSortedFolderItems = function (folder) {
      const items = original.call(this, folder);
      const files = [];
      const folders = [];
      for (const item of items) {
        if (isFolderItem(item)) folders.push(item);
        else files.push(item);
      }

      /* Which row carries the header is decided here because this is where
         it changes: a folder created, renamed or deleted all come back
         through the root's sort, and the answer is already in hand. */
      if (plugin._loaded && folder && folder.isRoot && folder.isRoot()) {
        plugin.placeHeader(this, folders);
      }

      return files.concat(folders);
    };

    this.resort();
  }

  restoreSort() {
    if (!this.sortProto || !this.originalSort) return;
    this.sortProto.getSortedFolderItems = this.originalSort;
    this.sortProto = null;
    this.originalSort = null;
  }

  explorerViews() {
    return this.app.workspace
      .getLeavesOfType("file-explorer")
      .map((leaf) => leaf.view)
      .filter((view) => view && view.containerEl);
  }

  resort() {
    this.explorerViews().forEach((view) => {
      if (typeof view.requestSort === "function") view.requestSort();
    });
  }

  /* --- the header ------------------------------------------------------ */

  /* Every File Explorer leaf gets a header. The second-left-sidebar plugin
     can put a second one on screen, and they share the one open state. */
  mountAll() {
    let moved = false;
    for (const view of this.explorerViews()) {
      if (this.placeHeader(view, rootFolders(view))) moved = true;
    }
    if (moved) this.remeasure();
  }

  /* Parking the header is two moves: mark the row that opens the band, and
     put the header in it. Returns whether anything actually changed, so the
     caller knows whether the tree needs measuring again. */
  placeHeader(view, folders) {
    const header = this.headerFor(view);
    /* Skip rows a file-hider has switched off — they take no space, so a
       header parked in one would have no band to sit in. */
    const seam = folders.find((item) => item.el && item.el.style.display !== "none");

    let changed = false;
    view.containerEl.querySelectorAll("." + SEAM_CLASS).forEach((el) => {
      if (seam && el === seam.el) return;
      el.classList.remove(SEAM_CLASS);
      changed = true;
    });

    if (!seam) {
      if (header.parentElement) {
        header.remove();
        changed = true;
      }
      return changed;
    }

    if (!seam.el.classList.contains(SEAM_CLASS)) {
      seam.el.classList.add(SEAM_CLASS);
      changed = true;
    }
    if (seam.el.firstChild !== header) {
      seam.el.insertBefore(header, seam.el.firstChild);
      changed = true;
    }
    return changed;
  }

  headerFor(view) {
    let header = this.headers.get(view);
    if (!header) {
      header = this.buildHeader();
      this.headers.set(view, header);
    }
    this.syncHeader(header);
    return header;
  }

  buildHeader() {
    const header = createDiv({ cls: HEADER_CLASS });
    header.setAttribute("role", "button");
    header.setAttribute("tabindex", "0");
    header.createSpan({ cls: HEADER_CLASS + "-label", text: LABEL });

    const chevron = header.createSpan({ cls: HEADER_CLASS + "-chevron" });
    setIcon(chevron, "chevron-down");

    /* The whole band takes the click, not just the glyph: same gesture, a
       target you do not have to aim at. It stops there too — the header sits
       inside a folder's row now, and that row is the File Explorer's. */
    header.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.setOpen(!this.open);
    });
    header.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        evt.stopPropagation();
        this.setOpen(!this.open);
      }
    });

    /* A long press on iOS raises the same event a right-click does, and the
       row underneath would answer it with the first folder's context menu —
       rename, delete — for a gesture aimed at a section header. Swallow it:
       the header is chrome, and has no menu of its own. */
    header.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
    });

    return header;
  }

  syncHeader(header) {
    header.setAttribute("aria-expanded", String(this.open));
    header.setAttribute("aria-label", (this.open ? "Hide" : "Show") + " folders");
  }

  /* --- toggling -------------------------------------------------------- */

  async setOpen(open) {
    /* Arm the transition before the state flips, disarm once it has run.
       340ms clears the longest of the two durations in styles.css. */
    document.body.classList.add(ANIM_CLASS);
    window.clearTimeout(this.animTimer);
    this.animTimer = window.setTimeout(() => {
      document.body.classList.remove(ANIM_CLASS);
      this.remeasure();
    }, ANIM_MS);

    this.open = open;
    document.body.classList.toggle(OPEN_CLASS, open);
    document.querySelectorAll("." + HEADER_CLASS).forEach((el) => this.syncHeader(el));
    await this.saveData({ open });
  }

  /* A toggle changes every folder row's height behind Obsidian's back. It
     measures the tree itself and caches what it finds, and no CSS class
     change tells it those numbers are now wrong; left alone it goes on
     placing rows by the old heights. That is how a shut drawer ends up with
     fifty thousand pixels of scroll under thirteen notes — the collapsed
     folders are clipped to nothing on screen while the model still counts
     every file inside them. Measure again once the animation has settled. */
  remeasure() {
    for (const view of this.explorerViews()) {
      const scroll = view.tree && view.tree.infinityScroll;
      if (scroll && typeof scroll.invalidateAll === "function") scroll.invalidateAll();
    }
  }
};

/* The rows Obsidian is currently holding for the vault root, in its order —
   the same list the sort hands over, for the times nothing has sorted yet. */
function rootFolders(view) {
  const tree = view.tree;
  const root = tree && tree.infinityScroll && tree.infinityScroll.rootEl;
  const children = root && root.vChildren && root.vChildren.children;
  return children ? children.filter(isFolderItem) : [];
}

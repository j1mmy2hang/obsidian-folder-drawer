"use strict";

/*
 * Folder Drawer
 *
 * Turns the core File Explorer into five lists, in this order:
 *
 *   TODO      — source notes whose `descriptive` list holds "todo"; the
 *               heading opens todo.md.md
 *   INBOX     — source notes to read (clippings, AI-written notes, research
 *               overviews), by a value in their `descriptive` list
 *   MIND      — the rest of the source folder (the vault root, or the one
 *               named in settings): notes to think through
 *   PROJECTS  — every note tagged #project/in-progress, wherever it lives in
 *               the vault
 *   ROOT      — the notes at the vault root, when the source folder is
 *               another one: what just landed, not yet moved anywhere. Not in
 *               the list: a dock pinned under it, at the bottom of the pane
 *
 * With Move todos on, a todo note at the root, in the source folder or in
 * the later folder files itself by its do date: today or earlier into the
 * source folder, later into the later folder; without a date, to the root,
 * where an undated new one waits. A todo anywhere else stays where it is,
 * so an archived todo stays archived. The note open in the active
 * tab moves once another opens. A todo moved into the source folder gets
 * today as its do date; one moved into the later folder without a future
 * date gets this Sunday; one moved from either back to the root loses its
 * do date.
 *
 * Spaces, as in Arc: the source folder is Today, the later folder is Later,
 * two lists side by side, and a sideways swipe moves from one to the other.
 * Each space fills the same headings from its own folder; Projects belong to
 * Today, the inbox dock to both. Dots at the bottom show which is showing.
 * The swipe itself is the browser's: the two lists sit in a horizontal
 * scroller with scroll snapping, so the trackpad's gesture, its momentum and
 * the landing all run natively, off the main thread.
 *
 * Folders leave the explorer entirely; reach them through search, the Quick
 * Switcher, or any other pane. A root note that is also an active project
 * appears once, under Projects. A section with no notes shows no heading.
 *
 * Until 2.0 this plugin folded the folders behind a FOLDERS header instead.
 * The header mechanism below is the same one, once per section.
 *
 * How the list is changed
 * -----------------------
 * The explorer is virtualised and builds rows from its own sorted model, so
 * the change is made where the model is made: getSortedFolderItems, wrapped
 * (not replaced — other plugins may wrap it too, and the explorer's sort order still
 * orders every section). For the root it returns the todo notes, the inbox
 * notes, the mind notes, then the project notes, which are real explorer items borrowed from their folders.
 * A source folder other than the root lends its notes the same way.
 * Each folder's own list drops what was borrowed, so no item is claimed by two
 * parents: a tree item belongs to whichever list last called setChildren on it.
 * Indentation is measured from where a row actually sits, so a borrowed row
 * lands flush with the root notes on its own.
 *
 * Why the heading is not a row
 * ----------------------------
 * The virtualiser deletes any child of the list it did not put there, and it
 * measures each row as the distance from its top to the next row's top.
 * Both were learned the hard way in 1.x. So each heading rides inside the
 * first row of its section: that row opens a band above itself with padding-top and
 * the heading is positioned absolutely into it, adding no height of its own.
 * Obsidian never rewrites a row's own children, and the band is part of a
 * row it measures, so nothing moves that Obsidian does not know about.
 */

const { Plugin, PluginSettingTab, Setting, TFile, TFolder, Keymap, Menu, moment, normalizePath, getAllTags, debounce, setIcon } = require("obsidian");

const ACTIVE_CLASS = "folder-drawer-active";
const HEADING_CLASS = "folder-drawer-heading";
const SEAM_CLASS = "folder-drawer-seam";
/* The seam of the first section in the list: nothing above it to keep apart. */
const TOP_SEAM_CLASS = "folder-drawer-seam-top";
/* The seam of a folded section: the row keeps its band, its own content hides. */
const FOLDED_CLASS = "folder-drawer-folded";
/* A row, or a seam row's own content, while a fold animates it. */
const FOLDING_CLASS = "folder-drawer-folding";
/* The root section's own panel, below the scrolling list. */
const DOCK_CLASS = "folder-drawer-dock";
/* Copies of rows that just left, fading where they were. */
const GHOSTS_CLASS = "folder-drawer-ghosts";
/* The dots at the bottom of the pane, one per space. */
const SPACES_CLASS = "folder-drawer-spaces";
const FOLD_MS = 260;
/* Today's list when nothing is left in it, and what it says then. */
const EMPTY_CLASS = "folder-drawer-empty";
const EMPTY_TEXT = "All clear for today.";
/* The horizontal scroller that holds the spaces, and Later's list in it. */
const SPACES_WRAP_CLASS = "folder-drawer-spaces-wrap";
const LATER_CLASS = "folder-drawer-later";
/* The bar atop Later: how full it is, against this many notes. */
const METER_CLASS = "folder-drawer-meter";
const LATER_CAPACITY = 20;
/* How far a finger moves before the swipe is read as sideways or not. */
const SWIPE_SLOP_PX = 10;
const FOLD_EASING = "cubic-bezier(0.2, 0, 0, 1)";

const DEFAULT_SETTINGS = {
  projectTag: "project/in-progress",
  /* The frontmatter list that holds projectTag. Empty reads the note's real
     tags instead, so project status can live outside the tags. */
  projectProperty: "descriptive",
  heading: "Projects",
  /* The note the heading opens. The author's own, found by file name, so a
     fresh install on another device works with nothing to type. Empty makes
     the heading a plain label again. */
  headingLink: "projects.md.md",
  /* Root notes whose property (projectProperty, or the tags) holds one of
     these go under the inbox heading instead of the mind heading. */
  inboxValues: ["clipping", "daily-vocab", "weekly-letter"],
  inboxHeading: "Inbox",
  /* Source-folder notes holding one of these go under the todo heading,
     which opens todoLink. Todo wins over inbox. */
  todoValues: ["todo"],
  todoHeading: "Todo",
  todoLink: "todo.md.md",
  /* Move todo notes between the source folder and laterFolder by the date
     in doDateProperty. Off by default: it moves files. */
  moveTodos: false,
  doDateProperty: "do date",
  laterFolder: "later",
  mindHeading: "Mind",
  rootHeading: "Inbox",
  /* The folder whose notes fill the mind and inbox sections. Empty is the
     vault root. */
  sourceFolder: "",
  /* Sections folded under their heading. */
  collapsed: [],
  /* Today (the source folder) and Later (the later folder) as two spaces,
     switched by a horizontal swipe. */
  spaces: true,
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/* Core's comparators, word for word, keyed by the explorer's sortOrder. */
const COMPARE = {
  alphabetical: (a, b) => collator.compare(a.basename, b.basename),
  alphabeticalReverse: (a, b) => -collator.compare(a.basename, b.basename),
  byModifiedTime: (a, b) => b.stat.mtime - a.stat.mtime,
  byModifiedTimeReverse: (a, b) => a.stat.mtime - b.stat.mtime,
  byCreatedTime: (a, b) => b.stat.ctime - a.stat.ctime,
  byCreatedTimeReverse: (a, b) => a.stat.ctime - b.stat.ctime,
};

/* "#Project/In-Progress" and "project/in-progress" are the same tag. */
function normalize(tag) {
  return tag.trim().replace(/^#+/, "").toLowerCase();
}

module.exports = class FolderDrawerPlugin extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    /* 1.x kept the drawer's open state here; there is no drawer any more. */
    delete saved.open;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.headings = new WeakMap();
    /* view → each section's full list of items, before any folding. */
    this.sections = new WeakMap();
    this.projects = new Set();
    this.rootFiles = new Set();
    /* Each space's todo, inbox and mind notes, filled in the same pass. */
    this.bySpace = [];
    /* view → its dock element, and the dock's last-drawn contents. */
    this.docks = new WeakMap();
    /* view → the elements of every item its list holds. */
    this.listed = new WeakMap();
    /* view → whether its dock was drawn yet, a dock fading out, and the
       dock's running animations. */
    this.dockSeen = new WeakSet();
    this.leavingDocks = new WeakMap();
    this.dockGlides = new WeakMap();
    /* The space showing: 0 is Today. Every launch starts there. */
    this.space = 0;
    /* explorer view → its spaces: the scroller and Later's own explorer. */
    this.stages = new Map();
    /* The explorers that list Later; every other one lists Today. */
    this.laterViews = new WeakSet();
    this.spaceDots = new WeakMap();

    document.body.classList.add(ACTIVE_CLASS);
    this.addSettingTab(new FolderDrawerSettingTab(this.app, this));
    this.addCommand({ id: "next-space", name: "Next space", callback: () => this.switchSpace(this.space + 1) });
    this.addCommand({ id: "previous-space", name: "Previous space", callback: () => this.switchSpace(this.space - 1) });

    /* Plugins load before the workspace is built, so the explorer's prototype
       is only reachable after layout-ready. active-leaf-change is for the
       phone, where the explorer sits in a drawer that starts closed and its
       leaf stays deferred until opened. */
    this.app.workspace.onLayoutReady(() => {
      this.scan();
      this.placeTodos();
      this.refresh();
    });
    this.registerEvent(this.app.workspace.on("layout-change", () => this.refresh()));
    /* A date that was in the future becomes today at midnight, with no
       event to say so: check once a minute whether the day turned. */
    this.registerInterval(
      window.setInterval(() => {
        if (this.day !== moment().format("YYYY-MM-DD")) this.placeTodos();
      }, 60 * 1000)
    );
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refresh()));

    /* Tagging a note or taking the tag off is a metadata change, not a vault
       one, so the explorer would never re-sort by itself. Only re-sort when
       the set of projects actually changed. */
    const rescan = (this.rescanLater = debounce(() => this.rescan(), 200, true));
    /* The explorer sorts a frame after a file event, and a note sorted by
       stale lists shows up in the wrong section first, then jumps. So the
       note itself is placed at once; the debounced rescan only confirms. */
    const now = (file) => {
      if (file instanceof TFile) {
        this.placeTodos(file);
        /* The sort redraws the dock too, in the same frame as the list. */
        if (this.track(file)) this.resort();
      } else {
        this.scan();
      }
      rescan();
    };
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (this.dating?.get(file) === "written") this.dating.delete(file);
        now(file);
      })
    );
    this.registerEvent(this.app.metadataCache.on("resolved", rescan));
    this.registerEvent(this.app.vault.on("create", now));
    this.registerEvent(this.app.vault.on("delete", now));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.arrive(file, oldPath);
        now(file);
      })
    );

    /* The heading lights up while its note is the one open, as a row does. */
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.placeTodos();
        this.syncHeadings();
        this.syncDockActive();
      })
    );
    this.registerEvent(this.app.vault.on("rename", () => this.syncHeadings()));
  }

  onunload() {
    /* Timers, frames and file moves started before unloading still call back
       afterwards; each entry point checks _loaded, or a dock or dots drawn
       by the old copy would outlive it next to the new copy's. */
    this.rescanLater?.cancel();
    document.body.classList.remove(ACTIVE_CLASS);
    this.clearFold();
    document.querySelectorAll("." + HEADING_CLASS).forEach((el) => el.remove());
    document.querySelectorAll("." + DOCK_CLASS).forEach((el) => el.remove());
    document.querySelectorAll("." + SPACES_CLASS).forEach((el) => el.remove());
    document.querySelectorAll("." + GHOSTS_CLASS).forEach((el) => el.remove());
    document.querySelectorAll("." + EMPTY_CLASS).forEach((el) => el.removeClass(EMPTY_CLASS));
    document.querySelectorAll("." + SEAM_CLASS).forEach((el) => el.classList.remove(SEAM_CLASS, TOP_SEAM_CLASS, FOLDED_CLASS));
    for (const view of [...this.stages.keys()]) this.unmountSpaces(view);
    this.space = 0;
    this.restore();
    this.resort();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.headings = new WeakMap();
    document.querySelectorAll("." + HEADING_CLASS).forEach((el) => el.remove());
    document.querySelectorAll("." + DOCK_CLASS).forEach((el) => el.remove());
    this.rescan(true);
    this.refresh();
  }

  isCollapsed(section) {
    return this.settings.collapsed.includes(section);
  }

  /* A fold moves only transform and opacity, which the compositor runs
     without layout. The layout changes once, at an instant when the motion
     hides it. Closing: the section's rows fade while the rows below slide up
     over them, and when the slide lands the sort drops the faded rows, so
     everything below is already where the new layout puts it. Opening: the
     sort lays the section out first, hidden, before the browser paints; the
     rows below start where they were and slide down, and the section fades
     in behind them. The virtualiser's cached heights are dropped at the end. */
  async toggleSection(section) {
    if (this.folding) return;
    /* The dock is outside the virtualised list: nothing to slide past. */
    if (section === "root") return this.toggleDock();
    this.folding = true;
    const closing = !this.isCollapsed(section);
    const motion = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    /* The chevron turns with the rows, not after them: a close sorts only
       once its slide lands. */
    for (const view of this.explorerViews()) this.headings.get(view)?.get(section)?.toggleClass("is-collapsed", closing);
    try {
      if (closing && motion) await this.fold(section, false);
      this.settings.collapsed = closing
        ? this.settings.collapsed.concat(section)
        : this.settings.collapsed.filter((s) => s !== section);
      this.saveData(this.settings);
      if (!closing && motion) {
        this.stage(section);
        this.sortNow();
        await this.fold(section, true);
      } else {
        this.sortNow();
      }
    } finally {
      this.clearFold();
      /* Heights only. A queued sort would land in the next fold and detach
         its rows, and a detached row drops its animation. */
      for (const view of this.explorerViews()) view.tree?.infinityScroll?.invalidateAll?.();
      this.folding = false;
    }
  }

  /* The dock folds as a section does, toward the pane's bottom edge. Its
     heading and list slide as one, clipped by the dock, and the list fades.
     Closing: they sink until the heading reaches the place the shut dock
     gives it, then the redraw lands it there. Opening: the redraw comes
     first, and they rise from where the heading was. */
  async toggleDock() {
    this.folding = true;
    const closing = !this.isCollapsed("root");
    const motion = this.motion();
    const docks = this.paneViews()
      .map((view) => this.docks.get(view))
      .filter((dock) => dock?.isConnected);
    for (const dock of docks) dock.querySelector(":scope > ." + HEADING_CLASS)?.toggleClass("is-collapsed", closing);
    try {
      if (closing && motion) {
        await this.slideDocks(docks, (dock, heading) => {
          const box = dock.getBoundingClientRect();
          const pad = parseFloat(getComputedStyle(dock).paddingBottom) || 0;
          return box.bottom - pad - heading.offsetHeight - heading.getBoundingClientRect().top;
        }, false);
      }
      const before = new Map(docks.map((dock) => [dock, dock.querySelector(":scope > ." + HEADING_CLASS)?.getBoundingClientRect().top]));
      this.settings.collapsed = closing
        ? this.settings.collapsed.concat("root")
        : this.settings.collapsed.filter((s) => s !== "root");
      this.saveData(this.settings);
      this.renderDocks();
      if (!closing && motion) {
        await this.slideDocks(docks, (dock, heading) => (before.get(dock) ?? 0) - heading.getBoundingClientRect().top, true);
      }
    } finally {
      this.clearFold();
      this.folding = false;
    }
  }

  /* offset(dock, heading) is how far below its resting place the content
     is shut. */
  async slideDocks(docks, offset, opening) {
    const animations = [];
    for (const dock of docks) {
      if (!dock.isConnected) continue;
      const heading = dock.querySelector(":scope > ." + HEADING_CLASS);
      const list = dock.querySelector(":scope > ." + DOCK_CLASS + "-list");
      if (!heading || !list) continue;
      /* Clipped first: leaving overflow auto resets the dock's scroll. */
      dock.classList.add(FOLDING_CLASS);
      const shut = `translateY(${offset(dock, heading)}px)`;
      for (const el of [heading, list]) {
        animations.push(
          el.animate(opening ? [{ transform: shut }, { transform: "none" }] : [{ transform: "none" }, { transform: shut }], {
            duration: FOLD_MS,
            easing: FOLD_EASING,
            fill: "both",
          })
        );
      }
      animations.push(
        list.animate(
          opening
            ? [{ opacity: 0 }, { opacity: 0, offset: 0.25 }, { opacity: 1 }]
            : [{ opacity: 1 }, { opacity: 0, offset: 0.6 }, { opacity: 0 }],
          { duration: FOLD_MS, easing: "linear", fill: "both" }
        )
      );
    }
    this.foldAnimations = (this.foldAnimations || []).concat(animations);
    await Promise.all(animations.map((a) => a.finished.catch(() => {})));
  }

  sortNow() {
    for (const view of this.explorerViews()) if (typeof view.sort === "function") view.sort();
  }

  /* What fades in a section: every row but the seam, and the seam row's own
     content, never the seam row itself, which carries the heading. */
  foldTargets(view, section) {
    const targets = [];
    for (const item of this.sections.get(view)?.[section] || []) {
      const el = item.el;
      if (!el || !el.isConnected || el.style.display === "none") continue;
      if (el.classList.contains(SEAM_CLASS)) {
        const self = el.querySelector(":scope > .tree-item-self");
        if (self) targets.push(self);
      } else {
        targets.push(el);
      }
    }
    return targets;
  }

  /* Opening: the section is laid out invisible, so the sort shows nothing. */
  stage(section) {
    for (const view of this.explorerViews()) {
      for (const item of this.sections.get(view)?.[section] || []) {
        const el = item.el;
        if (!el) continue;
        const target = el.classList.contains(SEAM_CLASS) ? el.querySelector(":scope > .tree-item-self") : el;
        target?.classList.add(FOLDING_CLASS, "is-staged");
      }
    }
  }

  async fold(section, opening) {
    const animations = [];
    const run = (el, frames, options) => {
      el.classList.add(FOLDING_CLASS);
      animations.push(el.animate(frames, { duration: FOLD_MS, fill: "both", ...options }));
    };
    for (const view of this.explorerViews()) {
      const targets = this.foldTargets(view, section);
      if (!targets.length) continue;
      /* The rows below: every attached row after the section's last one. */
      const last = targets[targets.length - 1].closest(".tree-item") || targets[targets.length - 1];
      const followers = [];
      for (let el = last.nextElementSibling; el; el = el.nextElementSibling) {
        if (el.classList.contains("tree-item")) followers.push(el);
      }
      /* How far they move: from where they sit now to just under the
         heading, which is where the section's own content begins. */
      const shift = followers.length ? followers[0].getBoundingClientRect().top - targets[0].getBoundingClientRect().top : 0;
      const away = `translateY(${-shift}px)`;
      for (const el of followers) {
        run(el, opening ? [{ transform: away }, { transform: "none" }] : [{ transform: "none" }, { transform: away }], {
          easing: FOLD_EASING,
        });
      }
      /* The section is gone by the time the rows below cover most of it,
         and comes back only as they uncover it. */
      for (const el of targets) {
        el.classList.remove("is-staged");
        run(
          el,
          opening
            ? [{ opacity: 0 }, { opacity: 0, offset: 0.25 }, { opacity: 1 }]
            : [{ opacity: 1 }, { opacity: 0, offset: 0.6 }, { opacity: 0 }],
          { easing: "linear" }
        );
      }
    }
    this.foldAnimations = (this.foldAnimations || []).concat(animations);
    await Promise.all(animations.map((a) => a.finished.catch(() => {})));
  }

  /* Rows glide to where a sort put them instead of jumping there. The root
     sort notes where every row is before the explorer redraws; in the frame
     the redraw lands, the rows move as shift() moves them. A row that is
     merely scrolled out of the drawn window is not gone, only undrawn, so
     only rows the list no longer holds fade out. Old places are measured
     with any glide still running, so a sort mid-glide carries on from where
     the rows are. */
  glide(view) {
    if (!this._loaded) return;
    if (this.folding || this.glideFrame?.has(view) || !this.motion()) return;
    const host = view.navFileContainerEl;
    if (!host) return;
    const before = this.rowRects(host);
    if (!before.size) return;
    this.glideFrame = this.glideFrame || new Set();
    this.glideFrame.add(view);
    requestAnimationFrame(() => {
      this.glideFrame.delete(view);
      if (this.folding || !this._loaded) return;
      for (const a of this.glides?.get(view) || []) a.cancel();
      const after = this.rowRects(host);
      const listed = this.listed.get(view) || new Set();
      const gone = [...before].filter(([el]) => !after.has(el) && !listed.has(el)).map(([, row]) => row);
      const animations = this.shift(before, after, gone, host);
      this.glides = this.glides || new WeakMap();
      this.glides.set(view, animations);
      if (!animations.length) return;
      /* The virtualiser measures rows; let it measure them at rest. */
      Promise.allSettled(animations.map((a) => a.finished)).then(() => view.tree?.infinityScroll?.invalidateAll?.());
    });
  }

  motion() {
    return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /* Each drawn note row in the list, by element (a note keeps its row when
     it is renamed or moved), with where it is. */
  rowRects(host) {
    const rows = new Map();
    host.querySelectorAll(".tree-item.nav-file").forEach((el) => {
      if (el.offsetParent && !el.closest("." + GHOSTS_CLASS)) rows.set(el, { el, rect: el.getBoundingClientRect() });
    });
    return rows;
  }

  /* The one motion for rows that come, go or move, timed like a fold. A row
     that moved slides from where it was. A new one fades in behind the rows
     making room for it, as an opening section does. One that left is copied
     where it was and the copy fades as the rows below slide up over its
     place, as a closing section does. before and after map a key to
     { el, rect }; host is a positioned element the copies are laid in. */
  shift(before, after, gone, host) {
    const animations = [];
    for (const [key, { el, rect }] of after) {
      const was = before.get(key);
      if (!was) {
        animations.push(
          el.animate([{ opacity: 0 }, { opacity: 0, offset: 0.25 }, { opacity: 1 }], { duration: FOLD_MS, easing: "linear" })
        );
      } else if (Math.abs(was.rect.top - rect.top) > 0.5) {
        animations.push(
          el.animate([{ transform: `translateY(${was.rect.top - rect.top}px)` }, { transform: "none" }], {
            duration: FOLD_MS,
            easing: FOLD_EASING,
          })
        );
      }
    }
    if (gone.length) {
      const box = host.getBoundingClientRect();
      const layer = createDiv({ cls: GHOSTS_CLASS });
      host.prepend(layer);
      const fades = gone.map(({ el, rect }) => {
        const copy = el.cloneNode(true);
        copy.removeAttribute("id");
        Object.assign(copy.style, {
          position: "absolute",
          top: `${rect.top - box.top + host.scrollTop}px`,
          left: `${rect.left - box.left + host.scrollLeft}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          margin: "0",
          transform: "none",
        });
        layer.appendChild(copy);
        return copy.animate([{ opacity: 1 }, { opacity: 0, offset: 0.6 }, { opacity: 0 }], {
          duration: FOLD_MS,
          easing: "linear",
          fill: "forwards",
        });
      });
      Promise.allSettled(fades.map((a) => a.finished)).then(() => layer.remove());
      animations.push(...fades);
    }
    return animations;
  }

  clearFold() {
    for (const a of this.foldAnimations || []) a.cancel();
    this.foldAnimations = [];
    document.querySelectorAll("." + FOLDING_CLASS).forEach((el) => el.classList.remove(FOLDING_CLASS, "is-staged"));
  }

  /* --- which notes are projects ---------------------------------------- */

  /* The space a view lists: Later's own explorer lists Later. */
  spaceOf(view) {
    return this.laterViews.has(view) ? 1 : 0;
  }

  /* Today's folder (the source folder, the root when unset) and, with
     spaces on, Later's. */
  spaceFolders() {
    const today = this.folderAt(this.settings.sourceFolder) || this.app.vault.getRoot();
    return this.spaces().length > 1 ? [today, this.folderAt(this.settings.laterFolder)] : [today];
  }

  allSets() {
    return [this.projects, this.rootFiles, ...this.bySpace.flatMap((s) => [s.todo, s.inbox, s.loose])];
  }

  /* Projects anywhere in the vault; inbox notes in a space's folder only. */
  scan() {
    this.projects = new Set();
    this.rootFiles = new Set();
    const rules = this.rules();
    this.bySpace = rules.sources.map(() => ({ todo: new Set(), inbox: new Set(), loose: new Set() }));
    for (const file of this.app.vault.getMarkdownFiles()) this.file(file, rules);
  }

  rules() {
    return {
      sources: this.spaceFolders(),
      want: normalize(this.settings.projectTag),
      inboxWant: new Set(this.settings.inboxValues.map(normalize).filter(Boolean)),
      todoWant: new Set(this.settings.todoValues.map(normalize).filter(Boolean)),
      key: this.settings.projectProperty.trim(),
    };
  }

  /* Adds one note to the lists it belongs in. */
  file(file, { sources, want, inboxWant, todoWant, key }) {
    /* A note on its way elsewhere shows up only once it arrives, not for a
       moment where it was. */
    const to = this.moving?.get(file);
    if (to && to !== file.path) return;
    const lists = this.bySpace[sources.indexOf(file.parent)];
    if (lists) lists.loose.add(file);
    else if (file.parent?.isRoot()) this.rootFiles.add(file);
    const meta = this.app.metadataCache.getFileCache(file);
    if (!meta) return;
    const values = (key ? [].concat(meta.frontmatter?.[key] ?? []) : getAllTags(meta) || [])
      .filter((v) => typeof v === "string")
      .map(normalize);
    if (want && values.some((v) => v === want || v.startsWith(want + "/"))) this.projects.add(file);
    else if (lists && values.some((v) => todoWant.has(v))) lists.todo.add(file);
    else if (lists && values.some((v) => inboxWant.has(v))) lists.inbox.add(file);
  }

  /* Re-files one note after it was created, changed, moved or deleted.
     Returns whether any list changed. */
  track(file) {
    const sets = this.allSets();
    const before = sets.map((set) => set.has(file));
    for (const set of sets) set.delete(file);
    if (file.extension === "md" && this.app.vault.getAbstractFileByPath(file.path) === file) this.file(file, this.rules());
    return sets.some((set, i) => set.has(file) !== before[i]);
  }

  rescan(force = false) {
    if (!this._loaded) return;
    const same = (a, b) => a.size === b.size && [...b].every((f) => a.has(f));
    const before = this.allSets();
    this.scan();
    this.placeTodos();
    const after = this.allSets();
    if (force || before.length !== after.length || before.some((set, i) => !same(set, after[i]))) this.resort();
    this.renderDocks();
  }

  /* --- filing todos by do date -------------------------------------------- */

  /* A note's do date as YYYY-MM-DD, or a string after every date when it
     has none, so undated todos sort last. */
  doDate(file) {
    const date = String(this.app.metadataCache.getFileCache(file)?.frontmatter?.[this.settings.doDateProperty] ?? "").trim();
    return /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : "~";
  }

  folderAt(path) {
    const clean = (path || "").trim().replace(/^\/+|\/+$/g, "");
    const folder = clean && this.app.vault.getAbstractFileByPath(clean);
    return folder instanceof TFolder ? folder : null;
  }

  isTodo(meta) {
    if (!meta || !meta.frontmatter) return false;
    const todoWant = new Set(this.settings.todoValues.map(normalize).filter(Boolean));
    const key = this.settings.projectProperty.trim();
    return (key ? [].concat(meta.frontmatter[key] ?? []) : getAllTags(meta) || [])
      .filter((v) => typeof v === "string")
      .map(normalize)
      .some((v) => todoWant.has(v));
  }

  /* A todo moved by hand gets a do date that keeps it where it was put:
     - arriving in the source folder from anywhere else, it is due today;
     - arriving in the later folder from anywhere else with a date that is
       not in the future, it is due this Sunday (next Sunday on a Sunday);
     - moved from either of them back to the vault root, it has no do date.
     A time after the date is kept. Without this, placeTodos would send the
     note straight back; until the new date is in the metadata cache it
     leaves the note alone. A todo filed by placeTodos itself already has a
     date that fits, so nothing is written. */
  arrive(file, oldPath) {
    if (!this.settings.moveTodos || !(file instanceof TFile) || file.extension !== "md") return;
    const now = this.folderAt(this.settings.sourceFolder);
    const later = this.folderAt(this.settings.laterFolder);
    if (!now || !later) return;
    const from = oldPath.includes("/") ? oldPath.slice(0, oldPath.lastIndexOf("/")) : "";
    const meta = this.app.metadataCache.getFileCache(file);
    if (!this.isTodo(meta)) return;
    const prop = this.settings.doDateProperty;
    const today = moment().format("YYYY-MM-DD");
    const current = String(meta.frontmatter[prop] ?? "").trim().slice(0, 10);
    let day;
    if (file.parent === now && from !== now.path) {
      if (current === today) return;
      day = today;
    } else if (file.parent === later && from !== later.path) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(current) && current > today) return;
      day = moment().day(7).format("YYYY-MM-DD");
    } else if (file.parent?.isRoot() && (from === now.path || from === later.path)) {
      if (!current) return;
      day = null;
    } else {
      return;
    }
    this.dating = this.dating || new Map();
    this.dating.set(file, "writing");
    this.app.fileManager
      .processFrontMatter(file, (fm) => {
        const old = String(fm[prop] ?? "").trim();
        if (day === null) fm[prop] = null;
        else fm[prop] = /^\d{4}-\d{2}-\d{2}(?![\d])/.test(old) ? day + old.slice(10) : day;
      })
      .then(
        () => {
          this.dating.set(file, "written");
          window.setTimeout(() => this.dating.delete(file), 5000);
        },
        (e) => {
          this.dating.delete(file);
          console.error("Folder Drawer: could not date", file.path, e);
        }
      );
  }

  /* Each todo at the root, in the source folder or in the later folder goes
     where its do date says, and one with no date goes back to the root. A note without a full date (or with a template's
     placeholder) stays put, and so does one whose name is taken there. */
  placeTodos(only) {
    if (!this._loaded) return false;
    this.day = moment().format("YYYY-MM-DD");
    if (!this.settings.moveTodos) return false;
    const now = this.folderAt(this.settings.sourceFolder);
    const later = this.folderAt(this.settings.laterFolder);
    if (!now || !later) return false;
    const root = this.app.vault.getRoot();
    const cache = this.app.metadataCache;
    /* note → the path it is moving to */
    this.moving = this.moving || new Map();
    let started = false;
    /* The note being worked in waits until another one opens: renaming an
       open file redraws its inline title, which drops the focus and the
       selection a new note is born with. */
    const active = this.app.workspace.getActiveFile();
    for (const file of only ? [only] : this.app.vault.getMarkdownFiles()) {
      if (file.extension !== "md") continue;
      if (file.parent !== root && file.parent !== now && file.parent !== later) continue;
      if (file === active || this.moving.has(file) || this.dating?.has(file)) continue;
      const meta = cache.getFileCache(file);
      if (!this.isTodo(meta)) continue;
      const date = String(meta.frontmatter[this.settings.doDateProperty] ?? "").trim();
      let target;
      /* A todo whose date was cleared is no longer scheduled: back to the root. */
      if (!date) target = root;
      else if (/^\d{4}-\d{2}-\d{2}(?![\d])/.test(date)) target = date.slice(0, 10) <= this.day ? now : later;
      else continue;
      if (file.parent === target) continue;
      const path = target.isRoot() ? file.name : normalizePath(target.path + "/" + file.name);
      if (this.app.vault.getAbstractFileByPath(path)) continue;
      this.moving.set(file, path);
      started = true;
      this.app.fileManager
        .renameFile(file, path)
        .catch((e) => console.error("Folder Drawer: could not move", file.path, e))
        .finally(() => {
          this.moving.delete(file);
          if (this.track(file)) this.resort();
        });
    }
    return started;
  }

  /* --- the explorer ------------------------------------------------------ */

  async refresh() {
    try {
      const deferred = this.app.workspace
        .getLeavesOfType("file-explorer")
        .filter((leaf) => leaf.isDeferred && typeof leaf.loadIfDeferred === "function");
      if (deferred.length) await Promise.all(deferred.map((leaf) => leaf.loadIfDeferred()));
    } catch (e) {
      /* The next event tries again. */
    }
    this.patch();
    this.mountAllSpaces();
  }

  /* The File Explorer panes: the explorers the workspace owns. */
  paneViews() {
    return this.app.workspace
      .getLeavesOfType("file-explorer")
      .filter((leaf) => !leaf.isDeferred)
      .map((leaf) => leaf.view)
      .filter((view) => view && view.containerEl && view.fileItems);
  }

  /* Every explorer the plugin sorts: the panes, and Later's beside each. */
  explorerViews() {
    const panes = this.paneViews();
    return panes.concat(panes.map((view) => this.stages.get(view)?.later).filter(Boolean));
  }

  patch() {
    if (this.proto) return;
    const view = this.explorerViews()[0];
    if (!view) return;
    const proto = Object.getPrototypeOf(view);
    if (!proto || typeof proto.getSortedFolderItems !== "function") return;

    this.proto = proto;
    this.original = proto.getSortedFolderItems;
    const original = this.original;
    const plugin = this;

    this.wrapper = function (folder) {
      const items = original.call(this, folder);
      /* If another plugin wrapped this wrapper, unloading cannot unhook it;
         the guard makes it inert instead. */
      if (!plugin._loaded) return items;
      const { projects } = plugin;
      const space = plugin.spaceOf(this);
      const folders = plugin.spaceFolders();
      const source = folders[space] || folders[0];
      const { inbox, todo } = plugin.bySpace[space] || { inbox: new Set(), todo: new Set() };
      if (!folder || !folder.isRoot()) {
        /* The source folder's notes are listed at the root instead. */
        if (folder === source) return items.filter((item) => !(item && item.file instanceof TFile));
        return items.filter((item) => !(item && projects.has(item.file)));
      }

      plugin.glide(this);
      const sourceItems = source.isRoot() ? items : original.call(this, source);
      const loose = sourceItems.filter((item) => item && item.file instanceof TFile && !projects.has(item.file));
      const todoItems = loose.filter((item) => todo.has(item.file));
      const mind = loose.filter((item) => !inbox.has(item.file) && !todo.has(item.file));
      const inboxItems = loose.filter((item) => inbox.has(item.file));
      /* Later is what is coming: its todos by do date, soonest first, and
         its other notes newest first, whatever the explorer's own order. */
      if (space) {
        const byItem = (cmp) => (a, b) => cmp(a.file, b.file);
        todoItems.sort(byItem((a, b) => plugin.doDate(a).localeCompare(plugin.doDate(b)) || COMPARE.alphabetical(a, b)));
        mind.sort(byItem(COMPARE.byCreatedTime));
        inboxItems.sort(byItem(COMPARE.byCreatedTime));
      }
      const compare = COMPARE[this.sortOrder] || COMPARE.alphabetical;
      /* Projects are what is in progress now: they belong to Today. */
      const borrowed = (space ? [] : [...projects])
        .sort(compare)
        .map((file) => this.fileItems[file.path])
        .filter(Boolean);
      /* Skip rows a file-hider has switched off: they take no space, so a
         heading parked in one would have no band to sit in. */
      const first = (list) => list.find((item) => item.el && item.el.style.display !== "none");
      /* Key order is list order: the first key's seam is the top one. */
      const firsts = {
        todo: first(todoItems),
        inbox: first(inboxItems),
        mind: first(mind),
        projects: first(borrowed),
      };
      plugin.sections.set(this, { todo: todoItems, mind, inbox: inboxItems, projects: borrowed });
      /* Every change at the root re-sorts the root, so the dock is redrawn
         here; it skips the work when nothing it shows has changed. */
      if (!space) plugin.renderDock(this);
      else plugin.renderMeter(this);
      plugin.placeHeadings(this, firsts);
      /* A folded section keeps only the row its heading rides in, so the
         virtualiser never builds or measures the rest. */
      const shown = (section, list) =>
        plugin.isCollapsed(section) ? (firsts[section] ? [firsts[section]] : []) : list;
      const list = shown("todo", todoItems).concat(shown("inbox", inboxItems), shown("mind", mind), shown("projects", borrowed));
      /* What the list holds, drawn or not, so a glide can tell a row that
         left from one only scrolled out of the drawn window. */
      plugin.listed.set(this, new Set(list.map((item) => item.el).filter(Boolean)));
      /* Today with nothing left says so. A pseudo-element on the list, since
         the virtualiser removes any element of the list it did not make. */
      if (!space) {
        const empty = !list.some((item) => item.el && item.el.style.display !== "none");
        this.navFileContainerEl?.toggleClass(EMPTY_CLASS, empty);
        this.navFileContainerEl?.setAttr("data-empty-text", EMPTY_TEXT);
      }
      return list;
    };

    proto.getSortedFolderItems = this.wrapper;
    this.resort();
  }

  restore() {
    if (!this.proto) return;
    if (this.proto.getSortedFolderItems === this.wrapper) this.proto.getSortedFolderItems = this.original;
    this.proto = null;
    this.original = null;
    this.wrapper = null;
  }

  /* Rebuild every list from the sorter. Folder lists first, so each project
     note is released by its folder before the root claims it; the root's
     sort comes last inside view.sort(). Then drop the cached heights, since
     the seam row's band changed behind the virtualiser's back. */
  resort() {
    for (const view of this.explorerViews()) {
      if (typeof view.requestSort === "function") view.requestSort();
      const scroll = view.tree && view.tree.infinityScroll;
      if (scroll && typeof scroll.invalidateAll === "function") scroll.invalidateAll();
    }
  }

  /* --- spaces --------------------------------------------------------------- */

  /* Today, then Later, left to right. None when spaces are off or the later
     folder does not exist. */
  spaces() {
    if (!this.settings.spaces || !this.folderAt(this.settings.laterFolder)) return [];
    const name = (folder, fallback) => (folder ? folder.name.charAt(0).toUpperCase() + folder.name.slice(1) : fallback);
    return [
      { name: name(this.folderAt(this.settings.sourceFolder), "Today"), later: false },
      { name: name(this.folderAt(this.settings.laterFolder), "Later"), later: true },
    ];
  }

  /* Each space is a real File Explorer. The pane's own lists Today; a
     second one, built on the same leaf, lists Later. The sorter tells them
     apart (spaceOf), so each is a whole live explorer: rows open, drag,
     rename and right-click, and it updates itself on every vault change.

     The two lists sit side by side in a horizontal scroller that snaps to
     each. That scroller is the whole gesture: the browser follows the
     fingers, carries the momentum and lands on a space, natively and off
     the main thread, as it would any snapping carousel. Nothing here runs
     while a swipe is under way; the plugin only reads where it landed. */
  mountAllSpaces() {
    const panes = this.paneViews();
    for (const view of [...this.stages.keys()]) if (!panes.includes(view)) this.unmountSpaces(view);
    for (const view of panes) this.mountSpaces(view);
  }

  async mountSpaces(view) {
    const want = this.spaces().length > 1;
    const mounted = this.stages.get(view);
    if (mounted && (!want || !mounted.wrap.isConnected)) this.unmountSpaces(view);
    if (!want || this.stages.has(view)) return;
    const list = view.navFileContainerEl;
    if (!list || !list.parentElement) return;
    /* Anything a previous load left in the pane goes first: the list comes
       back out of an old scroller, and old dots and Later panes leave. */
    const stale = view.containerEl.querySelector(":scope > ." + SPACES_WRAP_CLASS);
    if (stale) stale.replaceWith(list);
    view.containerEl.querySelectorAll(":scope > ." + SPACES_CLASS).forEach((el) => el.remove());

    /* The scroller holds a track two panes wide. The snap points are two
       still markers on the track, not the lists themselves, so anything
       drawn onto the lists cannot move where a swipe lands. */
    const wrap = createDiv({ cls: SPACES_WRAP_CLASS });
    const track = wrap.createDiv({ cls: SPACES_WRAP_CLASS + "-track" });
    track.createDiv({ cls: SPACES_WRAP_CLASS + "-stop" });
    track.createDiv({ cls: SPACES_WRAP_CLASS + "-stop" });
    list.before(wrap);
    track.appendChild(list);
    const later = new view.constructor(view.leaf);
    this.laterViews.add(later);
    /* A child of the plugin, so it unloads with the plugin whatever else
       happens on the way out. */
    this.addChild(later);
    later.sortOrder = view.sortOrder;
    this.stages.set(view, { wrap, later });
    /* open() mounts the explorer's own pane beside Today's list and loads
       it. The pane stays whole, toolbar hidden: the explorer answers clicks,
       drags and right-clicks on its rows from the pane, not from the list. */
    later.containerEl.addClass(LATER_CLASS);
    await later.open(track);
    const stage = this.stages.get(view);
    if (stage?.later !== later) return;
    later.requestSort();
    /* Later is no workspace pane, so nothing tells it when it gets a size.
       Built at no size, as on a phone, where the pane sits in a drawer that
       starts closed, its first sort lists nothing. So it re-sorts whenever
       its size changes, which also redraws the rows that now fit. */
    stage.resizer = new ResizeObserver(() => {
      if (later.navFileContainerEl.clientHeight) later.requestSort();
    });
    stage.resizer.observe(later.navFileContainerEl);
    wrap.scrollLeft = this.space * wrap.clientWidth;

    /* Where the scroller is, read only to light the dots. */
    const at = () => Math.round(wrap.scrollLeft / Math.max(1, wrap.clientWidth));
    this.registerDomEvent(wrap, "scroll", () => this.lightDots(view, at()), { passive: true });
    this.registerDomEvent(wrap, "scrollend", () => {
      this.space = at();
      this.renderSpaces(view);
    });
    this.guardDrawer(view, wrap);
    this.renderSpaces(view);
  }

  /* How full Later is: its notes against LATER_CAPACITY, as text over a
     thin bar, green to red as it fills. It sits in Later's pane above the
     list, never inside it, since the virtualiser owns the list's children. */
  renderMeter(later) {
    if (!this._loaded) return;
    const list = later.navFileContainerEl;
    const folder = this.folderAt(this.settings.laterFolder);
    if (!list?.parentElement || !folder) return;
    let meter = later.containerEl.querySelector(":scope > ." + METER_CLASS);
    if (!meter) {
      meter = createDiv({ cls: METER_CLASS });
      meter.createDiv({ cls: METER_CLASS + "-text" });
      meter.createDiv({ cls: METER_CLASS + "-bar" }).createDiv({ cls: METER_CLASS + "-fill" });
    }
    if (meter.nextElementSibling !== list) list.before(meter);
    let count = 0;
    const walk = (f) => f.children.forEach((c) => (c instanceof TFolder ? walk(c) : c.extension === "md" && count++));
    walk(folder);
    const pct = Math.round((count / LATER_CAPACITY) * 100);
    const level = pct >= 100 ? "full" : pct >= 75 ? "high" : pct >= 50 ? "mid" : "low";
    if (meter.dataset.key === pct + level) return;
    meter.dataset.key = pct + level;
    meter.dataset.level = level;
    meter.firstElementChild.setText(pct + "% full");
    meter.querySelector("." + METER_CLASS + "-fill").style.width = Math.min(pct, 100) + "%";
  }

  unmountSpaces(view) {
    const stage = this.stages.get(view);
    if (!stage) return;
    this.stages.delete(view);
    const { wrap, later, resizer } = stage;
    resizer?.disconnect();
    this.laterViews.delete(later);
    this.removeChild(later);
    later.containerEl.remove();
    if (wrap.contains(view.navFileContainerEl)) wrap.replaceWith(view.navFileContainerEl);
    else wrap.remove();
    this.spaceDots.get(view)?.remove();
    this.spaceDots.delete(view);
  }

  /* A dot, or a command: the scroller glides there, as a swipe would land. */
  switchSpace(to) {
    for (const view of this.paneViews()) {
      const wrap = this.stages.get(view)?.wrap;
      if (!wrap || to < 0 || to >= this.spaces().length) continue;
      wrap.scrollTo({ left: to * wrap.clientWidth, behavior: "smooth" });
    }
  }

  /* On a phone the pane sits in a drawer that a sideways swipe closes. A
     swipe the scroller can still take is the scroller's, so it stops here;
     one past the last space goes on to the drawer. */
  guardDrawer(view, wrap) {
    let start = null;
    this.registerDomEvent(wrap, "touchstart", (evt) => {
      const t = evt.touches[0];
      start = evt.touches.length === 1 ? { x: t.clientX, y: t.clientY, mine: null } : null;
    }, { passive: true });
    this.registerDomEvent(wrap, "touchmove", (evt) => {
      if (!start) return;
      const t = evt.touches[0];
      const dx = start.x - t.clientX;
      if (start.mine === null) {
        if (Math.abs(dx) < SWIPE_SLOP_PX && Math.abs(start.y - t.clientY) < SWIPE_SLOP_PX) return;
        const room = dx > 0 ? wrap.scrollLeft < wrap.scrollWidth - wrap.clientWidth - 1 : wrap.scrollLeft > 1;
        start.mine = Math.abs(dx) > Math.abs(start.y - t.clientY) && room;
      }
      if (start.mine) evt.stopPropagation();
    }, { passive: true });
  }

  lightDots(view, active) {
    this.spaceDots.get(view)?.querySelectorAll("." + SPACES_CLASS + "-dot").forEach((el, i) => el.toggleClass("is-active", i === active));
  }

  /* One dot per space at the very bottom of the pane; the filled one is
     showing. A dot is also a button to its space. */
  renderSpaces(view) {
    if (!this._loaded) return;
    const spaces = this.spaces();
    let dots = this.spaceDots.get(view);
    if (spaces.length < 2 || !this.stages.has(view)) {
      dots?.remove();
      this.spaceDots.delete(view);
      return;
    }
    if (!dots || dots.parentElement !== view.containerEl) {
      dots?.remove();
      dots = view.containerEl.createDiv({ cls: SPACES_CLASS });
      this.spaceDots.set(view, dots);
    } else if (dots !== view.containerEl.lastElementChild) {
      view.containerEl.appendChild(dots);
    }
    const key = [this.space, ...spaces.map((s) => s.name)].join("\n");
    if (dots.dataset.key === key) return;
    dots.dataset.key = key;
    dots.empty();
    spaces.forEach((space, i) => {
      const dot = dots.createEl("button", {
        cls: SPACES_CLASS + "-dot" + (i === this.space ? " is-active" : ""),
        attr: { "aria-label": space.name, "data-tooltip-position": "top" },
      });
      dot.addEventListener("click", (evt) => {
        evt.preventDefault();
        this.switchSpace(i);
      });
    });
  }

  /* --- the root dock -------------------------------------------------------- */

  /* The root's notes, in the explorer's order, minus what Hide Files hides.
     None when the root is the source folder: they are the mind already. */
  rootNotes(view) {
    if (this.spaceFolders()[0].isRoot()) return [];
    const hidden = this.app.plugins?.plugins?.["hide-files"]?.hidden;
    const compare = COMPARE[view.sortOrder] || COMPARE.alphabetical;
    return [...this.rootFiles]
      .filter((file) => !this.projects.has(file) && !(hidden && hidden.has(file.path)))
      .sort(compare);
  }

  renderDocks() {
    for (const view of this.paneViews()) this.renderDock(view);
  }

  /* A panel after the scrolling list, so it sits at the bottom of the pane
     whatever the list's length. Its rows are the plugin's own, not the
     virtualiser's, built with the explorer's classes so they look the same. */
  renderDock(view) {
    if (!this._loaded) return;
    this.renderSpaces(view);
    const files = this.rootNotes(view);
    let dock = this.docks.get(view);
    /* The first drawing of a pane is not a change, so it does not move. */
    const seen = this.dockSeen.has(view);
    this.dockSeen.add(view);
    const motion = seen && !this.folding && this.motion();
    /* A dock still fading out goes at once if a new one is needed. */
    this.leavingDocks.get(view)?.remove();
    this.leavingDocks.delete(view);
    if (!files.length) {
      this.docks.delete(view);
      if (!dock) return;
      if (!motion || !dock.isConnected) return dock.remove();
      /* The last note left: the whole panel fades, as a closing section. */
      this.leavingDocks.set(view, dock);
      const fade = dock.animate([{ opacity: 1 }, { opacity: 0, offset: 0.6 }, { opacity: 0 }], {
        duration: FOLD_MS,
        easing: "linear",
        fill: "forwards",
      });
      fade.finished.then(
        () => dock.remove(),
        () => {}
      );
      return;
    }
    const collapsed = this.isCollapsed("root");
    const key = [collapsed, this.settings.rootHeading, ...files.map((f) => f.path)].join("\n");
    if (dock && dock.isConnected && dock.parentElement === view.containerEl && dock.dataset.key === key) return;
    if (!dock || dock.parentElement !== view.containerEl) {
      dock?.remove();
      dock = createDiv({ cls: DOCK_CLASS });
      /* Above the space dots, which stay at the very bottom. */
      view.containerEl.insertBefore(dock, this.spaceDots.get(view)?.parentElement === view.containerEl ? this.spaceDots.get(view) : null);
      this.docks.set(view, dock);
    }
    /* The dock is rebuilt whole, so its rows are matched by path, and the
       heading by itself: it slides when the panel grows or shrinks. */
    const before = motion ? this.dockRects(dock) : null;
    for (const a of this.dockGlides.get(view) || []) a.cancel();
    dock.dataset.key = key;
    dock.empty();
    dock.toggleClass("is-collapsed", collapsed);
    const heading = this.headingFor(view, "root");
    dock.appendChild(heading);
    this.syncHeading(heading);
    if (!collapsed) {
      const list = dock.createDiv({ cls: DOCK_CLASS + "-list" });
      for (const file of files) this.dockRow(view, list, file);
      this.syncDockActive();
    }
    if (!before) return;
    const after = this.dockRects(dock);
    const gone = [...before].filter(([path]) => !after.has(path)).map(([, row]) => row);
    this.dockGlides.set(view, this.shift(before, after, gone, dock));
  }

  /* The dock's heading and rows, by path, with where they are. */
  dockRects(dock) {
    const rows = new Map();
    const heading = dock.querySelector(":scope > ." + HEADING_CLASS);
    if (heading) rows.set("", { el: heading, rect: heading.getBoundingClientRect() });
    dock.querySelectorAll("." + DOCK_CLASS + "-list > .tree-item").forEach((el) => {
      const path = el.querySelector(".nav-file-title")?.dataset.path;
      if (path) rows.set(path, { el, rect: el.getBoundingClientRect() });
    });
    return rows;
  }

  /* Opens, previews, drags and right-clicks like an explorer row. */
  dockRow(view, list, file) {
    const item = list.createDiv({ cls: "tree-item nav-file" });
    const self = item.createDiv({
      cls: "tree-item-self nav-file-title tappable is-clickable",
      attr: { "data-path": file.path, draggable: "true" },
    });
    self.createDiv({ cls: "tree-item-inner nav-file-title-content", text: file.extension === "md" ? file.basename : file.name });
    const workspace = this.app.workspace;
    const open = (evt, newTab) => {
      workspace.getLeaf(newTab || Keymap.isModEvent(evt)).openFile(file);
    };
    self.addEventListener("click", (evt) => open(evt, false));
    self.addEventListener("auxclick", (evt) => {
      if (evt.button === 1) open(evt, "tab");
    });
    self.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      const menu = new Menu();
      workspace.trigger("file-menu", menu, file, "file-explorer");
      menu.showAtMouseEvent(evt);
    });
    self.addEventListener("mouseover", (evt) => {
      workspace.trigger("hover-link", { event: evt, source: "file-explorer", hoverParent: view, targetEl: self, linktext: file.path });
    });
    self.addEventListener("dragstart", (evt) => {
      const drag = this.app.dragManager;
      if (drag && typeof drag.dragFile === "function") drag.onDragStart(evt, drag.dragFile(evt, file));
    });
  }

  syncDockActive() {
    const path = this.app.workspace.getActiveFile()?.path;
    document.querySelectorAll("." + DOCK_CLASS + " .nav-file-title").forEach((el) => {
      el.toggleClass("is-active", el.dataset.path === path);
    });
  }

  /* --- the headings -------------------------------------------------------- */

  /* firsts maps each section to the row its heading rides in, or nothing
     when the section is empty. */
  placeHeadings(view, firsts) {
    const rows = Object.values(firsts).filter(Boolean).map((item) => item.el);
    const seams = new Set(rows);
    /* The still copy mid-swipe keeps its own seams: it shows the other space. */
    (view.navFileContainerEl || view.containerEl).querySelectorAll("." + SEAM_CLASS).forEach((el) => {
      if (!seams.has(el)) el.classList.remove(SEAM_CLASS, TOP_SEAM_CLASS, FOLDED_CLASS);
    });
    rows.forEach((el, i) => el.classList.toggle(TOP_SEAM_CLASS, i === 0));
    for (const [section, first] of Object.entries(firsts)) {
      const heading = this.headingFor(view, section);
      if (!first) {
        heading.remove();
        continue;
      }
      first.el.classList.add(SEAM_CLASS);
      first.el.classList.toggle(FOLDED_CLASS, this.isCollapsed(section));
      if (first.el.firstChild !== heading) first.el.insertBefore(heading, first.el.firstChild);
      this.syncHeading(heading);
    }
  }

  /* The heading's note: a vault path, or a file name found anywhere in the
     vault. Looked up on every use, so renaming or moving it never strands
     the heading. */
  headingTarget(section = "projects") {
    const link = { projects: this.settings.headingLink, todo: this.settings.todoLink }[section];
    const want = (link || "").trim().replace(/^\/+/, "");
    if (!want) return null;
    const vault = this.app.vault;
    const exact = vault.getAbstractFileByPath(want);
    if (exact instanceof TFile) return exact;
    const named = vault.getFiles().find((f) => f.name === want);
    if (named) return named;
    return this.app.metadataCache.getFirstLinkpathDest(want, "");
  }

  /* Every heading is clickable now: a linked one opens its note, the rest
     fold their section. */
  syncHeading(heading) {
    const section = heading.dataset.section;
    const target = this.headingTarget(section);
    const active = this.app.workspace.getActiveFile();
    const collapsed = this.isCollapsed(section);
    heading.toggleClass("is-clickable", true);
    heading.toggleClass("is-active", !!target && active === target);
    heading.toggleClass("is-collapsed", collapsed);
    heading.setAttr("tabindex", "0");
    heading.setAttr("role", target ? "link" : "button");
    heading.setAttr("aria-expanded", target ? null : String(!collapsed));
  }

  syncHeadings() {
    document.querySelectorAll("." + HEADING_CLASS).forEach((el) => this.syncHeading(el));
  }

  /* Opens like a row: in place, or in a new tab with Cmd/Ctrl or the middle
     button, and focus goes to the note. */
  openHeadingTarget(evt, section) {
    const file = this.headingTarget(section);
    if (!file) return;
    const workspace = this.app.workspace;
    workspace.getLeaf(Keymap.isModEvent(evt)).openFile(file);
    workspace.setActiveLeaf(workspace.getMostRecentLeaf(), { focus: true });
  }

  /* The projects and todo headings link to a note; the others are labels. */
  headingFor(view, section) {
    let headings = this.headings.get(view);
    if (!headings) this.headings.set(view, (headings = new Map()));
    let heading = headings.get(section);
    if (!heading) {
      const text = { root: this.settings.rootHeading, todo: this.settings.todoHeading, mind: this.settings.mindHeading, inbox: this.settings.inboxHeading, projects: this.settings.heading }[section];
      heading = createDiv({ cls: HEADING_CLASS });
      heading.dataset.section = section;
      heading.createSpan({ cls: HEADING_CLASS + "-label", text });
      const chevron = heading.createDiv({ cls: HEADING_CLASS + "-chevron" });
      chevron.setAttr("aria-label", "Fold section");
      setIcon(chevron, "chevron-down");
      /* The chevron folds any section; a label without a note to open folds too. */
      const activate = (evt) => {
        if (evt.target instanceof Node && chevron.contains(evt.target)) this.toggleSection(section);
        else if (this.headingTarget(section)) this.openHeadingTarget(evt, section);
        else this.toggleSection(section);
      };
      /* It sits inside a note's row, and that row answers clicks, drags and
         right-clicks for the note, so every one of those stops here. A click
         (or a middle click, or Enter) opens the heading's own note. */
      for (const type of ["click", "auxclick", "contextmenu", "mousedown"]) {
        heading.addEventListener(type, (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          if (type === "click" && evt.button === 0) activate(evt);
          else if (type === "auxclick" && evt.button === 1) this.openHeadingTarget(evt, section);
        });
      }
      heading.addEventListener("keydown", (evt) => {
        if (evt.key !== "Enter" && evt.key !== " ") return;
        evt.preventDefault();
        evt.stopPropagation();
        /* Enter acts like a click on the label; Space always folds. */
        if (evt.key === "Enter") activate(evt);
        else this.toggleSection(section);
      });
      headings.set(section, heading);
    }
    return heading;
  }
};

class FolderDrawerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Project tag")
      .setDesc("Notes carrying this value, or one nested under it, are listed under the heading. With or without the #.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.projectTag)
          .setValue(this.plugin.settings.projectTag)
          .onChange(async (value) => {
            this.plugin.settings.projectTag = normalize(value) || DEFAULT_SETTINGS.projectTag;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Project property")
      .setDesc("The frontmatter list to look in for the project tag. Leave empty to use the note's tags.")
      .addText((text) =>
        text
          .setPlaceholder("tags")
          .setValue(this.plugin.settings.projectProperty)
          .onChange(async (value) => {
            this.plugin.settings.projectProperty = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Projects heading")
      .setDesc("The heading above the projects.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.heading)
          .setValue(this.plugin.settings.heading)
          .onChange(async (value) => {
            this.plugin.settings.heading = value.trim() || DEFAULT_SETTINGS.heading;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Source folder")
      .setDesc("The folder whose notes are listed under the mind and inbox headings. Leave empty for the vault root.")
      .addText((text) =>
        text
          .setPlaceholder("today")
          .setValue(this.plugin.settings.sourceFolder)
          .onChange(async (value) => {
            this.plugin.settings.sourceFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Inbox values")
      .setDesc("Source-folder notes whose project property (or tags) holds one of these, separated by commas, are listed under the inbox heading.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.inboxValues.join(", "))
          .setValue(this.plugin.settings.inboxValues.join(", "))
          .onChange(async (value) => {
            this.plugin.settings.inboxValues = value.split(",").map(normalize).filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Todo values")
      .setDesc("Source-folder notes whose project property (or tags) holds one of these, separated by commas, are listed under the todo heading.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.todoValues.join(", "))
          .setValue(this.plugin.settings.todoValues.join(", "))
          .onChange(async (value) => {
            this.plugin.settings.todoValues = value.split(",").map(normalize).filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Move todos")
      .setDesc("Move each todo note by its do date: today or earlier into the source folder, later into the later folder. Only notes at the root or in those two folders move; one whose date is cleared goes back to the root.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.moveTodos).onChange(async (value) => {
          this.plugin.settings.moveTodos = value;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.placeTodos();
        })
      );

    new Setting(containerEl)
      .setName("Spaces")
      .setDesc("Swipe sideways over the pane, with two fingers or one, to switch between the source folder (Today) and the later folder (Later).")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.spaces).onChange(async (value) => {
          this.plugin.settings.spaces = value;
          if (!value) this.plugin.space = 0;
          await this.plugin.saveSettings();
        })
      );

    for (const [key, name, desc] of [
      ["doDateProperty", "Do date property", "The frontmatter date that decides where a todo goes."],
      ["laterFolder", "Later folder", "Where todos with a future do date go."],
    ]) {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) =>
          text
            .setPlaceholder(DEFAULT_SETTINGS[key])
            .setValue(this.plugin.settings[key])
            .onChange(async (value) => {
              this.plugin.settings[key] = value.trim() || DEFAULT_SETTINGS[key];
              await this.plugin.saveSettings();
              this.plugin.placeTodos();
            })
        );
    }

    new Setting(containerEl)
      .setName("Todo heading link")
      .setDesc("The note the todo heading opens: a file name or a vault path. Leave empty for a plain heading.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.todoLink)
          .setValue(this.plugin.settings.todoLink)
          .onChange(async (value) => {
            this.plugin.settings.todoLink = value.trim();
            await this.plugin.saveData(this.plugin.settings);
            this.plugin.syncHeadings();
          })
      );

    for (const [key, name, desc] of [
      ["todoHeading", "Todo heading", "The heading above the todo notes."],
      ["mindHeading", "Mind heading", "The heading above the source folder's notes."],
      ["inboxHeading", "Inbox heading", "The heading above the inbox notes."],
      ["rootHeading", "Root heading", "The heading above the vault root's notes, when the source folder is another one."],
    ]) {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) =>
          text
            .setPlaceholder(DEFAULT_SETTINGS[key])
            .setValue(this.plugin.settings[key])
            .onChange(async (value) => {
              this.plugin.settings[key] = value.trim() || DEFAULT_SETTINGS[key];
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName("Heading link")
      .setDesc("The note the heading opens: a file name (found anywhere in the vault) or a vault path. Leave empty for a plain heading.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.headingLink)
          .setValue(this.plugin.settings.headingLink)
          .onChange(async (value) => {
            this.plugin.settings.headingLink = value.trim();
            await this.plugin.saveData(this.plugin.settings);
            this.plugin.syncHeadings();
          })
      );
  }
}

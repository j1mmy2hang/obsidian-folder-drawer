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
 * With Move todos on, a todo note files itself by its do date: today or
 * earlier into the source folder, later into the later folder. Only notes
 * at the root or already in one of those two are moved, so an archived todo
 * stays archived. The note open in the active tab moves once another opens.
 *
 * Spaces, as in Arc: the source folder is Today, the later folder is Later,
 * and a two-finger horizontal swipe over the pane (or a finger swipe on a
 * touchscreen) slides from one to the other. Each space fills the same
 * headings from its own folder; Projects belong to Today, the inbox dock to
 * both. Dots at the bottom of the pane show which space is showing.
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
/* The dots at the bottom of the pane, one per space. */
const SPACES_CLASS = "folder-drawer-spaces";
const FOLD_MS = 260;
/* The still copy of the panel being swiped away. */
const GHOST_CLASS = "folder-drawer-ghost";
/* Both panels while the strip is open. */
const STRIP_CLASS = "folder-drawer-strip";
/* The spring that lands the strip: how long it takes to settle, in
   seconds, and 1 for no bounce, as a paging scroll view lands. */
const SPRING_RESPONSE = 0.4;
const SPRING_DAMPING = 1;
/* How far ahead a lift's speed is projected to choose where to land: a
   quick flick reaches the next space, a slow push lands on the nearer one. */
const PROJECT_MS = 180;
/* How hard the strip resists past either end, as iOS does. */
const RUBBER = 0.55;
/* No wheel event for this long: the fingers stopped or lifted. */
const WHEEL_GAP_MS = 90;
/* How long the strip stays open after landing, for a swipe straight back. */
const STRIP_LINGER_MS = 900;
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
    /* The space showing: 0 is Today. Every launch starts there. */
    this.space = 0;
    /* The space the list is sorted for: the showing one, except mid-swipe,
       when the list is already the neighbour sliding in. */
    this.listing = 0;
    /* Each space's scroll position, so coming back lands where it left. */
    this.spaceScroll = [];
    this.swipeViews = new WeakSet();
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
    const rescan = debounce(() => this.rescan(), 200, true);
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
    this.registerEvent(this.app.metadataCache.on("changed", now));
    this.registerEvent(this.app.metadataCache.on("resolved", rescan));
    this.registerEvent(this.app.vault.on("create", now));
    this.registerEvent(this.app.vault.on("delete", now));
    this.registerEvent(this.app.vault.on("rename", now));

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
    document.body.classList.remove(ACTIVE_CLASS);
    this.clearFold();
    document.querySelectorAll("." + HEADING_CLASS).forEach((el) => el.remove());
    document.querySelectorAll("." + DOCK_CLASS).forEach((el) => el.remove());
    document.querySelectorAll("." + SPACES_CLASS).forEach((el) => el.remove());
    document.querySelectorAll("." + SEAM_CLASS).forEach((el) => el.classList.remove(SEAM_CLASS, TOP_SEAM_CLASS, FOLDED_CLASS));
    if (this.strip) {
      cancelAnimationFrame(this.strip.frame);
      clearTimeout(this.strip.closer);
      this.strip.el.style.transform = "";
      this.strip.el.removeClass(STRIP_CLASS);
      this.strip = null;
    }
    document.querySelectorAll("." + GHOST_CLASS).forEach((el) => el.remove());
    this.space = this.listing = 0;
    this.restore();
    this.resort();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.headings = new WeakMap();
    document.querySelectorAll("." + HEADING_CLASS).forEach((el) => el.remove());
    document.querySelectorAll("." + DOCK_CLASS).forEach((el) => el.remove());
    this.rescan(true);
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
    /* The dock is outside the virtualised list: nothing to slide past. */
    if (section === "root") {
      this.settings.collapsed = this.isCollapsed(section)
        ? this.settings.collapsed.filter((s) => s !== section)
        : this.settings.collapsed.concat(section);
      this.saveData(this.settings);
      this.renderDocks();
      return;
    }
    if (this.folding) return;
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
     the redraw lands, each row that moved starts from its old place and
     slides home, and a new one fades in. Old places are measured with any
     glide still running, so a sort mid-glide carries on from where the rows
     are. */
  glide(view) {
    if (this.folding || this.switching || this.glideFrame?.has(view)) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const before = this.rowTops(view);
    if (!before.size) return;
    this.glideFrame = this.glideFrame || new Set();
    this.glideFrame.add(view);
    requestAnimationFrame(() => {
      this.glideFrame.delete(view);
      if (this.folding || this.switching) return;
      for (const a of this.glides || []) a.cancel();
      const after = this.rowTops(view);
      const animations = [];
      for (const [path, { el, top }] of after) {
        const was = before.get(path);
        if (!was) {
          animations.push(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FOLD_MS, easing: "linear" }));
        } else if (Math.abs(was.top - top) > 0.5) {
          animations.push(
            el.animate([{ transform: `translateY(${was.top - top}px)` }, { transform: "none" }], {
              duration: FOLD_MS,
              easing: FOLD_EASING,
            })
          );
        }
      }
      this.glides = animations;
      if (!animations.length) return;
      /* The virtualiser measures rows; let it measure them at rest. */
      Promise.all(animations.map((a) => a.finished)).then(
        () => view.tree?.infinityScroll?.invalidateAll?.(),
        () => {}
      );
    });
  }

  /* Each drawn note row's top, by path. */
  rowTops(view) {
    const tops = new Map();
    view.containerEl.querySelectorAll(".nav-files-container .tree-item.nav-file").forEach((el) => {
      const path = el.querySelector(":scope > .nav-file-title")?.dataset.path;
      if (path && el.offsetParent) tops.set(path, { el, top: el.getBoundingClientRect().top });
    });
    return tops;
  }

  clearFold() {
    for (const a of this.foldAnimations || []) a.cancel();
    this.foldAnimations = [];
    document.querySelectorAll("." + FOLDING_CLASS).forEach((el) => el.classList.remove(FOLDING_CLASS, "is-staged"));
  }

  /* --- which notes are projects ---------------------------------------- */

  /* The folder the mind and inbox notes come from: the listed space's. */
  sourceFolder() {
    return this.spaceFolders()[this.listing] || this.spaceFolders()[0];
  }

  /* Today's folder (the source folder, the root when unset) and, with
     spaces on, Later's. */
  spaceFolders() {
    const today = this.folderAt(this.settings.sourceFolder) || this.app.vault.getRoot();
    return this.spaces().length > 1 ? [today, this.folderAt(this.settings.laterFolder)] : [today];
  }

  /* The listed space's sections. Both spaces are filed in every scan, so
     switching the list to the other one needs a sort and nothing more. */
  get todo() {
    return this.bySpace[this.listing]?.todo || new Set();
  }
  get inbox() {
    return this.bySpace[this.listing]?.inbox || new Set();
  }
  get loose() {
    return this.bySpace[this.listing]?.loose || new Set();
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
    const same = (a, b) => a.size === b.size && [...b].every((f) => a.has(f));
    const before = this.allSets();
    this.scan();
    this.placeTodos();
    const after = this.allSets();
    if (force || before.length !== after.length || before.some((set, i) => !same(set, after[i]))) this.resort();
    this.renderDocks();
  }

  /* --- filing todos by do date -------------------------------------------- */

  folderAt(path) {
    const clean = (path || "").trim().replace(/^\/+|\/+$/g, "");
    const folder = clean && this.app.vault.getAbstractFileByPath(clean);
    return folder instanceof TFolder ? folder : null;
  }

  /* Each todo at the root, in the source folder or in the later folder goes
     where its do date says. A note without a full date (or with a template's
     placeholder) stays put, and so does one whose name is taken there. */
  placeTodos(only) {
    this.day = moment().format("YYYY-MM-DD");
    if (!this.settings.moveTodos) return false;
    const now = this.folderAt(this.settings.sourceFolder);
    const later = this.folderAt(this.settings.laterFolder);
    if (!now || !later) return false;
    const root = this.app.vault.getRoot();
    const todoWant = new Set(this.settings.todoValues.map(normalize).filter(Boolean));
    const key = this.settings.projectProperty.trim();
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
      if (file === active || this.moving.has(file)) continue;
      const meta = cache.getFileCache(file);
      if (!meta || !meta.frontmatter) continue;
      const values = (key ? [].concat(meta.frontmatter[key] ?? []) : getAllTags(meta) || [])
        .filter((v) => typeof v === "string")
        .map(normalize);
      if (!values.some((v) => todoWant.has(v))) continue;
      const date = String(meta.frontmatter[this.settings.doDateProperty] ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}(?![\d])/.test(date)) continue;
      const target = date.slice(0, 10) <= this.day ? now : later;
      if (file.parent === target) continue;
      const path = normalizePath(target.path + "/" + file.name);
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
    for (const view of this.explorerViews()) this.attachSwipe(view);
  }

  explorerViews() {
    return this.app.workspace
      .getLeavesOfType("file-explorer")
      .filter((leaf) => !leaf.isDeferred)
      .map((leaf) => leaf.view)
      .filter((view) => view && view.containerEl && view.fileItems);
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
      const { projects, inbox, todo } = plugin;

      const source = plugin.sourceFolder();
      if (!folder || !folder.isRoot()) {
        /* The source folder's notes are listed at the root instead. */
        if (folder === source) return items.filter((item) => !(item && item.file instanceof TFile));
        return items.filter((item) => !(item && projects.has(item.file)));
      }

      plugin.glide(this);
      plugin.attachSwipe(this);
      const sourceItems = source.isRoot() ? items : original.call(this, source);
      const loose = sourceItems.filter((item) => item && item.file instanceof TFile && !projects.has(item.file));
      const todoItems = loose.filter((item) => todo.has(item.file));
      const mind = loose.filter((item) => !inbox.has(item.file) && !todo.has(item.file));
      const inboxItems = loose.filter((item) => inbox.has(item.file));
      const compare = COMPARE[this.sortOrder] || COMPARE.alphabetical;
      /* Projects are what is in progress now: they belong to Today. */
      const borrowed = (plugin.listing ? [] : [...projects])
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
      plugin.renderDock(this);
      plugin.placeHeadings(this, firsts);
      /* A folded section keeps only the row its heading rides in, so the
         virtualiser never builds or measures the rest. */
      const shown = (section, list) =>
        plugin.isCollapsed(section) ? (firsts[section] ? [firsts[section]] : []) : list;
      return shown("todo", todoItems).concat(shown("inbox", inboxItems), shown("mind", mind), shown("projects", borrowed));
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
     folder does not exist: nothing to swipe to. */
  spaces() {
    if (!this.settings.spaces || !this.folderAt(this.settings.laterFolder)) return [];
    const name = (folder, fallback) => (folder ? folder.name.charAt(0).toUpperCase() + folder.name.slice(1) : fallback);
    return [
      { name: name(this.folderAt(this.settings.sourceFolder), "Today"), later: false },
      { name: name(this.folderAt(this.settings.laterFolder), "Later"), later: true },
    ];
  }

  /* The scrolling list, which is what slides. The dock and the dots stay. */
  listEl(view) {
    return view.containerEl.querySelector(":scope .nav-files-container:not(." + GHOST_CLASS + ")");
  }

  /* Lists the given space's notes, without saying it is the one showing. */
  list(space) {
    this.listing = space;
    this.sortNow();
    for (const view of this.explorerViews()) view.tree?.infinityScroll?.invalidateAll?.();
  }

  /* --- the strip -----------------------------------------------------------

     The spaces are panels on one horizontal strip, Later to the right of
     Today, and the strip has exactly one position, `pos`: the pixel offset
     of the viewport along it, so Today shows at 0 and Later at one pane's
     width. One thing moves it at a time. While fingers are on it, they do,
     one to one. When they lift, a spring does, starting at the fingers'
     speed and aiming where that speed was carrying the strip. Touching again
     takes the strip from the spring wherever it is: nothing ever waits for
     an animation to end. Past either end the strip rubber-bands.

     The virtualiser holds one list, so the strip is two panels for as long
     as it is open: a still copy of the space it started on (the real list's
     rows, cloned where they stand) and the real list, sorted into the other
     space and laid beside it. Opening costs one sort, at the first pixel of
     movement. Once the strip rests on the real list, the copy waits a moment
     off screen, so swiping straight back is free; resting on the copy, the
     real list is sorted back behind it and the copy leaves the next frame,
     unseen because it looked exactly like what replaced it. */

  openStrip(view) {
    const open = this.strip;
    if (open) {
      if (open.view !== view) return null;
      clearTimeout(open.closer);
      open.spring = null;
      return open;
    }
    if (this.folding || this.spaces().length < 2) return null;
    const el = this.listEl(view);
    if (!el) return null;
    const from = this.space;
    const other = from ? from - 1 : from + 1;
    const ghost = el.cloneNode(true);
    ghost.classList.add(GHOST_CLASS);
    ghost.setAttr("aria-hidden", "true");
    /* Inline, because the virtualiser writes its own inline position onto
       the list, and the copy carries that over. */
    Object.assign(ghost.style, {
      position: "absolute",
      top: el.offsetTop + "px",
      left: el.offsetLeft + "px",
      width: el.offsetWidth + "px",
      height: el.offsetHeight + "px",
    });
    el.after(ghost);
    ghost.scrollTop = el.scrollTop;
    this.spaceScroll[from] = el.scrollTop;
    this.switching = true;
    this.list(other);
    el.scrollTop = this.spaceScroll[other] || 0;
    el.addClass(STRIP_CLASS);
    ghost.addClass(STRIP_CLASS);
    const width = el.offsetWidth || 1;
    this.strip = { view, el, ghost, from, other, width, pos: from * width, vel: 0, at: 0, spring: null, frame: 0, dot: from };
    this.paint();
    return this.strip;
  }

  /* Where the strip shows pos: as is between the ends, and past them
     resisting more the further it goes, as iOS does (c = 0.55). */
  shown(strip) {
    const max = (this.spaces().length - 1) * strip.width;
    const band = (over) => (1 - 1 / ((over * RUBBER) / strip.width + 1)) * strip.width;
    if (strip.pos < 0) return -band(-strip.pos);
    if (strip.pos > max) return max + band(strip.pos - max);
    return strip.pos;
  }

  paint() {
    const strip = this.strip;
    if (!strip) return;
    const x = this.shown(strip);
    strip.ghost.style.transform = `translate3d(${strip.from * strip.width - x}px, 0, 0)`;
    strip.el.style.transform = `translate3d(${strip.other * strip.width - x}px, 0, 0)`;
    /* The dot follows the strip, not the landing. */
    const dot = Math.max(0, Math.min(this.spaces().length - 1, Math.round(x / strip.width)));
    if (dot !== strip.dot) {
      strip.dot = dot;
      this.spaceDots.get(strip.view)?.querySelectorAll("." + SPACES_CLASS + "-dot").forEach((el, i) => el.toggleClass("is-active", i === dot));
    }
  }

  frame() {
    const strip = this.strip;
    if (strip && !strip.frame) strip.frame = requestAnimationFrame((t) => this.step(t));
  }

  step(now) {
    const strip = this.strip;
    if (!strip) return;
    strip.frame = 0;
    const spring = strip.spring;
    if (spring) {
      /* Small fixed steps, so a dropped frame cannot make it overshoot. */
      let left = Math.min(0.064, Math.max(0, (now - spring.last) / 1000));
      spring.last = now;
      const k = Math.pow((2 * Math.PI) / SPRING_RESPONSE, 2);
      const c = (4 * Math.PI * SPRING_DAMPING) / SPRING_RESPONSE;
      while (left > 0) {
        const dt = Math.min(left, 1 / 240);
        spring.v += (-k * (strip.pos - spring.to) - c * spring.v) * dt;
        strip.pos += spring.v * dt;
        left -= dt;
      }
      if (Math.abs(strip.pos - spring.to) < 0.5 && Math.abs(spring.v) < 30) {
        strip.pos = spring.to;
        strip.spring = null;
        this.paint();
        this.settle();
        return;
      }
      this.frame();
    }
    this.paint();
  }

  /* Fingers moved the strip by dx (positive: towards Later). */
  drag(strip, dx, time) {
    strip.spring = null;
    strip.pos += dx;
    const dt = Math.max(4, Math.min(64, time - (strip.at || time - 16)));
    strip.vel = strip.at && time - strip.at < 100 ? strip.vel * 0.4 + (dx / dt) * 0.6 : dx / dt;
    strip.at = time;
    this.frame();
  }

  /* Fingers lifted, moving at vel px/ms: the spring takes the strip where
     that speed was carrying it, one space at most. */
  release(strip, vel = strip.vel) {
    const count = this.spaces().length;
    const start = Math.round(strip.pos / strip.width);
    const aim = Math.round((strip.pos + vel * PROJECT_MS) / strip.width);
    const to = Math.max(0, Math.min(count - 1, Math.max(start - 1, Math.min(start + 1, aim))));
    this.springTo(strip, to, vel * 1000);
  }

  springTo(strip, space, v = 0) {
    strip.spring = { to: space * strip.width, v, last: performance.now() };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) strip.pos = strip.spring.to;
    this.frame();
  }

  /* At rest on a space. On the real list: that space is showing now, and the
     strip stays open a moment for a swipe straight back. On the copy: close
     at once, since a copy takes no clicks. */
  settle() {
    const strip = this.strip;
    const landed = Math.round(strip.pos / strip.width);
    if (landed === strip.other) {
      this.space = landed;
      this.renderSpaces(strip.view);
      strip.closer = window.setTimeout(() => this.closeStrip(), STRIP_LINGER_MS);
    } else {
      this.closeStrip();
    }
  }

  closeStrip() {
    const strip = this.strip;
    if (!strip) return;
    this.strip = null;
    cancelAnimationFrame(strip.frame);
    clearTimeout(strip.closer);
    const landed = Math.max(0, Math.min(this.spaces().length - 1, Math.round(strip.pos / strip.width)));
    strip.el.style.transform = "";
    strip.el.removeClass(STRIP_CLASS);
    this.space = landed;
    if (landed === strip.other) {
      strip.ghost.remove();
    } else {
      this.spaceScroll[strip.other] = strip.el.scrollTop;
      this.list(landed);
      strip.el.scrollTop = this.spaceScroll[landed] || 0;
      /* One more frame of the copy, covering the list while it redraws. */
      requestAnimationFrame(() => strip.ghost.remove());
    }
    this.switching = false;
    this.renderSpaces(strip.view);
  }

  /* A dot, or a command: the same spring, with no fingers on it. */
  switchSpace(to) {
    const view = this.explorerViews()[0];
    if (!view || to < 0 || to >= this.spaces().length) return;
    if (to === this.space && !this.strip) return;
    const strip = this.openStrip(view);
    if (strip) this.springTo(strip, to);
  }

  /* --- the trackpad ---------------------------------------------------------

     A two-finger swipe arrives as wheel events with deltaX. After the
     fingers lift, macOS keeps sending them as momentum, and no event says
     which is which. Momentum gives itself away by shape: each delta smaller
     than the last, smoothly. So while tracking, a run of shrinking deltas
     well below the swipe's peak means the fingers have lifted, and the
     spring takes over at the speed they had. While the spring runs, the
     momentum that keeps arriving is swallowed, until a delta grows instead
     of shrinking, or turns around: fingers are back on the trackpad, and
     they take the strip wherever it is. A swipe that starts vertical stays a
     scroll. */
  onWheel(view, evt) {
    if (evt.ctrlKey) return;
    const scale = evt.deltaMode === 1 ? 16 : evt.deltaMode === 2 ? view.containerEl.offsetWidth : 1;
    const dx = evt.deltaX * scale;
    const dy = evt.deltaY * scale;
    const size = Math.abs(dx);
    let wheel = this.wheel;
    if (wheel && evt.timeStamp - wheel.last > WHEEL_GAP_MS) wheel = this.wheel = null;

    if (wheel && wheel.view === view && wheel.phase === "coast") {
      const grows = size > wheel.prev * 1.25 + 1.5;
      const turns = dx && Math.sign(dx) !== wheel.sign && size >= 2;
      if (!grows && !turns) {
        if (size >= Math.abs(dy)) evt.preventDefault();
        if (dx) wheel.prev = size;
        wheel.last = evt.timeStamp;
        this.armWheel(wheel);
        return;
      }
      wheel = this.wheel = null;
    }

    if (!wheel) {
      if (size <= Math.abs(dy)) return;
      const strip = this.openStrip(view);
      if (!strip) return;
      wheel = this.wheel = { view, strip, phase: "track", recent: [], peak: 0, prev: 0, sign: Math.sign(dx), last: 0 };
    }
    if (wheel.view !== view) return;
    evt.preventDefault();
    wheel.last = evt.timeStamp;
    const strip = this.strip;
    if (!strip) {
      this.wheel = null;
      return;
    }
    this.drag(strip, dx, evt.timeStamp);
    if (dx) {
      wheel.sign = Math.sign(dx);
      wheel.recent.push(size);
      if (wheel.recent.length > 4) wheel.recent.shift();
      wheel.peak = Math.max(wheel.peak * 0.97, size);
      wheel.prev = size;
    }
    const r = wheel.recent;
    const shrinking = r.length === 4 && r[0] > r[1] && r[1] > r[2] && r[2] > r[3];
    if (shrinking && size < wheel.peak * 0.6) {
      wheel.phase = "coast";
      this.release(strip);
    }
    this.armWheel(wheel);
  }

  /* No event for a while: the fingers stopped, or lifted with no momentum.
     A finger at rest has no speed, so the strip settles where it is nearer. */
  armWheel(wheel) {
    clearTimeout(wheel.timer);
    wheel.timer = window.setTimeout(() => {
      if (this.wheel !== wheel) return;
      this.wheel = null;
      if (wheel.phase === "track" && this.strip && !this.strip.spring) this.release(this.strip, 0);
    }, WHEEL_GAP_MS);
  }

  /* --- the touchscreen ------------------------------------------------------

     The same strip under one finger. A touch that lands on a moving strip
     holds it; if the touch turns out to be a tap or a scroll, the strip is
     let go again. Once a swipe reads as sideways it is the plugin's, so the
     drawer the pane sits in on a phone does not also close under it. */
  onTouch(view, evt) {
    const touch = evt.touches[0] || evt.changedTouches[0];
    if (evt.type === "touchstart") {
      if (evt.touches.length !== 1) return (this.touch = null);
      const held = this.strip && this.strip.view === view && this.strip.spring ? this.openStrip(view) : null;
      this.touch = { view, x: touch.clientX, y: touch.clientY, held, claimed: false };
      return;
    }
    const t = this.touch;
    if (!t || t.view !== view) return;
    const letGo = () => {
      this.touch = null;
      if (t.held && this.strip === t.held && !t.held.spring) this.release(t.held, 0);
    };
    if (evt.type === "touchmove") {
      if (!t.claimed) {
        const dx = t.x - touch.clientX;
        const dy = t.y - touch.clientY;
        if (Math.abs(dx) < SWIPE_SLOP_PX && Math.abs(dy) < SWIPE_SLOP_PX) return;
        if (Math.abs(dx) <= Math.abs(dy) || !this.openStrip(view)) return letGo();
        t.claimed = true;
        t.x = touch.clientX;
      }
      evt.stopPropagation();
      if (evt.cancelable) evt.preventDefault();
      if (this.strip) this.drag(this.strip, t.x - touch.clientX, evt.timeStamp);
      t.x = touch.clientX;
      return;
    }
    /* touchend, touchcancel */
    if (!t.claimed) return letGo();
    this.touch = null;
    evt.stopPropagation();
    const strip = this.strip;
    if (!strip) return;
    /* A finger that stopped before lifting has no speed left. */
    const stale = evt.timeStamp - strip.at > 60;
    this.release(strip, evt.type === "touchcancel" || stale ? 0 : strip.vel);
  }

  /* Each explorer listens once, for as long as the plugin is loaded. */
  attachSwipe(view) {
    if (this.swipeViews.has(view)) return;
    this.swipeViews.add(view);
    const el = view.containerEl;
    this.registerDomEvent(el, "wheel", (evt) => this.onWheel(view, evt), { passive: false });
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      this.registerDomEvent(el, type, (evt) => this.onTouch(view, evt), { passive: type !== "touchmove" });
    }
  }

  /* One dot per space at the very bottom of the pane; the filled one is
     showing. A dot is also a button to its space. */
  renderSpaces(view) {
    const spaces = this.spaces();
    let dots = this.spaceDots.get(view);
    if (spaces.length < 2) {
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
    const active = this.strip && this.strip.view === view ? this.strip.dot : this.space;
    const key = [active, ...spaces.map((s) => s.name)].join("\n");
    if (dots.dataset.key === key) return;
    dots.dataset.key = key;
    dots.empty();
    spaces.forEach((space, i) => {
      const dot = dots.createEl("button", {
        cls: SPACES_CLASS + "-dot" + (i === active ? " is-active" : ""),
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
    for (const view of this.explorerViews()) this.renderDock(view);
  }

  /* A panel after the scrolling list, so it sits at the bottom of the pane
     whatever the list's length. Its rows are the plugin's own, not the
     virtualiser's, built with the explorer's classes so they look the same. */
  renderDock(view) {
    this.renderSpaces(view);
    const files = this.rootNotes(view);
    let dock = this.docks.get(view);
    if (!files.length) {
      dock?.remove();
      this.docks.delete(view);
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
    dock.dataset.key = key;
    dock.empty();
    dock.toggleClass("is-collapsed", collapsed);
    const heading = this.headingFor(view, "root");
    dock.appendChild(heading);
    this.syncHeading(heading);
    if (collapsed) return;
    const list = dock.createDiv({ cls: DOCK_CLASS + "-list" });
    for (const file of files) this.dockRow(view, list, file);
    this.syncDockActive();
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
    view.containerEl.querySelectorAll("." + SEAM_CLASS).forEach((el) => {
      if (!seams.has(el) && !el.closest("." + GHOST_CLASS)) el.classList.remove(SEAM_CLASS, TOP_SEAM_CLASS, FOLDED_CLASS);
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
            await this.plugin.saveData(this.plugin.settings);
            this.plugin.rescan(true);
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
      .setDesc("Move each todo note by its do date: today or earlier into the source folder, later into the later folder. Only notes at the root or in those two folders move.")
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
          if (!value) this.plugin.space = this.plugin.listing = 0;
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
              await this.plugin.saveData(this.plugin.settings);
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

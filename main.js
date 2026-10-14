"use strict";

/*
 * Folder Drawer
 *
 * Turns the core File Explorer into three lists:
 *
 *   MIND      — the notes at the vault root: what just arrived, not sorted yet
 *   INBOX     — root notes that came from outside (clippings, the daily vocab,
 *               the weekly letter), by a value in their `descriptive` list
 *   PROJECTS  — every note tagged #project/in-progress, wherever it lives in
 *               the vault
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
 * orders every section). For the root it returns the mind notes, the inbox
 * notes, then the project notes, which are real explorer items borrowed from their folders.
 * Each folder's own list drops its project notes, so no item is claimed by two
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

const { Plugin, PluginSettingTab, Setting, TFile, Keymap, getAllTags, debounce, setIcon } = require("obsidian");

const ACTIVE_CLASS = "folder-drawer-active";
const HEADING_CLASS = "folder-drawer-heading";
const SEAM_CLASS = "folder-drawer-seam";
/* The seam of the first section in the list: nothing above it to keep apart. */
const TOP_SEAM_CLASS = "folder-drawer-seam-top";
/* The seam of a folded section: the row keeps its band, its own content hides. */
const FOLDED_CLASS = "folder-drawer-folded";
/* A row, or a seam row's own content, while a fold animates it. */
const FOLDING_CLASS = "folder-drawer-folding";
const FOLD_MS = 260;
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
  mindHeading: "Mind",
  /* Sections folded under their heading. */
  collapsed: [],
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
    this.inbox = new Set();

    document.body.classList.add(ACTIVE_CLASS);
    this.addSettingTab(new FolderDrawerSettingTab(this.app, this));

    /* Plugins load before the workspace is built, so the explorer's prototype
       is only reachable after layout-ready. active-leaf-change is for the
       phone, where the explorer sits in a drawer that starts closed and its
       leaf stays deferred until opened. */
    this.app.workspace.onLayoutReady(() => {
      this.scan();
      this.refresh();
    });
    this.registerEvent(this.app.workspace.on("layout-change", () => this.refresh()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refresh()));

    /* Tagging a note or taking the tag off is a metadata change, not a vault
       one, so the explorer would never re-sort by itself. Only re-sort when
       the set of projects actually changed. */
    const rescan = debounce(() => this.rescan(), 200, true);
    this.registerEvent(this.app.metadataCache.on("changed", rescan));
    this.registerEvent(this.app.metadataCache.on("resolved", rescan));
    this.registerEvent(this.app.vault.on("delete", rescan));
    this.registerEvent(this.app.vault.on("rename", rescan));

    /* The heading lights up while its note is the one open, as a row does. */
    this.registerEvent(this.app.workspace.on("file-open", () => this.syncHeadings()));
    this.registerEvent(this.app.vault.on("rename", () => this.syncHeadings()));
  }

  onunload() {
    document.body.classList.remove(ACTIVE_CLASS);
    this.clearFold();
    document.querySelectorAll("." + HEADING_CLASS).forEach((el) => el.remove());
    document.querySelectorAll("." + SEAM_CLASS).forEach((el) => el.classList.remove(SEAM_CLASS, TOP_SEAM_CLASS, FOLDED_CLASS));
    this.restore();
    this.resort();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.headings = new WeakMap();
    document.querySelectorAll("." + HEADING_CLASS).forEach((el) => el.remove());
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
    if (this.folding) return;
    this.folding = true;
    const closing = !this.isCollapsed(section);
    const motion = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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

  clearFold() {
    for (const a of this.foldAnimations || []) a.cancel();
    this.foldAnimations = [];
    document.querySelectorAll("." + FOLDING_CLASS).forEach((el) => el.classList.remove(FOLDING_CLASS, "is-staged"));
  }

  /* --- which notes are projects ---------------------------------------- */

  /* Projects anywhere in the vault; inbox notes at the root only. */
  scan() {
    const want = normalize(this.settings.projectTag);
    const inboxWant = new Set(this.settings.inboxValues.map(normalize).filter(Boolean));
    const projects = new Set();
    const inbox = new Set();
    const key = this.settings.projectProperty.trim();
    const cache = this.app.metadataCache;
    for (const file of this.app.vault.getMarkdownFiles()) {
      const meta = cache.getFileCache(file);
      if (!meta) continue;
      const values = (key ? [].concat(meta.frontmatter?.[key] ?? []) : getAllTags(meta) || [])
        .filter((v) => typeof v === "string")
        .map(normalize);
      if (want && values.some((v) => v === want || v.startsWith(want + "/"))) projects.add(file);
      else if (file.parent?.isRoot() && values.some((v) => inboxWant.has(v))) inbox.add(file);
    }
    this.projects = projects;
    this.inbox = inbox;
  }

  rescan(force = false) {
    const same = (a, b) => a.size === b.size && [...b].every((f) => a.has(f));
    const before = [this.projects, this.inbox];
    this.scan();
    if (force || !same(before[0], this.projects) || !same(before[1], this.inbox)) this.resort();
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
      const { projects, inbox } = plugin;

      if (!folder || !folder.isRoot()) {
        return items.filter((item) => !(item && projects.has(item.file)));
      }

      const loose = items.filter((item) => item && item.file instanceof TFile && !projects.has(item.file));
      const mind = loose.filter((item) => !inbox.has(item.file));
      const inboxItems = loose.filter((item) => inbox.has(item.file));
      const compare = COMPARE[this.sortOrder] || COMPARE.alphabetical;
      const borrowed = [...projects]
        .sort(compare)
        .map((file) => this.fileItems[file.path])
        .filter(Boolean);
      /* Skip rows a file-hider has switched off: they take no space, so a
         heading parked in one would have no band to sit in. */
      const first = (list) => list.find((item) => item.el && item.el.style.display !== "none");
      const firsts = { mind: first(mind), inbox: first(inboxItems), projects: first(borrowed) };
      plugin.sections.set(this, { mind, inbox: inboxItems, projects: borrowed });
      plugin.placeHeadings(this, firsts);
      /* A folded section keeps only the row its heading rides in, so the
         virtualiser never builds or measures the rest. */
      const shown = (section, list) =>
        plugin.isCollapsed(section) ? (firsts[section] ? [firsts[section]] : []) : list;
      return shown("mind", mind).concat(shown("inbox", inboxItems), shown("projects", borrowed));
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

  /* --- the headings -------------------------------------------------------- */

  /* firsts maps each section to the row its heading rides in, or nothing
     when the section is empty. */
  placeHeadings(view, firsts) {
    const rows = Object.values(firsts).filter(Boolean).map((item) => item.el);
    const seams = new Set(rows);
    view.containerEl.querySelectorAll("." + SEAM_CLASS).forEach((el) => {
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
    if (section !== "projects") return null;
    const want = (this.settings.headingLink || "").trim().replace(/^\/+/, "");
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

  /* Only the projects heading links to a note; the others are labels. */
  headingFor(view, section) {
    let headings = this.headings.get(view);
    if (!headings) this.headings.set(view, (headings = new Map()));
    let heading = headings.get(section);
    if (!heading) {
      const text = { mind: this.settings.mindHeading, inbox: this.settings.inboxHeading, projects: this.settings.heading }[section];
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
      .setName("Inbox values")
      .setDesc("Root notes whose project property (or tags) holds one of these, separated by commas, are listed under the inbox heading.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.inboxValues.join(", "))
          .setValue(this.plugin.settings.inboxValues.join(", "))
          .onChange(async (value) => {
            this.plugin.settings.inboxValues = value.split(",").map(normalize).filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    for (const [key, name, desc] of [
      ["mindHeading", "Mind heading", "The heading above the root notes."],
      ["inboxHeading", "Inbox heading", "The heading above the inbox notes."],
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

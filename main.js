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
 * The File Explorer, its virtualiser and its sorter are the same code on iOS
 * and Android, so the two mechanisms above hold as they are. One thing about
 * the phone is not cosmetic, though, and it breaks the first of them:
 *
 *   **The File Explorer may not exist yet when this plugin looks for it.**
 *   Obsidian defers a sidebar leaf's view until the leaf is shown, and on a
 *   phone the explorer lives in a drawer that starts closed. The leaf is
 *   there, `leaf.view` answers to the right view type — and it is a
 *   placeholder with no getSortedFolderItems to wrap. Desktop never meets
 *   this because its sidebar is open at startup. loadExplorers below asks
 *   for the real view instead of waiting to be handed one.
 *
 * The rest is hardware, handled where it belongs:
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

const { Plugin, setIcon, Platform } = require("obsidian");

const ACTIVE_CLASS = "folder-drawer-active";
const OPEN_CLASS = "folder-drawer-open";
const ANIM_CLASS = "folder-drawer-animating";
const HEADER_CLASS = "folder-drawer-header";
const SEAM_CLASS = "folder-drawer-seam";
const LABEL = "Folders";
const ANIM_MS = 340;

/* --- the rubber band ---------------------------------------------------
   Chromium does not bounce an inner scroller. Only the page itself does on
   macOS, so the File Explorer hits its ends with a thud while every native
   list on the machine gives a little.

   The behaviour below is atomiks/elastic-scroll-polyfill (MIT), including its
   tuning. It is worth knowing why that library is shaped the way it is, since
   the obvious approach is a different one: rather than follow the gesture and
   resist it — accumulating a pull, damping it through Apple's curve, holding
   it until the wheel goes quiet — it fires exactly one impulse at the moment
   of impact and lets two CSS transitions carry the rest. Out fast, back slow.

   That buys a great deal. It never calls preventDefault, so the scroller's
   own behaviour is never taken away and handed back; it needs no idle timer
   to guess when a trackpad gesture ended; and it cannot get stuck holding an
   offset, because every transform it sets is already on its way back before
   the next event arrives.

   Its one trick is the guard below: if scrollTop has not moved since the last
   wheel event, there is nothing to bounce about. That single line covers both
   "you are already resting against the edge" and "this list does not scroll
   at all", which is otherwise two checks.

   Chromium ships this natively in 145. When Obsidian's Electron catches up,
   this whole section stops running on its own. */
const ELASTIC_EASING = "cubic-bezier(.23, 1, .32, 1)";
const ELASTIC_OUT_MS = 90;
const ELASTIC_BACK_MS = 750;
const ELASTIC_INTENSITY = 0.8;

/* How long the wheel must go quiet before the edge will give again. One push
   is one bounce, however many events the push is made of: a trackpad flick
   arrives as a burst at roughly 60Hz and macOS keeps sending decaying deltas
   after the fingers lift, so anything shorter than the gaps inside a gesture
   would fire repeatedly through a single shove and read as a rattle. */
const ELASTIC_REARM_MS = 150;
const ELASTIC_NATIVE_CHROME = 145;

const chromeVersion = () => {
  const m = /Chrome\/(\d+)/.exec(navigator.userAgent);
  return m ? parseInt(m[1], 10) : 0;
};

/* Duck-typed, like the sort below: the items hold TFile/TFolder, and only a
   folder carries children. */
const isFolderItem = (item) => !!(item && item.file && Array.isArray(item.file.children));

module.exports = class FolderDrawerPlugin extends Plugin {
  async onload() {
    const saved = await this.loadData();
    this.open = !!(saved && saved.open);
    this.headers = new WeakMap();
    this.banded = new WeakSet();
    this.bandReleases = [];

    document.body.classList.add(ACTIVE_CLASS);
    document.body.classList.toggle(OPEN_CLASS, this.open);

    /* All of these wait for the layout. On a cold start plugins load before
       the workspace is built, so there is no File Explorer leaf yet and no
       prototype to patch — doing it here would silently do nothing and leave
       the folders on top. The events retry it for explorers that appear or
       load later, and patchSort is a no-op once it has taken.

       active-leaf-change is in the list for the phone: opening the drawer
       there is not always a layout change, but it does change which leaf is
       active, so it is the event that fires when the File Explorer finally
       arrives. */
    this.app.workspace.onLayoutReady(() => this.refresh());
    this.registerEvent(this.app.workspace.on("layout-change", () => this.refresh()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refresh()));

    this.addCommand({
      id: "toggle",
      name: "Toggle folder drawer",
      callback: () => this.setOpen(!this.open),
    });
  }

  onunload() {
    window.clearTimeout(this.animTimer);
    this.releaseBands();
    /* registerDomEvent takes the listeners away; the inline styles they wrote
       are ours to clear. */
    document.querySelectorAll(".nav-files-container > *").forEach((el) => {
      el.style.transform = "";
      el.style.transition = "";
    });
    document.body.classList.remove(ACTIVE_CLASS, OPEN_CLASS, ANIM_CLASS);
    document.querySelectorAll("." + HEADER_CLASS).forEach((el) => el.remove());
    document.querySelectorAll("." + SEAM_CLASS).forEach((el) => el.classList.remove(SEAM_CLASS));
    this.restoreSort();
    this.resort();
    this.remeasure();
  }

  /* Nothing here can run against a view that has not been built yet, so
     resolving the deferred ones comes first. See loadExplorers. */
  async refresh() {
    try {
      await this.loadExplorers();
    } catch (e) {
      /* A leaf that refuses to load is not worth failing the rest over: the
         next event tries again. */
    }
    this.patchSort();
    this.mountAll();
    this.attachBands();
  }

  /* Obsidian does not build a sidebar leaf's view until the leaf is actually
     shown — it parks a placeholder there instead, and `leaf.view` is that
     placeholder, not a FileExplorerView. The placeholder carries no
     getSortedFolderItems, so patchSort finds nothing to wrap.

     On the desktop this never came up: the sidebar is open at startup, so the
     explorer is real by the time layout-ready fires. On a phone the File
     Explorer lives in a drawer that starts *closed*, so the leaf is deferred,
     the sort is never patched, and the folders sit on top of the notes —
     which is the whole thing this plugin exists to undo.

     So ask for the real view rather than waiting to be handed one. It costs
     building the file tree at startup, which the desktop does anyway, and it
     is the one view this plugin has any business loading. Guarded by typeof
     for Obsidian builds older than deferred views, where the question does
     not arise. */
  async loadExplorers() {
    const deferred = this.app.workspace
      .getLeavesOfType("file-explorer")
      .filter((leaf) => leaf.isDeferred && typeof leaf.loadIfDeferred === "function");

    if (deferred.length) await Promise.all(deferred.map((leaf) => leaf.loadIfDeferred()));
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

  /* Deferred leaves are filtered out rather than mapped over: their view is a
     placeholder that answers to the same view type and has a containerEl, so
     it passes every duck-type below while carrying none of the machinery this
     plugin reaches for. */
  explorerViews() {
    return this.app.workspace
      .getLeavesOfType("file-explorer")
      .filter((leaf) => !leaf.isDeferred)
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

    /* The scroller is about to change height under any held offset. */
    this.releaseBands();

    this.open = open;
    document.body.classList.toggle(OPEN_CLASS, open);
    document.querySelectorAll("." + HEADER_CLASS).forEach((el) => this.syncHeader(el));
    await this.saveData({ open });
  }

  /* --- the rubber band --------------------------------------------------

     Chromium does not rubber-band an inner scroller. Only the page itself
     bounces on macOS; an overflow:auto div stops dead, which is why the File
     Explorer hits its ends with a thud while every native list on the machine
     gives a little. iOS has it for free — WebKit bounces inner scrollers — so
     none of this runs there.

     What follows is the effect, not a reimplementation of scrolling. The
     scroller keeps doing its own job the entire time; this only takes over
     the wheel once there is no scrolling left to do in that direction, and
     hands it straight back the moment there is.

     Why a transform is safe here, when so little else is: the tree is
     virtualised and its cached row heights are measured as the distance from
     one row's top to the next. Translating the whole content by the same
     number leaves every one of those distances exactly as it was, and touches
     neither scrollTop nor layout — so the model cannot drift. A per-row
     transform, or anything that changed heights, would be a different story.

     Bound per scroller rather than per view because that is the element that
     both scrolls and gets replaced; the WeakSet keeps a rebuilt explorer from
     collecting a second listener. */
  attachBands() {
    /* Three reasons not to run, all of them "something better already
       happens here":

       iOS and Android bounce an inner scroller natively — that is the whole
       reason this is desktop-only. Chromium ships the same thing for inner
       scrollers in 145, so on a new enough build the browser does it properly
       and an imitation on top would fight it; Obsidian is on 142 today, and
       this retires itself the moment its Electron catches up. And elastic
       scrolling is an Apple idiom: Windows and Linux do not do it anywhere
       else in the system, so doing it here would read as a bug, not a
       flourish. The polyfill makes the same call with appleDevicesOnly. */
    if (Platform.isMobile) return;
    if (Platform.isMacOS === false) return;
    if (chromeVersion() >= ELASTIC_NATIVE_CHROME) return;

    for (const view of this.explorerViews()) {
      const scroll = view.containerEl.querySelector(".nav-files-container");
      if (scroll && !this.banded.has(scroll)) {
        this.banded.add(scroll);
        this.bindBand(scroll);
      }
    }
  }

  bindBand(scroll) {
    /* The polyfill moves a wrapper it inserts around the scroller's contents.
       Here the transform goes on the children that are already there, because
       a new element between .nav-files-container and its child would land in
       the middle of this plugin's own selectors — the drawer collapses folders
       through `.nav-files-container > div > .tree-item.nav-folder`, and an
       extra div pushes every one of those a level out of reach. Moving the
       existing children reaches the same pixels and rearranges nothing.

       It is also the safer of the two against the virtualiser: cached row
       heights are measured as the distance from one row's top to the next, and
       translating everything by the same number leaves every one of those
       distances exactly as it was. */
    const sheets = () => Array.from(scroll.children);

    let applied = 0;
    let transitioning = false;
    let timer = 0;
    let idle = 0;
    let armed = true;

    /* The breathing room styles.css adds at the two ends is padding, and
       padding counts towards scrollHeight — so a list that fits its pane can
       still report a few pixels of scroll that exist only because of it.
       Subtracting it back out is the difference between "this list scrolls"
       and "this list was given somewhere to rest". Cached against the pane's
       height rather than read per event: a wheel arrives up to a hundred times
       a second, and getComputedStyle would flush style each time. */
    let slackAt = -1;
    let slack = 0;
    const slackNow = () => {
      if (slackAt !== scroll.clientHeight) {
        const cs = getComputedStyle(scroll);
        slack = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        slackAt = scroll.clientHeight;
      }
      return slack;
    };

    const move = (px, ms) => {
      applied = px;
      for (const el of sheets()) {
        el.style.transition = `transform ${ms}ms ${ELASTIC_EASING}`;
        el.style.transform = `translate3d(0, ${px}px, 0)`;
      }
    };

    const settle = () => {
      window.clearTimeout(timer);
      armed = true;
      applied = 0;
      transitioning = false;
      for (const el of sheets()) {
        el.style.transition = "none";
        el.style.transform = "";
      }
    };

    this.bandReleases.push(settle);

    /* The polyfill hands the two phases off with transitionend. That is the
       precise way to do it and it is also the fragile way: a transitionend
       that never arrives leaves the list sitting off its own edge with no
       second event coming to put it back. It does not arrive if the transform
       resolves to the value it already had, if the pane is hidden partway
       through, or — measured here, which is how this was found — when two
       impulses land inside one task and the style never gets recalculated
       between them. The durations are ours, so time them rather than listen
       for them: the worst a missed frame costs then is a slightly early snap,
       instead of a list that never comes home. */
    const bounce = (px) => {
      transitioning = true;
      move(px, ELASTIC_OUT_MS);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        move(0, ELASTIC_BACK_MS);
        timer = window.setTimeout(() => {
          applied = 0;
          transitioning = false;
        }, ELASTIC_BACK_MS);
      }, ELASTIC_OUT_MS);
    };

    this.registerDomEvent(
      scroll,
      "wheel",
      (evt) => {
        const top = scroll.scrollTop;

        /* A pixel of tolerance, and it is load-bearing. The polyfill tests the
           bottom as `scrollTop + offsetHeight >= scrollHeight`, exactly, which
           is right until the content lands on a fraction: the browser rounds
           scrollHeight up to a whole number while scrollTop clamps to the real
           maximum, so the two never meet. Measured here — scrollHeight 756,
           clientHeight 495, scrollTop pinned at 260.5 — the sum comes to 755.5
           and the bottom edge simply never registers. */
        const atTop = top <= 1;
        const atBottom = top >= scroll.scrollHeight - scroll.clientHeight - 1;

        /* Every event, edge or not, counts as the gesture still going. */
        window.clearTimeout(idle);
        idle = window.setTimeout(() => {
          armed = true;
        }, ELASTIC_REARM_MS);

        /* Away from both ends: the list is moving under its own power, and a
           leftover offset would ride along with it. */
        if (!atTop && !atBottom) {
          if (applied) settle();
          return;
        }

        /* A list that only "scrolls" by the width of its own breathing room is
           a list that fits, and nothing is holding it back to bounce against. */
        if (scroll.scrollHeight - scroll.clientHeight <= slackNow() + 1) return;

        /* The polyfill gates on scrollTop having moved since the last event,
           which means it bounces when you *arrive* at the edge and then never
           again — once you are resting there scrollTop stops changing, so every
           further push is swallowed. Pushing against an edge that is already
           against you is exactly when a rubber band should give, so the gate
           here is the gesture instead: one bounce per push, and the next push
           gets another. */
        if (!armed || transitioning) return;
        armed = false;
        bounce(ELASTIC_INTENSITY * -evt.deltaY);
      },
      { passive: true }
    );
  }

  /* Snap every band home. Called when the drawer toggles, because that
     changes the scroller's height underneath a held offset. */
  releaseBands() {
    for (const release of this.bandReleases) release();
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

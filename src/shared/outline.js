'use strict';

/*
 * PDF outline (bookmark) tree arithmetic, shared by bookmarks.js and
 * unit-tested in Node.
 *
 * A PDF outline is a TREE, not a list: every entry may have children, and a
 * drawing set received from someone else can carry a real nested structure with
 * meaningful titles. So the tree itself is the model held in state — entries
 * that arrived with the file are carried through untouched, and the only nodes
 * this app ever adds or removes are its own, marked with `mine`. Nothing here
 * can damage a foreign entry, because nothing here rewrites one.
 *
 * A normalized node is { title, page, mine, items }. `page` is 1-based, or null
 * when the destination could not be resolved — those are kept so saving does
 * not drop them, and skipped when listing.
 *
 * Dual export → { flattenOutline, ... } in Node, or the same names on App in
 * the browser.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.App = root.App || {}; Object.assign(root.App, factory()); }
})(typeof self !== 'undefined' ? self : this, function () {
  // Title given to entries this app creates. Sheet numbers cannot be reliably
  // extracted from a drawing, so the page number is the honest default.
  function defaultTitle(page) { return 'Page ' + page; }

  function nodesOf(tree) { return Array.isArray(tree) ? tree : []; }

  // Depth-first walk into flat rows for the shelf. Unresolvable entries are
  // skipped for display — they cannot be navigated to — but remain in the tree.
  function flattenOutline(tree, depth) {
    const out = [];
    const d = depth || 0;
    for (const n of nodesOf(tree)) {
      if (!n) continue;
      if (typeof n.page === 'number' && n.page > 0) {
        out.push({ title: String(n.title || ''), page: n.page, mine: !!n.mine, depth: d });
      }
      if (n.items && n.items.length) out.push.apply(out, flattenOutline(n.items, d + 1));
    }
    return out;
  }

  // Total entries, including nested ones — what /Count needs.
  function countOutline(tree) {
    let n = 0;
    for (const node of nodesOf(tree)) {
      if (!node) continue;
      n += 1 + countOutline(node.items);
    }
    return n;
  }

  // Does THIS app have a bookmark on the page?
  //
  // Deliberately ours only, not "any entry pointing here". The button toggles
  // our bookmark, so lighting it for a foreign entry would mean a press either
  // deletes someone else's bookmark or silently adds a duplicate. A foreign
  // bookmark still shows in the shelf; it is simply not ours to toggle.
  function hasOurBookmark(tree, page) {
    return nodesOf(tree).some((n) => n && n.mine && n.page === page);
  }

  // Add or remove our bookmark for a page, returning a NEW tree. Foreign
  // entries are passed through by reference — never rebuilt, so they cannot be
  // altered. Ours are kept in page order at the top level, so the shelf reads in
  // document order without a sort at display time.
  function toggleBookmark(tree, page, title) {
    const nodes = nodesOf(tree);
    if (!(page > 0)) return nodes.slice();
    if (hasOurBookmark(nodes, page)) {
      return nodes.filter((n) => !(n && n.mine && n.page === page));
    }
    const entry = {
      title: title || defaultTitle(page),
      page: page,
      mine: true,
      items: []
    };
    // Insert before the first of OUR entries that sits after this page; foreign
    // entries keep their original relative position.
    const out = nodes.slice();
    let at = out.length;
    for (let i = 0; i < out.length; i++) {
      const n = out[i];
      if (n && n.mine && typeof n.page === 'number' && n.page > page) { at = i; break; }
    }
    out.splice(at, 0, entry);
    return out;
  }

  // Pages this app has bookmarked, ascending. For tests and for the shelf's
  // "n bookmarks" summary.
  function ourPages(tree) {
    return nodesOf(tree)
      .filter((n) => n && n.mine && typeof n.page === 'number')
      .map((n) => n.page)
      .sort((a, b) => a - b);
  }

  return { flattenOutline, countOutline, hasOurBookmark, toggleBookmark, ourPages, defaultTitle };
});

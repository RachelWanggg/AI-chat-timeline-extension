import { JSDOM } from "jsdom";

/**
 * Build a document from an HTML fragment and expose the globals that the
 * content-script modules read (`document`, `Node`, `CSS`).
 *
 * Returns a teardown function that restores the previous globals, so suites
 * that install a document do not leak it into unrelated tests.
 */
export function withDocument(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  const previous = {
    document: globalThis.document,
    Node: globalThis.Node,
    CSS: globalThis.CSS,
  };

  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  globalThis.CSS = dom.window.CSS;

  return {
    window: dom.window,
    document: dom.window.document,
    restore() {
      globalThis.document = previous.document;
      globalThis.Node = previous.Node;
      globalThis.CSS = previous.CSS;
      dom.window.close();
    },
  };
}

/** Create a detached element from an HTML fragment, without touching globals. */
export function makeElement(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  return dom.window.document.body.firstElementChild;
}

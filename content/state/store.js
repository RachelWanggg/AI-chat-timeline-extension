/**
 * Store: centralized state container with pub/sub.
 * Does NOT perform DOM operations and does NOT call extension APIs.
 */
export function createStore(initialState = {}) {
  let state = { ...initialState };
  const listeners = new Set();

  function getState() {
    return state;
  }

  function setState(patch) {
    state = { ...state, ...(patch || {}) };
    listeners.forEach((fn) => fn(state));
    return state;
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { getState, setState, subscribe };
}

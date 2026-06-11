import "@testing-library/jest-dom/vitest";

// vitest's jsdom global proxy leaves window.localStorage undefined, which
// crashes zustand's persist middleware on every set(). Install an in-memory
// stand-in so persisted stores behave like they do in a real browser.
if (typeof window !== "undefined" && !window.localStorage) {
  const store = new Map<string, string>();
  const shim: Storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, String(value)),
    removeItem: (key) => void store.delete(key),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(window, "localStorage", {
    value: shim,
    configurable: true,
  });
}

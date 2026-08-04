// Jest manual mock for the `webextension-polyfill` package.
//
// tests/setup.ts already stubs a promise-based `chrome` global whose shape
// matches what source code expects from `browser.*` (storage/runtime/tabs/etc.
// all return native Promises, mirroring Chrome's MV3 API surface). The real
// polyfill wraps a genuine Chrome's callback-based APIs by appending its own
// callback and waiting for the underlying implementation to invoke it — our
// test mocks are plain `async` functions that ignore any extra callback
// argument, so letting the real polyfill wrap them causes it to hang forever
// waiting on a callback that never fires. Re-exporting the stubbed `chrome`
// global sidesteps that entirely: it's already the right shape.
//
// This must be a live Proxy, not a captured reference: some tests replace
// `global.chrome` wholesale mid-test (e.g. `(global as any).chrome = {...}`)
// to inject a per-test mock. A plain `const chromeGlobal = globalThis.chrome`
// would freeze in whatever `chrome` was at module-evaluation time (i.e. the
// setup.ts stub), silently ignoring any later reassignment.
const browserProxy = new Proxy(
  {},
  {
    get(_target, prop) {
      const chromeGlobal = (globalThis as unknown as { chrome: Record<string | symbol, unknown> }).chrome;
      return chromeGlobal?.[prop];
    },
  },
);

export default browserProxy;

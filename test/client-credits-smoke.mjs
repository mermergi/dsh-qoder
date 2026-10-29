// Offline smoke test for the browser half of @local/dsh-plugin-qoder.
//
// There is no browser (and no React package) in this repository, so the test:
//   1. captures the lazy-CJS registration the client bundle posts to
//      `window.__ModuleLoader__`;
//   2. builds it with a shim `require` (react, react-dom, jsx-runtime, and a
//      marker-object stub for @deepseek-ai/dsh-client-ui-primitives);
//   3. runs `apply()` against a stub client context to inspect the two slot
//      registrations, the zh/en dictionaries, and the settings-form projection;
//   4. drives the real CreditsChip component through a tiny hooks harness with
//      a stubbed `fetch`, covering the 404 (no route) and known-session paths,
//      the visibility-gated poll, and the popover rows.
//
// The Host route contract exercised here is `/qoder/credits?sessionId=...` v1.
import assert from "node:assert/strict";

const registrations = [];
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration);
    }
  }
};

/** Document-level visibility listeners installed by the chip (and removed on unmount). */
const visibilityListeners = new Set();
/** Keydown listeners installed while the popover is open. */
const keydownListeners = new Set();
globalThis.document = {
  baseURI: "http://127.0.0.1:3080/",
  body: { appendChild() {} },
  visibilityState: "visible",
  addEventListener(name, listener) {
    if (name === "visibilitychange") visibilityListeners.add(listener);
    if (name === "keydown") keydownListeners.add(listener);
  },
  removeEventListener(name, listener) {
    if (name === "visibilitychange") visibilityListeners.delete(listener);
    if (name === "keydown") keydownListeners.delete(listener);
  },
  createElement: () => ({ style: {}, setAttribute() {}, select() {}, remove() {} })
};
if (!globalThis.navigator) globalThis.navigator = {};

const bundleUrl = new URL("../client.js", import.meta.url);
await import(bundleUrl.href);
assert.equal(registrations.length, 1, `expected one registration, got ${registrations.length}`);
const registration = registrations[0];
assert.equal(registration.id, "@local/dsh-plugin-qoder");
console.log("module id:", registration.id);

//#region shim require
/** Element-tree JSX runtime stub: components are plain functions of their props. */
const jsxRuntimeStub = {
  jsx: (type, props) => ({ type, props: props ?? {} }),
  jsxs: (type, props) => ({ type, props: props ?? {} }),
  Fragment: Symbol("Fragment")
};

/** react-dom stub: the popover's portal is identity here (there is no document). */
const reactDomStub = {
  createPortal: (node) => node
};

/** Base React surface: enough for apply() and the settings card (which uses no hooks). */
const baseReactStub = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } };
  },
  Fragment: Symbol("Fragment")
};

/** Minimal stand-in for the real SettingsFormModel used by QoderCardController. */
const formModelInstances = [];
class SettingsFormModelStub {
  constructor(scope, specs, secrets) {
    this.scope = scope;
    this.specs = specs;
    this.secrets = secrets;
    this.project = undefined;
    this.listeners = new Set();
    formModelInstances.push(this);
  }
  bind(project) {
    this.project = project;
    return {
      getSnapshot: () => this.project(),
      subscribe: (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      set: () => {}
    };
  }
  shell() {
    return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false };
  }
  field() {
    return { text: "", overridden: false, invalid: false };
  }
  actions() {
    return { edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {} };
  }
  dispose() {}
}

/** Marker-object primitives: the serializer understands these as plain elements. */
const primitivesStub = {
  SettingsFormModel: SettingsFormModelStub,
  settingsTextField: (field) => ({
    field,
    format: (value) => (value === undefined || value === null ? "" : String(value)),
    parse: (text) => (text === "" ? { kind: "clear" } : { kind: "set", value: text })
  }),
  SettingsForm: (props) => ({ type: "SettingsForm", props }),
  SettingsSecretField: (props) => ({ type: "SettingsSecretField", props }),
  SettingsValueField: (props) => ({ type: "SettingsValueField", props }),
  Tooltip: (props) => ({ type: "Tooltip", props }),
  IconGaugeOutlineRegular: (props) => ({ type: "IconGauge", props: props ?? {} }),
  IconSparkleRegular: (props) => ({ type: "IconSparkle", props: props ?? {} }),
  useAnchoredPosition: () => null,
  useDismissOnOutsidePointer: () => {}
};

/**
 * Build one module instance against a specific React implementation.
 * @param reactImplementation - `react` export surface for this build.
 * @returns the module exports.
 */
function buildModule(reactImplementation) {
  return registration.factory((specifier) => {
    if (specifier === "react") return reactImplementation;
    if (specifier === "react-dom") return reactDomStub;
    if (specifier === "react/jsx-runtime") return jsxRuntimeStub;
    if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
    throw new Error(`unexpected require: ${specifier}`);
  });
}
//#endregion

//#region tiny hooks harness
/**
 * React-hook surface for driving one function component: state cells, refs, and
 * effect descriptors are indexed by call order, as React does per component.
 * @returns the implementation plus per-render bookkeeping.
 */
function createHooksReact() {
  const states = [];
  const refs = [];
  const effects = [];
  let cursor = 0;
  return {
    effects,
    beginRender() {
      cursor = 0;
      effects.length = 0;
    },
    implementation: {
      useState(initial) {
        const slot = cursor++;
        if (!(slot in states)) states[slot] = typeof initial === "function" ? initial() : initial;
        return [states[slot], (next) => {
          states[slot] = typeof next === "function" ? next(states[slot]) : next;
        }];
      },
      useRef(initial) {
        const slot = cursor++;
        if (!(slot in refs)) refs[slot] = { current: initial };
        return refs[slot];
      },
      useEffect(fn, deps) {
        effects.push({ slot: cursor++, fn, deps });
      },
      useMemo(factory) {
        cursor += 1;
        return factory();
      },
      useCallback(fn) {
        cursor += 1;
        return fn;
      },
      createElement(type, props, ...children) {
        return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } };
      },
      Fragment: Symbol("Fragment")
    }
  };
}

/** Deep equality for effect dependency arrays; absent deps always re-run. */
function sameDeps(left, right) {
  if (left === undefined || right === undefined) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
}

/**
 * Mount one function component against the hooks harness.
 * @param component - the function component to render.
 * @param props - its props.
 * @param hooks - the hook implementation the module's `react` was built with.
 * @returns render/update/unmount accessors.
 */
function mountComponent(component, props, hooks) {
  const committed = new Map();
  let tree = null;
  const renderOnce = () => {
    hooks.beginRender();
    tree = component(props);
  };
  const runEffects = () => {
    for (const effect of hooks.effects) {
      const previous = committed.get(effect.slot);
      if (previous !== undefined && sameDeps(previous.deps, effect.deps)) continue;
      if (previous !== undefined && previous.cleanup !== undefined) previous.cleanup();
      const cleanup = effect.fn();
      committed.set(effect.slot, { deps: effect.deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
    }
  };
  renderOnce();
  runEffects();
  return {
    tree: () => tree,
    html: () => serialize(tree),
    update() {
      renderOnce();
      runEffects();
    },
    unmount() {
      for (const entry of committed.values()) if (entry.cleanup !== undefined) entry.cleanup();
      committed.clear();
    }
  };
}

/** Serialize a marker tree, invoking function components like React would. */
function serialize(node) {
  if (node === null || node === undefined || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(serialize).join("");
  const { type, props } = node;
  if (typeof type === "function") return serialize(type(props));
  const attributes = [];
  for (const [name, value] of Object.entries(props)) {
    if (name === "children") continue;
    if (typeof value === "function" || value === undefined || value === null || value === false) continue;
    if (name === "style" && typeof value === "object") {
      attributes.push(`style="${Object.entries(value).map(([key, item]) => `${key}:${item}`).join(";")}"`);
      continue;
    }
    attributes.push(value === true ? name : `${name}="${String(value)}"`);
  }
  return `<${String(type)}${attributes.length > 0 ? ` ${attributes.join(" ")}` : ""}>${serialize(props.children)}</${String(type)}>`;
}

/** Collect marker nodes matching a predicate, descending through props.children. */
function findNodes(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) findNodes(child, predicate, found);
    return found;
  }
  if (predicate(node)) found.push(node);
  findNodes(node.props?.children, predicate, found);
  return found;
}

/** Flush pending promise continuations (fetch -> json -> setState). */
function flush(times = 4) {
  return new Promise((resolve) => {
    let remaining = times;
    const step = () => {
      if (remaining === 0) {
        resolve();
        return;
      }
      remaining -= 1;
      setImmediate(step);
    };
    step();
  });
}
//#endregion

//#region locale dictionaries
let zhDictionary = {};
let enDictionary = {};
/** Interpolate `{name}` placeholders exactly like the locale runtime. */
function makeT(dictionary) {
  return (key, values) => {
    const template = dictionary[key] ?? key;
    if (values === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match));
  };
}
/** Apply-time reader: resolves the dictionary once `apply()` registered it. */
const t = (key, values) => makeT(zhDictionary)(key, values);
//#endregion

//#region apply() against a stub client context
const slots = [];
const localeRegistrations = [];
const edits = [];
const resets = [];
let scopeReads = 0;
const scope = {
  getSnapshot() {
    scopeReads += 1;
    return {
      status: "ready",
      value: { apiKeyEnv: "QODER_API_KEY" },
      base: {},
      user: {},
      writable: true,
      revision: 1
    };
  },
  subscribe() {
    return () => {};
  },
  mutate: async () => true
};
const ctx = {
  effect(fn) {
    return fn();
  },
  locale: {
    bind() {
      return t;
    },
    register(namespace, dictionaries) {
      localeRegistrations.push({ namespace, dictionaries });
      zhDictionary = dictionaries.zh;
      enDictionary = dictionaries.en;
      assert.ok(dictionaries.zh && dictionaries.en, "locale dictionaries incomplete");
      return () => {};
    }
  },
  configForms: {
    get(namespace) {
      assert.equal(namespace, "llm-qoder");
      return scope;
    },
    whileServed(namespaces, fn) {
      assert.deepEqual(namespaces, ["llm-qoder"]);
      return fn();
    }
  },
  remote: {
    $on() {
      return () => {};
    },
    credentials: {
      describe: async () => ({ ok: true, value: {} }),
      set: async () => true
    }
  },
  slots: {
    inject(name, register) {
      if (name !== "settings.models.provider-card" && name !== "conversation.session.header.utilities") {
        throw new Error(`unexpected slot ${name}`);
      }
      return register();
    },
    register(options, component) {
      slots.push({ options, component });
      return () => {};
    }
  }
};
const client = buildModule(baseReactStub);
assert.deepEqual(Object.keys(client).sort(), ["NS", "__test", "apply", "inject"]);
assert.equal(client.NS, "settings.qoder");
assert.deepEqual(client.inject, ["slots", "locale", "remote", "remote.credentials", "configForms"]);
client.apply(ctx);
console.log("locale registrations:", localeRegistrations.length);
console.log("slot registrations:", slots.map((slot) => `${slot.options.name} id=${slot.options.id ?? "-"} key=${slot.options.key ?? "-"} order=${slot.options.order ?? "-"}`).join(" | "));
assert.equal(localeRegistrations.length, 1);
assert.equal(localeRegistrations[0].namespace, "settings.qoder");
assert.deepEqual(Object.keys(zhDictionary).sort(), Object.keys(enDictionary).sort(), "zh/en dictionaries disagree on keys");
for (const key of [
  "defaultReasoningEffort",
  "defaultReasoningEffortHint",
  "credits.title",
  "credits.aria",
  "credits.turn",
  "credits.turnCalls",
  "credits.session",
  "credits.sessionBreakdown",
  "credits.lifetime",
  "credits.model",
  "credits.effort",
  "credits.priceFactor",
  "credits.free",
  "credits.empty"
]) {
  assert.ok(key in zhDictionary, `missing zh key ${key}`);
  assert.ok(key in enDictionary, `missing en key ${key}`);
}
console.log("dictionaries OK:", Object.keys(zhDictionary).length, "keys");
//#endregion

//#region settings card registration
const cardSlot = slots.find((slot) => slot.options.name === "settings.models.provider-card");
assert.ok(cardSlot, "provider-card slot not registered");
assert.equal(cardSlot.options.key, "llm-qoder");
assert.equal(cardSlot.options.locale, "settings.qoder");
// The controller's projection must carry the new field's control state.
const formModel = formModelInstances[0];
assert.ok(formModel, "SettingsFormModel was not constructed");
const projection = formModel.project();
assert.deepEqual(projection.defaultReasoningEffort, { text: "", overridden: false, invalid: false });
assert.ok("baseURL" in projection && "defaultModel" in projection && "apiKey" in projection);
console.log("form projection includes defaultReasoningEffort OK");

const cardState = {
  available: true,
  writable: true,
  dirty: false,
  invalid: false,
  saving: false,
  failed: false,
  apiKeyWritable: true,
  apiKeyConfigured: false,
  apiKey: { text: "", overridden: false, invalid: false },
  baseURL: { text: "", overridden: false, invalid: false },
  defaultModel: { text: "ultimate", overridden: false, invalid: false },
  defaultReasoningEffort: { text: "", overridden: false, invalid: false }
};
const cardTree = cardSlot.component({
  t,
  useQoderCard: (selector) => selector(cardState),
  edit: (field, text) => edits.push([field, text]),
  resetField: (field) => resets.push(field),
  save: () => {},
  discard: () => {}
});
const effortField = findNodes(cardTree, (node) => node.props?.id === "plugin-config-qoder-effort")[0];
assert.ok(effortField, "settings card does not render plugin-config-qoder-effort");
assert.equal(effortField.props.label, "默认推理强度");
assert.equal(effortField.props.hint, zhDictionary.defaultReasoningEffortHint);
assert.equal(effortField.props.disabled, false);
effortField.props.onEdit("high");
effortField.props.onReset();
assert.deepEqual(edits, [["defaultReasoningEffort", "high"]]);
assert.deepEqual(resets, ["defaultReasoningEffort"]);
const cardHtml = serialize(cardTree);
assert.ok(cardHtml.includes('id="plugin-config-qoder-effort"'), "rendered card lacks the effort input id");
assert.ok(cardHtml.includes("默认推理强度"), "rendered card lacks the localized effort label");
console.log("settings card renders plugin-config-qoder-effort OK");
//#endregion

//#region header chip registration
const chipSlot = slots.find((slot) => slot.options.name === "conversation.session.header.utilities");
assert.ok(chipSlot, "header utilities slot not registered");
assert.equal(chipSlot.options.id, "qoder-credits");
assert.equal(chipSlot.options.order, 5);
assert.equal(chipSlot.options.locale, "settings.qoder");
assert.deepEqual(chipSlot.options.inject(), {});
assert.equal(chipSlot.component, client.__test.CreditsChip);
console.log("header chip registered OK");
//#endregion

//#region pure helpers
const { parseStatsResponse, formatCredits, formatPriceFactor, CreditsPanel } = client.__test;

assert.equal(formatCredits(0.5), "0.5");
assert.equal(formatCredits(1.48), "1.48");
assert.equal(formatCredits(12), "12");
assert.equal(formatCredits(1.489), "1.49");
assert.equal(formatCredits(0), "0");
assert.equal(formatCredits(null), "\u2014");
assert.equal(formatCredits("2.50"), "2.5");
assert.equal(formatPriceFactor(0.5, t), "0.5×");
assert.equal(formatPriceFactor(1, t), "1×");
assert.equal(formatPriceFactor(0, t), "免费");
assert.equal(formatPriceFactor(null, t), "\u2014");
console.log("formatCredits/formatPriceFactor OK");

const STATS = {
  ok: true,
  known: true,
  sessionId: "session/1",
  model: "qwen3-coder-plus",
  modelName: "Qwen3 Coder Plus",
  effort: "high",
  priceFactor: 0.5,
  turn: { index: 2, credits: 0.56, calls: 8, lastCallCredits: 0.07 },
  session: { modelCredits: 10, sandboxCredits: 2.34, totalCredits: 12.34, carriedCredits: 0, total: 12.34 },
  lifetime: { credits: 25.5, calls: 42 },
  updatedAt: 1700000000000
};
const parsed = parseStatsResponse(STATS);
assert.equal(parsed.known, true);
assert.equal(parsed.sessionId, "session/1");
assert.equal(parsed.modelName, "Qwen3 Coder Plus");
assert.equal(parsed.effort, "high");
assert.equal(parsed.priceFactor, 0.5);
assert.deepEqual(parsed.turn, { index: 2, credits: 0.56, calls: 8, lastCallCredits: 0.07 });
assert.deepEqual(parsed.session, { modelCredits: 10, sandboxCredits: 2.34, totalCredits: 12.34, carriedCredits: 0, total: 12.34 });
assert.deepEqual(parsed.lifetime, { credits: 25.5, calls: 42 });
assert.equal(parsed.updatedAt, 1700000000000);

const unknown = parseStatsResponse({
  ok: true,
  known: false,
  sessionId: "other",
  model: null,
  modelName: null,
  effort: null,
  priceFactor: null,
  turn: { index: 0, credits: 0, calls: 0, lastCallCredits: 0 },
  session: { modelCredits: 0, sandboxCredits: 0, totalCredits: 0, carriedCredits: 0, total: 0 },
  lifetime: { credits: 7.5, calls: 3 },
  updatedAt: 0
});
assert.equal(unknown.known, false);
assert.equal(unknown.model, null);
assert.equal(unknown.priceFactor, null);
assert.equal(unknown.session.total, 0);
assert.deepEqual(unknown.lifetime, { credits: 7.5, calls: 3 });

const noSession = parseStatsResponse({ ok: true, known: true, session: null, lifetime: { credits: 3 } });
assert.equal(noSession.session, null);
assert.deepEqual(noSession.lifetime, { credits: 3, calls: 0 });

assert.equal(parseStatsResponse(null), null);
assert.equal(parseStatsResponse(undefined), null);
assert.equal(parseStatsResponse("nope"), null);
assert.equal(parseStatsResponse({ known: true }), null);
assert.equal(parseStatsResponse({ ok: false }), null);
console.log("parseStatsResponse contracts OK");
//#endregion

//#region popover panel rows
const panelHtml = serialize(jsxRuntimeStub.jsx(CreditsPanel, { stats: parsed, t }));
for (const expected of [
  "Qoder 积分",
  "本轮",
  "0.56",
  "8 次请求",
  "本会话累计",
  "12.34",
  "模型 10 · 沙箱 2.34",
  "本次运行累计",
  "25.5",
  "Qwen3 Coder Plus",
  "推理强度",
  "high",
  "积分倍率",
  "0.5×"
]) {
  assert.ok(panelHtml.includes(expected), `panel is missing ${expected}`);
}
console.log("panel rows OK");

const freePanel = serialize(jsxRuntimeStub.jsx(CreditsPanel, {
  stats: parseStatsResponse({
    ...STATS,
    priceFactor: 0,
    turn: { index: 0, credits: 0, calls: 0, lastCallCredits: 0 },
    session: { modelCredits: 0, sandboxCredits: 0, totalCredits: 0, carriedCredits: 0, total: 0 },
    lifetime: { credits: 0, calls: 0 },
    effort: null,
    modelName: null,
    model: null
  }),
  t
}));
assert.ok(freePanel.includes("免费"), "priceFactor 0 should read as 免费");
assert.ok(freePanel.includes("暂无数据"), "zero/absent figures should read as 暂无数据");
assert.ok(freePanel.includes("\u2014"), "absent effort should read as an em dash");
console.log("panel empty/free states OK");

assert.equal(CreditsPanel({ stats: { ...parsed, session: null }, t }), null);
console.log("panel renders nothing without a session snapshot OK");
//#endregion

//#region fetch-driven chip
/** Install a scripted fetch and record every call. */
let fetchCalls = [];
function installFetch(handler) {
  fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return handler(url, options);
  };
}

/**
 * Build a fresh module whose `react` surface is a fresh hooks harness, then
 * mount the chip. A fresh build per mount keeps hook state independent, exactly
 * like separate React roots.
 * @param sessionId - the Session standard prop to hand the chip.
 * @returns the mounted harness.
 */
function mountChip(sessionId) {
  const hooks = createHooksReact();
  const module = buildModule(hooks.implementation);
  return mountComponent(module.__test.CreditsChip, { sessionId, t }, hooks);
}

// 404: this deployment has no route. The chip must render nothing and stop polling.
installFetch(() => ({ status: 404, ok: false, json: async () => ({}) }));
const missing = mountChip("s-missing");
await flush();
missing.update();
assert.equal(missing.html(), "", "404 response should render no chip");
assert.equal(fetchCalls.length, 1, `404 polling should stop, saw ${fetchCalls.length} requests`);
assert.equal(fetchCalls[0].url, "qoder/credits?sessionId=s-missing");
assert.equal(fetchCalls[0].options.credentials, "same-origin");
assert.equal(fetchCalls[0].options.cache, "no-store");
assert.equal(fetchCalls[0].options.method, "GET");
missing.unmount();
console.log("404 path renders nothing and stops polling OK");

// Visibility gate: hidden pages never poll; becoming visible fetches immediately.
document.visibilityState = "hidden";
installFetch(() => ({ status: 200, ok: true, json: async () => STATS }));
const chip = mountChip("session/1");
await flush();
assert.equal(fetchCalls.length, 0, "hidden page must not poll");
assert.equal(chip.html(), "", "no stats yet -> no chip");
document.visibilityState = "visible";
for (const listener of visibilityListeners) listener();
await flush();
chip.update();
const chipHtml = chip.html();
assert.ok(chipHtml.includes("<button"), "known stats should render the trigger");
assert.ok(chipHtml.includes("12.34"), "chip should show the formatted session total");
assert.ok(chipHtml.includes('aria-label="Qoder 积分：12.34"'), "chip aria-label should be localized and carry the total");
assert.ok(chipHtml.includes('aria-haspopup="dialog"'), "trigger should advertise the popover");
assert.equal(fetchCalls.length, 1);
assert.equal(fetchCalls[0].url, "qoder/credits?sessionId=session%2F1", "session id must be encoded");
assert.equal(fetchCalls[0].options.method, "GET");
assert.equal(fetchCalls[0].options.credentials, "same-origin");
assert.equal(fetchCalls[0].options.cache, "no-store");
assert.equal(visibilityListeners.size, 1, "one visibility listener while mounted");

// Click opens the portaled breakdown; Escape closes it.
const trigger = findNodes(chip.tree(), (node) => node.props?.["aria-haspopup"] === "dialog")[0];
assert.ok(trigger, "trigger button not found");
trigger.props.onClick();
chip.update();
const openHtml = chip.html();
assert.ok(openHtml.includes("本轮") && openHtml.includes("本会话累计") && openHtml.includes("本次运行累计"), "popover rows should open on click");
assert.ok(openHtml.includes("0.5×"), "popover should show the credit multiplier");
assert.equal(keydownListeners.size, 1, "Escape listener only while open");
for (const listener of keydownListeners) listener({ key: "Escape" });
chip.update();
assert.ok(!chip.html().includes("本会话累计"), "Escape should close the popover");
assert.equal(keydownListeners.size, 0, "Escape listener removed when closed");
chip.unmount();
assert.equal(visibilityListeners.size, 0, "unmount should remove the visibility listener");
console.log("known chip + popover + cleanup OK");

// known:false (a Session that has not started a turn yet) renders nothing.
installFetch(() => ({ status: 200, ok: true, json: async () => ({ ...STATS, known: false }) }));
const pending = mountChip("s-pending");
await flush();
pending.update();
assert.equal(pending.html(), "", "known:false should render no chip");
pending.unmount();
console.log("known:false renders nothing OK");

// A transport failure keeps polling instead of going dark.
let failing = 0;
installFetch(() => {
  failing += 1;
  if (failing === 1) throw new Error("network down");
  return { status: 200, ok: true, json: async () => STATS };
});
const retrying = mountChip("s-retry");
await flush();
retrying.update();
assert.equal(retrying.html(), "", "failed first read leaves no chip");
assert.equal(failing, 1);
// The retry is scheduled 2.5s out; force the clock forward by re-triggering the
// visibility path, which performs an immediate read.
for (const listener of visibilityListeners) listener();
await flush();
retrying.update();
assert.ok(retrying.html().includes("12.34"), "a retry should recover the chip");
assert.equal(failing, 2);
retrying.unmount();
document.visibilityState = "visible";
console.log("transport failure retries OK");
//#endregion

console.log("OK");

// Headless verification of the Qoder browser card (client.js).
// It stubs the browser module graph (window.__ModuleLoader__, react/jsx-runtime,
// UI primitives) and a cordis client context, then materializes the bundle and
// asserts the slot registration + credential wiring behave as designed.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");

// --- stub browser module loader --------------------------------------------
let registration;
const window = {
	__ModuleLoader__: {
		load: (reg) => {
			registration = reg;
		},
	},
};

// --- stub react / react-dom / react/jsx-runtime + UI primitives ------------
const jsx = (type, props) => ({ type, ...(props ?? {}) });
const reactJsxRuntime = { jsx, jsxs: jsx };
// The bundle now also owns the Session-header credit chip, which uses hooks and
// a portal; a minimal React surface is enough to materialize and render it.
const react = {
	useState(initial) {
		return [initial, () => {}];
	},
	useRef(initial) {
		return { current: initial };
	},
	useEffect() {},
	useMemo(factory) {
		return factory();
	},
	useCallback(fn) {
		return fn;
	},
	createElement: jsx,
};
const reactDom = { createPortal: (element) => element };

function createSnapshotStore(initial) {
	return {
		_value: initial,
		set(value) {
			this._value = value;
		},
		getSnapshot() {
			return this._value;
		},
	};
}

class FakeSettingsFormModel {
	constructor(scope, specs, secrets = []) {
		this.scope = scope;
		this.specs = specs;
		this.secrets = secrets;
		this._stores = [];
	}
	bind(project) {
		const store = createSnapshotStore(project());
		this._stores.push(store);
		this.project = project;
		return store;
	}
	_publish() {
		for (const store of this._stores) store.set(this.project());
	}
	shell() {
		return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false };
	}
	field(name) {
		return { text: "", overridden: false, invalid: false };
	}
	actions() {
		return { edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {} };
	}
	dispose() {}
}

const primitives = {
	SettingsForm: (props) => jsx("SettingsForm", props),
	SettingsSecretField: (props) => jsx("SettingsSecretField", props),
	SettingsValueField: (props) => jsx("SettingsValueField", props),
	SettingsFormModel: FakeSettingsFormModel,
	settingsTextField: (field) => ({ field }),
	settingsNumberField: (field) => ({ field }),
	Tooltip: (props) => props.children,
	IconGaugeOutlineRegular: () => jsx("IconGauge"),
	useAnchoredPosition: () => null,
	useDismissOnOutsidePointer: () => {},
};

const require = (specifier) => {
	if (specifier === "react") return react;
	if (specifier === "react-dom") return reactDom;
	if (specifier === "react/jsx-runtime") return reactJsxRuntime;
	if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
	throw new Error(`unexpected require: ${specifier}`);
};

// --- stub cordis client context --------------------------------------------
const scope = {
	getSnapshot: () => ({ status: "ready", writable: true, revision: 1, value: { apiKeyEnv: "QODER_API_KEY", baseURL: "https://api.qoder.com", defaultModel: "ultimate" } }),
	subscribe: () => () => {},
	mutate: async () => true,
};

const credentialCalls = { describe: [], set: [] };
let registeredSlot;
let registeredChip;
let whileServedCb;
const ctx = {
	locale: { bind: () => (key) => key, register: () => {} },
	configForms: {
		get: (ns) => {
			assert.equal(ns, "llm-qoder");
			return scope;
		},
		whileServed: (namespaces, cb) => {
			assert.deepEqual(namespaces, ["llm-qoder"]);
			whileServedCb = cb;
			cb();
			return () => {};
		},
	},
	remote: {
		$on: () => () => {},
		credentials: {
			describe: async (refs) => {
				credentialCalls.describe.push(refs);
				return { ok: true, value: { [refs[0]]: { configured: true, writable: true } } };
			},
			set: async (ref, value) => {
				credentialCalls.set.push([ref, value]);
			},
		},
	},
	slots: {
		inject: (name, cb) => {
			assert.ok(name === "settings.models.provider-card" || name === "conversation.session.header.utilities", `unexpected slot: ${name}`);
			cb();
			return () => {};
		},
		register: (options, component) => {
			if (options.name === "settings.models.provider-card") registeredSlot = { options, component };
			if (options.name === "conversation.session.header.utilities") registeredChip = { options, component };
			return () => {};
		},
	},
	effect: (fn) => (typeof fn === "function" ? fn() : undefined),
};

// --- materialize + run ------------------------------------------------------
new Function("window", source)(window);
assert.equal(registration.id, "@local/dsh-plugin-qoder");
const exportsObj = registration.factory(require);
assert.equal(typeof exportsObj.apply, "function");
assert.deepEqual(exportsObj.inject, ["slots", "locale", "remote", "remote.credentials", "configForms"]);

exportsObj.apply(ctx);

// The keyed provider-card seat must be registered for the llm-qoder namespace.
assert.ok(registeredSlot, "provider-card slot was not registered");
assert.equal(registeredSlot.options.name, "settings.models.provider-card");
assert.equal(registeredSlot.options.key, "llm-qoder");
assert.equal(registeredSlot.options.locale, "settings.qoder");

// The Session-header seat carries the Qoder credit chip, keyed to no provider.
assert.ok(registeredChip, "credit chip slot was not registered");
assert.equal(registeredChip.options.name, "conversation.session.header.utilities");
assert.equal(registeredChip.options.id, "qoder-credits");
assert.equal(registeredChip.options.locale, "settings.qoder");

// The credential is addressed by the reference the section names.
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(credentialCalls.describe[0], ["QODER_API_KEY"]);

// The injected face exposes the store hook + form actions.
const face = registeredSlot.options.inject();
assert.ok(face.hooks.qoderCard, "expected a qoderCard hook store");
assert.equal(face.hooks.qoderCard.getSnapshot().defaultReasoningEffort.text, "", "defaultReasoningEffort missing from the form");
for (const action of ["edit", "resetField", "save", "discard"]) assert.equal(typeof face[action], "function");

// Rendering the card must not throw and must surface the configured badge.
const props = {
	t: (key) => key,
	provider: { provider: "qoder", displayName: "Qoder", settingsNs: "llm-qoder" },
	configured: true,
	keyConfigured: true,
	useQoderCard: (selector) => selector(face.hooks.qoderCard.getSnapshot()),
	...face,
};
const rendered = registeredSlot.component(props);
assert.ok(rendered, "card rendered nothing");
assert.equal(rendered.type, "div");

console.log("client card wiring: PASS");

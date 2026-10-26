// Offline smoke test for the Qoder provider plugin: stubs global fetch with
// WHATWG Responses and drives the adapter through a full Qoder turn. Run:
//   node test/test-smoke.mjs
import tls from "node:tls";

const calls = [];
const agentPayloads = [];
let turnStarted = false;

function jsonResp(obj, status = 200) {
	return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

// Emulated Qoder SSE turn body: our user.message echo, running, one agent
// message, then idle. Deliberately split mid-frame to exercise buffering.
function* sseChunks() {
	yield "event: user.message\nid: evt_u1\ndata: {\"type\":\"user.message\",\"id\":\"evt_u1\"}\n\n";
	yield "event: session.status_running\n";
	yield "id: evt_r1\ndata: {\"type\":\"session.status_running\",\"id\":\"evt_r1\"}\n\n";
	yield "event: heartbeat\ndata: {}\n\n";
	yield "event: agent.thinking\ndata: {\"type\":\"agent.thinking\",\"id\":\"evt_t1\"}\n\n";
	yield "event: agent.message\nid: evt_m1\ndata: {\"type\":\"agent.message\",\"id\":\"evt_m1\",\"content\":[{\"type\":\"text\"";
	yield ",\"text\":\"Hello from Qoder!\"}]}\n\n";
	yield "event: session.status_idle\nid: evt_i1\ndata: {\"type\":\"session.status_idle\",\"id\":\"evt_i1\",\"stop_reason\":{\"type\":\"end_turn\"}}\n\n";
}

// Turn 1 of the local-tool bridge: the model asks for a *bridged* tool, so the
// Session pauses with `requires_action` instead of answering.
function* sseCustomToolTurn() {
	yield "event: agent.thinking\ndata: {\"type\":\"agent.thinking\",\"id\":\"evt_t2\"}\n\n";
	yield "event: agent.custom_tool_use\nid: evt_c1\ndata: {\"type\":\"agent.custom_tool_use\",\"id\":\"evt_c1\",\"name\":\"dsh_Read\",\"input\":{\"file_path\":\"d:/dsh/version\"}}\n\n";
	yield "event: session.status_idle\nid: evt_i2\ndata: {\"type\":\"session.status_idle\",\"id\":\"evt_i2\",\"stop_reason\":{\"type\":\"requires_action\",\"event_ids\":[\"evt_c1\"]}}\n\n";
}

// Turn 2: the result we handed back was consumed and the model answers with it.
function* sseResumedTurn() {
	yield "event: agent.message\nid: evt_m2\ndata: {\"type\":\"agent.message\",\"id\":\"evt_m2\",\"content\":[{\"type\":\"text\",\"text\":\"It says 44.0.0\"}]}\n\n";
	yield "event: session.status_idle\nid: evt_i3\ndata: {\"type\":\"session.status_idle\",\"id\":\"evt_i3\",\"stop_reason\":{\"type\":\"end_turn\"}}\n\n";
}

// A model that ignores the bridge and calls a *cloud* tool instead: the user must
// still get an explanation rather than a silent empty turn.
function* sseCloudToolTurn() {
	yield "event: agent.tool_use\nid: evt_b1\ndata: {\"type\":\"agent.tool_use\",\"id\":\"evt_b1\",\"name\":\"Read\",\"input\":{\"file_path\":\"d:/dsh/version\"}}\n\n";
	yield "event: session.status_idle\nid: evt_i4\ndata: {\"type\":\"session.status_idle\",\"id\":\"evt_i4\",\"stop_reason\":{\"type\":\"end_turn\"}}\n\n";
}

// The cloud ran out of room and summarized its own history: the turn must say so.
function* sseCompactedTurn() {
	yield "event: agent.thread_context_compacted\nid: evt_cc1\ndata: {\"type\":\"agent.thread_context_compacted\",\"id\":\"evt_cc1\",\"usage\":{\"credits\":0.42}}\n\n";
	yield "event: agent.message\nid: evt_m8\ndata: {\"type\":\"agent.message\",\"id\":\"evt_m8\",\"content\":[{\"type\":\"text\",\"text\":\"Continuing from the summary.\"}]}\n\n";
	yield "event: session.status_idle\nid: evt_i8\ndata: {\"type\":\"session.status_idle\",\"id\":\"evt_i8\",\"stop_reason\":{\"type\":\"end_turn\"}}\n\n";
}

// A turn the cloud cut short for a reason other than a clean end: it must not look
// like a normal completed answer.
function* sseCutShortTurn() {
	yield "event: agent.message\nid: evt_m9\ndata: {\"type\":\"agent.message\",\"id\":\"evt_m9\",\"content\":[{\"type\":\"text\",\"text\":\"Partial thought.\"}]}\n\n";
	yield "event: session.status_idle\nid: evt_i9\ndata: {\"type\":\"session.status_idle\",\"id\":\"evt_i9\",\"stop_reason\":{\"type\":\"retries_exhausted\"}}\n\n";
}

// One scripted turn per stream request, consumed in order. Sessions are created
// as conversations are first seen: sess_1 = plain chat, sess_2 = bridge, sess_3 = cloud-tool,
// …, sess_8 = context compaction, sess_9 = cut short.
const scriptQueues = new Map([["sess_1", [sseChunks, sseChunks]], ["sess_2", [sseCustomToolTurn, sseResumedTurn]], ["sess_3", [sseCloudToolTurn]], ["sess_8", [sseCompactedTurn]], ["sess_9", [sseCutShortTurn]]]);
function takeScript(sessionId) {
	const queue = scriptQueues.get(sessionId);
	return queue && queue.length > 0 ? queue.shift() : sseChunks;
}

const postedEvents = [];
const sessionPatches = [];
let sessionSeq = 0;
// When non-zero, the next created Session reports this as its
// `agent.model.effective_context_window` (set only by the test that needs it, so
// every other Session keeps the catalog-derived window).
let nextEffectiveWindow = 0;

globalThis.fetch = async (url, init = {}) => {
	const u = String(url);
	calls.push({ url: u, method: init.method ?? "GET", auth: init.headers?.authorization, body: init.body });
	if (u.endsWith("/api/v1/cloud/environments") && init.method === "GET") return jsonResp({ data: [{ id: "env_1" }] });
	if (u.endsWith("/api/v1/cloud/agents") && init.method === "POST") {
		const parsed = JSON.parse(String(init.body));
		agentPayloads.push(parsed);
		return jsonResp({ id: "agent_1" });
	}
	if (u.endsWith("/api/v1/cloud/sessions") && init.method === "POST") {
		const effective = nextEffectiveWindow;
		nextEffectiveWindow = 0;
		return jsonResp(effective > 0 ? { id: `sess_${++sessionSeq}`, agent: { model: { effective_context_window: effective } } } : { id: `sess_${++sessionSeq}` });
	}
	// Live Session tool patch (POST /sessions/{id}) — must not disturb history.
	const patch = u.match(/\/api\/v1\/cloud\/sessions\/(sess_\d+)$/);
	if (patch && init.method === "POST") {
		sessionPatches.push({ sessionId: patch[1], body: JSON.parse(String(init.body)) });
		return jsonResp({ id: patch[1] });
	}
	const stream = u.match(/\/sessions\/(sess_\d+)\/events\/stream/);
	if (stream) {
		const script = takeScript(stream[1]);
		return new Response(ReadableStream.from(Array.from(script(), (s) => new TextEncoder().encode(s))), { status: 200, headers: { "content-type": "text/event-stream" } });
	}
	const events = u.match(/\/sessions\/(sess_\d+)\/events$/);
	if (events && init.method === "POST") {
		turnStarted = true;
		postedEvents.push(...JSON.parse(String(init.body)).events);
		return jsonResp({ data: [{ id: "evt_u1", type: "user.message" }] });
	}
	// Context fields mirror the real catalog shape: a hard input ceiling, a default
	// tier, and the selectable tiers.
	if (u.endsWith("/api/v1/cloud/models")) return jsonResp({ data: [{ id: "ultimate", type: "model", display_name: "Ultimate", is_enabled: true, max_input_tokens: 1000000, default_context_window: 200000, available_context_windows: [200000, 400000, 1000000] }, { id: "fast", type: "model", display_name: "Qoder Fast", is_enabled: true, max_input_tokens: 128000, default_context_window: 128000, available_context_windows: [128000] }], has_more: false });
	return jsonResp({}, 404);
};

process.env.QODER_PAT = "pt-test-token";

const captured = {};
const warnings = [];
const ctx = {
	fiber: { entry: { options: { id: "llm-qoder" } } },
	logger: { warn: (...a) => { warnings.push(a.map(String).join(" ")); console.log("[warn]", ...a); } },
	inject: (_need, cb) => cb({ effect: () => {}, settings: { configure: () => {} } }),
	on: (_event, _handler) => {},
	// Deliberately messy: whitespace + a stray "Bearer " prefix must be
	// normalized away (a common paste artifact that yields HTTP 401).
	get: (name) => (name === "credentials" ? { resolve: async () => ({ value: "  Bearer pt-test-token  " }) } : void 0),
	llm: {
		registerConfigurableProviders: (entries) => { captured.providers = entries; },
		registerAdapter: (providers, adapter) => { captured.providers2 = providers; captured.adapter = adapter; return { replace: () => {} }; }
	}
};

const mod = await import(new URL("../index.js", import.meta.url));
mod.apply(ctx, {
	apiKeyEnv: "QODER_PAT",
	baseURL: "https://api.qoder.com",
	defaultModel: "ultimate",
	agentTools: "Bash,Read,Write"
});

// Some networks reset TLS 1.3 to the Qoder host; the plugin must pin 1.2.
const tlsPinned = tls.DEFAULT_MAX_VERSION === "TLSv1.2";
console.log("tls pinned:", tlsPinned, tls.DEFAULT_MAX_VERSION);

const adapter = captured.adapter;
if (!adapter) throw new Error("adapter was not registered");

// 1. providerInfo / models
console.log("providerInfo:", JSON.stringify(adapter.providerInfo("qoder")));
console.log("listModels:", JSON.stringify(await adapter.listModels("qoder")));
console.log("resolveModel:", JSON.stringify(await adapter.resolveModel("qoder", "ultimate")));

// 1b. prepareCall must hand the registry *resolved* metadata, never a Promise
// (regression: `model: this.resolveModel(...)` without await surfaced as
// "adapter returned invalid exact model metadata").
const prepared = await adapter.prepareCall("qoder", "ultimate");
const info = prepared?.model;
const modelOk =
	typeof prepared?.stream === "function" &&
	!(info instanceof Promise) &&
	info?.provider === "qoder" &&
	info?.id === "ultimate" &&
	typeof info?.name === "string" && info.name.length > 0 &&
	Number.isInteger(info?.context?.contextWindow) && info.context.contextWindow > 0 &&
	Number.isSafeInteger(info?.defaultMaxTokens) && info.defaultMaxTokens > 0;
console.log("prepareCall.model:", JSON.stringify(info), "valid:", modelOk);

// 1c. the catalog must already carry the provider/id/name shape the registry validates,
// and must map the documented `display_name` field.
const catalog = await adapter.listModels("qoder");
const catalogOk =
	Array.isArray(catalog) &&
	catalog.length > 0 &&
	catalog.every((m) => m.provider === "qoder" && typeof m.id === "string" && m.id.length > 0 && typeof m.name === "string" && m.name.length > 0) &&
	catalog.some((m) => m.name === "Qoder Fast");
console.log("catalog:", JSON.stringify(catalog), "valid:", catalogOk);

// 2. full stream turn
const chunks = [];
for await (const chunk of adapter.stream({ provider: "qoder", model: "ultimate", sessionId: "conv-1", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })) chunks.push(chunk);
console.log("stream chunks:", JSON.stringify(chunks, null, 0));

// 3. second turn reuses the cached session (no new agents/sessions POST)
const before = calls.length;
for await (const _c of adapter.stream({ provider: "qoder", model: "ultimate", sessionId: "conv-1", messages: [{ role: "user", content: [{ type: "text", text: "again" }] }] })) {}
const reused = !calls.slice(before).some((c) => c.url.endsWith("/agents") || c.url.endsWith("/sessions"));

// 4. local-tool bridge: a bridged call must surface as a dsh tool-call and hand
// dsh's result back to the SAME paused Session as `user.custom_tool_result`.
const bridgeTools = [{ name: "Read", description: "Read a local file", parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } }];
const bridgeTurn1 = [];
for await (const chunk of adapter.stream({ provider: "qoder", model: "ultimate", sessionId: "conv-bridge", tools: bridgeTools, messages: [{ role: "user", content: [{ type: "text", text: "read d:/dsh/version" }] }] })) bridgeTurn1.push(chunk);
const surfaced = bridgeTurn1.find((c) => c.type === "block-end" && c.block?.type === "tool-call");
const bridgeFinish = bridgeTurn1.find((c) => c.type === "finish");

const bridgeTurn2 = [];
const bridgeHistory = [
	{ role: "user", content: [{ type: "text", text: "read d:/dsh/version" }] },
	{ role: "assistant", content: [{ type: "tool-call", id: surfaced?.block?.id, name: surfaced?.block?.name, arguments: surfaced?.block?.arguments }] },
	{ role: "tool", toolCallId: surfaced?.block?.id, content: [{ type: "text", text: "44.0.0" }], isError: false }
];
for await (const chunk of adapter.stream({ provider: "qoder", model: "ultimate", sessionId: "conv-bridge", tools: bridgeTools, messages: bridgeHistory })) bridgeTurn2.push(chunk);
const resumedText = bridgeTurn2.filter((c) => c.type === "text-delta").map((c) => c.text).join("");

const agentWithCustom = agentPayloads.some((payload) => payload.tools?.some((tool) => tool.type === "custom" && tool.name === "dsh_Read"));
// Built-in file tools must stay OFF while bridging, or the model reads Qoder's
// sandbox and reports the user's files as missing.
const toolsetRestricted = agentPayloads.every((payload) => !payload.tools?.some((tool) => tool.type === "agent_toolset_20260401" && (tool.enabled_tools ?? []).some((name) => ["Read", "Write", "Edit", "Bash", "Glob", "Grep"].includes(name))));
const directiveSent = agentPayloads.some((payload) => /local machine/i.test(payload.system ?? ""));
const resultForwarded = postedEvents.some((event) => event.type === "user.custom_tool_result" && event.custom_tool_use_id === surfaced?.block?.id && event.content?.[0]?.text === "44.0.0");
const bridgeOk =
	surfaced?.block?.name === "Read" &&
	surfaced?.block?.arguments === '{"file_path":"d:/dsh/version"}' &&
	bridgeFinish?.reason?.kind === "tool-calls" &&
	agentWithCustom &&
	toolsetRestricted &&
	directiveSent &&
	resultForwarded &&
	resumedText === "It says 44.0.0" &&
	bridgeTurn2.find((c) => c.type === "finish")?.reason?.kind === "stop";
console.log("bridge:", JSON.stringify({ name: surfaced?.block?.name, finish: bridgeFinish?.reason?.kind, agentWithCustom, toolsetRestricted, directiveSent, resultForwarded, resumedText }, null, 0), "valid:", bridgeOk);

// 5. a cloud-tool detour must still explain itself instead of returning nothing.
const cloudTurn = [];
for await (const chunk of adapter.stream({ provider: "qoder", model: "ultimate", sessionId: "conv-cloud", tools: bridgeTools, messages: [{ role: "user", content: [{ type: "text", text: "read d:/dsh/version" }] }] })) cloudTurn.push(chunk);
const cloudText = cloudTurn.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
const cloudOk = /cloud tool "Read"/.test(cloudText) && cloudTurn.some((c) => c.type === "finish");
console.log("cloud detour:", JSON.stringify(cloudText.slice(0, 80)), "valid:", cloudOk);

// 6. tool provenance: the bridge forwards *everything* dsh made visible to this
// agent — host tools, tools registered by other plugins, and MCP-bridged tools —
// and Qoder's 128-entry cap must degrade to a warning instead of a failed turn.
const foreignTools = [
	{ name: "Read", description: "host tool", parameters: { type: "object", properties: {} } },
	{ name: "prompt_editor_search", description: "another plugin", parameters: { type: "object", properties: {} } },
	{ name: "mcp__github__create_issue", description: "mcp server tool", parameters: { type: "object", properties: {} } }
];
for await (const _c of adapter.stream({ provider: "qoder", model: "ultimate", sessionId: "conv-foreign", tools: foreignTools, messages: [{ role: "user", content: [{ type: "text", text: "use any tool" }] }] })) {}
const foreignPayload = agentPayloads.find((payload) => payload.tools?.some((tool) => tool.name === "dsh_prompt_editor_search"));
// Qoder reserves the `mcp__` *prefix* for its own MCP tools, so the bridge prefix
// has to stay in front of it.
const foreignNames = foreignPayload?.tools?.filter((tool) => tool.type === "custom").map((tool) => tool.name) ?? [];
const foreignOk = foreignNames.includes("dsh_Read") && foreignNames.includes("dsh_prompt_editor_search") && foreignNames.includes("dsh_mcp__github__create_issue") && !foreignNames.some((name) => name.startsWith("mcp__"));
console.log("foreign tools:", JSON.stringify(foreignNames), "valid:", foreignOk);

const manyTools = Array.from({ length: 200 }, (_unused, index) => ({ name: `tool_${index}`, description: `tool ${index}`, parameters: { type: "object", properties: {} } }));
for await (const _c of adapter.stream({ provider: "qoder", model: "ultimate", sessionId: "conv-many", tools: manyTools, messages: [{ role: "user", content: [{ type: "text", text: "many tools" }] }] })) {}
const manyPayload = agentPayloads.find((payload) => payload.tools?.some((tool) => tool.name === "dsh_tool_0"));
const manyCustom = manyPayload?.tools?.filter((tool) => tool.type === "custom") ?? [];
// 128 total entries minus the one cloud toolset declaration.
const capOk = manyCustom.length === 127 && warnings.some((w) => /128-entry limit/.test(w));
console.log("cap:", { offered: manyCustom.length, warned: warnings.some((w) => /128-entry limit/.test(w)) }, "valid:", capOk);

// 7. context window: the size dsh is told about must come from the model catalog,
// and a chosen tier must reach Qoder as `model.context_window` (or be dropped with
// a warning when the model does not offer it).
const tieredAdapter = (() => {
	mod.apply(ctx, { apiKeyEnv: "QODER_PAT", baseURL: "https://api.qoder.com", defaultModel: "fast", agentContextWindow: 128000 });
	return captured.adapter;
})();
const tieredInfo = await tieredAdapter.resolveModel("qoder", "fast");
for await (const _c of tieredAdapter.stream({ provider: "qoder", model: "fast", sessionId: "conv-tier", messages: [{ role: "user", content: [{ type: "text", text: "tiered" }] }] })) {}
const tierPayload = agentPayloads.find((payload) => payload.name === "dsh-fast" && typeof payload.model === "object");
const tierOk = tieredInfo.context.contextWindow === 128000 && tierPayload?.model?.id === "fast" && tierPayload?.model?.context_window === 128000;
console.log("context tier:", JSON.stringify({ reported: tieredInfo.context.contextWindow, sent: tierPayload?.model }), "valid:", tierOk);

const fallbackWindow = (await adapter.resolveModel("qoder", "ultimate")).context.contextWindow;
// 400000 is not offered for `fast` (which caps at 128000): it must be dropped, and
// the reported window must still respect the model's ceiling.
const badTierAdapter = (() => {
	mod.apply(ctx, { apiKeyEnv: "QODER_PAT", baseURL: "https://api.qoder.com", defaultModel: "fast", agentContextWindow: 400000 });
	return captured.adapter;
})();
const badWindow = (await badTierAdapter.resolveModel("qoder", "fast")).context.contextWindow;
for await (const _c of badTierAdapter.stream({ provider: "qoder", model: "fast", sessionId: "conv-badtier", messages: [{ role: "user", content: [{ type: "text", text: "bad tier" }] }] })) {}
const badPayload = agentPayloads.filter((payload) => payload.name === "dsh-fast").at(-1);
const windowOk = fallbackWindow === 200000 && badWindow === 128000 && badPayload?.model === "fast" && warnings.some((w) => /not offered for model "fast"/.test(w));
console.log("window fallback/clamp:", JSON.stringify({ ultimate: fallbackWindow, badTierReported: badWindow, sent: badPayload?.model }), "valid:", windowOk);

// 8. cloud context overflow visibility: Qoder compacts its own Session history, and
// the turn must say so instead of degrading silently. A Session's
// `effective_context_window` also becomes the figure reported to dsh, and a stop
// that is not a clean end must be named rather than passed off as an answer.
nextEffectiveWindow = 400000;
const compactTurn = [];
for await (const chunk of adapter.stream({ provider: "qoder", model: "compactmodel", sessionId: "conv-compact", messages: [{ role: "user", content: [{ type: "text", text: "keep going" }] }] })) compactTurn.push(chunk);
const compactText = compactTurn.filter((c) => c.type === "text-delta").map((c) => c.text).join("\n");
const learnedWindow = (await adapter.resolveModel("qoder", "compactmodel")).context.contextWindow;
const cutTurn = [];
for await (const chunk of adapter.stream({ provider: "qoder", model: "cutmodel", sessionId: "conv-cutshort", messages: [{ role: "user", content: [{ type: "text", text: "go on" }] }] })) cutTurn.push(chunk);
const cutText = cutTurn.filter((c) => c.type === "text-delta").map((c) => c.text).join("\n");
const overflowOk = /compacted this session's cloud context/.test(compactText) && /0\.42 credits/.test(compactText) && learnedWindow === 400000 && /stop_reason "retries_exhausted"/.test(cutText) && cutTurn.some((c) => c.type === "finish");
console.log("overflow:", JSON.stringify({ compactText: compactText.slice(0, 48), learnedWindow, cutText: cutText.slice(0, 90) }, null, 0), "valid:", overflowOk);

// 9. a changed dsh tool set must be re-patched onto the live Session (history kept).
const readTool = { name: "Read", description: "read", parameters: { type: "object", properties: {} } };
const writeTool = { name: "Write", description: "write", parameters: { type: "object", properties: {} } };
for await (const _c of adapter.stream({ provider: "qoder", model: "patchmodel", sessionId: "conv-patch", tools: [readTool], messages: [{ role: "user", content: [{ type: "text", text: "first" }] }] })) {}
for await (const _c of adapter.stream({ provider: "qoder", model: "patchmodel", sessionId: "conv-patch", tools: [readTool, writeTool], messages: [{ role: "user", content: [{ type: "text", text: "first" }] }, { role: "user", content: [{ type: "text", text: "second" }] }] })) {}
const patchBody = sessionPatches.find((entry) => entry.body?.agent?.tools?.some((tool) => tool.name === "dsh_Write"))?.body;
const patchOk = patchBody?.agent?.tools?.some((tool) => tool.name === "dsh_Read") === true && patchBody?.agent?.tools?.some((tool) => tool.type === "agent_toolset_20260401") === true;
console.log("session re-patch:", JSON.stringify(sessionPatches.map((entry) => entry.body?.agent?.tools?.map((tool) => tool.name ?? tool.type))), "valid:", patchOk);

// assertions
const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
const finish = chunks.find((c) => c.type === "finish");
const bearer = calls.every((c) => c.auth === "Bearer pt-test-token");
const ok =
	tlsPinned &&
	modelOk &&
	catalogOk &&
	bridgeOk &&
	cloudOk &&
	foreignOk &&
	capOk &&
	tierOk &&
	windowOk &&
	overflowOk &&
	patchOk &&
	text === "Hello from Qoder!" &&
	finish?.reason?.kind === "stop" &&
	chunks.filter((c) => c.type === "block-start").length === 1 &&
	chunks.filter((c) => c.type === "block-end").length === 1 &&
	turnStarted &&
	reused &&
	bearer;
console.log("\nRESULTS:", { text, finish, sessionReuse: reused, bearerAll: bearer });
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);

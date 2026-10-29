// Offline + optional live checks for the host half of @local/dsh-plugin-qoder.
//
// Offline: every pure helper, the credit store, the /qoder/credits route, and a
// full adapter turn driven through `apply()` with a stubbed `fetch` — catalog
// discovery, Agent creation (effort included), Session creation, the SSE stream
// translation (thinking → reasoning block, message → text, spans/usage → credit
// stats), a second turn that patches the live Session's model in place, and the
// fallback to a fresh Session when that patch is refused.
//
// Live (QODER_LIVE=1, needs ~/.dsh/.credentials.yaml with QODER_API_KEY): the
// real catalog, a real Agent with an explicit effort, a real Session, one real
// streamed turn, and a real in-place effort patch that must keep the history.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { apply, Config, __test } from "../index.js";

/** The environment's real fetch, restored before the optional live block. */
const realFetch = globalThis.fetch;

const {
	QoderCreditStats,
	agentModelSpec,
	effortIdsForModel,
	formatFactor,
	modelDescription,
	normalizeModelList,
	priceFactorBadge,
	reasoningInfoFor,
	serveCreditStats,
	thinkingSummaryOf,
	thinkingTextOf
} = __test;

let checks = 0;
function ok(name, fn) {
	fn();
	checks += 1;
	console.log(`ok ${checks} - ${name}`);
}

//#region pure helpers
ok("catalog normalization keeps the picker facts", () => {
	const models = normalizeModelList({
		data: [
			{ id: "dmodel", display_name: "DeepSeek-V4-Pro", price_factor: 0.5, efforts: ["high", "max"], default_effort: "max", max_input_tokens: 96000, default_context_window: 200000, available_context_windows: [200000, 400000] },
			{ id: "dfmodel", display_name: "DeepSeek-Flash", price_factor: 0, efforts: ["high", "low", "max"], default_effort: "high", support_disable_reasoning: true },
			{ id: "auto", display_name: "Auto", price_factor: 0.5 },
			{ id: "bogus-effort", efforts: ["nope", 7, "low"] },
			{ id: "bogus-rate", price_factor: -1 }
		]
	});
	assert.equal(models.length, 5);
	assert.equal(models[0].priceFactor, 0.5);
	assert.deepEqual(models[0].efforts, ["high", "max"]);
	assert.equal(models[0].defaultEffort, "max");
	assert.equal(models[2].priceFactor, 0.5);
	assert.deepEqual(models[2].efforts, []);
	assert.equal(models[3].efforts.length, 1);
	assert.equal(models[4].priceFactor, undefined);
});

ok("effort lists are validated, ordered least→greatest, and gain none only when allowed", () => {
	const model = { efforts: ["xhigh", "low", "medium"], defaultEffort: "medium", supportDisableReasoning: false };
	assert.deepEqual(effortIdsForModel(model), ["low", "medium", "xhigh"]);
	assert.deepEqual(effortIdsForModel({ ...model, supportDisableReasoning: true }), ["none", "low", "medium", "xhigh"]);
	assert.deepEqual(effortIdsForModel(undefined), []);
});

ok("price-factor badge fits dsh's catalog constraints", () => {
	assert.deepEqual(priceFactorBadge(0), { text: "0×", tone: "info" });
	assert.deepEqual(priceFactorBadge(0.5), { text: "0.5×", tone: "info" });
	assert.deepEqual(priceFactorBadge(1), { text: "1×", tone: "neutral" });
	assert.deepEqual(priceFactorBadge(1.25), { text: "1.25×", tone: "warning" });
	assert.equal(priceFactorBadge(undefined), undefined);
	for (const factor of [0, 0.1, 0.5, 1, 1.25, 2]) {
		const badge = priceFactorBadge(factor);
		const text = typeof badge.text === "string" ? badge.text : badge.text.en;
		assert.ok(Array.from(text).length <= 12, `badge text too long: ${text}`);
		assert.ok(["neutral", "info", "success", "warning"].includes(badge.tone));
	}
	assert.equal(formatFactor(0.5), "0.5");
	assert.equal(formatFactor(1), "1");
});

ok("reasoning metadata honours the catalog default and the configured override", () => {
	const model = { efforts: ["low", "medium", "high"], defaultEffort: "medium", supportDisableReasoning: false };
	const fromCatalog = reasoningInfoFor(model, "");
	assert.deepEqual(fromCatalog.efforts.map((effort) => effort.id), ["low", "medium", "high"]);
	assert.equal(fromCatalog.defaultEffort, "medium");
	assert.ok(fromCatalog.efforts.every((effort) => effort.name.length > 0));
	assert.equal(reasoningInfoFor(model, "high").defaultEffort, "high");
	assert.equal(reasoningInfoFor(model, "max").defaultEffort, "medium", "unsupported override falls back");
	assert.equal(reasoningInfoFor({ efforts: [] }, "high"), undefined);
	assert.ok(modelDescription(model).includes("Reasoning"));
});

ok("Agent model value carries effort and the context tier, dropping unsupported values", () => {
	const entry = { efforts: ["high", "max"], availableContextWindows: [200000, 400000], supportDisableReasoning: false };
	assert.equal(agentModelSpec("dmodel", entry, 0, undefined, () => {}), "dmodel");
	assert.deepEqual(agentModelSpec("dmodel", entry, 0, "max", () => {}), { id: "dmodel", effort: "max" });
	assert.deepEqual(agentModelSpec("dmodel", entry, 400000, "high", () => {}), { id: "dmodel", effort: "high", context_window: 400000 });
	const warnings = [];
	assert.equal(agentModelSpec("dmodel", entry, 0, "low", (message) => warnings.push(message)), "dmodel");
	assert.equal(warnings.length, 1);
	assert.equal(agentModelSpec("dmodel", { efforts: ["high"] }, 0, "max", () => {}), "dmodel", "unknown model still sends nothing");
	assert.deepEqual(agentModelSpec("dmodel", undefined, 0, "max", () => {}), { id: "dmodel", effort: "max" }, "no catalog: let Qoder validate");
});

ok("credit store replaces cumulative snapshots and sums per-call spans", () => {
	const stats = new QoderCreditStats();
	assert.equal(stats.snapshot("s1").known, false);
	stats.startTurn("s1", { model: "dmodel", modelName: "DeepSeek-V4-Pro", effort: "high", priceFactor: 0.5 });
	stats.noteCall("s1", 0.27);
	stats.noteCall("s1", 0.1);
	stats.applyUsage("s1", { modelCredits: 0.37, sandboxCredits: 0.02, totalCredits: 0.39 });
	const first = stats.snapshot("s1");
	assert.equal(first.known, true);
	assert.equal(first.turn.credits, 0.37);
	assert.equal(first.turn.calls, 2);
	assert.equal(first.turn.lastCallCredits, 0.1);
	assert.equal(first.session.total, 0.39);
	assert.equal(first.lifetime.credits, 0.37);
	stats.startTurn("s1", {});
	assert.equal(stats.snapshot("s1").turn.credits, 0);
	stats.rotateCloudSession("s1");
	const rotated = stats.snapshot("s1");
	assert.equal(rotated.session.carriedCredits, 0.39);
	assert.equal(rotated.session.total, 0.39);
	stats.applyUsage("s1", { modelCredits: 0.5, sandboxCredits: 0, totalCredits: 0.5 });
	const next = stats.snapshot("s1");
	assert.equal(next.session.total, 0.89, "rotated total keeps growing");
	stats.reset();
	assert.equal(stats.snapshot("s1").known, false);
});

ok("thinking payloads pass text through and describe a contentless phase", () => {
	assert.equal(thinkingTextOf({ content: [{ type: "text", text: "real reasoning" }] }), "real reasoning");
	assert.equal(thinkingTextOf({ thinking: "direct" }), "direct");
	assert.equal(thinkingTextOf({}), "");
	const summary = thinkingSummaryOf({ effort: "high", requestStartedAt: Date.parse("2026-01-01T00:00:00.000Z") }, { processed_at: "2026-01-01T00:00:04.200Z" });
	assert.ok(summary.includes("4.2s"), summary);
	assert.ok(summary.includes("High"), summary);
	assert.ok(summary.includes("does not publish"), summary);
});

ok("the credit route answers GET/HEAD and refuses other methods", () => {
	const stats = new QoderCreditStats();
	stats.startTurn("session-test", { model: "dmodel" });
	stats.noteCall("session-test", 0.5);
	stats.applyUsage("session-test", { modelCredits: 0.5, sandboxCredits: 0, totalCredits: 0.5 });
	const get = fakeResponse();
	serveCreditStats({ method: "GET", url: "/qoder/credits?sessionId=session-test" }, get, stats);
	assert.equal(get.status, 200);
	assert.equal(get.headers["content-type"].includes("application/json"), true);
	const payload = JSON.parse(get.body);
	assert.equal(payload.ok, true);
	assert.equal(payload.known, true);
	assert.equal(payload.turn.credits, 0.5);
	assert.equal(payload.session.total, 0.5);
	const head = fakeResponse();
	serveCreditStats({ method: "HEAD", url: "/qoder/credits?sessionId=session-test" }, head, stats);
	assert.equal(head.status, 200);
	assert.equal(head.body, "");
	const post = fakeResponse();
	serveCreditStats({ method: "POST", url: "/qoder/credits" }, post, stats);
	assert.equal(post.status, 405);
	assert.equal(JSON.parse(post.body).ok, false);
	const unknown = fakeResponse();
	serveCreditStats({ method: "GET", url: "/qoder/credits?sessionId=nope" }, unknown, stats);
	assert.equal(JSON.parse(unknown.body).known, false);
});
//#endregion

//#region harness
function fakeResponse() {
	return {
		status: 0,
		headers: {},
		body: "",
		writeHead(status, headers = {}) {
			this.status = status;
			this.headers = headers;
		},
		end(body = "") {
			this.body = body;
		}
	};
}

/** A minimal Cordis-shaped context that captures what the plugin registers. */
function harnessContext(getToken) {
	const captured = { adapter: void 0, routes: [], providers: [], settingsConfigured: false };
	const settingsChild = {
		effect: (factory) => factory(),
		settings: {
			configure() {
				captured.settingsConfigured = true;
			}
		}
	};
	const webChild = {
		effect: (factory) => factory(),
		webServer: {
			register(route) {
				captured.routes.push(route);
				return () => {
					const index = captured.routes.indexOf(route);
					if (index >= 0) captured.routes.splice(index, 1);
				};
			}
		}
	};
	const ctx = {
		llm: {
			registerAdapter(routes, adapter) {
				captured.adapter = adapter;
				return { replace() {} };
			},
			registerConfigurableProviders(providers) {
				captured.providers.push(...providers);
			}
		},
		fiber: { entry: { options: { id: "llm-qoder" } } },
		inject(names, callback) {
			if (names.includes("settings")) callback(settingsChild);
			if (names.includes("webServer")) callback(webChild);
		},
		get(name) {
			if (name === "credentials") return { resolve: async () => ({ value: getToken() }) };
			return void 0;
		},
		on() {},
		logger: { warn() {} }
	};
	return { ctx, captured };
}

function baseConfig(overrides = {}) {
	return {
		apiKeyEnv: "QODER_API_KEY",
		baseURL: "https://api.qoder.com.cn",
		defaultModel: "dmodel",
		contextWindow: 0,
		agentContextWindow: 0,
		defaultReasoningEffort: "",
		maxTokens: 8192,
		tlsMaxVersion: "TLSv1.2",
		systemPrompt: "",
		environmentId: "",
		autoCreateEnvironment: true,
		agentTools: "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch",
		bridgeLocalTools: true,
		cloudTools: "DeliverArtifacts",
		localToolPrefix: "dsh_",
		replayHistory: true,
		displayName: "Qoder",
		...overrides
	};
}

/** SSE body from an ordered list of `{ event, data }` frames. */
function sseResponse(frames) {
	const text = frames.map((frame) => `id: ${frame.data.id ?? "evt_test"}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`).join("");
	return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const CATALOG = {
	data: [
		{ id: "dmodel", display_name: "DeepSeek-V4-Pro", price_factor: 0.5, efforts: ["high", "max"], default_effort: "max", max_input_tokens: 96000, default_context_window: 200000, available_context_windows: [200000, 400000] },
		{ id: "gmodel", display_name: "GLM-5.3", price_factor: 0.8, efforts: ["high", "low", "max"], default_effort: "high", max_input_tokens: 180000, default_context_window: 200000, available_context_windows: [200000, 400000] }
	]
};

function turnFrames({ id, text, credits, summary = false }) {
	return [
		{ event: "span.model_request_start", data: { id: `${id}-start`, type: "span.model_request_start", processed_at: "2026-01-01T00:00:00.000Z" } },
		{ event: "agent.thinking", data: { id: `${id}-think`, type: "agent.thinking", processed_at: "2026-01-01T00:00:03.500Z" } },
		{ event: "agent.message", data: { id: `${id}-msg`, type: "agent.message", content: [{ type: "text", text }], processed_at: "2026-01-01T00:00:04.000Z" } },
		{ event: "span.model_request_end", data: { id: `${id}-end`, type: "span.model_request_end", processed_at: "2026-01-01T00:00:04.000Z", model_usage: { credits } } },
		{ event: "session.usage", data: { id: `${id}-usage`, type: "session.usage", model_credits: credits, sandbox_runtime_credits: 0, total_credits: credits } },
		{ event: "session.status_idle", data: { id: `${id}-idle`, type: "session.status_idle", stop_reason: { type: "end_turn" } } }
	];
}

/** Fetch stub that records every request and answers the Cloud Agents calls. */
function stubFetch(state) {
	return async (url, init = {}) => {
		const method = (init.method ?? "GET").toUpperCase();
		const parsed = new URL(url);
		const path = parsed.pathname;
		state.calls.push({ method, path, headers: init.headers ?? {}, body: init.body });
		if (method === "GET" && path.endsWith("/api/v1/cloud/models")) return Response.json(CATALOG);
		if (method === "GET" && path.endsWith("/api/v1/cloud/environments")) return Response.json({ data: [{ id: "env_test" }] });
		if (method === "POST" && path.endsWith("/api/v1/cloud/agents")) {
			const body = JSON.parse(init.body);
			state.agents.push(body);
			return Response.json({ id: `agent_${state.agents.length}` });
		}
		if (method === "POST" && path.endsWith("/api/v1/cloud/sessions")) {
			const body = JSON.parse(init.body);
			state.sessions.push(body);
			return Response.json({ id: `sess_${state.sessions.length}`, agent: { model: { effective_context_window: 200000 } } });
		}
		if (method === "POST" && path.endsWith("/events")) {
			state.turns += 1;
			return Response.json({ data: [{ id: `evt_posted_${state.turns}` }] });
		}
		if (method === "POST" && path.includes("/api/v1/cloud/sessions/")) {
			// Session runtime patch (model / tools).
			if (state.refuseModelPatch && JSON.parse(init.body).agent?.model !== void 0) {
				return Response.json({ error: { message: "Field 'model.effort' is not supported by model 'gmodel'." } }, { status: 400 });
			}
			state.patches.push({ path, headers: init.headers ?? {}, body: JSON.parse(init.body) });
			return Response.json({ id: path.split("/").pop(), agent: { model: { effective_context_window: 200000 } } });
		}
		if (method === "GET" && path.endsWith("/events/stream")) return sseResponse(turnFrames(state.frames.shift() ?? { id: "x", text: "fallback", credits: 0 }));
		return Response.json({ error: { message: `unexpected ${method} ${path}` } }, { status: 500 });
	};
}

/** Run one `apply()` against the harness with the given fetch stub installed for the whole test block. */
async function boot({ config = baseConfig(), token = "pt-test", fetchImpl } = {}) {
	const { ctx, captured } = harnessContext(() => token);
	if (fetchImpl !== void 0) globalThis.fetch = fetchImpl;
	apply(ctx, config);
	return captured;
}

async function collect(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	return chunks;
}
//#endregion

//#region full adapter turn
{
	const state = { calls: [], agents: [], sessions: [], patches: [], turns: 0, refuseModelPatch: false, frames: [
		{ id: "turn1", text: "hello from Qoder", credits: 0.27 },
		{ id: "turn2", text: "second answer", credits: 0.13 }
	] };
	const captured = await boot({ fetchImpl: stubFetch(state) });
	assert.ok(captured.adapter !== void 0, "adapter registered");
	assert.ok(captured.routes.some((route) => route.path === "/qoder/credits"), "credit route registered");

	const models = await captured.adapter.listModels("qoder");
	assert.equal(models.length, 2);
	const dmodel = models.find((model) => model.id === "dmodel");
	assert.deepEqual(dmodel.badge, { text: "0.5×", tone: "info" });
	assert.ok(dmodel.description.includes("Credit rate: 0.5×"));
	const gmodel = models.find((model) => model.id === "gmodel");
	assert.deepEqual(gmodel.badge, { text: "0.8×", tone: "info" });
	console.log(`ok ${++checks} - listModels badges/descriptions`);

	const resolved = await captured.adapter.resolveModel("qoder", "dmodel");
	assert.deepEqual(resolved.reasoning.efforts.map((effort) => effort.id), ["high", "max"]);
	assert.equal(resolved.reasoning.defaultEffort, "max");
	assert.equal(resolved.context.contextWindow, 96000);

	// One bridged turn: thinking → reasoning block, message → text, spans → credits.
	const chunks = await collect(captured.adapter.stream({
		provider: "qoder",
		model: "dmodel",
		reasoningEffort: "high",
		sessionId: "session-test",
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		tools: []
	}));
	const reasoning = chunks.find((chunk) => chunk.type === "block-end" && chunk.block.type === "reasoning");
	assert.ok(reasoning !== undefined, "reasoning block emitted for agent.thinking");
	assert.ok(reasoning.block.text.includes("Thinking phase"), reasoning.block.text);
	assert.ok(reasoning.block.text.includes("High"), reasoning.block.text);
	const text = chunks.find((chunk) => chunk.type === "block-end" && chunk.block.type === "text");
	assert.equal(text.block.text, "hello from Qoder");
	const finish = chunks.at(-1);
	assert.deepEqual(finish, { type: "finish", reason: { kind: "stop" } });
	assert.equal(state.agents[0].model.effort, "high", "Agent created with the selected effort");
	console.log(`ok ${++checks} - first turn chunks (thinking, text, credits)`);

	const route = captured.routes.find((item) => item.path === "/qoder/credits");
	const statsResponse = fakeResponse();
	route.handler({ method: "GET", url: "/qoder/credits?sessionId=session-test" }, statsResponse);
	const stats = JSON.parse(statsResponse.body);
	assert.equal(stats.turn.credits, 0.27);
	assert.equal(stats.turn.calls, 1);
	assert.equal(stats.session.total, 0.27);
	assert.equal(stats.model, "dmodel");
	assert.equal(stats.effort, "high");
	assert.equal(stats.priceFactor, 0.5);
	console.log(`ok ${++checks} - credit route reports the first turn`);

	// Second turn, different model + effort: patched in place, no new Agent or Session.
	state.frames.unshift({ id: "turn3", text: "switched model", credits: 0.2 });
	await collect(captured.adapter.stream({
		provider: "qoder",
		model: "gmodel",
		reasoningEffort: "max",
		sessionId: "session-test",
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "text", text: "hello from Qoder" }] },
			{ role: "user", content: [{ type: "text", text: "next" }] }
		],
		tools: []
	}));
	assert.equal(state.agents.length, 1, "model switch reuses the Agent path via session patch");
	assert.equal(state.sessions.length, 1, "model switch preserves the cloud Session");
	const patch = state.patches.at(-1);
	assert.deepEqual(patch.body, { agent: { model: { id: "gmodel", effort: "max" } } });
	assert.equal(patch.headers["x-qoder-beta"], "session-agent-patch-2026-07-21");
	const afterSwitch = JSON.parse((() => {
		const response = fakeResponse();
		route.handler({ method: "GET", url: "/qoder/credits?sessionId=session-test" }, response);
		return response.body;
	})());
	assert.equal(afterSwitch.turn.credits, 0.2);
	assert.equal(afterSwitch.model, "gmodel");
	assert.equal(afterSwitch.effort, "max");
	console.log(`ok ${++checks} - model/effort switch patches the Session in place`);
	globalThis.fetch = realFetch;
}
//#endregion

//#region patch refusal falls back to a fresh Session with replay
{
	const state = { calls: [], agents: [], sessions: [], patches: [], turns: 0, refuseModelPatch: true, frames: [
		{ id: "turn1", text: "first", credits: 0.1 },
		{ id: "turn2", text: "after fallback", credits: 0.2 }
	] };
	const captured = await boot({ fetchImpl: stubFetch(state) });
	await collect(captured.adapter.stream({
		provider: "qoder",
		model: "dmodel",
		reasoningEffort: "high",
		sessionId: "session-fallback",
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		tools: []
	}));
	await collect(captured.adapter.stream({
		provider: "qoder",
		model: "gmodel",
		reasoningEffort: "high",
		sessionId: "session-fallback",
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "text", text: "first" }] },
			{ role: "user", content: [{ type: "text", text: "second" }] }
		],
		tools: []
	}));
	assert.equal(state.sessions.length, 2, "refused patch starts a new cloud Session");
	const sent = state.calls.filter((call) => call.method === "POST" && call.path.endsWith("/events")).at(-1);
	const body = JSON.parse(sent.body);
	assert.ok(body.events[0].content[0].text.includes("[Context replay:"), "cold Session receives the transcript replay");
	const stats = fakeResponse();
	captured.routes.find((route) => route.path === "/qoder/credits").handler({ method: "GET", url: "/qoder/credits?sessionId=session-fallback" }, stats);
	const payload = JSON.parse(stats.body);
	assert.ok(payload.session.carriedCredits >= 0.1, "previous cloud Session's credits carried forward");
	console.log(`ok ${++checks} - refused patch falls back to a fresh Session with replay`);
	globalThis.fetch = realFetch;
}
//#endregion

//#region options / config schema
ok("Config exposes the new default reasoning effort field", () => {
	const resolved = Config({});
	assert.equal(resolved.defaultReasoningEffort, "");
	assert.equal(typeof resolved.defaultModel, "string");
});
//#endregion

console.log(`\n${checks} offline checks passed`);

//#region live (optional)
if (process.env.QODER_LIVE === "1") {
	globalThis.fetch = realFetch;
	const credentialsPath = join(homedir(), ".dsh", ".credentials.yaml");
	const text = readFileSync(credentialsPath, "utf8");
	const token = text.match(/QODER_API_KEY:\s*(\S+)/)?.[1]?.replace(/^["']|["']$/g, "");
	if (token === void 0 || token.length === 0) throw new Error("QODER_LIVE=1 but no QODER_API_KEY in ~/.dsh/.credentials.yaml");
	const captured = await boot({ token, config: baseConfig({ bridgeLocalTools: false }) });
	const models = await captured.adapter.listModels("qoder");
	const effortModel = models.find((model) => model.id === "dmodel") ?? models.find((model) => model.reasoning !== void 0);
	if (effortModel === undefined) throw new Error("live catalog did not list a reasoning-capable model");
	const resolved = await captured.adapter.resolveModel("qoder", effortModel.id);
	assert.ok(resolved.reasoning.efforts.length > 0, "live catalog exposes reasoning levels");
	const effort = resolved.reasoning.defaultEffort ?? resolved.reasoning.efforts.at(-1).id;
	const chunks = await collect(captured.adapter.stream({
		provider: "qoder",
		model: effortModel.id,
		reasoningEffort: effort,
		sessionId: "live-session-test",
		messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: OK" }] }],
		tools: []
	}));
	const textBlock = chunks.find((chunk) => chunk.type === "block-end" && chunk.block.type === "text");
	assert.ok(textBlock !== undefined, `live turn produced text: ${JSON.stringify(chunks).slice(0, 600)}`);
	const stats = fakeResponse();
	captured.routes.find((route) => route.path === "/qoder/credits").handler({ method: "GET", url: "/qoder/credits?sessionId=live-session-test" }, stats);
	const payload = JSON.parse(stats.body);
	assert.equal(payload.known, true);
	assert.ok(payload.turn.credits > 0, `live turn reported credits: ${JSON.stringify(payload)}`);
	assert.equal(payload.model, effortModel.id);
	assert.equal(payload.effort, effort);
	console.log(`ok ${++checks} - live turn on ${effortModel.id} (effort ${effort}) reported ${payload.turn.credits} credits`);
}
//#endregion

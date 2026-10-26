// Regression test: a turn abandoned while the cloud Session was paused on a
// bridged tool call.
//
// Symptom it locks down (reported from a real host, 2026-10-26): stop the turn
// while a local tool is pending, send the next message, and every later turn
// failed with "qoder: resuming a paused turn but no matching tool results were
// supplied" — the cached Session record stayed in its `awaiting` phase and the
// adapter refused the new user message instead of recovering.
//
// Run: node test/test-abandoned-pause.mjs
function jsonResp(obj, status = 200) {
	return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

// Turn 1: the model asks for a bridged tool, so the Session pauses.
function* sseToolPause() {
	yield "event: agent.custom_tool_use\nid: evt_c1\ndata: {\"type\":\"agent.custom_tool_use\",\"id\":\"evt_c1\",\"name\":\"dsh_Read\",\"input\":{\"file_path\":\"d:/dsh/version\"}}\n\n";
	yield "event: session.status_idle\nid: evt_i1\ndata: {\"type\":\"session.status_idle\",\"id\":\"evt_i1\",\"stop_reason\":{\"type\":\"requires_action\",\"event_ids\":[\"evt_c1\"]}}\n\n";
}

// Turn 2 (after the abandonment): a plain answer.
function* sseAnswer() {
	yield "event: agent.message\nid: evt_m2\ndata: {\"type\":\"agent.message\",\"id\":\"evt_m2\",\"content\":[{\"type\":\"text\",\"text\":\"好的，重新开始。\"}]}\n\n";
	yield "event: session.status_idle\nid: evt_i2\ndata: {\"type\":\"session.status_idle\",\"id\":\"evt_i2\",\"stop_reason\":{\"type\":\"end_turn\"}}\n\n";
}

const scripts = [sseToolPause, sseAnswer];
const posted = [];
const requestLog = [];
let sessionStatusPolls = 0;

globalThis.fetch = async (url, init = {}) => {
	const u = String(url);
	const method = init.method ?? "GET";
	requestLog.push({ url: u, method });
	if (u.endsWith("/api/v1/cloud/environments")) return jsonResp({ data: [{ id: "env_1" }] });
	if (u.endsWith("/api/v1/cloud/agents") && method === "POST") return jsonResp({ id: "agent_1" });
	if (u.endsWith("/api/v1/cloud/sessions") && method === "POST") return jsonResp({ id: "sess_1" });
	if (u.endsWith("/api/v1/cloud/sessions/sess_1") && method === "GET") {
		sessionStatusPolls += 1;
		return jsonResp({ id: "sess_1", status: "idle" });
	}
	if (u.endsWith("/api/v1/cloud/sessions/sess_1/events/stream")) {
		const script = scripts.shift() ?? sseAnswer;
		return new Response(ReadableStream.from(Array.from(script(), (s) => new TextEncoder().encode(s))), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}
	if (u.endsWith("/api/v1/cloud/sessions/sess_1/events") && method === "POST") {
		const events = JSON.parse(String(init.body)).events;
		posted.push(...events);
		return jsonResp({ data: events.map((event, index) => ({ id: `evt_posted_${posted.length}_${index}`, type: event.type })) });
	}
	if (u.endsWith("/api/v1/cloud/models")) {
		return jsonResp({ data: [{ id: "ultimate", type: "model", display_name: "Ultimate", is_enabled: true, max_input_tokens: 200000, default_context_window: 200000, available_context_windows: [200000] }] });
	}
	return jsonResp({}, 404);
};

process.env.QODER_PAT = "pt-test-token";
const ctx = {
	fiber: { entry: { options: { id: "llm-qoder" } } },
	logger: { warn: () => {} },
	inject: (_need, cb) => cb({ effect: () => {}, settings: { configure: () => {} } }),
	on: () => {},
	get: () => void 0,
	llm: {
		registerConfigurableProviders: () => {},
		registerAdapter: (_providers, adapter) => {
			ctx.adapter = adapter;
			return { replace: () => {} };
		},
	},
};
const mod = await import(new URL("../index.js", import.meta.url));
mod.apply(ctx, { apiKeyEnv: "QODER_PAT", baseURL: "https://api.qoder.com", defaultModel: "ultimate" });

const run = async (messages) => {
	const chunks = [];
	for await (const chunk of ctx.adapter.stream({ provider: "qoder", model: "ultimate", sessionId: "conv-abandon", tools: [{ name: "Read", description: "read", parameters: { type: "object", properties: {} } }], messages })) {
		chunks.push(chunk);
	}
	return chunks;
};

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });

// Turn 1: pauses on the bridged tool call.
const first = await run([user("读一下版本文件")]);
const firstFinish = first.find((c) => c.type === "finish");
const toolCall = first.find((c) => c.type === "tool-call-delta");
const paused = firstFinish?.reason?.kind === "tool-calls" && toolCall !== undefined;

// The user abandons that turn and sends a new message instead of the tool result.
posted.length = 0;
requestLog.length = 0;
let second;
let failure;
try {
	second = await run([user("读一下版本文件"), { role: "assistant", content: [{ type: "tool-call", id: toolCall.id, name: toolCall.name, arguments: toolCall.argumentsDelta }] }, user("算了，直接告诉我你在线吗")]);
} catch (error) {
	failure = error;
}

const interrupted = posted.some((event) => event.type === "user.interrupt");
const sentUser = posted.find((event) => event.type === "user.message");
const text = (second ?? []).filter((c) => c.type === "text-delta").map((c) => c.text).join("");

const results = {
	"turn 1 paused on the bridged tool": paused,
	"turn 2 did not fail": failure === undefined,
	"abandoned turn was interrupted in the cloud": interrupted,
	"new user message was sent after the interrupt": sentUser !== undefined && sentUser.content[0].text.includes("在线吗"),
	"session idle was polled": sessionStatusPolls > 0,
	"turn 2 produced an answer": text.includes("重新开始"),
};
console.log("abandoned pause:", results);
if (failure !== undefined) console.log("failure:", failure?.code, String(failure?.message).slice(0, 120));
const ok = Object.values(results).every(Boolean);
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);

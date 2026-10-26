// Regression test: a message typed *while the tools were running* must reach the
// model.
//
// Symptom it locks down (reported from a real host, 2026-10-26): user text
// injected mid-turn never arrived — the resume call forwarded only the tool
// results, so the instruction was silently dropped.
//
// Qoder accepts a `user.message` in the same batch as `user.custom_tool_result`
// (verified against the live API: the model honoured it), so the resume POST must
// carry both, results first.
//
// Run: node test/test-steering.mjs
function jsonResp(obj, status = 200) {
	return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

function* ssePause() {
	yield "event: agent.custom_tool_use\nid: evt_c1\ndata: {\"type\":\"agent.custom_tool_use\",\"id\":\"evt_c1\",\"name\":\"dsh_Bash\",\"input\":{\"command\":\"ls\"}}\n\n";
	yield "event: session.status_idle\nid: evt_i1\ndata: {\"type\":\"session.status_idle\",\"id\":\"evt_i1\",\"stop_reason\":{\"type\":\"requires_action\",\"event_ids\":[\"evt_c1\"]}}\n\n";
}

function* sseAnswer() {
	yield "event: agent.message\nid: evt_m2\ndata: {\"type\":\"agent.message\",\"id\":\"evt_m2\",\"content\":[{\"type\":\"text\",\"text\":\"按你说的用中文回答。\"}]}\n\n";
	yield "event: session.status_idle\nid: evt_i2\ndata: {\"type\":\"session.status_idle\",\"id\":\"evt_i2\",\"stop_reason\":{\"type\":\"end_turn\"}}\n\n";
}

const scripts = [ssePause, sseAnswer];
const posts = [];

globalThis.fetch = async (url, init = {}) => {
	const u = String(url);
	const method = init.method ?? "GET";
	if (u.endsWith("/api/v1/cloud/environments")) return jsonResp({ data: [{ id: "env_1" }] });
	if (u.endsWith("/api/v1/cloud/agents") && method === "POST") return jsonResp({ id: "agent_1" });
	if (u.endsWith("/api/v1/cloud/sessions") && method === "POST") return jsonResp({ id: "sess_1" });
	if (u.endsWith("/api/v1/cloud/sessions/sess_1") && method === "GET") return jsonResp({ id: "sess_1", status: "idle" });
	if (u.endsWith("/api/v1/cloud/sessions/sess_1/events/stream")) {
		const script = scripts.shift() ?? sseAnswer;
		return new Response(ReadableStream.from(Array.from(script(), (s) => new TextEncoder().encode(s))), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}
	if (u.endsWith("/api/v1/cloud/sessions/sess_1/events") && method === "POST") {
		const events = JSON.parse(String(init.body)).events;
		posts.push(events);
		return jsonResp({ data: events.map((event, index) => ({ id: `evt_posted_${posts.length}_${index}`, type: event.type })) });
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

const tools = [{ name: "Bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } } } }];
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const run = async (messages) => {
	const chunks = [];
	for await (const chunk of ctx.adapter.stream({ provider: "qoder", model: "ultimate", sessionId: "conv-steer", tools, messages })) chunks.push(chunk);
	return chunks;
};

// Turn 1: the model calls a bridged tool, so the Session pauses.
const first = await run([user("列一下目录")]);
const call = first.find((c) => c.type === "tool-call-delta");
const paused = first.find((c) => c.type === "finish")?.reason?.kind === "tool-calls" && call !== undefined;

// Turn 2: dsh executed the tool and now re-calls with the result; the user typed
// an instruction while that tool was running.
posts.length = 0;
const steeringText = "补充：请用中文回答";
const second = await run([
	user("列一下目录"),
	{ role: "assistant", content: [{ type: "tool-call", id: call.id, name: call.name, arguments: call.argumentsDelta }] },
	{ role: "tool", toolCallId: call.id, content: [{ type: "text", text: "a.txt b.txt" }] },
	user(steeringText),
]);

const resumePost = posts.find((events) => events.some((event) => event.type === "user.custom_tool_result"));
const resultIndex = resumePost?.findIndex((event) => event.type === "user.custom_tool_result") ?? -1;
const steeringIndex = resumePost?.findIndex((event) => event.type === "user.message") ?? -1;
const steeringEvent = resumePost?.[steeringIndex];
const text = second.filter((c) => c.type === "text-delta").map((c) => c.text).join("");

const results = {
	"turn 1 paused on the bridged tool": paused,
	"resume carried the tool result": resultIndex >= 0,
	"resume carried the injected instruction": steeringIndex >= 0,
	"tool result came before the steering message": resultIndex >= 0 && steeringIndex > resultIndex,
	"steering text is exactly what the user typed": steeringEvent?.content?.[0]?.text === steeringText,
	"turn 2 produced an answer": text.includes("中文"),
};
console.log("steering:", results);
const ok = Object.values(results).every(Boolean);
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);

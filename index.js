/**
 * @file Qoder LLM provider for DeepSeek Harness — self-contained.
 *
 * Qoder exposes its models through the *Cloud Agents* API: a stateful runtime
 * where an **Agent** (model + system prompt + tool set) is bound to an
 * **Environment** (a managed cloud sandbox) to form a **Session**. A turn is
 * driven by POSTing a `user.message` event and reading the assistant back over
 * an SSE event stream (`session.status_running` → `agent.thinking` →
 * `agent.message` → `agent.tool_use` / `agent.tool_result` → `session.status_idle`).
 *
 * dsh's `llm` seam is a *stateless* streaming-completion contract: it hands an
 * adapter the full message history plus dsh's own tool schemas and expects
 * `StreamChunk`s (text/reasoning deltas, tool-call deltas, a finish).
 *
 * This adapter bridges the two shapes:
 *   - One dsh conversation (`sessionId`) maps to one long-lived Qoder Session,
 *     so Qoder keeps its own history server-side and we only send the newest
 *     user turn.
 *   - With `bridgeLocalTools` (the default) dsh's own tools are re-published to
 *     Qoder as *client-side custom tools*: Qoder decides, pauses the Session with
 *     `stop_reason: requires_action`, and we surface the call to dsh as a
 *     `tool-call` ending in `{ kind: 'tool-calls' }`. dsh executes it locally and
 *     re-invokes us with the result, which we hand back as
 *     `user.custom_tool_result` so the same Session resumes. The model therefore
 *     reads and edits the *user's* files, not the cloud sandbox.
 *     Qoder's own filesystem tools are excluded from that mode: leaving them
 *     visible makes the model quietly read its empty sandbox and report that the
 *     user's files are missing.
 *   - With `bridgeLocalTools: false` Qoder runs its own cloud tools and only the
 *     final assistant text comes back, finishing with `{ kind: 'stop' }`.
 *   - Context length is a two-sided fact. dsh meters its own history against the
 *     `context.contextWindow` this adapter reports, while the Qoder Session holds
 *     its own server-side context under the Agent's `model.context_window` tier.
 *     The reported figure is therefore taken from the model catalog
 *     (`default_context_window`, capped by `max_input_tokens`) rather than guessed,
 *     and `agentContextWindow` can raise the cloud-side tier to match.
 *   - Authentication is a Personal Access Token (PAT), resolved through dsh's
 *     `credentials` service when available and otherwise from the launching
 *     environment, then sent as `Authorization: Bearer <PAT>`.
 *
 * Design constraint that shapes this file: a profile-linked plugin is resolved
 * outside `app.asar`, so it must not import `@deepseek-ai/*` service packages
 * (they are packed inside the archive and do not resolve here). It therefore
 * reaches the LLM registry through the Cordis `ctx` services (`ctx.llm`,
 * `ctx.get('credentials')`), registers a *duck-typed* adapter (`llm.registerAdapter`
 * only calls the adapter's methods), uses native `fetch`, parses SSE by hand, and
 * throws an `Error` carrying a string `.code`, which is how the harness inspects
 * adapter failures. The one exception is `@deepseek-ai/schemastery` (+ its sole
 * runtime dep `cosmokit`), which is *vendored* into this package's own
 * `node_modules` so the plugin can export a real `Config` schema — the thing that
 * makes the provider show up in Settings → Models.
 */

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
// Vendored so the Settings → Models page can build a real config form for this
// provider. A profile-linked plugin resolves bare specifiers against its own
// `node_modules` (see the plugin README), so `@deepseek-ai/schemastery` and its
// only runtime dependency `@deepseek-ai/cosmokit` are shipped alongside index.js.
import z from "@deepseek-ai/schemastery";

/** Plugin identity as it appears in the profile composition. */
const name = "llm-qoder";
/** Services this plugin needs from the Cordis container. */
const inject = ["llm"];
/** Provider route owned by this plugin. */
const PROVIDER = "qoder";
/** Default display name for the provider in the UI. */
const PROVIDER_DISPLAY = "Qoder";
/** Qoder Cloud Agents REST root (relative to the base URL). */
const CLOUD_API = "/api/v1/cloud";
/** Idle ceiling for one streamed turn before the connection is aborted. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
/**
 * How long to wait for a Session that answered 409 to become idle again. Qoder
 * retries an overloaded model with `session.status_rescheduled`, which holds the
 * Session for as long as the retry loop lasts; past this ceiling the turn fails
 * with SESSION_BUSY instead of hanging.
 */
const BUSY_WAIT_TIMEOUT_MS = 20000;
/** Ceiling for the best-effort `user.interrupt` sent when a turn is cancelled locally. */
const INTERRUPT_TIMEOUT_MS = 8000;
/**
 * Replay budget for a cold Session: how much of the earlier conversation the
 * client sends along with the first message after a model switch or a host
 * restart. Kept modest because this text is billed as input tokens every time a
 * Session has to be rebuilt, and because a truncated transcript is still far
 * better than a model that believes the conversation just started.
 */
const REPLAY_BUDGET_CHARS = 24000;
/** Per-turn ceiling inside the replayed transcript. */
const REPLAY_ENTRY_CHARS = 2500;
/** Opens the replayed transcript (see buildHistoryReplay). */
const REPLAY_HEADER = "[Context replay: transcript of this conversation before the current message, supplied by the dsh client because this cloud Session was just created. Treat it as already-spoken history; do not repeat or summarise it.]";
/** Separates the replayed transcript from the actual request. */
const REPLAY_FOOTER = "[End of context replay. The current request follows.]";
/** Attribution user-agent, since the shared `attributionHeaders()` is not importable. */
const USER_AGENT = "dsh-plugin-qoder/1.0";
/**
 * Hard ceiling Qoder enforces on one Agent's `tools` array: exceeding it is a
 * `400 invalid_request_error` ("tools exceeds the maximum of 128 entries").
 * dsh hands over every tool visible to the calling agent — host tools, tools
 * registered by other plugins, and `mcp__*` tools bridged by the MCP client —
 * so a heavily equipped profile can legitimately overflow the limit.
 */
const QODER_MAX_TOOL_ENTRIES = 128;
/**
 * Fallback context window reported to dsh when neither the config nor the model
 * catalog states one. dsh meters its own history against this number to decide
 * when to compact, so it must describe the *model's* real window — the Qoder
 * catalog normally supplies it via `default_context_window`.
 */
const DEFAULT_CONTEXT_WINDOW = 200000;
/**
 * Qoder's reasoning-effort vocabulary, ordered from least to greatest. The
 * model catalog advertises a per-model subset in `efforts` (in no dependable
 * order), and the Agent accepts it as `model.effort`; dsh's model picker wants
 * the selectable levels ordered least→greatest, so everything is ranked here.
 */
const EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"];
/**
 * Display metadata for each effort level. These names are provider strings, the
 * same way `llm-deepseek` labels its own levels, so the picker reads them
 * identically regardless of UI language.
 */
const EFFORT_INFO = {
	none: {
		name: "None",
		description: "Disable the reasoning phase; answer directly."
	},
	low: {
		name: "Low",
		description: "Fast, light reasoning for routine tasks."
	},
	medium: {
		name: "Medium",
		description: "Balanced reasoning for everyday work."
	},
	high: {
		name: "High",
		description: "Deeper reasoning for complex tasks."
	},
	xhigh: {
		name: "X-High",
		description: "Extra reasoning depth for hard problems."
	},
	max: {
		name: "Max",
		description: "Maximum reasoning effort; slowest and most expensive."
	}
};
/**
 * Beta header Qoder requires before a live Session's `agent.model` may be
 * changed. Patching the Session keeps its server-side history, so switching the
 * model or reasoning level no longer starts a new cloud conversation.
 */
const SESSION_AGENT_PATCH_BETA = "session-agent-patch-2026-07-21";
/**
 * Exact HTTP route the plugin's browser half reads for credit statistics.
 *
 * Why a plugin-owned route: credits are runtime facts produced inside a turn
 * (`span.model_request_end.model_usage.credits` and `session.usage`), not
 * settings and not session events, so the Web UI has no built-in way to read
 * them. `ctx.get('webServer')` is the Host's own route service; the browser half
 * requests the same origin it was served from. The path deliberately avoids
 * `/api` (the RPC channel) and `/plugins` (client bundles).
 */
const CREDIT_STATS_ROUTE = "/qoder/credits";
/**
 * Appended to the Agent's system prompt while local-tool bridging is on.
 *
 * Without it the model happily calls a *built-in* tool, reads the equivalent path
 * inside Qoder's empty cloud sandbox, and tells the user their files do not exist.
 */
const BRIDGE_DIRECTIVE = "IMPORTANT: You run in Qoder's cloud, which has NO access to the user's computer. The user's real files, code and commands live on their local machine and are reachable ONLY through the client-side tools whose names start with the bridging prefix (they are the tools listed as custom, e.g. dsh_Read, dsh_Bash). Never use a built-in sandbox tool to inspect the user's project, and never claim a user file is missing until a bridged tool has been called and returned an error. Call bridged tools whenever answering requires reading files, searching code or running commands.";

/**
 * Plugin configuration schema. Exporting a real Schemastery `Config` is what
 * makes the Settings → Models page render a card for this provider: the settings
 * service only materialises a namespace (and thus a Models row) for a plugin
 * whose Config has at least one `volatile` field. `apiKeyEnv` is marked with the
 * `credential-ref` role, so the page exposes a single "API key" box that stores
 * the PAT under the reference named by its value (`QODER_API_KEY` by default),
 * which is exactly what `resolveToken` looks up at request time.
 */
const Config = z.object({
	apiKeyEnv: z.string().role("credential-ref").default("QODER_API_KEY").volatile(),
	baseURL: z.string().default("https://api.qoder.com"),
	defaultModel: z.string().default("ultimate"),
	// Context window reported to dsh, which uses it for its own compaction budget.
	// Leave it at 0 to take the window the Qoder model catalog states for the
	// selected model (`default_context_window`, capped by `max_input_tokens`); set
	// it only to force a different figure.
	contextWindow: z.number().default(0),
	// Context-window tier to hand Qoder as `model.context_window` when creating the
	// Agent (0 = keep the model's default tier). It must be one of that model's
	// `available_context_windows`; an unavailable value is dropped with a warning.
	// Larger tiers cost more Qoder credits per turn.
	agentContextWindow: z.number().default(0),
	// Default reasoning effort materialised into requests when a conversation has
	// not picked one ("" = whichever `default_effort` the model catalog states).
	// It must be a level that model advertises in its `efforts` array; an
	// unsupported value is simply not offered for that model.
	defaultReasoningEffort: z.string().default(""),
	maxTokens: z.number().default(8192),
	tlsMaxVersion: z.string().default("TLSv1.2"),
	systemPrompt: z.string().default(""),
	environmentId: z.string().default(""),
	autoCreateEnvironment: z.boolean().default(true),
	agentTools: z.string().default("Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch"),
	// When true (default) the adapter does NOT let Qoder run tools in its cloud
	// sandbox. Instead it re-publishes dsh's own tool list to Qoder as
	// *client-side custom tools*, so the model can decide but the side effects
	// (read/write/exec) happen on this machine through dsh's tool loop. Turning
	// it off restores the original text-only/cloud-tool behaviour.
	bridgeLocalTools: z.boolean().default(true),
	// Built-in Qoder tools that stay enabled while bridging. Must stay non-empty
	// and free of filesystem/shell tools: an empty allowlist switches *all*
	// built-ins on, which lets the model read its sandbox instead of the user's
	// disk. Set to "" to fall back to the minimal "DeliverArtifacts" only.
	cloudTools: z.string().default("DeliverArtifacts"),
	// Prefix applied to every bridged tool name when registering it with Qoder.
	// Required because a custom tool name may not collide with a built-in name
	// such as Read/Bash; it is stripped again when the call is handed back to dsh.
	localToolPrefix: z.string().default("dsh_"),
	// When true (default) a *cold* cloud Session (just rebuilt after a model switch,
	// a host restart, or an abandoned Session) is seeded with a transcript of the
	// dsh-side conversation, so switching models no longer makes the model forget
	// everything. Costs input tokens only on that first turn; turn it off to keep
	// the cloud Session strictly server-side-history-only.
	replayHistory: z.boolean().default(true),
	displayName: z.string().default(PROVIDER_DISPLAY),
});

/**
 * Error carrying a harness-style string code. The `llm` registry classifies
 * adapter failures by `error.code`, so a dependency-free plugin reproduces that
 * contract locally instead of importing `LlmError`.
 */
class QoderError extends Error {
	constructor(message, code, failure) {
		super(message);
		this.name = "QoderError";
		this.code = code;
		if (failure !== void 0) Object.assign(this, failure);
	}
}

/**
 * Normalize the live plugin config into a plain snapshot. Volatile-wrapped
 * leaves (when present) expose `.get()`; plain values pass through untouched.
 * @param config - the `config` object handed to `apply()`.
 * @param env - a value reader, defaulting to `process.env`.
 * @returns detached connection facts.
 */
/**
 * Read a value that cordis may hand back either raw or wrapped in a volatile
 * `{ get() }` box, returning the underlying scalar in both cases.
 * @param value - raw leaf or volatile box.
 * @returns the unwrapped value, or `undefined` when a box throws.
 */
function unwrapValue(value) {
	if (value && typeof value === "object" && typeof value.get === "function") {
		try {
			return value.get();
		} catch {
			return void 0;
		}
	}
	return value;
}

/** Read one config field, transparently unwrapping a volatile box. */
function pick(config, key) {
	return unwrapValue(config == null ? void 0 : config[key]);
}

/** Coerce a possibly-boxed / possibly-number config field to a non-empty string. */
function str(value, fallback) {
	const v = unwrapValue(value);
	if (typeof v === "string" && v.length > 0) return v;
	if (typeof v === "number" && Number.isFinite(v)) return String(v);
	return fallback;
}

function resolveConnection(config, env = readProcessEnv) {
	const baseURL = trimTrailing(str(pick(config, "baseURL"), "https://api.qoder.com"));
	let parsed;
	try {
		parsed = new URL(baseURL);
	} catch {
		throw new QoderError(`qoder: baseURL is not a valid URL: "${baseURL}"`, "INVALID_REQUEST");
	}
	if (!["http:", "https:"].includes(parsed.protocol)) throw new QoderError(`qoder: baseURL must be HTTP(S), got "${baseURL}"`, "INVALID_REQUEST");
	const apiKeyRef = str(pick(config, "apiKeyEnv"), "QODER_API_KEY");
	const ambient = nonEmpty(env(apiKeyRef)) ?? nonEmpty(env("QODER_ACCESS_TOKEN"));
	return {
		baseURL,
		apiKeyRef,
		defaultModel: str(pick(config, "defaultModel"), "ultimate"),
		contextWindow: positiveInt(pick(config, "contextWindow"), 0),
		agentContextWindow: positiveInt(pick(config, "agentContextWindow"), 0),
		defaultReasoningEffort: str(pick(config, "defaultReasoningEffort"), "").trim().toLowerCase(),
		maxTokens: positiveInt(pick(config, "maxTokens"), 8192),
		systemPrompt: str(pick(config, "systemPrompt"), ""),
		environmentId: str(pick(config, "environmentId"), "").trim(),
		autoCreateEnvironment: pick(config, "autoCreateEnvironment") !== false,
		tools: str(pick(config, "agentTools"), "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch").split(",").map((tool) => tool.trim()).filter(Boolean),
		bridgeLocalTools: pick(config, "bridgeLocalTools") !== false,
		cloudTools: str(pick(config, "cloudTools"), "DeliverArtifacts").split(",").map((tool) => tool.trim()).filter(Boolean),
		localToolPrefix: str(pick(config, "localToolPrefix"), "dsh_"),
		replayHistory: pick(config, "replayHistory") !== false,
		displayName: str(pick(config, "displayName"), PROVIDER_DISPLAY),
		ambientKey: ambient
	};
}

function readProcessEnv(key) {
	return typeof process !== "undefined" && process.env ? process.env[key] : void 0;
}
function nonEmpty(value) {
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
function trimTrailing(value) {
	return String(value).replace(/\/+$/, "");
}

/**
 * Normalize a pasted credential: strip surrounding whitespace and quotes plus an
 * accidental `Bearer ` prefix. These are the common ways an otherwise valid PAT
 * ends up rejected as invalid.
 */
function normalizeToken(raw) {
	let value = String(raw).trim();
	value = value.replace(/^bearer\s+/i, "");
	return value.replace(/^["']+|["']+$/g, "").trim();
}
function positiveInt(value, fallback) {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Pin the largest TLS version Node is willing to negotiate.
 *
 * Some networks reset TLS 1.3 handshakes to the Qoder host: `curl` (which
 * offers 1.2) succeeds while Node/undici (which defaults to 1.3) gets
 * `ECONNRESET`, surfacing as a generic transport failure. Lowering the process
 * ceiling makes the built-in `fetch` negotiate 1.2 and reach the API. TLS 1.2
 * remains current and universally supported; `tlsMaxVersion` lets a network
 * that later allows 1.3 opt back in.
 * @param version - "TLSv1.2" or "TLSv1.3".
 */
function pinTlsMax(version) {
	const wanted = version === "TLSv1.3" ? "TLSv1.3" : "TLSv1.2";
	try {
		if (tls.DEFAULT_MAX_VERSION !== wanted) tls.DEFAULT_MAX_VERSION = wanted;
	} catch {
		/* best-effort: an environment that forbids the change keeps its default */
	}
}

/**
 * Turn the last dsh user message into Qoder `user.message` text. Qoder keeps its
 * own history inside the Session, so only the newest user turn is forwarded.
 * @param messages - dsh message history.
 * @returns extracted text, or an empty string when none is present.
 */
function extractUserText(messages) {
	if (!Array.isArray(messages)) return "";
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "user" || !Array.isArray(message.content)) continue;
		const text = message.content.filter((block) => block?.type === "text" && typeof block.text === "string" && block.text.length > 0).map((block) => block.text).join("\n");
		if (text.length > 0) return text;
	}
	return "";
}

/**
 * Collect the trailing run of user messages — everything dsh splices into the
 * current turn, in order. A brand-new Qoder Session has no server-side history
 * to lean on, and dsh places the task text *before* the workspace, runtime
 * context, and skills reminders of that same turn, so forwarding only the newest
 * user message hands the cloud agent a bare reminder and no task at all.
 * Stops at the first non-user message, so a resumed conversation still forwards
 * only the current turn and never replays earlier assistant turns.
 * @param messages - dsh message history.
 * @returns the current turn's user texts joined in order, or "" when none.
 */
function extractTurnUserText(messages) {
	if (!Array.isArray(messages)) return "";
	const texts = [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "user" || !Array.isArray(message.content)) break;
		const text = message.content.filter((block) => block?.type === "text" && typeof block.text === "string" && block.text.length > 0).map((block) => block.text).join("\n");
		if (text.length > 0) texts.push(text);
	}
	return texts.reverse().join("\n\n");
}

/**
 * Rebuild a readable transcript of everything spoken before the current turn.
 *
 * dsh re-sends the whole conversation on every call, so this is the client's only
 * source of history once a Qoder Session has to be rebuilt (model switch, host
 * restart, abandoned Session). Tool traffic is omitted on purpose: the cloud
 * Session replays its own tool loop, and a transcript of stale tool results would
 * read as instructions to run them again.
 * @param messages - dsh message history, including the current turn at the tail.
 * @param budgetChars - total character ceiling; the newest turns are kept.
 * @returns labelled `user:` / `assistant:` lines, or "" when there is no history.
 */
function buildHistoryReplay(messages, budgetChars = REPLAY_BUDGET_CHARS) {
	if (!Array.isArray(messages) || messages.length === 0) return "";
	// The trailing run of user messages is the CURRENT turn (dsh splices the task
	// text, workspace reminder, runtime context and skills notice as consecutive
	// user messages); everything before it is history.
	let start = messages.length;
	while (start > 0 && messages[start - 1]?.role === "user") start -= 1;
	const entries = [];
	for (let index = 0; index < start; index += 1) {
		const message = messages[index];
		if (message?.role !== "user" && message?.role !== "assistant") continue;
		if (!Array.isArray(message.content)) continue;
		const text = message.content.filter((block) => block?.type === "text" && typeof block.text === "string" && block.text.length > 0).map((block) => block.text).join("\n").trim();
		if (text.length === 0) continue;
		const clipped = text.length > REPLAY_ENTRY_CHARS ? `${text.slice(0, REPLAY_ENTRY_CHARS)}…` : text;
		entries.push(`${message.role === "user" ? "user" : "assistant"}: ${clipped}`);
	}
	if (entries.length === 0) return "";
	// Keep the newest entries that fit the budget: the tail of a conversation is
	// what the next answer actually depends on.
	const kept = [];
	let total = 0;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const size = entries[index].length + 1;
		if (total + size > budgetChars) break;
		kept.unshift(entries[index]);
		total += size;
	}
	return kept.join("\n\n");
}

//#region local-tool bridge
/**
 * Collect the tool-result messages dsh appended to the history that answer one
 * of the Qoder custom tool calls we surfaced on the previous turn. dsh re-sends
 * the whole history every call, so `awaiting` (the ids we have not forwarded
 * yet) is what makes this incremental and idempotent.
 * @param messages - dsh message history.
 * @param awaiting - set of outstanding Qoder custom_tool_use ids.
 * @returns `{ id, blocks, isError }` per not-yet-forwarded tool result.
 */
function collectToolResults(messages, awaiting) {
	const out = [];
	if (!Array.isArray(messages) || awaiting.size === 0) return out;
	for (const message of messages) {
		if (message?.role !== "tool") continue;
		const id = message.toolCallId;
		if (typeof id !== "string" || !awaiting.has(id)) continue;
		out.push({ id, blocks: toQoderResultBlocks(message.content), isError: message.isError === true });
	}
	return out;
}

/**
 * User text injected after the tool call that the Session is paused on.
 *
 * dsh splices a message typed mid-turn into the history of the *next* step, which
 * for a bridged turn is the resume call — so these messages are new content that
 * has not been forwarded anywhere, not a re-send of the turn's original prompt.
 * Scanning forward from the last assistant tool-call block covers both orders dsh
 * may use (before or after the tool results).
 * @param messages - dsh message history for the resume call.
 * @returns the injected user texts joined in order, or "" when none.
 */
function collectSteering(messages) {
	if (!Array.isArray(messages)) return "";
	let lastToolCall = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		if (message.content.some((block) => block?.type === "tool-call")) {
			lastToolCall = index;
			break;
		}
	}
	if (lastToolCall < 0) return "";
	const texts = [];
	for (let index = lastToolCall + 1; index < messages.length; index += 1) {
		const message = messages[index];
		if (message?.role !== "user" || !Array.isArray(message.content)) continue;
		const text = message.content.filter((block) => block?.type === "text" && typeof block.text === "string" && block.text.length > 0).map((block) => block.text).join("\n");
		if (text.length > 0) texts.push(text);
	}
	return texts.join("\n\n");
}

/**
 * Map a tool-result payload onto Qoder `content` blocks. dsh result blocks are
 * primarily `{ type: "text", text }` (images carry an attachment reference that
 * the cloud sandbox cannot read here), so non-text payloads are serialised to
 * keep the model's view faithful instead of silently dropping it.
 * @param content - the dsh tool result `content` (blocks, string, or value).
 * @returns a non-empty array of Qoder text content blocks.
 */
function toQoderResultBlocks(content) {
	if (content == null) return [{ type: "text", text: "" }];
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [{ type: "text", text: safeStringify(content) }];
	const blocks = [];
	for (const block of content) {
		if (block == null) continue;
		if (block.type === "text" && typeof block.text === "string") {
			if (block.text.length > 0) blocks.push({ type: "text", text: block.text });
			continue;
		}
		if (typeof block.text === "string" && block.text.length > 0) {
			blocks.push({ type: "text", text: block.text });
			continue;
		}
		blocks.push({ type: "text", text: safeStringify(block) });
	}
	return blocks.length > 0 ? blocks : [{ type: "text", text: "(no output)" }];
}

function safeStringify(value) {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** Qoder-side name for a dsh tool: `<prefix><sanitised dsh name>`. */
function toCustomToolName(prefix, dshName) {
	const safe = String(dshName).replace(/[^A-Za-z0-9_]/g, "_");
	return `${prefix}${safe}`;
}
/** Strip the bridge prefix to recover the dsh tool name. */
function fromCustomToolName(prefix, customName) {
	if (typeof customName !== "string") return customName;
	return customName.startsWith(prefix) ? customName.slice(prefix.length) : customName;
}

/**
 * Coerce a dsh tool's parameter description into the JSON Schema object Qoder
 * demands (`{ "type": "object", ... }`). dsh hands the schema under
 * `parameters`; a couple of shapes are tolerated defensively.
 * @param tool - one entry from `options.tools`.
 * @returns a Qoder `input_schema` object.
 */
function toolInputSchema(tool) {
	const raw = unwrapValue(tool?.parameters ?? tool?.inputSchema ?? tool?.schema);
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const properties = raw.properties && typeof raw.properties === "object" ? raw.properties : {};
		return {
			type: "object",
			properties,
			...Array.isArray(raw.required) ? { required: raw.required } : {}
		};
	}
	return { type: "object", properties: {} };
}

/**
 * Translate dsh's active tool list into Qoder client-side custom tool
 * declarations. Only custom tools are emitted (never the cloud toolset), so the
 * model's only way to act is through dsh executing on the local machine.
 *
 * The list is not filtered by origin: whatever dsh made visible to this agent is
 * bridged, including tools contributed by other plugins and MCP servers. The one
 * constraint applied here is Qoder's per-Agent entry cap, so `budget` drops the
 * overflow instead of letting the whole turn fail with a 400.
 * @param prefix - the bridge name prefix.
 * @param tools - `options.tools` from dsh.
 * @param budget - maximum number of custom declarations to emit.
 * @returns `{ custom, dropped }`: the declarations plus the dsh names that were
 *   left out because the cap was reached.
 */
function buildCustomTools(prefix, tools, budget = QODER_MAX_TOOL_ENTRIES) {
	const custom = [];
	const dropped = [];
	// Qoder only accepts `[A-Za-z0-9_]` tool names, so a declared name can differ
	// from the dsh name (e.g. `mcp__bili-duty__x` → `mcp__bili_duty__x`). Keep the
	// reverse map: the model calls back with the sanitised name, and dsh must still
	// be handed its original one or the dispatcher reports `unknown tool`.
	const byCustomName = /* @__PURE__ */ new Map();
	if (!Array.isArray(tools)) return { custom, dropped, byCustomName };
	const seen = /* @__PURE__ */ new Set();
	for (const tool of tools) {
		const dshName = tool?.name;
		if (typeof dshName !== "string" || dshName.length === 0) continue;
		const customName = toCustomToolName(prefix, dshName);
		const key = customName.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		if (custom.length >= budget) {
			dropped.push(dshName);
			continue;
		}
		custom.push({
			type: "custom",
			name: customName,
			description: str(tool.description, dshName),
			input_schema: toolInputSchema(tool)
		});
		byCustomName.set(key, dshName);
	}
	return { custom, dropped, byCustomName };
}

/**
 * Resolve the context window to report to dsh.
 *
 * dsh meters its own message history against this figure to decide when to
 * compact, and the UI ContextMeter shows it as the denominator, so it has to
 * describe the window the *model* actually has — not a guess. An explicit
 * `contextWindow` wins (manual override), then the chosen Agent tier, then the
 * catalog's `default_context_window`; whatever is used is capped by the model's
 * hard `max_input_tokens` ceiling, because promising dsh more than Qoder can
 * hold would only surface later as a truncated cloud session.
 * @param connection - resolved plugin config.
 * @param entry - catalog entry for the model, when discovery succeeded.
 * @param learned - the Session's `agent.model.effective_context_window`, once known.
 * @returns a positive token count.
 */
function effectiveContextWindow(connection, entry, learned = 0) {
	// The runtime-resolved window a live Session reports is the closest thing to
	// ground truth (environment overrides included), so it outranks the config tier
	// and the catalog default — but not an explicit `contextWindow` override.
	const stated = connection.contextWindow > 0 ? connection.contextWindow : learned > 0 ? learned : connection.agentContextWindow > 0 ? connection.agentContextWindow : entry?.defaultContextWindow ?? 0;
	const ceiling = entry?.maxInputTokens ?? 0;
	if (stated > 0) return ceiling > 0 ? Math.min(stated, ceiling) : stated;
	return ceiling > 0 ? Math.min(DEFAULT_CONTEXT_WINDOW, ceiling) : DEFAULT_CONTEXT_WINDOW;
}

/**
 * The `model` value for Agent creation or a Session runtime patch.
 *
 * Qoder accepts either a bare model id or the object form
 * `{ id, effort, context_window }`. An effort the catalog does not list for this
 * model is dropped (with a warning) instead of sent, exactly like an
 * unavailable context tier, so a stale pick cannot fail the whole turn. When
 * discovery failed and nothing is known about the model, the requested effort
 * is sent anyway: Qoder validates it and its 400 names the problem.
 * @param model - Qoder model id.
 * @param entry - catalog entry for the model, when discovery succeeded.
 * @param tier - configured `agentContextWindow` (0 = keep the model default).
 * @param effort - requested reasoning level, or undefined for the model default.
 * @param warn - sink for a dropped value's notice.
 * @returns a Qoder Agent `model` value.
 */
function agentModelSpec(model, entry, tier, effort, warn) {
	const spec = { id: model };
	let tuned = false;
	if (typeof effort === "string" && effort.length > 0 && EFFORT_INFO[effort] !== void 0) {
		const allowed = effortIdsForModel(entry);
		if (allowed.length === 0 || allowed.includes(effort)) {
			spec.effort = effort;
			tuned = true;
		} else warn(`qoder: reasoning effort "${effort}" is not offered for model "${model}" (available: ${allowed.join(", ")}); keeping the model default`);
	}
	if (tier > 0) {
		const allowed = entry?.availableContextWindows ?? [];
		if (allowed.length > 0 && !allowed.includes(tier)) warn(`qoder: context window ${tier} is not offered for model "${model}" (available: ${allowed.join(", ") || "none reported"}); keeping the model default`);
		else {
			spec.context_window = tier;
			tuned = true;
		}
	}
	return tuned ? spec : model;
}

/** Stable signature of a tool set, used to decide when a session needs re-patching. */
function toolSetSignature(sessionTools) {
	return sessionTools.map((tool) => `${tool.name ?? tool.type}\u0000${tool.description ?? ""}\u0000${safeStringify(tool.input_schema ?? tool.enabled_tools ?? [])}`).join("\u0001");
}
/**
 * Assemble the Agent's complete `tools` array.
 *
 * While bridging, Qoder's built-in sandbox tools must be restricted: omitting the
 * toolset does NOT hide it (the model still calls a built-in `Read`, reads Qoder's
 * empty cloud sandbox, and reports your files as missing), and an *empty*
 * `enabled_tools` enables every built-in. So a non-empty, filesystem-free
 * allowlist is always sent, and the prompt states where the real files are.
 * @param connection - resolved plugin config.
 * @param customTools - bridged `{ type: "custom", ... }` declarations.
 * @param bridge - whether local-tool bridging is active.
 * @returns the tool array to hand Qoder.
 */
function buildSessionTools(connection, customTools, bridge) {
	if (!bridge) return [{ type: "agent_toolset_20260401", enabled_tools: connection.tools }];
	const cloud = connection.cloudTools.length > 0 ? connection.cloudTools : ["DeliverArtifacts"];
	return [{ type: "agent_toolset_20260401", enabled_tools: cloud }, ...customTools];
}
//#endregion

//#region low-level HTTP
/**
 * Thin Qoder REST client. Every request carries an attribution `user-agent` plus
 * the bearer token, matching Qoder's authentication contract.
 */
class QoderClient {
	constructor(connection, token) {
		this.connection = connection;
		this.token = token;
	}
	headers(extra = {}) {
		return {
			"user-agent": USER_AGENT,
			"authorization": `Bearer ${this.token}`,
			...extra
		};
	}
	async json(pathname, init, signal) {
		const response = await this.raw(pathname, init, signal);
		const text = await response.text();
		if (!response.ok) throw httpError("Qoder request failed", response.status, text);
		if (text.length === 0) return {};
		try {
			return JSON.parse(text);
		} catch {
			throw new QoderError("Qoder returned a non-JSON response", "INVALID_RESPONSE", { cause: new Error(text) });
		}
	}
	raw(pathname, init, signal) {
		const url = `${this.connection.baseURL}${pathname}`;
		return fetch(url, {
			redirect: "error",
			...init,
			signal,
			headers: this.headers(init?.headers ?? {})
		});
	}
	/** GET /environments → first id; create one when none exist and allowed. */
	async ensureEnvironment(signal) {
		if (this.connection.environmentId.length > 0) return this.connection.environmentId;
		const listed = await this.json(`${CLOUD_API}/environments`, { method: "GET" }, signal);
		const first = Array.isArray(listed.data) ? listed.data[0] : void 0;
		if (first?.id) return first.id;
		if (!this.connection.autoCreateEnvironment) throw new QoderError("qoder: no environment is configured and auto-creation is disabled", "MISSING_ENVIRONMENT");
		const created = await this.json(`${CLOUD_API}/environments`, {
			method: "POST",
			"headers": { "content-type": "application/json" },
			body: JSON.stringify({ name: "default" })
		}, signal);
		if (!created?.id) throw new QoderError("qoder: environment creation returned no id", "INVALID_RESPONSE");
		return created.id;
	}
	/**
	 * Create the Agent. When bridging, its tool set is the *custom* tools derived
	 * from dsh's own list plus a deliberately minimal built-in allowlist, so the
	 * model cannot reach into its own sandbox and mistake it for the user's disk.
	 * When not bridging, keep the original cloud tool set.
	 * @param modelSpec - Qoder model id, or `{ id, context_window }` when a tier was chosen.
	 * @param sessionTools - full tool array for this conversation (see buildSessionTools()).
	 * @param bridge - whether local-tool bridging is active.
	 * @param signal - cancellation.
	 * @returns the created Agent id.
	 */
	async ensureAgent(modelSpec, sessionTools, bridge, signal) {
		const connection = this.connection;
		const modelId = typeof modelSpec === "string" ? modelSpec : modelSpec.id;
		const body = {
			name: `dsh-${modelId}`,
			model: modelSpec,
			system: connection.systemPrompt.length > 0 ? connection.systemPrompt : "You are a helpful programming assistant.",
			tools: sessionTools
		};
		if (bridge) body.system = `${body.system}\n\n${BRIDGE_DIRECTIVE}`;
		const created = await this.json(`${CLOUD_API}/agents`, {
			method: "POST",
			"headers": { "content-type": "application/json" },
			body: JSON.stringify(body)
		}, signal);
		if (!created?.id) throw new QoderError("qoder: agent creation returned no id", "INVALID_RESPONSE");
		return created.id;
	}
	/**
	 * Patch a live Session's runtime configuration without replacing it or
	 * disturbing its server-side history.
	 *
	 * `agent.tools` is a complete replacement; `agent.model` switches the model
	 * and its reasoning level in place. Qoder gates the model field behind the
	 * `session-agent-patch-2026-07-21` beta header, so it is only sent when the
	 * patch touches the model. The response echoes the Session and is the source
	 * of the runtime-resolved `effective_context_window`.
	 * @param sessionId - the Session to patch.
	 * @param patch - `{ tools?, model? }` subset of `agent`.
	 * @param signal - cancellation.
	 * @returns `{ effectiveContextWindow }` from the updated Session (0 when absent).
	 */
	async updateSessionRuntime(sessionId, patch, signal) {
		const headers = { "content-type": "application/json" };
		if (patch.model !== void 0) headers["x-qoder-beta"] = SESSION_AGENT_PATCH_BETA;
		const updated = await this.json(`${CLOUD_API}/sessions/${encodeURIComponent(sessionId)}`, {
			method: "POST",
			headers,
			body: JSON.stringify({ agent: patch })
		}, signal);
		return {
			effectiveContextWindow: positiveInt(updated?.agent?.model?.effective_context_window, 0)
		};
	}
	/**
	 * Create a Session and report both its id and the context window the runtime
	 * actually resolved for it. `agent.model.effective_context_window` is a
	 * response-only field that includes environment-level overrides, so it is a
	 * better description of the cloud budget than the tier we asked for.
	 * @param agentId - Agent to bind.
	 * @param environmentId - Environment to run in.
	 * @param signal - cancellation.
	 * @returns `{ sessionId, effectiveContextWindow }`.
	 */
	async createSession(agentId, environmentId, signal) {
		const created = await this.json(`${CLOUD_API}/sessions`, {
			method: "POST",
			"headers": { "content-type": "application/json" },
			body: JSON.stringify({ agent: agentId, environment_id: environmentId })
		}, signal);
		if (!created?.id) throw new QoderError("qoder: session creation returned no id", "INVALID_RESPONSE");
		return { sessionId: created.id, effectiveContextWindow: positiveInt(created?.agent?.model?.effective_context_window, 0) };
	}
	/** Raw POST /events; the caller owns status handling. */
	postEvents(sessionId, events, signal) {
		return this.raw(`${CLOUD_API}/sessions/${encodeURIComponent(sessionId)}/events`, {
			method: "POST",
			"headers": { "content-type": "application/json" },
			body: JSON.stringify({ events })
		}, signal);
	}
	/**
	 * Ask a Session to stop its current turn (`user.interrupt` is one of the
	 * accepted client events). Harmless on an already-idle Session; the caller
	 * decides whether a failure matters.
	 * @param sessionId - the Session to interrupt.
	 * @param signal - cancellation.
	 */
	async interrupt(sessionId, signal) {
		const response = await this.postEvents(sessionId, [{ type: "user.interrupt" }], signal);
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw httpError("qoder: failed to interrupt the session", response.status, text);
		}
		return safeJson(response);
	}
	/** Current Session status, or undefined when the read failed. */
	async sessionStatus(sessionId, signal) {
		const response = await this.raw(`${CLOUD_API}/sessions/${encodeURIComponent(sessionId)}`, { method: "GET" }, signal);
		if (!response.ok) return void 0;
		return (await safeJson(response))?.status;
	}
	/**
	 * Wait for a busy Session to finish the turn holding it.
	 *
	 * `session.status_rescheduled` is Qoder retrying an overloaded model, and that
	 * loop can hold a Session for minutes — longer than any usable turn.
	 * @param sessionId - the Session to poll.
	 * @param signal - cancellation.
	 * @param timeoutMs - ceiling; false is returned when it expires.
	 * @returns whether the Session is idle.
	 */
	async waitForIdle(sessionId, signal, timeoutMs = BUSY_WAIT_TIMEOUT_MS) {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			signal?.throwIfAborted?.();
			const status = await this.sessionStatus(sessionId, signal).catch(() => void 0);
			if (status === "idle") return true;
			if (status === "terminated" || status === "deleted") return false;
			if (Date.now() >= deadline) return false;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}
	/**
	 * POST one batch of client events to a Session. Shared by user turns and
	 * custom-tool results.
	 *
	 * A 409 means the previous turn still owns the Session — the ordinary cause is
	 * a turn the user stopped locally (nothing told Qoder to stop, so it kept
	 * running, or kept retrying an overloaded model). Recover in place: cancel that
	 * turn, wait for idle, then retry once. Without this the Session stays busy and
	 * every later turn fails with "session is busy with a previous turn", even
	 * after switching models or reopening the conversation.
	 * @param sessionId - target Session.
	 * @param events - array of `{ type, ... }` event objects.
	 * @param signal - cancellation.
	 * @returns the parsed response payload.
	 */
	async sendEvents(sessionId, events, signal) {
		let response = await this.postEvents(sessionId, events, signal);
		if (response.status === 409) {
			await this.interrupt(sessionId, signal).catch(() => {});
			if (await this.waitForIdle(sessionId, signal)) {
				response = await this.postEvents(sessionId, events, signal);
			}
		}
		const payload = await safeJson(response);
		if (response.status === 409) throw new QoderError("qoder: session is busy with a previous turn", "SESSION_BUSY", { cause: errorDetail(payload) });
		if (!response.ok) throw httpError("qoder: failed to send event", response.status, JSON.stringify(payload));
		return payload;
	}
	async sendUserMessage(sessionId, text, signal) {
		const payload = await this.sendEvents(sessionId, [{ type: "user.message", content: [{ type: "text", text }] }], signal);
		return lastEventIdOf(payload);
	}
	/**
	 * Resume a Session paused on `requires_action` by returning custom tool
	 * results dsh produced locally. Each result references the originating
	 * `agent.custom_tool_use` id, which is also the dsh tool-call id we surfaced.
	 * @param sessionId - the paused Session.
	 * @param results - `{ id, blocks, isError }` items.
	 * @param signal - cancellation.
	 */
	/**
	 * Resume a Session paused on `requires_action` by returning custom tool
	 * results dsh produced locally. Each result references the originating
	 * `agent.custom_tool_use` id, which is also the dsh tool-call id we surfaced.
	 *
	 * `steering` carries user text that arrived *while the tools were running*.
	 * Qoder accepts a `user.message` in the same batch as the tool results (the
	 * pair resumes the paused turn and steers it), and without it that instruction
	 * would be silently dropped: dsh re-sends the whole history on the resume call,
	 * but this adapter never forwarded anything except the tool results.
	 * @param sessionId - the paused Session.
	 * @param results - `{ id, blocks, isError }` items.
	 * @param signal - cancellation.
	 * @param steering - mid-turn user text to append after the results, if any.
	 */
	async sendCustomToolResults(sessionId, results, signal, steering = "") {
		const events = results.map((result) => ({
			type: "user.custom_tool_result",
			custom_tool_use_id: result.id,
			content: result.blocks,
			is_error: result.isError === true
		}));
		if (typeof steering === "string" && steering.length > 0) {
			events.push({ type: "user.message", content: [{ type: "text", text: steering }] });
		}
		const payload = await this.sendEvents(sessionId, events, signal);
		return lastEventIdOf(payload);
	}
	/**
	 * Open the Session event stream.
	 *
	 * `lastEventId` is the id of the event this client just posted; passing it as
	 * `Last-Event-ID` makes the stream replay everything recorded after it, so the
	 * ordering "post first, subscribe second" loses nothing. That ordering matters:
	 * Node's `fetch` (undici) never returns a request's response while another
	 * response from the same origin is still streaming, so the previous
	 * "subscribe first, then post" sequence deadlocked on the POST — the Session
	 * had already recorded the user message and run the turn, while the client sat
	 * waiting for a response that could not be delivered (curl, which has no such
	 * constraint, returned in ~170 ms).
	 */
	openStream(sessionId, signal, lastEventId) {
		const headers = { "accept": "text/event-stream" };
		if (typeof lastEventId === "string" && lastEventId.length > 0) headers["last-event-id"] = lastEventId;
		return this.raw(`${CLOUD_API}/sessions/${encodeURIComponent(sessionId)}/events/stream`, {
			method: "GET",
			headers
		}, signal);
	}
	async listModels(signal) {
		const response = await this.raw(`${CLOUD_API}/models`, { method: "GET" }, signal);
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw httpError("qoder: model discovery failed", response.status, text);
		}
		return normalizeModelList(await safeJson(response));
	}
}
async function safeJson(response) {
	const text = await response.text();
	if (text.length === 0) return {};
	try {
		return JSON.parse(text);
	} catch {
		return { raw: text };
	}
}
/**
 * Last event id in a POST /events response, usable as the stream's
 * `Last-Event-ID` cursor so the replay picks up exactly after it.
 * @param payload - parsed `{ data: [{ id, type, ... }] }` response.
 * @returns the last id, or undefined when the response carried none.
 */
function lastEventIdOf(payload) {
	const list = Array.isArray(payload?.data) ? payload.data : [];
	for (let index = list.length - 1; index >= 0; index -= 1) {
		const id = list[index]?.id;
		if (typeof id === "string" && id.length > 0) return id;
	}
	return void 0;
}
function errorDetail(payload) {
	const message = payload?.error?.message ?? payload?.message ?? payload?.raw;
	return message ? new Error(String(message)) : new Error(JSON.stringify(payload ?? {}));
}
function httpError(prefix, status, text) {
	let detail = text;
	try {
		const parsed = JSON.parse(text);
		detail = parsed?.error?.message ?? parsed?.message ?? text;
	} catch {}
	const hint = status === 401 ? "; check the region (global https://api.qoder.com, China https://api.qoder.com.cn) and, if needed, regenerate the PAT in the Qoder console (Settings \u2192 Personal Access Tokens) with the qca.access scope" : "";
	return new QoderError(`${prefix} (HTTP ${status}): ${String(detail).slice(0, 400)}${hint}`, status === 401 || status === 403 ? "MISSING_CREDENTIAL" : "PROVIDER_ERROR", { status });
}
function normalizeModelList(json) {
	const items = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : Array.isArray(json) ? json : [];
	const out = [];
	const seen = new Set();
	for (const item of items) {
		const id = item?.id ?? item?.model ?? item?.name;
		if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
		seen.add(id);
		out.push({
			id,
			name: item?.name ?? item?.display_name ?? id,
			// The catalog is the only trustworthy source for how much a model can hold:
			// `max_input_tokens` is its hard ceiling, `default_context_window` the tier
			// used when the Agent does not choose one, and `available_context_windows`
			// the tiers that may be sent as `model.context_window`.
			maxInputTokens: positiveInt(item?.max_input_tokens, 0),
			defaultContextWindow: positiveInt(item?.default_context_window, 0),
			availableContextWindows: Array.isArray(item?.available_context_windows) ? item.available_context_windows.filter((value) => Number.isInteger(value) && value > 0) : [],
			// Selection facts the model picker shows:
			// `price_factor` is the Credit rate relative to the account's base rate,
			// `efforts`/`default_effort` are the reasoning levels the model accepts as
			// `model.effort`, and `support_disable_reasoning` says whether `none` may be
			// sent even when the upstream list omits it.
			priceFactor: creditRateOf(item?.price_factor),
			efforts: effortIdsOf(item?.efforts),
			defaultEffort: effortIdOf(item?.default_effort),
			supportDisableReasoning: item?.support_disable_reasoning === true
		});
	}
	return out;
}

//#region catalog facts (credits and reasoning levels)
/**
 * Read a Qoder Credit rate (`price_factor`). The catalog reports it as a plain
 * number, where 0 means the model is currently free and 1 is the account's
 * base rate; anything else (a string, a negative number, NaN) is treated as
 * unknown rather than as a rate, because a wrong multiplier misleads more than
 * a missing one.
 * @param value - raw `price_factor` from the catalog.
 * @returns the rate, or undefined when the catalog did not state a usable one.
 */
function creditRateOf(value) {
	const rate = typeof value === "string" && value.trim().length > 0 ? Number(value) : value;
	return typeof rate === "number" && Number.isFinite(rate) && rate >= 0 ? rate : void 0;
}
/**
 * Coerce one catalog effort id into the provider's vocabulary.
 * @param value - raw id.
 * @returns the id when Qoder offers it, otherwise undefined.
 */
function effortIdOf(value) {
	return typeof value === "string" && EFFORT_INFO[value] !== void 0 ? value : void 0;
}
/**
 * Deduplicate and validate a catalog `efforts` array.
 * @param values - raw ids from the catalog.
 * @returns known ids in catalog order.
 */
function effortIdsOf(values) {
	if (!Array.isArray(values)) return [];
	const out = [];
	for (const value of values) {
		const id = effortIdOf(value);
		if (id !== void 0 && !out.includes(id)) out.push(id);
	}
	return out;
}
/**
 * The levels a model may actually be asked for, least→greatest.
 *
 * `support_disable_reasoning: true` adds `none` even when the upstream list
 * omits it — verified against the live API: such models accept `effort: "none"`
 * and the level is absent from `efforts` only because reasoning is on by
 * default. A model that does not support disabling reasoning only exposes the
 * listed levels.
 * @param model - catalog entry.
 * @returns ordered effort ids, possibly empty when the model has no levels.
 */
function effortIdsForModel(model) {
	const ids = effortIdsOf(model?.efforts);
	if (model?.supportDisableReasoning === true && !ids.includes("none")) ids.push("none");
	return ids.sort((left, right) => EFFORT_ORDER.indexOf(left) - EFFORT_ORDER.indexOf(right));
}
/**
 * Render a Credit rate the way the picker's badge shows it.
 *
 * The badge is the only per-model label the model selector renders next to a
 * name, so the rate lives there. `0` is shown as a localized "free" because a
 * bare `0×` reads as broken; `>1` uses the warning tone because those models
 * cost more than the account's base rate.
 * @param factor - catalog `price_factor`.
 * @returns a dsh model badge, or undefined when the catalog stated no rate.
 */
function priceFactorBadge(factor) {
	if (factor === void 0) return void 0;
	if (factor === 0) return {
		text: {
			zh: "免费",
			en: "Free"
		},
		tone: "success"
	};
	return {
		text: `${formatFactor(factor)}×`,
		tone: factor > 1 ? "warning" : factor < 1 ? "info" : "neutral"
	};
}
/**
 * Format a Credit rate without trailing zeroes: 0.5, 0.8, 1, 1.25.
 * @param value - finite non-negative number.
 * @returns display text.
 */
function formatFactor(value) {
	return String(Math.round(value * 100) / 100);
}
/**
 * One-line catalog description for a model: the levels it accepts and its
 * Credit rate. The model selector itself renders only the badge; this text is
 * for surfaces that show a description (e.g. Settings → Models).
 * @param model - catalog entry.
 * @returns description text, or undefined when the catalog stated neither fact.
 */
function modelDescription(model) {
	const parts = [];
	const efforts = effortIdsForModel(model);
	if (efforts.length > 0) parts.push(`Reasoning: ${efforts.map((id) => EFFORT_INFO[id].name.toLowerCase()).join(" / ")}`);
	if (model?.priceFactor !== void 0) parts.push(`Credit rate: ${formatFactor(model.priceFactor)}×`);
	return parts.length > 0 ? parts.join(" · ") : void 0;
}
/**
 * Build dsh's selectable-reasoning metadata for one exact model route.
 *
 * dsh materialises `defaultEffort` into every request that omits one, validates
 * a requested effort against this list, and the model picker renders the list
 * least→greatest. `none` is only advertised when the model accepts it.
 * @param model - catalog entry for the model.
 * @param configured - `defaultReasoningEffort` from the plugin config, if any.
 * @returns reasoning metadata, or undefined when the model exposes no levels.
 */
function reasoningInfoFor(model, configured) {
	const efforts = effortIdsForModel(model);
	if (efforts.length === 0) return void 0;
	const wanted = typeof configured === "string" ? configured.trim().toLowerCase() : "";
	const defaultEffort = wanted.length > 0 && efforts.includes(wanted) ? wanted : typeof model?.defaultEffort === "string" && efforts.includes(model.defaultEffort) ? model.defaultEffort : void 0;
	return {
		efforts: efforts.map((id) => ({
			id,
			...EFFORT_INFO[id]
		})),
		...defaultEffort === void 0 ? {} : { defaultEffort }
	};
}
//#endregion

//#endregion

//#region SSE parsing
/**
 * Parse a Server-Sent Events byte stream into typed frames.
 * @param body - a WHATWG ReadableStream from `fetch`.
 * @yields `{ event, id, data }` objects in arrival order.
 */
async function* parseSse(body) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let boundary;
		while ((boundary = findFrameBoundary(buffer)) !== -1) {
			const rawFrame = buffer.slice(0, boundary.head);
			buffer = buffer.slice(boundary.consumed);
			const frame = parseFrame(rawFrame);
			if (frame) yield frame;
		}
	}
}
function findFrameBoundary(text) {
	const lf = text.indexOf("\n\n");
	const crlf = text.indexOf("\r\n\r\n");
	const candidates = [lf, crlf].filter((index) => index !== -1);
	if (candidates.length === 0) return -1;
	const useCrlf = crlf !== -1 && (lf === -1 || crlf < lf);
	return { head: useCrlf ? crlf : lf, consumed: useCrlf ? crlf + 4 : lf + 2 };
}
function parseFrame(rawFrame) {
	let event = "message";
	let id;
	const dataLines = [];
	for (const line of rawFrame.split(/\r?\n/)) {
		if (line.length === 0 || line.startsWith(":")) continue;
		if (line.startsWith("event:")) event = line.slice(6).trim();
		else if (line.startsWith("id:")) id = line.slice(3).trim();
		else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
	}
	if (dataLines.length === 0 && event === "message") return null;
	let data = {};
	if (dataLines.length > 0) {
		try {
			data = JSON.parse(dataLines.join("\n"));
		} catch {
			data = {};
		}
	}
	return { event, id, data };
}
//#endregion

//#region credit statistics
/**
 * Round one Credit figure the way Qoder reports it (two decimal places, floored
 * upstream). Summing the per-request figures locally must not accumulate binary
 * float noise into numbers the UI shows next to Qoder's own totals.
 * @param value - arbitrary number.
 * @returns a finite non-negative amount, or 0 for junk.
 */
function creditNumber(value) {
	const number = typeof value === "string" && value.trim().length > 0 ? Number(value) : value;
	return typeof number === "number" && Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : 0;
}
/** Add two Credit amounts without float drift. */
function addCredits(left, right) {
	return Math.round((creditNumber(left) + creditNumber(right)) * 100) / 100;
}
/**
 * Cumulative and per-turn Qoder Credit accounting for the provider.
 *
 * Two Qoder facts feed it, both carried by the Session event stream:
 * - `span.model_request_end.model_usage.credits` — the exact Credits of one model
 *   call, which is what makes a per-turn figure possible;
 * - `session.usage` — the Session's cumulative snapshot (`model_credits`,
 *   `sandbox_runtime_credits`, `total_credits`), emitted before each idle.
 * The snapshot REPLACES the previous one rather than adding up; only per-call
 * spans are summed. A conversation that has to switch to a fresh cloud Session
 * (model patch refused, host restart) carries the completed Session's total
 * forward so the user-visible conversation total keeps growing monotonically.
 */
class QoderCreditStats {
	/** dsh session id -> record; kept only for this host process lifetime. */
	#sessions = new Map();
	/** Credits billed across every conversation since this host started. */
	#lifetimeCredits = 0;
	#lifetimeCalls = 0;
	#record(sessionId) {
		if (typeof sessionId !== "string" || sessionId.length === 0) return void 0;
		let record = this.#sessions.get(sessionId);
		if (record === void 0) {
			record = {
				sessionId,
				model: null,
				modelName: null,
				effort: null,
				priceFactor: null,
				turnIndex: 0,
				turnCredits: 0,
				turnCalls: 0,
				lastCallCredits: 0,
				usage: null,
				carriedCredits: 0,
				updatedAt: 0
			};
			this.#sessions.set(sessionId, record);
		}
		return record;
	}
	/**
	 * Open a new conversation turn: reset the per-turn counters and record which
	 * model/level the turn is actually billed against.
	 * @param sessionId - dsh conversation key.
	 * @param facts - model id, display name, effort, and catalog Credit rate.
	 */
	startTurn(sessionId, facts = {}) {
		const record = this.#record(sessionId);
		if (record === void 0) return;
		record.turnIndex += 1;
		record.turnCredits = 0;
		record.turnCalls = 0;
		record.lastCallCredits = 0;
		if (facts.model !== void 0) record.model = facts.model;
		if (facts.modelName !== void 0) record.modelName = facts.modelName;
		if (facts.effort !== void 0) record.effort = facts.effort;
		if (facts.priceFactor !== void 0) record.priceFactor = facts.priceFactor;
		record.updatedAt = Date.now();
	}
	/**
	 * Account one completed model call.
	 * @param sessionId - dsh conversation key.
	 * @param credits - `model_usage.credits` from `span.model_request_end`.
	 */
	noteCall(sessionId, credits) {
		const record = this.#record(sessionId);
		if (record === void 0) return;
		const amount = creditNumber(credits);
		record.turnCredits = addCredits(record.turnCredits, amount);
		record.turnCalls += 1;
		record.lastCallCredits = amount;
		record.updatedAt = Date.now();
		this.#lifetimeCredits = addCredits(this.#lifetimeCredits, amount);
		this.#lifetimeCalls += 1;
	}
	/**
	 * Replace the Session's cumulative snapshot with the freshly emitted one.
	 * @param sessionId - dsh conversation key.
	 * @param usage - the `session.usage` event's three Credit fields.
	 */
	applyUsage(sessionId, usage) {
		const record = this.#record(sessionId);
		if (record === void 0) return;
		record.usage = {
			modelCredits: creditNumber(usage?.modelCredits),
			sandboxCredits: creditNumber(usage?.sandboxCredits),
			totalCredits: creditNumber(usage?.totalCredits)
		};
		record.updatedAt = Date.now();
	}
	/**
	 * A real cloud Session is being replaced by a fresh one for the same dsh
	 * conversation: carry its completed total forward and start the new Session's
	 * snapshot from zero, so "本次会话累计" never goes backwards.
	 * @param sessionId - dsh conversation key.
	 */
	rotateCloudSession(sessionId) {
		const record = this.#record(sessionId);
		if (record === void 0) return;
		record.carriedCredits = addCredits(record.carriedCredits, record.usage?.totalCredits ?? 0);
		record.usage = null;
		record.updatedAt = Date.now();
	}
	/** Forget every conversation record (config reload); lifetime totals survive. */
	reset() {
		this.#sessions.clear();
	}
	/**
	 * The wire snapshot the browser half renders (see CREDIT_STATS_ROUTE).
	 * @param sessionId - dsh conversation key from the request query.
	 * @returns the v1 statistics payload; `known` is false until a turn began.
	 */
	snapshot(sessionId) {
		const lifetime = {
			credits: creditNumber(this.#lifetimeCredits),
			calls: this.#lifetimeCalls
		};
		const record = typeof sessionId === "string" ? this.#sessions.get(sessionId) : void 0;
		if (record === void 0) return {
			ok: true,
			known: false,
			sessionId: typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null,
			model: null,
			modelName: null,
			effort: null,
			priceFactor: null,
			turn: {
				index: 0,
				credits: 0,
				calls: 0,
				lastCallCredits: 0
			},
			session: {
				modelCredits: 0,
				sandboxCredits: 0,
				totalCredits: 0,
				carriedCredits: 0,
				total: 0
			},
			lifetime,
			updatedAt: 0
		};
		const usage = record.usage ?? {
			modelCredits: 0,
			sandboxCredits: 0,
			totalCredits: 0
		};
		return {
			ok: true,
			known: record.updatedAt > 0,
			sessionId: record.sessionId,
			model: record.model,
			modelName: record.modelName,
			effort: record.effort,
			priceFactor: record.priceFactor,
			turn: {
				index: record.turnIndex,
				credits: creditNumber(record.turnCredits),
				calls: record.turnCalls,
				lastCallCredits: creditNumber(record.lastCallCredits)
			},
			session: {
				modelCredits: usage.modelCredits,
				sandboxCredits: usage.sandboxCredits,
				totalCredits: usage.totalCredits,
				carriedCredits: record.carriedCredits,
				total: addCredits(record.carriedCredits, usage.totalCredits)
			},
			lifetime,
			updatedAt: record.updatedAt
		};
	}
}
/**
 * Answer the browser half's statistics request.
 *
 * Reads only; never throws (a rejected read would surface as a broken page for
 * every session). The route is registered on the Host's loopback Web server, so
 * it is reachable only from the page that same server serves.
 * @param req - inbound request (GET/HEAD).
 * @param res - response; this function owns it.
 * @param stats - live statistics store.
 */
function serveCreditStats(req, res, stats) {
	try {
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405, {
				"content-type": "application/json; charset=utf-8",
				"allow": "GET, HEAD",
				"cache-control": "no-store"
			});
			res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
			return;
		}
		let sessionId = null;
		try {
			sessionId = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("sessionId");
		} catch {
			sessionId = null;
		}
		const payload = stats.snapshot(sessionId);
		res.writeHead(200, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff"
		});
		if (req.method === "HEAD") {
			res.end();
			return;
		}
		res.end(JSON.stringify(payload));
	} catch (error) {
		try {
			res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
		} catch {
			/* the response is already gone; nothing useful left to do */
		}
	}
}
//#endregion

/**
 * The Qoder provider adapter. Duck-typed against the `llm` seam's requirements:
 * `providerInfo`, `providerRetryPolicy`, `listModels`, `resolveModel`,
 * `prepareCall`, and `stream`. Owns one Qoder Session per conversation; a model
 * or reasoning-level change patches that Session in place (see
 * #reconcileConversation), and only a refused patch falls back to a new Session.
 */
class QoderSessionAdapter {
	#connection;
	#resolveToken;
	#stats;
	/** conversation key -> per-conversation Qoder session record (see #ensureConversation) */
	#sessions = new Map();
	/** `${model-spec}\0${tool-signature}` -> cached agent id; environment cached separately */
	#agents = new Map();
	/** model id -> catalog entry (display name plus the context-window facts) */
	#catalog = new Map();
	/** model id -> the `effective_context_window` a live Session reported for it */
	#effectiveWindows = new Map();

	/** in-flight catalog read, so concurrent resolutions share one request */
	#discovery;
	/** whether a catalog has been attempted since the last `reset()` */
	#catalogAttempted = false;
	#warn;
	#environmentId;
	constructor(connection, resolveToken, warn = () => {}, stats = new QoderCreditStats()) {
		this.#connection = connection;
		this.#resolveToken = resolveToken;
		this.#warn = warn;
		this.#stats = stats;
	}
	providerInfo(provider) {
		return { id: provider, name: this.#connection().displayName };
	}
	providerRetryPolicy(_provider) {
		return void 0;
	}
	imageRequestPricing(_provider, _model) {
		return void 0;
	}
	/**
	 * Read the account's model catalog, caching every entry it reports.
	 * Failures are advisory: a bad token, an offline host, or the documented 503
	 * "catalog unavailable" all degrade to an empty catalog rather than breaking
	 * the model picker or the turn.
	 * @returns the discovered models (possibly empty).
	 */
	async #fetchCatalog() {
		this.#catalogAttempted = true;
		try {
			const connection = this.#connection();
			const token = await this.#resolveToken();
			const models = await new QoderClient(connection, token).listModels();
			for (const model of models) this.#catalog.set(model.id, model);
			return models;
		}
		catch {
			return [];
		}
	}
	/** Single-flight variant of {@link #fetchCatalog}, used when a model is unknown. */
	#ensureCatalog() {
		this.#discovery ??= this.#fetchCatalog().finally(() => {
			this.#discovery = void 0;
		});
		return this.#discovery;
	}
	/**
	 * Look up one model's catalog entry, triggering a single discovery read when
	 * nothing is known yet (and never retrying a read that already failed).
	 * @param model - Qoder model id.
	 * @returns the entry, or undefined when the catalog does not know it.
	 */
	async #catalogEntry(model) {
		const known = this.#catalog.get(model);
		if (known !== void 0) return known;
		if (!this.#catalogAttempted) return (await this.#ensureCatalog()).find((entry) => entry.id === model);
		return void 0;
	}
	async listModels(provider) {
		const connection = this.#connection();
		// The picker is where a freshly pasted token first gets exercised, so this
		// path always refetches instead of reusing a previous (failed) read.
		this.#catalogAttempted = false;
		let discovered = await this.#ensureCatalog();
		if (!discovered.some((model) => model.id === connection.defaultModel)) discovered = [{
			id: connection.defaultModel,
			name: titleCase(connection.defaultModel),
			maxInputTokens: 0,
			defaultContextWindow: 0,
			availableContextWindows: [],
			priceFactor: void 0,
			efforts: [],
			defaultEffort: void 0,
			supportDisableReasoning: false
		}, ...discovered];
		return discovered.map((model) => {
			// The selector shows one provider-authored badge per model. Qoder's Credit
			// rate (`price_factor`) is the per-model fact users cannot otherwise see,
			// and a free model is worth flagging as a benefit rather than "0×".
			const badge = priceFactorBadge(model.priceFactor);
			const description = modelDescription(model);
			return {
				provider,
				id: model.id,
				name: model.name,
				...description === void 0 ? {} : { description },
				...badge === void 0 ? {} : { badge }
			};
		});
	}
	async resolveModel(provider, model, _signal) {
		const connection = this.#connection();
		const entry = await this.#catalogEntry(model);
		const reasoning = reasoningInfoFor(entry, connection.defaultReasoningEffort);
		return {
			provider,
			id: model,
			name: entry?.name ?? titleCase(model),
			context: { contextWindow: effectiveContextWindow(connection, entry, this.#effectiveWindows.get(model) ?? 0) },
			defaultMaxTokens: connection.maxTokens,
			...reasoning === void 0 ? {} : { reasoning }
		};
	}
	async prepareCall(provider, model, signal) {
		// `resolveModel` is async; it MUST be awaited before the result is handed to
		// the registry, which validates the metadata synchronously (a pending
		// Promise would read as "invalid exact model metadata").
		return {
			model: await this.resolveModel(provider, model, signal),
			stream: (options) => this.stream(options)
		};
	}
	/**
	 * Best-effort `user.interrupt` on a short, independent abort budget.
	 *
	 * Runs while the turn's own signal is already aborted, so it must not reuse it.
	 * @param client - request-scoped Qoder client.
	 * @param sessionId - the Session to release.
	 */
	async #interruptQuietly(client, sessionId) {
		try {
			await client.interrupt(sessionId, AbortSignal.timeout(INTERRUPT_TIMEOUT_MS));
		} catch (error) {
			this.#warn(`qoder: could not interrupt the cloud session ${sessionId} (the next turn will retry): ${error?.message ?? error}`);
		}
	}
	/** Drop every cached Session/agent/environment so new config takes effect. */
	reset() {
		this.#sessions.clear();
		this.#agents.clear();
		this.#catalog.clear();
		this.#effectiveWindows.clear();
		this.#catalogAttempted = false;
		this.#environmentId = void 0;
	}
	async *stream(options) {
		const connection = this.#connection();
		const bridge = connection.bridgeLocalTools;
		const prefix = connection.localToolPrefix;
		// Honour the model dsh actually selected for this call; the configured
		// default is only the fallback when no model is named.
		const model = str(options.model, connection.defaultModel);
		// One slot of Qoder's 128-entry budget goes to the cloud toolset declaration,
		// so at most 127 dsh tools can be bridged in a single turn.
		const { custom: customTools, dropped, byCustomName } = bridge ? buildCustomTools(prefix, options.tools, QODER_MAX_TOOL_ENTRIES - 1) : { custom: [], dropped: [], byCustomName: /* @__PURE__ */ new Map() };
		if (dropped.length > 0) this.#warn(`qoder: ${dropped.length} local tool(s) exceed Qoder's ${QODER_MAX_TOOL_ENTRIES}-entry limit and were not offered this turn: ${dropped.join(", ")}`);
		const sessionTools = buildSessionTools(connection, customTools, bridge);
		if (process.env.QODER_DEBUG) console.error(`[qoder-dbg] model=${model} bridge=${bridge} prefix=${JSON.stringify(prefix)} tools_in=${options.tools?.length ?? "undefined"} session=${JSON.stringify(sessionTools.map((t) => t.name ?? t.type))}`);
		const token = await this.#resolveToken();
		const client = new QoderClient(connection, token);
		// The Agent bakes in the model, its reasoning level, and its context-window
		// tier, so resolve all three before provisioning the conversation. The level
		// comes from the caller (the model picker's effort submenu); when a model
		// declares a default, dsh has already materialised it here.
		const entry = await this.#catalogEntry(model);
		const effort = str(options.reasoningEffort, "");
		const modelSpec = agentModelSpec(model, entry, connection.agentContextWindow, effort, this.#warn);

		// A single cancellable lifecycle for the whole turn.
		const controller = new AbortController();
		let idleFired = false;
		let timer;
		const armIdle = () => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				idleFired = true;
				controller.abort();
			}, DEFAULT_STREAM_IDLE_TIMEOUT_MS);
		};
		const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
		armIdle();
		/** Set once the conversation exists, so the failure path can release the cloud turn. */
		let conversation;
		try {
			let record = await this.#ensureConversation(client, options.sessionId, modelSpec, sessionTools, bridge, signal);
			conversation = record;
			// Trigger the turn first and subscribe second, using the posted event's id
			// as the stream's `Last-Event-ID` cursor: the stream then replays every
			// event recorded after it, so nothing is missed. The opposite order
			// deadlocks — see openStream() for why Node's fetch cannot post while a
			// same-origin response is still streaming.
			let lastEventId;
			const toolResults = record.phase === "awaiting" ? collectToolResults(options.messages, record.awaiting) : [];
			// A new conversation turn — as opposed to the resume call that follows local
			// tool execution — is the unit the credit panel reports. Auxiliary model
			// calls (session title, compaction) do not open a user-visible turn.
			const continuingTurn = record.phase === "awaiting" && toolResults.length > 0;
			if (!continuingTurn && options.purpose === void 0) this.#stats.startTurn(options.sessionId, {
				model,
				modelName: entry?.name,
				effort: effort.length > 0 ? effort : entry?.defaultEffort,
				priceFactor: entry?.priceFactor
			});
			if (record.phase === "awaiting" && toolResults.length > 0) {
				// dsh has just executed the pending local tools and re-called us with
				// their results appended to history. Forward those results to the SAME
				// paused Session (a `user.custom_tool_result`, NOT a fresh user message)
				// so Qoder resumes the interrupted turn. Anything the user typed while
				// the tools were running rides along as a `user.message`, or it would be
				// dropped: this adapter forwards nothing but the results on a resume.
				const steering = collectSteering(options.messages);
				for (const result of toolResults) record.awaiting.delete(result.id);
				lastEventId = await client.sendCustomToolResults(record.sessionId, toolResults, signal, steering);
			} else {
				if (record.phase === "awaiting") {
					// The Session was paused on a bridged tool call, but dsh came back with
					// a NEW user message instead of the tool results: that turn was
					// abandoned (the user pressed Stop while the tool was pending). The
					// paused turn can never be resumed — it would fail every later message
					// with "resuming a paused turn but no matching tool results were
					// supplied" — so release it in the cloud and start this message fresh.
					record.phase = "idle";
					record.awaiting = new Set();
					await this.#interruptQuietly(client, record.sessionId);
					await client.waitForIdle(record.sessionId, signal).catch(() => false);
				}
				// A fresh user turn. Re-resolve the conversation record now that any
				// abandoned pause has been released: a model or reasoning-level change
				// the user made while that pause was pending is applied here, in place,
				// so the message is sent to the Session the picker currently shows.
				record = await this.#ensureConversation(client, options.sessionId, modelSpec, sessionTools, bridge, signal);
				conversation = record;
				// A cold Session has no server-side history, so carry the whole current
				// turn; once the Session exists, the incremental newest-only path is right.
				const userText = record.fresh ? extractTurnUserText(options.messages) : extractUserText(options.messages);
				if (userText.length === 0) throw new QoderError("qoder: no user message text to send", "INVALID_REQUEST");
				// A cold Session only exists because this conversation has none yet:
				// a different model was selected, the host restarted, or the previous
				// Session was abandoned. Qoder keeps the history, so without a replay
				// the model would silently forget every earlier turn. The transcript
				// goes out as part of the same user message — a `user.message` always
				// starts a turn, and `system.message` may only be the final event of a
				// request, so a separate seeding event cannot be silent.
				let messageText = userText;
				if (record.fresh && connection.replayHistory) {
					const replay = buildHistoryReplay(options.messages);
					if (replay.length > 0) messageText = `${REPLAY_HEADER}\n${replay}\n\n${REPLAY_FOOTER}\n${userText}`;
				}
				lastEventId = await client.sendUserMessage(record.sessionId, messageText, signal);
				record.fresh = false;
			}
			const streamResponse = await client.openStream(record.sessionId, signal, lastEventId);
			if (!streamResponse.ok || streamResponse.body === null) {
				const text = await streamResponse.text().catch(() => "");
				throw httpError("qoder: failed to open event stream", streamResponse.status, text);
			}
			const turn = {
				pending: new Set(),
				prefix,
				byCustomName,
				stats: this.#stats,
				sessionId: options.sessionId,
				effort: effort.length > 0 ? effort : entry?.defaultEffort,
				requestStartedAt: 0
			};
			yield* this.#translate(streamResponse.body, signal, armIdle, turn, bridge);
			// Remember whether we paused for local tool execution, and which calls are
			// outstanding, so the next stream() call can forward their results.
			if (bridge && turn.pending.size > 0) {
				record.phase = "awaiting";
				record.awaiting = turn.pending;
			} else {
				record.phase = "idle";
				record.awaiting = new Set();
			}
		} catch (error) {
			// A turn cancelled from this side (the user pressed Stop, or the idle
			// ceiling fired) keeps running in the cloud: nothing has told Qoder to
			// stop it. It would then hold the Session and reject every following turn
			// with 409 "session is busy with a previous turn", which is why stopping a
			// turn used to break the whole conversation.
			if (conversation !== void 0 && (options.signal?.aborted === true || idleFired)) {
				// Forget any tool call this turn was waiting on: its result can never
				// arrive, and holding the pause would fail the next message with
				// "resuming a paused turn but no matching tool results were supplied".
				conversation.phase = "idle";
				conversation.awaiting = new Set();
				await this.#interruptQuietly(client, conversation.sessionId);
			}
			if (options.signal?.aborted) throw new QoderError("qoder: request aborted", "ABORTED", { cause: error });
			if (idleFired) throw new QoderError("qoder: event stream idle timeout", "TIMEOUT", { cause: error });
			if (error instanceof QoderError) throw error;
			throw new QoderError(`qoder: transport failed (${error?.cause?.code ?? error?.code ?? error?.message ?? "unknown"})`, "TRANSPORT", { cause: error });
		} finally {
			clearTimeout(timer);
			controller.abort();
		}
	}
	/**
	 * Provision (or reuse) the per-conversation record backing one dsh chat.
	 * The record carries the Qoder Session id plus the tool-loop state machine:
	 * `phase` (idle vs awaiting local tool results), the `awaiting` set of
	 * outstanding `custom_tool_use` ids, and the `toolSignature` last pushed.
	 * @param client - request-scoped Qoder client.
	 * @param conversationId - dsh's stable conversation key (falls back to ephemeral).
	 * @param modelSpec - Qoder model id, or `{ id, context_window }`.
	 * @param sessionTools - the full tool array for this conversation.
	 * @param bridge - whether local-tool bridging is active.
	 * @param signal - cancellation.
	 * @returns the live conversation record.
	 */
	async #ensureConversation(client, conversationId, modelSpec, sessionTools, bridge, signal) {
		// One cloud Session per dsh conversation: the model and reasoning level are
		// runtime settings now (patched in place), not part of the cache key.
		const key = conversationId === void 0 || conversationId === null ? null : String(conversationId);
		if (key !== null) {
			const cached = this.#sessions.get(key);
			if (cached !== void 0) {
				// A Session paused on a local tool call is mid-turn: switching its model
				// or tools underneath the paused turn would corrupt that turn, so the
				// caller reconciles after it releases the pause (see stream()).
				if (cached.phase !== "idle") return cached;
				const reconciled = await this.#reconcileConversation(cached, client, modelSpec, sessionTools, signal);
				return reconciled === void 0 ? await this.#createConversation(key, client, modelSpec, sessionTools, bridge, signal) : reconciled;
			}
		}
		return await this.#createConversation(key, client, modelSpec, sessionTools, bridge, signal);
	}
	/**
	 * Create a fresh cloud Session (and the Agent backing it) for one conversation.
	 * @param key - dsh conversation key, or null for an ephemeral call.
	 * @param client - request-scoped Qoder client.
	 * @param modelSpec - Qoder model id, or `{ id, effort, context_window }`.
	 * @param sessionTools - the full tool array for this conversation.
	 * @param bridge - whether local-tool bridging is active.
	 * @param signal - cancellation.
	 * @returns the live conversation record, marked `fresh` for history replay.
	 */
	async #createConversation(key, client, modelSpec, sessionTools, bridge, signal) {
		if (this.#environmentId === void 0) this.#environmentId = await client.ensureEnvironment(signal);
		// An Agent's tools, model, and reasoning level are baked in at creation, so
		// cache by model spec + tool set; a changed value yields a fresh Agent
		// rather than a stale snapshot.
		const signature = toolSetSignature(sessionTools);
		const modelKey = JSON.stringify(modelSpec);
		const agentKey = `${modelKey}\u0000${signature}`;
		let agentId = this.#agents.get(agentKey);
		if (agentId === void 0) {
			agentId = await client.ensureAgent(modelSpec, sessionTools, bridge, signal);
			this.#agents.set(agentKey, agentId);
		}
		const createdSession = await client.createSession(agentId, this.#environmentId, signal);
		const modelId = typeof modelSpec === "string" ? modelSpec : modelSpec.id;
		if (createdSession.effectiveContextWindow > 0) this.#effectiveWindows.set(modelId, createdSession.effectiveContextWindow);
		const record = {
			key,
			conversationId: key,
			sessionId: createdSession.sessionId,
			phase: "idle",
			awaiting: new Set(),
			toolSignature: signature,
			modelKey,
			fresh: true
		};
		if (key !== null) this.#sessions.set(key, record);
		return record;
	}
	/**
	 * Bring an idle cloud Session's runtime configuration up to date in place.
	 *
	 * Qoder's Session update endpoint replaces `agent.tools` and, behind the
	 * `session-agent-patch-2026-07-21` beta header, `agent.model` — the latter
	 * carries both the model id and its reasoning level. Because the Session is
	 * patched rather than replaced, changing the model or effort in the picker no
	 * longer wipes the cloud conversation (previous behaviour: new Session plus a
	 * 24k-character replay on the next turn).
	 *
	 * A tools-only refusal stays fatal: the model would otherwise call tools it
	 * was never given. A model/effort refusal falls back to a fresh Session, which
	 * is the one path where trading history for a working turn is right — and the
	 * cold-Session replay immediately restores the transcript.
	 * @param record - live idle conversation record.
	 * @param client - request-scoped Qoder client.
	 * @param modelSpec - desired Qoder model value.
	 * @param sessionTools - desired complete tool array.
	 * @param signal - cancellation.
	 * @returns the record when it stays in use, or undefined after it was released.
	 */
	async #reconcileConversation(record, client, modelSpec, sessionTools, signal) {
		const modelKey = JSON.stringify(modelSpec);
		const signature = toolSetSignature(sessionTools);
		const patch = {};
		if (signature !== record.toolSignature) patch.tools = sessionTools;
		if (modelKey !== record.modelKey) patch.model = modelSpec;
		if (patch.tools === void 0 && patch.model === void 0) return record;
		try {
			const updated = await client.updateSessionRuntime(record.sessionId, patch, signal);
			record.toolSignature = signature;
			record.modelKey = modelKey;
			const modelId = typeof modelSpec === "string" ? modelSpec : modelSpec.id;
			if (updated.effectiveContextWindow > 0) this.#effectiveWindows.set(modelId, updated.effectiveContextWindow);
			return record;
		} catch (error) {
			if (patch.model === void 0) throw error;
			const modelId = typeof modelSpec === "string" ? modelSpec : modelSpec.id;
			this.#warn(`qoder: could not switch this conversation's cloud session to ${modelId} in place (${error?.message ?? error}); starting a fresh cloud session and replaying the transcript`);
			// Carry this Session's credits onto the conversation's running total and
			// release it so a paused or busy turn cannot pin it.
			this.#stats.rotateCloudSession(record.conversationId);
			record.phase = "idle";
			record.awaiting = new Set();
			if (record.key !== null) this.#sessions.delete(record.key);
			await this.#interruptQuietly(client, record.sessionId);
			await client.waitForIdle(record.sessionId, signal).catch(() => false);
			return void 0;
		}
	}
	/** Map Qoder events onto the dsh chunk protocol until the turn settles. */
	async *#translate(body, signal, armIdle, turn, bridge) {
		let index = 0;
		let emitted = false;
		for await (const frame of parseSse(body)) {
			armIdle();
			signal.throwIfAborted();
			const type = String(frame.data?.type ?? frame.event ?? "");
			if (process.env.QODER_DEBUG) console.error(`[qoder-dbg] frame type=${type} pending=${turn.pending.size} bridge=${bridge}`);
			if (type === "heartbeat" || type === "user.message" || type === "session.status_running") continue;
			if (type === "session.error") {
				const message = frame.data?.error?.message ?? frame.data?.message ?? "unknown Qoder session error";
				throw new QoderError(`qoder: session error: ${String(message)}`, "PROVIDER_ERROR");
			}
			if (type === "span.model_request_start") {
				turn.requestStartedAt = timestampOf(frame.data?.processed_at);
				continue;
			}
			if (type === "span.model_request_end") {
				// The only exact per-request Credit figure Qoder exposes. Summing these
				// over a turn is what the credit panel's "本轮" row reports; the
				// Session's cumulative snapshot arrives separately as `session.usage`.
				// A missing `model_usage` (credits unavailable) is not a zero-cost call,
				// so only a stated figure counts; a genuine 0 (free model) still counts
				// as one request.
				const credits = Number(frame.data?.model_usage?.credits);
				if (Number.isFinite(credits)) turn.stats.noteCall(turn.sessionId, credits);
				continue;
			}
			if (type === "session.usage") {
				// Cumulative Session snapshot: replaces the previous values, never added.
				turn.stats.applyUsage(turn.sessionId, {
					modelCredits: frame.data?.model_credits,
					sandboxCredits: frame.data?.sandbox_runtime_credits,
					totalCredits: frame.data?.total_credits
				});
				continue;
			}
			if (type === "agent.thinking") {
				// Qoder publishes the thinking PHASE but not its text: the API documents
				// that "agent.thinking never exposes reasoning content", and the live API
				// (buffered events and `event_deltas[]=agent.thinking` alike) was verified
				// to match. Surface the phase as dsh's reasoning block anyway — the
				// selected level and how long the model thought are real facts the
				// transcript should show — and pass through any reasoning text a payload
				// ever does carry.
				const text = thinkingTextOf(frame.data);
				const summary = text.length > 0 ? text : thinkingSummaryOf(turn, frame.data);
				if (summary.length > 0) {
					yield { type: "block-start", index, blockType: "reasoning" };
					yield { type: "reasoning-delta", index, text: summary };
					yield { type: "block-end", index, block: { type: "reasoning", text: summary } };
					index += 1;
				}
				continue;
			}
			if (type === "agent.message") {
				for (const block of textBlocks(frame.data?.content)) {
					yield { type: "block-start", index, blockType: "text" };
					yield { type: "text-delta", index, text: block };
					yield { type: "block-end", index, block: { type: "text", text: block } };
					index += 1;
					emitted = true;
				}
				continue;
			}
			if (bridge && type === "agent.custom_tool_use") {
				// The model wants a bridged tool. Surface it to dsh as a tool-call using
				// the Qoder event id AS the dsh tool-call id, so the matching result can
				// be routed straight back on the next turn without a side table.
				const data = frame.data ?? {};
				const callId = String(data.custom_tool_use_id ?? data.id ?? frame.id ?? "");
				if (callId.length === 0) continue;
				const dshName = turn.byCustomName?.get(String(data.name ?? "").toLowerCase()) ?? fromCustomToolName(turn.prefix, data.name);
				const args = typeof data.input === "string" ? data.input : safeStringify(data.input ?? {});
				turn.pending.add(callId);
				yield { type: "block-start", index, blockType: "tool-call" };
				yield { type: "tool-call-delta", index, id: callId, name: dshName, argumentsDelta: args };
				yield { type: "block-end", index, block: { type: "tool-call", id: callId, name: dshName, arguments: args } };
				index += 1;
				emitted = true;
				continue;
			}
			if (bridge && type === "agent.tool_use") {
				// The model reached for a *cloud* tool instead of a bridged one. Its
				// sandbox is not the user's disk, so say so plainly rather than letting
				// the turn end with an unexplained blank answer.
				const data = frame.data ?? {};
				const note = `(Qoder tried its own cloud tool "${String(data.name ?? "unknown")}" on its sandbox — that is not your machine. Use a local tool instead.)`;
				yield { type: "block-start", index, blockType: "text" };
				yield { type: "text-delta", index, text: note };
				yield { type: "block-end", index, block: { type: "text", text: note } };
				index += 1;
				emitted = true;
				continue;
			}
			if (type === "agent.thread_context_compacted") {
				// The cloud just summarized this Session's own history to stay inside the
				// model's window. Not an error, but the transcript did become lossy — say so
				// instead of letting a long conversation quietly degrade.
				// Qoder reports fractional credits, so read the number rather than requiring
				// an integer token count.
				const credits = Number(frame.data?.usage?.credits);
				const note = `(Qoder compacted this session's cloud context${credits > 0 ? `, costing ${credits} credits` : ""} — earlier turns are now a summary, so details from further back may be less reliable. Consider starting a fresh conversation for a new task.)`;
				yield { type: "block-start", index, blockType: "text" };
				yield { type: "text-delta", index, text: note };
				yield { type: "block-end", index, block: { type: "text", text: note } };
				index += 1;
				emitted = true;
				continue;
			}
			if (type === "session.status_idle") {
				// A custom tool call leaves the Session parked in `requires_action`; report
				// it as a tool-calls finish so dsh runs the tool locally and calls us back.
				if (bridge && turn.pending.size > 0) {
					yield { type: "finish", reason: { kind: "tool-calls" } };
					return;
				}
				if (!emitted) {
					const placeholder = bridge
						? "(Qoder produced no answer and did not call any local tool. Try asking it to read or search a specific path, or set `cloudTools`/`bridgeLocalTools`.)"
						: "(Qoder returned no message content.)";
					yield { type: "block-start", index, blockType: "text" };
					yield { type: "text-delta", index, text: placeholder };
					yield { type: "block-end", index, block: { type: "text", text: placeholder } };
					index += 1;
				}
				const stopType = String(frame.data?.stop_reason?.type ?? "");
				// Anything that is neither a clean end nor a pending custom tool deserves a
				// word: `max_tokens`, `retries_exhausted` and the other terminal reasons are how
				// the cloud reports it ran out of room or attempts, and a normal-looking answer
				// would hide that the turn was cut short.
				if (stopType.length > 0 && stopType !== "end_turn" && stopType !== "requires_action") {
					const note = `(Qoder stopped this turn with stop_reason "${stopType}".)`;
					yield { type: "block-start", index, blockType: "text" };
					yield { type: "text-delta", index, text: note };
					yield { type: "block-end", index, block: { type: "text", text: note } };
					index += 1;
				}
				const kind = stopType === "max_tokens" ? "max-tokens" : "stop";
				yield { type: "finish", reason: { kind } };
				return;
			}
			// agent.tool_result carries no dsh-side equivalent: it is a *cloud* tool's
			// output, which the user did not ask to run and cannot inspect locally.
			// agent.thinking is translated above into a reasoning block.
		}
		if (bridge && turn.pending.size > 0) {
			yield { type: "finish", reason: { kind: "tool-calls" } };
			return;
		}
		if (!emitted) throw new QoderError("qoder: event stream ended before the turn settled", "STREAM_CLOSED");
		yield { type: "finish", reason: { kind: "stop" } };
	}
}
/** Extract non-empty text strings from a Qoder content-block array. */
function textBlocks(content) {
	if (!Array.isArray(content)) return [];
	return content.filter((block) => block?.type === "text" && typeof block.text === "string" && block.text.length > 0).map((block) => block.text);
}
/**
 * Extract reasoning text from an `agent.thinking` payload.
 *
 * The public API sends a contentless marker today, but the shape is read
 * defensively: a provider/region that starts including text under `content`,
 * `thinking`, `reasoning`, or `text` is rendered verbatim instead of dropped.
 * @param data - the thinking event's payload.
 * @returns reasoning text, or "" when the payload carries none.
 */
function thinkingTextOf(data) {
	for (const key of ["thinking", "reasoning", "text"]) {
		if (typeof data?.[key] === "string" && data[key].length > 0) return data[key];
	}
	if (!Array.isArray(data?.content)) return "";
	return data.content.filter((block) => typeof block?.text === "string" && block.text.length > 0).map((block) => block.text).join("\n");
}
/**
 * Describe one thinking phase when the provider withholds its text.
 *
 * dsh's reasoning block is the transcript's own "thinking process" row, so
 * putting the phase there keeps the display honest: it names the level that was
 * requested and how long the phase took, and says plainly that the reasoning
 * text itself is not public.
 * @param turn - per-turn stream context (request start, effort).
 * @param data - the thinking event's payload.
 * @returns one-line phase summary.
 */
function thinkingSummaryOf(turn, data) {
	const startedAt = turn.requestStartedAt;
	const finishedAt = timestampOf(data?.processed_at);
	const seconds = startedAt > 0 && finishedAt > startedAt ? Math.round((finishedAt - startedAt) / 100) / 10 : 0;
	const effort = typeof turn.effort === "string" && turn.effort.length > 0 ? turn.effort : "";
	const label = effort.length > 0 ? EFFORT_INFO[effort]?.name ?? effort : "";
	const facts = ["Thinking phase"];
	if (seconds > 0) facts.push(`${seconds}s`);
	if (label.length > 0) facts.push(`effort ${label}`);
	return `${facts.join(" · ")} (Qoder Cloud Agents does not publish the reasoning text).`;
}
/**
 * Parse an RFC 3339 timestamp from a public Qoder event.
 * @param value - `processed_at` value.
 * @returns epoch milliseconds, or 0 when absent/unparsable.
 */
function timestampOf(value) {
	if (typeof value !== "string" || value.length === 0) return 0;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : 0;
}
function titleCase(value) {
	return String(value).replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Plugin entry point.
 * @param ctx - Cordis plugin context (with the `llm` service injected).
 * @param config - the plugin's live configuration object.
 */
function apply(ctx, config) {
	// Diagnostic trail: proves the plugin loaded and pinpoints where registration
	// stops, if it ever does. Best-effort; never throws.
	const trace = (message) => {
		try {
			appendFileSync(join(homedir(), ".dsh", "qoder-plugin-load.log"), `[${new Date().toISOString()}] ${message}\n`);
		} catch {
			/* ignore */
		}
	};
	try {
		const shape = config == null ? String(config) : typeof config === "object" ? `object{${Object.keys(config).join(",")}}` : typeof config;
		trace(`apply() entered; config=${shape} ctx.llm=${typeof ctx?.llm} registerAdapter=${typeof ctx?.llm?.registerAdapter} registerConfigurableProviders=${typeof ctx?.llm?.registerConfigurableProviders}`);
	} catch {
		/* marker is best-effort; never let it break the load */
	}
	// Keep the Settings service from auto-writing this plugin's config; the patch
	// layer (or environment) is the source of truth.
	ctx.inject(["settings"], (child) => {
		child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
	});
	const settingsNs = ctx.fiber.entry?.options.id ?? name;
	// Some networks reset TLS 1.3 handshakes to the Qoder host (curl, offering
	// 1.2, succeeds while Node/undici, defaulting to 1.3, gets ECONNRESET). Pin
	// the process TLS ceiling before the first request; see pinTlsMax().
	pinTlsMax(str(pick(config, "tlsMaxVersion"), "TLSv1.2"));
	// Eagerly validate so misconfiguration surfaces at load — but never let a
	// config-shape surprise disable the whole plugin; the provider still needs
	// to register so it shows up in Settings → Models.
	try {
		resolveConnection(config);
	} catch (error) {
		ctx.logger?.warn?.("qoder: provider config not finalized at load; will re-resolve per request", error);
	}

	let lastTokenSource = "";
	const noteTokenSource = (source, value) => {
		if (lastTokenSource === source) return;
		lastTokenSource = source;
		trace(`token resolved from ${source} (length ${value.length})`);
	};
	const resolveToken = async () => {
		const snapshot = resolveConnection(config);
		// Candidate credential references, in priority order. The configured ref
		// wins, but the Models page (with no settings schema of its own) stores a
		// typed key under the derived `QODER_API_KEY`, and the original patch used
		// `QODER_PAT`; trying all of them means the token is found whichever way it
		// was saved, without depending on a full profile restart.
		const refs = [...new Set([snapshot.apiKeyRef, "QODER_API_KEY", "QODER_PAT"])];
		const credentials = ctx.get("credentials");
		if (credentials?.resolve !== void 0) {
			for (const ref of refs) {
				try {
					const hit = await credentials.resolve(ref);
					const raw = hit?.value ?? hit;
					const value = typeof raw === "string" ? normalizeToken(raw) : "";
					if (value.length > 0) {
						noteTokenSource(`credential "${ref}"`, value);
						return value;
					}
				} catch (error) {
					ctx.logger?.warn?.(`qoder: credentials lookup failed for "${ref}", trying next`, error);
				}
			}
		}
		for (const ref of refs) {
			const ambient = nonEmpty(readProcessEnv(ref));
			if (ambient !== void 0) {
				noteTokenSource(`environment "${ref}"`, ambient);
				return ambient;
			}
		}
		if (snapshot.ambientKey !== void 0) return normalizeToken(snapshot.ambientKey);
		throw new QoderError(`qoder: no access token for provider route "${PROVIDER}"; enter it in Settings \u2192 Models, or export ${refs[0]} in the launching environment`, "MISSING_CREDENTIAL");
	};

	// One statistics store for the whole provider: the adapter writes per-call
	// Credits into it and the browser half reads it back over the plugin's own
	// route. It lives on this fiber, so the effect that registers the route is
	// disposed with the plugin.
	const stats = new QoderCreditStats();

	try {
		if (ctx.llm?.registerConfigurableProviders) {
			ctx.llm.registerConfigurableProviders([{
				provider: PROVIDER,
				displayName: PROVIDER_DISPLAY,
				settingsNs,
				settingsPath: []
			}]);
			trace("registerConfigurableProviders() ok");
		} else {
			trace("registerConfigurableProviders() SKIPPED (method unavailable)");
		}

		const adapter = new QoderSessionAdapter(() => resolveConnection(config), resolveToken, (message) => {
			trace(message);
			ctx.logger?.warn?.(message);
		}, stats);
		const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
		trace("registerAdapter() ok");
		if (registration?.replace !== void 0) {
			ctx.on("loader/volatile-update", () => {
				adapter.reset();
				registration.replace([PROVIDER]);
			});
		}
		// Credit statistics are not settings and not session events, so the Web
		// client cannot read them through an existing RPC namespace. The Host's own
		// Web server is the intended plugin seam (`ctx.inject(['webServer'])`, the
		// same way client bundles are served); when the deployment has none (e.g.
		// the Electron shell) the route simply never appears and the browser half
		// renders nothing.
		ctx.inject(["webServer"], (webCtx) => {
			webCtx.effect(() => webCtx.webServer.register({
				kind: "exact",
				path: CREDIT_STATS_ROUTE,
				handler: (req, res) => serveCreditStats(req, res, stats)
			}), "qoder: credit statistics route");
		});
		trace("apply() completed successfully");
	} catch (error) {
		trace(`apply() FAILED: ${error?.stack ?? error?.message ?? error}`);
		throw error;
	}
}

/**
 * Internals exported for the repository's offline tests. Not part of the plugin
 * contract: the harness only consumes `apply`, `Config`, `inject`, and `name`.
 */
const __test = {
	QoderError,
	QoderCreditStats,
	QoderSessionAdapter,
	agentModelSpec,
	creditNumber,
	creditRateOf,
	effortIdsForModel,
	formatFactor,
	modelDescription,
	normalizeModelList,
	priceFactorBadge,
	reasoningInfoFor,
	serveCreditStats,
	thinkingTextOf,
	thinkingSummaryOf,
	EFFORT_INFO,
	EFFORT_ORDER
};

export { apply, Config, inject, name, __test };

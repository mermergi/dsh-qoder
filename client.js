// Browser half of the Qoder provider plugin.
//
// Why this file exists: dsh's Settings → Models page renders a per-provider
// editor only for the two hard-coded families (`llm-deepseek`, `llm-pi-ai`);
// every other namespace falls back to an "edit cordis.patch.yml" hint with the
// submit button disabled. A third-party provider therefore cannot use that
// built-in editor. The Models section does, however, declare a keyed child slot
// `settings.models.provider-card` that it renders inline on every provider row
// (matched by `entryKey === row.entry.settingsNs`). Registering a component
// there keyed to `llm-qoder` puts a working configuration form directly on the
// Qoder card — no file editing required.
//
// This bundle is discovered by the host `ClientModuleRegistry`, which scans the
// loaded profile entries for a package.json `dsh.client` declaration with
// `platform: "web"` and serves this file (resolved from `exports["./client"]`).
// It is authored in the same lazy-CJS `window.__ModuleLoader__.load` shape the
// built-in client packages use, so it materializes against the app's existing
// React + UI-primitives module graph.
//
// The same bundle also owns the Qoder credit chip in the Session header. That
// chip reads `GET /qoder/credits?sessionId=…` from the Host's own Web server
// (the runtime Credits are not settings and not Session events), polls it while
// the page is visible, and renders nothing at all — forever, for that page —
// when the deployment has no such route.
window.__ModuleLoader__.load({
	id: "@local/dsh-plugin-qoder",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_dom = require("react-dom");
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region locales
		const en = {
			title: "Qoder sign-in",
			description: "Enter a Personal Access Token to use Qoder Cloud models.",
			apiKey: "Personal Access Token",
			apiKeyHint: "Stored in the credential vault, not the settings file. Leave blank to keep the current token.",
			apiKeySet: "A token is configured.",
			apiKeyUnset: "No token yet — sign in to use Qoder models.",
			baseUrl: "Endpoint",
			baseUrlHint: "Qoder Cloud API base URL. Leave blank for the default.",
			defaultModel: "Default model",
			defaultModelHint: "Model id used when a conversation does not pick one.",
			overridden: "Overridden",
			reset: "Reset to default",
			save: "Save",
			saving: "Saving…",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			unavailable: "The Qoder provider is not loaded, so it cannot be configured right now.",
			readOnly: "This deployment stores settings read-only.",
			defaultReasoningEffort: "Default reasoning effort",
			defaultReasoningEffortHint: "Leave blank to follow the model's default; accepted values: low / medium / high / xhigh / max.",
			"credits.title": "Qoder credits",
			"credits.aria": "Qoder credits: {credits}",
			"credits.turn": "This turn",
			"credits.turnCalls": "{calls} requests",
			"credits.session": "This conversation",
			"credits.sessionBreakdown": "Model {model} · Sandbox {sandbox}",
			"credits.lifetime": "This run",
			"credits.model": "Model",
			"credits.effort": "Reasoning effort",
			"credits.priceFactor": "Credit multiplier",
			"credits.empty": "No data"
		};
		const zh = {
			title: "Qoder 登录配置",
			description: "填入 Personal Access Token 即可使用 Qoder Cloud 模型。",
			apiKey: "Personal Access Token",
			apiKeyHint: "保存在凭据库中，不写入设置文件。留空表示保持当前令牌。",
			apiKeySet: "已配置令牌。",
			apiKeyUnset: "尚未配置令牌——登录后才能使用 Qoder 模型。",
			baseUrl: "接口地址",
			baseUrlHint: "Qoder Cloud API 基地址，留空则使用默认值。",
			defaultModel: "默认模型",
			defaultModelHint: "对话未指定模型时使用的模型 id。",
			overridden: "已覆盖",
			reset: "恢复默认",
			save: "保存",
			saving: "保存中…",
			saveFailed: "本部署没有接受这些值，已保留供你修改。",
			unavailable: "Qoder provider 当前未加载，暂时无法配置。",
			readOnly: "本部署的设置为只读。",
			defaultReasoningEffort: "默认推理强度",
			defaultReasoningEffortHint: "留空 = 跟随模型默认；可选 low / medium / high / xhigh / max。",
			"credits.title": "Qoder 积分",
			"credits.aria": "Qoder 积分：{credits}",
			"credits.turn": "本轮",
			"credits.turnCalls": "{calls} 次请求",
			"credits.session": "本会话累计",
			"credits.sessionBreakdown": "模型 {model} · 沙箱 {sandbox}",
			"credits.lifetime": "本次运行累计",
			"credits.model": "模型",
			"credits.effort": "推理强度",
			"credits.priceFactor": "积分倍率",
			"credits.empty": "暂无数据"
		};
		/**
		* The shared form frame's copy, read from this card's dictionary.
		* @param t - the card's locale reader.
		* @returns the labels SettingsForm renders.
		*/
		function formLabels(t) {
			return {
				unavailable: t("unavailable"),
				readOnly: t("readOnly"),
				saveFailed: t("saveFailed"),
				save: t("save"),
				saving: t("saving")
			};
		}
		//#endregion
		//#region component
		/**
		* Render the Qoder configuration card inline on the Models page.
		* @param props - locale reader, the bound form store, and its actions; plus
		*   the owner props the Models section hands to every provider-card seat.
		* @returns the form.
		*/
		function QoderCard(props) {
			const { t } = props;
			const state = props.useQoderCard((snapshot) => snapshot);
			return (0, react_jsx_runtime.jsxs)("div", {
				style: { display: "flex", flexDirection: "column", gap: "8px", marginTop: "8px" },
				children: [
					(0, react_jsx_runtime.jsx)("div", {
						style: { fontWeight: 600, fontSize: "13px" },
						children: t("title")
					}),
					(0, react_jsx_runtime.jsxs)(primitives.SettingsForm, {
						labels: formLabels(t),
						state,
						onSave: props.save,
						onDiscard: props.discard,
						children: [
							(0, react_jsx_runtime.jsx)(primitives.SettingsSecretField, {
								id: "plugin-config-qoder-key",
								label: t("apiKey"),
								hint: t("apiKeyHint"),
								disabled: !state.apiKeyWritable,
								text: state.apiKey.text,
								configured: state.apiKeyConfigured,
								stateLabel: state.apiKeyConfigured ? t("apiKeySet") : t("apiKeyUnset"),
								onEdit: (text) => {
									props.edit("apiKey", text);
								}
							}),
							(0, react_jsx_runtime.jsx)(primitives.SettingsValueField, {
								id: "plugin-config-qoder-endpoint",
								label: t("baseUrl"),
								hint: t("baseUrlHint"),
								overriddenLabel: t("overridden"),
								resetLabel: t("reset"),
								disabled: !state.writable,
								...state.baseURL,
								onEdit: (text) => {
									props.edit("baseURL", text);
								},
								onReset: () => {
									props.resetField("baseURL");
								}
							}),
							(0, react_jsx_runtime.jsx)(primitives.SettingsValueField, {
								id: "plugin-config-qoder-model",
								label: t("defaultModel"),
								hint: t("defaultModelHint"),
								overriddenLabel: t("overridden"),
								resetLabel: t("reset"),
								disabled: !state.writable,
								...state.defaultModel,
								onEdit: (text) => {
									props.edit("defaultModel", text);
								},
								onReset: () => {
									props.resetField("defaultModel");
								}
							}),
							(0, react_jsx_runtime.jsx)(primitives.SettingsValueField, {
								id: "plugin-config-qoder-effort",
								label: t("defaultReasoningEffort"),
								hint: t("defaultReasoningEffortHint"),
								overriddenLabel: t("overridden"),
								resetLabel: t("reset"),
								disabled: !state.writable,
								...state.defaultReasoningEffort,
								onEdit: (text) => {
									props.edit("defaultReasoningEffort", text);
								},
								onReset: () => {
									props.resetField("defaultReasoningEffort");
								}
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region credits
		/**
		* How often the header chip re-reads the Host's statistics while the page is
		* visible. The route is an in-memory read, and a turn's Credits change only
		* when a model call settles, so ~2.5s is responsive without being chatty.
		*/
		const CREDIT_POLL_MS = 2500;
		/** Placeholder for a statistic the Host has no value for. */
		const EM_DASH = "\u2014";
		/** Measurement style while the anchored panel is still being placed. */
		const HIDDEN_MEASURE = {
			visibility: "hidden",
			left: 0,
			top: 0
		};
		/** Quiet header trigger: secondary text tone, hover wash, tabular figures. */
		const creditsTriggerStyle = {
			display: "inline-flex",
			alignItems: "center",
			gap: "5px",
			flex: "none",
			padding: "1px 7px",
			border: "none",
			borderRadius: "var(--dsw-radius-sm)",
			background: "transparent",
			color: "var(--dsw-alias-label-tertiary)",
			fontFamily: "inherit",
			fontSize: "var(--dsh-content-font-size-secondary, 13px)",
			fontVariantNumeric: "tabular-nums",
			lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
			whiteSpace: "nowrap",
			cursor: "pointer"
		};
		/** The trigger's hover/open surface, matching the header's other quiet controls. */
		const creditsTriggerActiveStyle = {
			background: "var(--dsw-alias-interactive-bg-hover)",
			color: "var(--dsw-alias-label-secondary)"
		};
		/** Popover shell: the app's menu material, radius, and prominent elevation. */
		const creditsPanelStyle = {
			position: "fixed",
			zIndex: 1100,
			boxSizing: "border-box",
			width: "min(280px, calc(100vw - 24px))",
			padding: "10px 12px",
			borderRadius: "var(--dsw-radius-lg)",
			background: "var(--dsw-specific-menu)",
			backdropFilter: "var(--dsw-menu-backdrop-filter)",
			boxShadow: "var(--dsw-elevation-prominent)",
			color: "var(--dsw-alias-label-secondary)",
			fontSize: "12px",
			lineHeight: "20px",
			cursor: "default"
		};
		/** Popover header line. */
		const creditsHeaderStyle = {
			display: "flex",
			alignItems: "center",
			gap: "6px",
			marginBottom: "4px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		/** One label/value line. */
		const creditsRowStyle = {
			display: "flex",
			alignItems: "baseline",
			justifyContent: "space-between",
			gap: "12px",
			padding: "2px 0"
		};
		/** Secondary label tone inside a line. */
		const creditsLabelStyle = {
			color: "var(--dsw-alias-label-tertiary)"
		};
		/** Primary number tone inside a line. */
		const creditsValueStyle = {
			color: "var(--dsw-alias-label-primary)",
			fontVariantNumeric: "tabular-nums",
			fontWeight: 500
		};
		/** Smaller explanation under a line (call counts, model/sandbox split). */
		const creditsHintStyle = {
			color: "var(--dsw-alias-label-tertiary)",
			fontSize: "11px",
			lineHeight: "16px",
			fontVariantNumeric: "tabular-nums"
		};
		/** Hairline separating the totals from the model facts. */
		const creditsDividerStyle = {
			height: "1px",
			margin: "6px 0",
			background: "var(--dsw-alias-border-l1)"
		};
		/**
		* Format a Credit amount for the chip and panel: at most two decimals with
		* trailing zeros dropped (`0.5`, `1.48`, `12`).
		* @param value - a Credit amount from the route snapshot.
		* @returns the display text, or an em dash when the amount is not a number.
		*/
		function formatCredits(value) {
			const number = typeof value === "number" ? value : value === null || value === undefined ? Number.NaN : Number(value);
			if (!Number.isFinite(number)) return EM_DASH;
			// toFixed rounds half-up enough for display and always emits two
			// decimals, so the strip is a simple suffix removal.
			return number.toFixed(2).replace(/\.?0+$/, "");
		}
		/**
		* Format the catalog's Credit multiplier: `0.5×` for a paid model, the
		* localized "free" word for 0 Credits, and an em dash when the catalog has
		* no answer for this model.
		* @param value - the route's `priceFactor`.
		* @param t - the card's locale reader.
		* @returns the display text.
		*/
		function formatPriceFactor(value, t) {
			const number = typeof value === "number" ? value : value === null || value === undefined ? Number.NaN : Number(value);
			if (!Number.isFinite(number)) return EM_DASH;
			// A 0 rate is a reference rate, not proof that the model is free: Cloud
			// Agents also bills sandbox runtime, and the catalog rate can trail the
			// actual charge. Show the literal rate and let the Credits rows speak.
			return `${formatCredits(number)}\u00d7`;
		}
		/**
		* Normalize one `/qoder/credits` response body into the shape the chip
		* renders. Pure and total: a malformed body yields null, counts that the
		* route omits fall back to 0, and every other number stays either a finite
		* number or null so the panel can tell "0 Credits" from "unknown".
		* @param raw - the parsed JSON body.
		* @returns the normalized snapshot, or null when the body is not a v1 answer.
		*/
		function parseStatsResponse(raw) {
			if (raw === null || typeof raw !== "object" || raw.ok !== true) return null;
			const text = (value) => typeof value === "string" && value.length > 0 ? value : null;
			const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
			const count = (value) => number(value) ?? 0;
			const session = raw.session !== null && typeof raw.session === "object" ? raw.session : null;
			return {
				known: raw.known === true,
				sessionId: text(raw.sessionId),
				model: text(raw.model),
				modelName: text(raw.modelName),
				effort: text(raw.effort),
				priceFactor: number(raw.priceFactor),
				turn: {
					index: count(raw.turn?.index),
					credits: count(raw.turn?.credits),
					calls: count(raw.turn?.calls),
					lastCallCredits: count(raw.turn?.lastCallCredits)
				},
				session: session === null ? null : {
					modelCredits: count(session.modelCredits),
					sandboxCredits: count(session.sandboxCredits),
					totalCredits: count(session.totalCredits),
					carriedCredits: count(session.carriedCredits),
					total: count(session.total)
				},
				lifetime: {
					credits: count(raw.lifetime?.credits),
					calls: count(raw.lifetime?.calls)
				},
				updatedAt: number(raw.updatedAt)
			};
		}
		/**
		* Build one panel line.
		* @param label - localized row label.
		* @param value - already-formatted value text.
		* @param hint - optional smaller explanation under the line.
		* @returns the line element.
		*/
		function creditsRow(label, value, hint) {
			return (0, react_jsx_runtime.jsxs)("div", {
				style: { padding: "3px 0" },
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						style: creditsRowStyle,
						children: [
							(0, react_jsx_runtime.jsx)("span", {
								style: creditsLabelStyle,
								children: label
							}),
							(0, react_jsx_runtime.jsx)("span", {
								style: creditsValueStyle,
								children: value
							})
						]
					}),
					hint === undefined ? null : (0, react_jsx_runtime.jsx)("div", {
						style: creditsHintStyle,
						children: hint
					})
				]
			});
		}
		/**
		* The credit breakdown panel. Kept separate from the chip so it renders the
		* same way in the popover and in offline tests, and never touches the
		* network or the DOM itself.
		* @param props.stats - a snapshot from {@link parseStatsResponse} with `known: true`.
		* @param props.t - the card's locale reader.
		* @param props.panelRef - ref the anchored-position hook measures.
		* @param props.style - placement coordinates from the anchor hook.
		* @returns the panel, or null when the snapshot carries no Session section.
		*/
		function CreditsPanel({ stats, t, panelRef, style }) {
			if (stats.session === null) return null;
			const empty = t("credits.empty");
			// "No data" rather than a misleading 0 while the Host has not recorded
			// a figure yet; priceFactor 0 has its own truthful "free" wording.
			// A reported 0 is a real figure (nothing billed yet or nothing to bill), so
			// it reads "0"; only an absent value reads "no data".
			const amount = (value) => typeof value === "number" && Number.isFinite(value) ? formatCredits(value) : empty;
			const model = stats.modelName ?? stats.model;
			return (0, react_jsx_runtime.jsxs)("div", {
				ref: panelRef,
				role: "dialog",
				"aria-label": t("credits.title"),
				style: { ...creditsPanelStyle, ...(style ?? {}) },
				children: [
					(0, react_jsx_runtime.jsx)("div", {
						style: creditsHeaderStyle,
						children: t("credits.title")
					}),
					creditsRow(t("credits.turn"), amount(stats.turn.credits), stats.turn.calls > 0 ? t("credits.turnCalls", { calls: stats.turn.calls }) : empty),
					creditsRow(t("credits.session"), amount(stats.session.total), t("credits.sessionBreakdown", {
						model: formatCredits(stats.session.modelCredits),
						sandbox: formatCredits(stats.session.sandboxCredits)
					})),
					creditsRow(t("credits.lifetime"), amount(stats.lifetime.credits)),
					(0, react_jsx_runtime.jsx)("div", { style: creditsDividerStyle }),
					creditsRow(t("credits.model"), model ?? empty),
					creditsRow(t("credits.effort"), stats.effort ?? EM_DASH),
					creditsRow(t("credits.priceFactor"), formatPriceFactor(stats.priceFactor, t))
				]
			});
		}
		/**
		* Session-header credit chip.
		*
		* Polls the Host route while the page is visible because Credits are runtime
		* facts with no Session event of their own. Renders nothing until the Host
		* says it knows this Session, and renders nothing forever when the route is
		* absent (the Electron shell or a deployment without the Web seam) — an
		* absent route must not turn into a missing-control artifact on every header.
		* @param props.sessionId - the Session standard prop this seat receives.
		* @param props.t - the card's locale reader.
		* @returns the trigger and, while open, the portaled breakdown; or null.
		*/
		function CreditsChip({ sessionId, t }) {
			const [stats, setStats] = (0, react.useState)(null);
			// Which Session the snapshot above belongs to. Kept beside it so a
			// Session switch renders nothing during the first paint, before the
			// effect below gets a chance to clear the previous conversation's data.
			const [statsSession, setStatsSession] = (0, react.useState)(null);
			const [absent, setAbsent] = (0, react.useState)(false);
			const [open, setOpen] = (0, react.useState)(false);
			const [hover, setHover] = (0, react.useState)(false);
			const rootRef = (0, react.useRef)(null);
			const panelRef = (0, react.useRef)(null);
			const position = (0, primitives.useAnchoredPosition)({
				open,
				anchorRef: rootRef,
				panelRef,
				side: "bottom",
				gap: 8,
				margin: 12
			});
			(0, primitives.useDismissOnOutsidePointer)(rootRef, open, setOpen, panelRef);
			(0, react.useEffect)(() => {
				if (!open) return;
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);
			(0, react.useEffect)(() => {
				if (typeof sessionId !== "string" || sessionId.length === 0) return;
				let cancelled = false;
				let timer = null;
				let gone = false;
				// A different Session starts from "nothing known" rather than
				// showing the previous conversation's totals for one poll.
				setStats(null);
				setAbsent(false);
				setOpen(false);
				const clearTimer = () => {
					if (timer !== null) {
						clearTimeout(timer);
						timer = null;
					}
				};
				const schedule = () => {
					clearTimer();
					if (cancelled || gone) return;
					timer = setTimeout(tick, CREDIT_POLL_MS);
				};
				const read = async () => {
					try {
						const response = await fetch(`qoder/credits?sessionId=${encodeURIComponent(sessionId)}`, {
							method: "GET",
							credentials: "same-origin",
							cache: "no-store",
							headers: { accept: "application/json" }
						});
						if (cancelled) return;
						// 404 is permanent for this deployment: the Host has no such
						// route, so stop asking instead of polling a missing endpoint.
						if (response.status === 404) {
							gone = true;
							clearTimer();
							setAbsent(true);
							return;
						}
						if (!response.ok) {
							schedule();
							return;
						}
						const parsed = parseStatsResponse(await response.json());
						if (cancelled) return;
						// A malformed body keeps the last good snapshot and retries.
						if (parsed !== null) {
							setStats(parsed);
							setStatsSession(sessionId);
						}
						schedule();
					} catch {
						// Network/parse failure: retry on the next poll, keeping the
						// last snapshot the user is already looking at.
						if (!cancelled) schedule();
					}
				};
				const tick = () => {
					clearTimer();
					if (document.visibilityState !== "visible") return;
					read();
				};
				const onVisibility = () => {
					if (cancelled || gone) return;
					clearTimer();
					// Returning to the page refreshes immediately, then re-arms.
					if (document.visibilityState === "visible") read();
				};
				tick();
				document.addEventListener("visibilitychange", onVisibility);
				return () => {
					cancelled = true;
					clearTimer();
					document.removeEventListener("visibilitychange", onVisibility);
				};
			}, [sessionId]);
			const current = statsSession === sessionId ? stats : null;
			if (absent || typeof sessionId !== "string" || current === null || current.known !== true || current.session === null) return null;
			const total = formatCredits(current.session.total);
			const label = t("credits.aria", { credits: total });
			const triggerStyle = {
				...creditsTriggerStyle,
				...(hover || open ? creditsTriggerActiveStyle : {})
			};
			return (0, react_jsx_runtime.jsxs)("span", {
				ref: rootRef,
				style: { display: "inline-flex", flex: "none" },
				children: [
					(0, react_jsx_runtime.jsx)(primitives.Tooltip, {
						label,
						side: "bottom",
						delayMs: 200,
						disabled: open,
						children: (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							style: triggerStyle,
							"aria-label": label,
							"aria-haspopup": "dialog",
							"aria-expanded": open,
							onMouseEnter: () => setHover(true),
							onMouseLeave: () => setHover(false),
							onClick: () => setOpen(!open),
							children: [(0, react_jsx_runtime.jsx)(primitives.IconGaugeOutlineRegular, { size: 14 }), (0, react_jsx_runtime.jsx)("span", { children: total })]
						})
					}),
					open ? (0, react_dom.createPortal)((0, react_jsx_runtime.jsx)(CreditsPanel, {
						stats: current,
						t,
						panelRef,
						style: position ?? HIDDEN_MEASURE
					}), document.body) : null
				]
			});
		}
		//#endregion
		//#region controller
		/** Settings namespace owned by the Qoder provider (its composition entry id). */
		const QODER_NS = "llm-qoder";
		/** Credential reference the provider resolves when the section names none. */
		const DEFAULT_API_KEY_REF = "QODER_API_KEY";
		/** Form field the credential control stages under. */
		const API_KEY_FIELD = "apiKey";
		/**
		* Staged form over the `llm-qoder` namespace plus the credential the section
		* references. The token literal never rides a settings response: the card
		* learns only whether one is configured (via `credentials.describe`) and
		* writes it through the credentials domain (via `credentials.set`), addressed
		* by the reference the section names — exactly the web-search card's contract.
		*/
		var QoderCardController = class {
			scope;
			ctx;
			form;
			store;
			unsubscribe;
			credential = {
				ref: "",
				configured: false,
				writable: true
			};
			constructor(scope, ctx) {
				this.scope = scope;
				this.ctx = ctx;
				this.form = new primitives.SettingsFormModel(scope, [
					primitives.settingsTextField("baseURL"),
					primitives.settingsTextField("defaultModel"),
					primitives.settingsTextField("defaultReasoningEffort")
				], [{
					field: API_KEY_FIELD,
					write: (text) => this.writeKey(text)
				}]);
				this.store = this.form.bind(() => this.projection());
				this.unsubscribe = scope.subscribe(() => {
					this.readCredential();
				});
				this.readCredential();
			}
			projection() {
				return {
					...this.form.shell(),
					baseURL: this.form.field("baseURL"),
					defaultModel: this.form.field("defaultModel"),
					defaultReasoningEffort: this.form.field("defaultReasoningEffort"),
					apiKey: this.form.field(API_KEY_FIELD),
					apiKeyConfigured: this.credential.configured,
					apiKeyWritable: this.credential.writable
				};
			}
			async readCredential() {
				const ref = refOf(this.scope.getSnapshot());
				if (ref !== this.credential.ref) {
					this.credential = {
						ref,
						configured: false,
						writable: true
					};
					this.store.set(this.projection());
				}
				const response = await this.ctx.remote.credentials.describe([ref]);
				if (!response.ok || ref !== refOf(this.scope.getSnapshot())) return;
				const view = response.value[ref];
				const next = {
					ref,
					configured: view?.configured ?? false,
					writable: view?.writable ?? true
				};
				if (next.configured === this.credential.configured && next.writable === this.credential.writable) return;
				this.credential = next;
				this.store.set(this.projection());
			}
			refreshCredential(ref) {
				if (ref !== this.credential.ref) return;
				this.readCredential();
			}
			inject() {
				return {
					hooks: { qoderCard: this.store },
					...this.form.actions()
				};
			}
			async writeKey(value) {
				await this.ctx.remote.credentials.set(refOf(this.scope.getSnapshot()), value);
				await this.readCredential();
				return this.credential.configured;
			}
			dispose() {
				this.unsubscribe();
				this.form.dispose();
			}
		};
		/**
		* The credential reference the section names, or the provider's default.
		* @param snapshot - the current scope snapshot.
		* @returns the reference to address.
		*/
		function refOf(snapshot) {
			const declared = snapshot.value?.apiKeyEnv;
			return typeof declared === "string" && declared.length > 0 ? declared : DEFAULT_API_KEY_REF;
		}
		//#endregion
		//#region entry
		/** Dictionary namespace owned by this card. */
		const NS = "settings.qoder";
		/** Required services (cordis fiber inject). */
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.credentials",
			"configForms"
		];
		/**
		* Mount the Qoder configuration card while the Host serves the `llm-qoder`
		* namespace, into the Models section's keyed provider-card seat.
		* @param ctx - the browser plugin context.
		*/
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-settings-qoder: dictionaries");
			const card = new QoderCardController(ctx.configForms.get(QODER_NS), ctx);
			ctx.effect(() => () => {
				card.dispose();
			}, "ui-settings-qoder: form subscription");
			ctx.effect(() => ctx.remote.$on("credentials/reference-updated", (ref) => {
				card.refreshCredential(ref);
			}), "ui-settings-qoder: credential invalidations");
			ctx.effect(() => ctx.configForms.whileServed([QODER_NS], () => ctx.slots.inject("settings.models.provider-card", () => ctx.slots.register({
				name: "settings.models.provider-card",
				key: QODER_NS,
				locale: NS,
				inject: () => card.inject()
			}, QoderCard))), "ui-settings-qoder: card");
			// The header chip is not gated on the Settings page and is registered
			// unconditionally: it reads the Host's credit route directly, and hides
			// itself when this deployment has no such route at all.
			ctx.effect(() => ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "qoder-credits",
				order: 5,
				locale: NS,
				inject: () => ({})
			}, CreditsChip)), "ui-settings-qoder: credit chip");
		}
		//#endregion
		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		/** Offline-test surface: pure helpers plus the two components, no network. */
		exports.__test = {
			parseStatsResponse,
			formatCredits,
			formatPriceFactor,
			CreditsChip,
			CreditsPanel
		};
		return module.exports;
	}
});

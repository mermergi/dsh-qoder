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
window.__ModuleLoader__.load({
	id: "@local/dsh-plugin-qoder",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
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
			readOnly: "This deployment stores settings read-only."
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
			readOnly: "本部署的设置为只读。"
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
							})
						]
					})
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
					primitives.settingsTextField("defaultModel")
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
		}
		//#endregion
		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

window.__ModuleLoader__.load({
	id: "dsh-approval-review",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		/**
		* Reset the nearest scrollable ancestor that actually overflows.
		*
		* "Actually overflows" matters: an ancestor with `overflow-y: auto` but no
		* overflow cannot be scrolled, so resetting it is a no-op that would hide the
		* real scroller further up.
		* @param from - the element whose ancestry to search (usually the view root).
		* @param overflowYOf - computed `overflow-y` accessor for one node.
		* @param maxDepth - stop after this many ancestors.
		* @returns the node that was reset, or undefined when none qualified.
		*/
		function resetScrollableAncestorToTop(from, overflowYOf, maxDepth = 12) {
			let node = from?.parentElement ?? null;
			for (let depth = 0; node !== null && depth < maxDepth; depth += 1, node = node.parentElement) {
				const overflowY = overflowYOf(node);
				if (overflowY !== "auto" && overflowY !== "scroll") continue;
				if (node.scrollHeight <= node.clientHeight) continue;
				node.scrollTop = 0;
				return node;
			}
		}
		//#endregion
		//#region src/client/model-choices.ts
		/**
		* Reviewer-route choices for the Approvals tab's model picker.
		*
		* The reviewer runs as a subagent, so the routes a deployment actually offers it
		* are already published as session projections — this module just reads them
		* instead of hardcoding a model list that would go stale:
		*
		* - `subagentModelSelectionPolicy`: the deployment's allowed subagent routes
		*   (`subagent-model-selection.allowedModels` in `settings.yaml`);
		* - `modelSelection.lastUsed`: the session's own route, i.e. what "inherit"
		*   resolves to.
		*
		* Everything is read structurally and defensively: a projection this host does
		* not publish, or an entry with a non-string half, contributes nothing rather
		* than breaking the picker.
		* @module dsh-approval-review/client/model-choices
		*/
		/** One `{provider, model}` route, when both halves are strings. */
		function routeOf(value) {
			if (typeof value !== "object" || value === null) return void 0;
			const entry = value;
			if (typeof entry.provider !== "string" || typeof entry.model !== "string") return void 0;
			if (entry.provider.length === 0 || entry.model.length === 0) return void 0;
			return `${entry.provider}/${entry.model}`;
		}
		/** Every valid route in a projection that carries a list of them. */
		function routesOf(value) {
			if (!Array.isArray(value)) return [];
			const out = [];
			for (const entry of value) {
				const route = routeOf(entry);
				if (route !== void 0) out.push(route);
			}
			return out;
		}
		/**
		* Every route in a client model-directory snapshot (`modelDirectories` service).
		*
		* This is the SAME catalog the composer's model seat and the `/model` picker
		* read, so the reviewer picker offers exactly the models the deployment
		* configures locally — minus anything the catalog failed to load, which it
		* reports separately and which we deliberately do not guess at.
		* @param value - the directory state returned by `directoryFor(session).load()`.
		* @returns distinct `provider/model` labels in catalog order.
		*/
		function routesFromDirectory(value) {
			if (typeof value !== "object" || value === null) return [];
			const groups = value.groups;
			if (!Array.isArray(groups)) return [];
			const out = [];
			for (const group of groups) {
				if (typeof group !== "object" || group === null) continue;
				const id = group.id;
				const models = group.models;
				if (typeof id !== "string" || id.length === 0 || !Array.isArray(models)) continue;
				for (const model of models) {
					if (typeof model !== "object" || model === null) continue;
					const modelId = model.id;
					if (typeof modelId !== "string" || modelId.length === 0) continue;
					const route = `${id}/${modelId}`;
					if (!out.includes(route)) out.push(route);
				}
			}
			return out;
		}
		/**
		* Build the picker's option list.
		*
		* Order is deliberate: the session override in force first (so a route chosen
		* outside the deployment's list still shows as the current selection), then the
		* session's own model, then the deployment's allowed subagent routes. Duplicates
		* collapse, so a model that is both the session default and an allowed route
		* appears once.
		* @param input - the projections' raw values plus the override in force.
		* @returns distinct `provider/model` labels, in display order.
		*/
		function reviewerRouteChoices(input) {
			const out = [];
			const push = (route) => {
				if (route === void 0 || route.length === 0 || out.includes(route)) return;
				out.push(route);
			};
			push(input.current);
			push(routeOf(typeof input.sessionDefault === "object" && input.sessionDefault !== null ? input.sessionDefault.lastUsed : void 0));
			for (const route of routesOf(input.allowed)) push(route);
			return out;
		}
		/**
		* Filter routes for the picker's list.
		*
		* Matching is a case-insensitive substring over the whole `provider/model`
		* label, so typing `luna` and typing `codex/luna` both narrow to the same row.
		* An empty (or whitespace-only) query keeps the whole list.
		* @param routes - candidate labels.
		* @param query - what the operator typed.
		* @returns the matching labels, in input order.
		*/
		function filterRoutes(routes, query) {
			const needle = query.trim().toLowerCase();
			if (needle.length === 0) return routes;
			return routes.filter((route) => route.toLowerCase().includes(needle));
		}
		//#endregion
		//#region src/client/ModelPicker.tsx
		/**
		* The reviewer-model picker.
		*
		* A native `<datalist>` (or `<select>`) popup is drawn by the browser, not the
		* page: its font, weight, and width ignore CSS entirely, which made the list
		* read as a different, much louder control than the tab it sits in. This is the
		* plugin's own listbox instead, styled with the ledger's own type scale, with a
		* free-text field on top so an id the catalog no longer advertises stays
		* reachable (catalog membership is advisory).
		* @module dsh-approval-review/client/ModelPicker
		*/
		const TEXT$1 = "var(--dsw-alias-label-primary, #e6edf3)";
		const MUTED$1 = "var(--dsw-alias-label-tertiary, #8b949e)";
		const BORDER$1 = "var(--dsw-alias-border-l2, #30363d)";
		const PANEL$1 = "var(--dsw-alias-bg-layer-2, #161b22)";
		const HOVER = "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08))";
		const CODE$1 = "var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)";
		/** The picker's field and its plugin-rendered list. */
		function ModelPicker({ choices, runCommand, loadModels, zh, onChoicesLoaded }) {
			const [draft, setDraft] = (0, react.useState)("");
			const [open, setOpen] = (0, react.useState)(false);
			const [highlight, setHighlight] = (0, react.useState)(0);
			const rootRef = (0, react.useRef)(null);
			const requestedRef = (0, react.useRef)(false);
			const matches = (0, react.useMemo)(() => filterRoutes(choices, draft), [choices, draft]);
			/** Fetch the catalog once, on first interaction. */
			const loadOnce = () => {
				if (requestedRef.current || loadModels === void 0) return;
				requestedRef.current = true;
				loadModels().then((routes) => onChoicesLoaded(routes)).catch(() => onChoicesLoaded([]));
			};
			(0, react.useEffect)(() => {
				if (!open) return;
				const onPointerDown = (event) => {
					if (rootRef.current?.contains(event.target) === true) return;
					setOpen(false);
				};
				document.addEventListener("mousedown", onPointerDown);
				return () => {
					document.removeEventListener("mousedown", onPointerDown);
				};
			}, [open]);
			const apply = (route) => {
				const value = route.trim();
				if (value.length === 0) return;
				runCommand(`/approval-review model ${value}`);
				setDraft("");
				setOpen(false);
			};
			const fieldStyle = {
				fontFamily: CODE$1,
				fontSize: 11,
				lineHeight: "16px",
				padding: "2px 6px",
				width: 190,
				borderRadius: 6,
				border: `1px solid ${BORDER$1}`,
				background: "transparent",
				color: TEXT$1,
				outline: "none"
			};
			const itemStyle = {
				display: "block",
				width: "100%",
				textAlign: "left",
				background: "transparent",
				border: "none",
				borderRadius: 4,
				cursor: "pointer",
				fontFamily: CODE$1,
				fontSize: 11,
				fontWeight: 400,
				lineHeight: "16px",
				padding: "3px 8px",
				color: TEXT$1
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				ref: rootRef,
				style: {
					position: "relative",
					display: "inline-flex"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					value: draft,
					role: "combobox",
					"aria-expanded": open,
					"aria-label": zh ? "复核模型" : "reviewer model",
					placeholder: zh ? "选择或输入模型" : "pick or type a model",
					style: fieldStyle,
					onFocus: () => {
						loadOnce();
						setOpen(true);
					},
					onClick: () => {
						loadOnce();
						setOpen(true);
					},
					onChange: (event) => {
						setDraft(event.target.value);
						setHighlight(0);
						setOpen(true);
					},
					onKeyDown: (event) => {
						if (event.key === "Escape") {
							setOpen(false);
							return;
						}
						if (event.key === "ArrowDown" || event.key === "ArrowUp") {
							event.preventDefault();
							if (matches.length === 0) return;
							setOpen(true);
							setHighlight((current) => {
								return ((event.key === "ArrowDown" ? current + 1 : current - 1) + matches.length) % matches.length;
							});
							return;
						}
						if (event.key !== "Enter") return;
						const picked = open ? matches[highlight] : void 0;
						apply(picked ?? draft);
					}
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					role: "listbox",
					style: {
						position: "absolute",
						top: "calc(100% + 4px)",
						left: 0,
						zIndex: 60,
						minWidth: "100%",
						maxWidth: 320,
						maxHeight: 220,
						overflowY: "auto",
						background: PANEL$1,
						border: `1px solid ${BORDER$1}`,
						borderRadius: 8,
						padding: 4,
						boxShadow: "0 8px 24px rgba(0,0,0,.45)"
					},
					children: matches.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							...itemStyle,
							color: MUTED$1,
							cursor: "default"
						},
						children: choices.length === 0 ? zh ? "没有可选模型，直接输入 id 后回车" : "no models to pick from — type an id and press Enter" : zh ? "没有匹配的模型" : "no matching model"
					}) : matches.map((route, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						role: "option",
						"aria-selected": index === highlight,
						style: {
							...itemStyle,
							background: index === highlight ? HOVER : "transparent"
						},
						onMouseEnter: () => setHighlight(index),
						onClick: () => apply(route),
						children: route
					}, route))
				}) : null]
			});
		}
		//#endregion
		//#region src/client/LedgerView.tsx
		/**
		* The approval ledger as a full conversation tab.
		*
		* This is the "look at everything that was reviewed" surface: one row per
		* approval request with the action, the verdict, the reviewer's full rationale,
		* the safer alternative it suggested, the risk grade, which rule routed it, the
		* reviewer route and timing, and the expandable arguments. The header card is the
		* at-a-glance control; this tab is the audit record.
		*
		* It reads the same `approvalReview` projection as the card, so the two can never
		* disagree, and it holds no state of its own.
		* @module dsh-approval-review/client/LedgerView
		*/
		const TEXT = "var(--dsw-alias-label-primary, #e6edf3)";
		const MUTED = "var(--dsw-alias-label-tertiary, #8b949e)";
		const BORDER = "var(--dsw-alias-border-l2, #30363d)";
		const PANEL = "var(--dsw-alias-bg-layer-2, #161b22)";
		const ROW = "var(--dsw-alias-bg-layer-1, #0d1117)";
		const ALLOWED = "var(--dsw-alias-state-success-primary, #2ea043)";
		const REFUSED = "var(--dsw-alias-state-error-primary, #f85149)";
		const WARN = "var(--dsw-alias-state-warn-primary, #d29922)";
		const CODE = "var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)";
		/** Risk tone; unknown risk is neutral rather than reassuring. */
		function riskTone(risk) {
			if (risk === "low") return ALLOWED;
			if (risk === "medium") return WARN;
			if (risk === "high" || risk === "critical") return REFUSED;
			return MUTED;
		}
		/**
		* Whether the plugin was even responsible for one row, from the policy that
		* routed it. A `human` or `never` row sits on the card because the user asked
		* for a record of every approval, NOT because a reviewer judged it.
		*/
		function routingTag(record, zh) {
			if (record.policy === "never") return zh ? "硬禁用" : "hard-disabled";
			if (record.policy === "human") return zh ? "交还人工" : "delegated";
		}
		/**
		* The rationale line, told truthfully.
		*
		* A missing rationale has three very different causes and the row must not
		* blame the wrong one: a `never` row never ran a reviewer, a `human` row was
		* handed back to the human answerer, and an `ai` row either never reached the
		* reviewer or completed with the allow rationale left unpersisted
		* (`recordAllowedVerdicts: false`, or a value-projection accept).
		*/
		function rationaleText(record, zh) {
			if (record.reason !== void 0) return record.reason;
			if (record.policy === "never") return zh ? "按 never 策略硬禁用，没有经过复核模型。" : "Hard-disabled by the never policy; no reviewer ran.";
			if (record.policy === "human") return zh ? "已交还人工应答者，本插件没有裁决这一次。" : "Delegated to the human answerer; this plugin did not decide it.";
			return record.refused ? zh ? "被否决，但本行没有留下理由记录。" : "Refused, but no rationale was recorded." : zh ? "已放行；本行没有留下理由记录（该请求未走到复核模型，或核可理由未落盘）。" : "Allowed, but no rationale was recorded (the request never reached the reviewer, or its allow rationale was not persisted).";
		}
		/** Short wall-clock stamp. */
		function stamp(epochMs) {
			const d = new Date(epochMs);
			const p = (n) => String(n).padStart(2, "0");
			return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
		}
		/** A labelled field row. */
		function Field({ label, children, mono }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					gap: 10,
					alignItems: "baseline"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: {
						color: MUTED,
						flex: "0 0 auto",
						width: 76,
						fontSize: 11
					},
					children: label
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: {
						color: TEXT,
						fontSize: mono === true ? 11 : 12,
						fontFamily: mono === true ? CODE : void 0,
						whiteSpace: "pre-wrap",
						wordBreak: "break-word",
						flex: "1 1 auto"
					},
					children
				})]
			});
		}
		/** Merge the base list with the loaded catalog, keeping the base order first. */
		function reviewerRoutesMerge(base, loaded) {
			const out = [...base];
			for (const route of loaded) if (!out.includes(route)) out.push(route);
			return out;
		}
		/** One ledger entry, expanded. */
		function Entry({ record, zh, onApprove, deniedIndex }) {
			const [showArgs, setShowArgs] = (0, react.useState)(false);
			const pending = record.outcome === void 0;
			const verdict = pending ? zh ? "进行中" : "pending" : record.refused ? zh ? "否决" : "refused" : record.outcome === "allowed-once" ? zh ? "放行" : "allowed" : zh ? "转人工" : "delegated";
			const tone = pending ? MUTED : record.refused ? REFUSED : ALLOWED;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					border: `1px solid ${BORDER}`,
					borderLeft: `3px solid ${tone}`,
					borderRadius: 8,
					background: ROW,
					padding: "12px 14px",
					display: "flex",
					flexDirection: "column",
					gap: 8
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 8,
							alignItems: "center",
							flexWrap: "wrap"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontFamily: CODE,
									fontSize: 13,
									fontWeight: 600,
									color: TEXT
								},
								children: record.toolName
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 11,
									color: tone,
									border: `1px solid ${tone}`,
									borderRadius: 999,
									padding: "1px 7px"
								},
								children: verdict
							}),
							routingTag(record, zh) === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 11,
									color: MUTED,
									border: `1px solid ${BORDER}`,
									borderRadius: 999,
									padding: "1px 7px"
								},
								children: routingTag(record, zh)
							}),
							record.risk === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									fontSize: 11,
									color: riskTone(record.risk)
								},
								children: [
									zh ? "风险" : "risk",
									" ",
									record.risk
								]
							}),
							record.overridden ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 11,
									color: WARN
								},
								children: zh ? "含人工一次性授权" : "human override"
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									marginLeft: "auto",
									fontSize: 11,
									color: MUTED
								},
								children: [
									stamp(record.startedAt),
									" · T",
									record.turn,
									"/S",
									record.step,
									record.durationMs === void 0 ? "" : ` · ${record.durationMs} ms`
								]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: zh ? "裁决理由" : "rationale",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { color: record.reason === void 0 ? MUTED : TEXT },
							children: rationaleText(record, zh)
						})
					}),
					record.suggestion === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: zh ? "更安全的做法" : "safer path",
						children: record.suggestion
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Field, {
						label: zh ? "路由策略" : "routing",
						mono: true,
						children: [
							record.policy,
							" · ",
							record.policySource
						]
					}),
					record.askReason === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: zh ? "申请理由" : "asked why",
						children: record.askReason
					}),
					record.reviewerRoute === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Field, {
						label: zh ? "复核模型" : "reviewer",
						mono: true,
						children: [record.reviewerRoute, record.uncertain ? ` · ${zh ? "不确定" : "uncertain"}` : ""]
					}),
					record.argumentsPreview === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: () => setShowArgs((v) => !v),
						style: {
							background: "none",
							border: "none",
							padding: 0,
							cursor: "pointer",
							color: "var(--dsw-alias-link, #58a6ff)",
							fontSize: 11
						},
						children: showArgs ? zh ? "收起参数" : "hide arguments" : zh ? "查看参数" : "show arguments"
					}), showArgs ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
						style: {
							margin: "6px 0 0",
							padding: 10,
							borderRadius: 6,
							background: PANEL,
							fontFamily: CODE,
							fontSize: 11,
							color: TEXT,
							whiteSpace: "pre-wrap",
							wordBreak: "break-word",
							maxHeight: 320,
							overflow: "auto"
						},
						children: record.argumentsPreview
					}) : null] }),
					record.refused && record.outcome === "rejected" && onApprove !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: () => onApprove(record, deniedIndex),
						style: {
							alignSelf: "flex-start",
							cursor: "pointer",
							fontSize: 11,
							padding: "3px 9px",
							borderRadius: 6,
							border: `1px solid ${BORDER}`,
							background: "transparent",
							color: TEXT
						},
						children: zh ? `授权重试第 ${deniedIndex} 条否决` : `approve denial #${deniedIndex} for one retry`
					}) : null
				]
			});
		}
		/** The full ledger tab. */
		/**
		* Start a freshly opened ledger at its top.
		*
		* The tab renders inside the conversation's resident scrollport, which the
		* transcript keeps pinned to its newest line, so a ledger mounted under it would
		* show its own BOTTOM — while the ledger lists the newest decision FIRST. The
		* walk that finds the box to reset lives in `./scroll.ts`.
		* @param root - the ledger's root element.
		*/
		function useStartAtTop(root) {
			(0, react.useEffect)(() => {
				const element = root.current;
				if (element === null) return;
				element.scrollTop = 0;
				if (typeof window === "undefined") return;
				resetScrollableAncestorToTop(element, (node) => window.getComputedStyle(node).overflowY);
			}, [root]);
		}
		function LedgerView({ view, zh, runCommand, modelChoices, loadModels }) {
			const rootRef = (0, react.useRef)(null);
			useStartAtTop(rootRef);
			const [loadedChoices, setLoadedChoices] = (0, react.useState)(void 0);
			const [commandError, setCommandError] = (0, react.useState)(null);
			const run = (line) => {
				if (runCommand === void 0) return;
				setCommandError(null);
				Promise.resolve(runCommand(line)).then((failure) => {
					if (typeof failure === "string") setCommandError(failure);
				}).catch((error) => {
					setCommandError(String(error));
				});
			};
			const choices = loadedChoices ?? modelChoices ?? [];
			const records = view?.records ?? [];
			const denials = (0, react.useMemo)(() => records.filter((r) => r.refused), [records]);
			const reviewedCount = (0, react.useMemo)(() => records.filter((r) => r.policy === "ai").length, [records]);
			const deniedIndexOf = (record) => denials.findIndex((d) => d.reviewId === record.reviewId) + 1;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				style: {
					padding: "14px 16px",
					overflow: "auto",
					height: "100%",
					fontFamily: "inherit"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 12,
							alignItems: "center",
							flexWrap: "wrap",
							padding: "0 2px 10px",
							borderBottom: `1px solid ${BORDER}`,
							marginBottom: 12
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
								style: {
									fontSize: 14,
									color: TEXT
								},
								children: zh ? "审批审计" : "Approval audit"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 12,
									color: view?.enabled === false ? MUTED : ALLOWED
								},
								children: view === void 0 ? zh ? "尚无数据" : "no data" : view.enabled ? zh ? "自动审批已开启" : "auto-approval on" : zh ? "自动审批已关闭" : "auto-approval off"
							}),
							runCommand === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: view?.enabled === true,
								onClick: () => run("/approval-review on"),
								style: {
									fontSize: 11,
									padding: "3px 9px",
									borderRadius: 6,
									cursor: view?.enabled === true ? "default" : "pointer",
									border: `1px solid ${BORDER}`,
									color: view?.enabled === true ? MUTED : TEXT,
									background: "transparent"
								},
								children: zh ? "开启" : "on"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: view?.enabled === false,
								onClick: () => run("/approval-review off"),
								style: {
									fontSize: 11,
									padding: "3px 9px",
									borderRadius: 6,
									cursor: view?.enabled === false ? "default" : "pointer",
									border: `1px solid ${BORDER}`,
									color: view?.enabled === false ? MUTED : TEXT,
									background: "transparent"
								},
								children: zh ? "关闭" : "off"
							})] }),
							view === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									fontSize: 11,
									color: MUTED,
									fontFamily: CODE
								},
								children: [zh ? "复核模型 " : "reviewer ", view.reviewerModel.length > 0 ? `${view.reviewerProvider.length > 0 ? `${view.reviewerProvider}/` : ""}${view.reviewerModel}` : zh ? "继承会话" : "inherit session"]
							}),
							runCommand === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									display: "flex",
									gap: 4,
									alignItems: "center"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelPicker, {
									choices,
									runCommand: run,
									loadModels,
									zh,
									onChoicesLoaded: (routes) => {
										setLoadedChoices(routes.length === 0 ? modelChoices ?? [] : reviewerRoutesMerge(modelChoices ?? [], routes));
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => run("/approval-review model default"),
									style: {
										fontSize: 11,
										padding: "3px 9px",
										borderRadius: 6,
										cursor: "pointer",
										border: `1px solid ${BORDER}`,
										color: TEXT,
										background: "transparent"
									},
									children: zh ? "继承" : "inherit"
								})]
							}),
							view === void 0 || view.total === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 11,
									color: MUTED
								},
								children: zh ? `共 ${view.total} 次 · 本插件裁决 ${reviewedCount} · 已否决 ${view.refused} · 本回合复审 ${view.reviewsThisTurn}/${view.maxReviewsPerTurn} · 连续否决 ${view.consecutiveDenials}` : `${view.total} total · ${reviewedCount} routed to the reviewer · ${view.refused} refused · this turn ${view.reviewsThisTurn}/${view.maxReviewsPerTurn} · streak ${view.consecutiveDenials}`
							})
						]
					}),
					commandError === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							fontSize: 11,
							color: REFUSED,
							marginBottom: 8
						},
						children: [zh ? "命令被拒：" : "command refused: ", commandError]
					}),
					view?.circuitOpen === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 12,
							color: REFUSED,
							marginBottom: 10
						},
						children: zh ? "否决熔断已触发：本回合后续请求转人工审批。" : "Rejection breaker is open: later requests in this turn go to the human chain."
					}) : null,
					records.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 13,
							color: MUTED,
							padding: "24px 4px",
							lineHeight: 1.7
						},
						children: zh ? "本会话还没有审批记录。当某个动作需要越过沙箱边界时，这里会留下完整的裁决理由、风险等级与更安全的替代做法。" : "No approvals recorded in this session yet. When an action needs to cross the sandbox boundary, its full rationale, risk grade, and safer alternative land here."
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 10
						},
						children: records.map((record) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Entry, {
							record,
							zh,
							deniedIndex: deniedIndexOf(record),
							onApprove: runCommand === void 0 ? void 0 : (_r, index) => run(`/approval-review approve ${index}`)
						}, record.reviewId))
					})
				]
			});
		}
		//#endregion
		//#region src/client/access-mode-glyph.ts
		/**
		* The "approve for me" access-mode glyph, installed from this plugin.
		*
		* Background: the composer's access-mode menu draws a shield glyph for each
		* permission preset, and that glyph table is a CLOSED design set inside
		* `@deepseek-ai/dsh-client-ui-conversation` — a preset key outside it renders
		* with no icon at all, and the host cannot be asked for one (the `permissions`
		* projection carries value/name/description only). So a plugin that adds a
		* fourth preset gets a fourth menu row with no picture next to it.
		*
		* Two ways out exist. Editing the harness package is the tidy one, but it only
		* takes effect after that package is rebuilt, and it couples the harness to a
		* plugin-specific key. This module is the other one: the plugin decorates the
		* two buttons the menu renders, from the outside, with the same shield+eye mark.
		*
		* Why it decorates by ATTRIBUTE and not by inserting nodes: these buttons belong
		* to React. Inserting a child would put an unknown node where React expects its
		* own child list and would make a later re-render reconcile against DOM it never
		* produced. Setting a `data-*` attribute and drawing the glyph from a
		* plugin-owned stylesheet via `::before` leaves React's tree untouched — React
		* does not remove attributes it never set, and a remount simply loses the mark
		* until the next pass, which the observer re-applies.
		*
		* The shim YIELDS to the built-in glyph: when the harness glyph table already
		* covers this key (i.e. the package was rebuilt with it), the mark is removed
		* and the stylesheet draws nothing, so a rebuild never produces a double icon.
		*
		* Naming coupling: the preset key comes from `Config.reviewerPreset` and the
		* bundle patch's `permission.presets` entry, and the display name from that same
		* entry's `name`. The DOM exposes the NAME (the trigger's `aria-label`, a menu
		* row's text), never the key, so the label list below is what this shim matches.
		* Rename the preset and the glyph simply does not appear; the menu keeps
		* working, which is why this is a progressive enhancement and not a dependency.
		* @module dsh-approval-review/client/access-mode-glyph
		*/
		/**
		* Display names the preset may carry, matched against the access-mode trigger's
		* `aria-label` ("访问模式，当前：替我审批" / "Access mode, current: Approve for
		* me") and against a menu row's own text. The bundle patch ships the Chinese
		* name; the English form is accepted so an English deployment still gets its
		* glyph.
		*/
		const PRESET_LABELS = ["替我审批", "Approve for me"];
		/** Marks a decorated button; also the selector the stylesheet hangs off. */
		const MARK_ATTRIBUTE = "data-dsh-approval-review-glyph";
		/** The style element's identity, so a re-install replaces its own node. */
		const STYLE_ATTRIBUTE = "data-dsh-approval-review-glyph-style";
		/**
		* The glyph itself: the same shield as the built-in modes — the boundary is
		* unchanged — carrying an eye, because the reviewer looks at the action before
		* it crosses. Rendered as a MASK, so the mark takes `currentColor` from the
		* button exactly like the built-in `currentColor` SVGs do.
		*/
		const GLYPH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none"><path d="M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z" stroke="#000" stroke-width="1.31831" stroke-linejoin="round"/><path d="M5.348 6.58C6.224 7.773 7.029 8.375 8.2 8.375C9.371 8.375 10.176 7.773 11.052 6.58" stroke="#000" stroke-width="1.31831" stroke-linecap="round"/><path d="M5.348 6.58C6.224 5.387 7.029 4.785 8.2 4.785C9.371 4.785 10.176 5.387 11.052 6.58" stroke="#000" stroke-width="1.31831" stroke-linecap="round"/><circle cx="8.2" cy="6.58" r="0.95" fill="#000"/></svg>`;
		/**
		* The one selector every pass and every mutation check uses.
		*
		* It is deliberately narrow: the trigger is addressed by SUBSTRING on the
		* `aria-label` (a native attribute test, not a JavaScript scan of every button
		* in the document), menu rows by role, and already-marked buttons — whichever
		* they are — by the mark itself, so a mode switch clears the old one.
		*/
		const TARGET_SELECTOR = [
			...PRESET_LABELS.map((label) => `button[aria-label*="${label}"]`),
			"button[role=\"menuitem\"]",
			`[${MARK_ATTRIBUTE}]`
		].join(", ");
		/** Build the stylesheet that draws the mark on a decorated button. */
		function stylesheet() {
			const mask = `url("data:image/svg+xml,${encodeURIComponent(GLYPH_SVG)}")`;
			return `
[${MARK_ATTRIBUTE}]::before{
  content:"";
  display:inline-block;
  flex:none;
  width:16px;
  height:16px;
  background-color:currentColor;
  -webkit-mask-image:${mask};
  mask-image:${mask};
  -webkit-mask-repeat:no-repeat;
  mask-repeat:no-repeat;
  -webkit-mask-position:center;
  mask-position:center;
  -webkit-mask-size:contain;
  mask-size:contain;
}
/* The composer trigger sizes its icons at 14px. */
button[aria-label][${MARK_ATTRIBUTE}]::before{
  width:14px;
  height:14px;
}
`;
		}
		/**
		* Whether an element already carries the harness's own glyph.
		*
		* Both surfaces render the built-in icon as a leading `<span>` holding an
		* `<svg>`; the trailing chevron is a later sibling, so only the first child
		* counts. When this is true the shim steps aside.
		*/
		function hasBuiltInGlyph(button) {
			const first = button.firstElementChild;
			return first instanceof HTMLElement && first.tagName === "SPAN" && first.querySelector("svg") !== null;
		}
		/**
		* The pure matching rule behind the shim.
		*
		* Extracted from the DOM pass so the rule that can actually go wrong — which
		* button is this plugin's preset, and does it already have a built-in glyph —
		* is testable without a browser. The DOM *plumbing* around it is decoration and
		* degrades to "no glyph", never to a broken menu.
		* @param facts - the element facts the shim matches on.
		* @returns `'mark'` when this plugin should draw the glyph, `'skip'` otherwise.
		*/
		function accessModeGlyphDecision(facts) {
			const label = facts.ariaLabel ?? "";
			if (!(PRESET_LABELS.some((candidate) => label.includes(candidate)) || facts.role === "menuitem" && PRESET_LABELS.includes((facts.text ?? "").trim()))) return "skip";
			return facts.hasBuiltInGlyph === true ? "skip" : "mark";
		}
		/**
		* Install the access-mode glyph decoration.
		*
		* The observer is deliberately cheap: it inspects only MUTATED subtrees for the
		* target selector and coalesces every hit into one animation frame, so a
		* streaming conversation (which appends text nodes constantly) never becomes a
		* per-token query over the document.
		* @param root - document to decorate; injectable for tests.
		* @returns the disposer that removes the stylesheet, the marks, and the observer.
		*/
		function installAccessModeGlyph(root = document) {
			if (root.querySelector(`style[${STYLE_ATTRIBUTE}]`) === null) {
				const style = root.createElement("style");
				style.setAttribute(STYLE_ATTRIBUTE, "1");
				style.textContent = stylesheet();
				root.head.appendChild(style);
			}
			const decorate = () => {
				for (const button of root.querySelectorAll(TARGET_SELECTOR)) if (accessModeGlyphDecision({
					ariaLabel: button.getAttribute("aria-label"),
					role: button.getAttribute("role"),
					text: button.textContent ?? "",
					hasBuiltInGlyph: hasBuiltInGlyph(button)
				}) === "mark") {
					if (!button.hasAttribute(MARK_ATTRIBUTE)) button.setAttribute(MARK_ATTRIBUTE, "1");
				} else if (button.hasAttribute(MARK_ATTRIBUTE)) button.removeAttribute(MARK_ATTRIBUTE);
			};
			/** True when a mutation could have produced one of the decorated buttons. */
			const mightMatter = (node) => {
				if (!(node instanceof Element)) return false;
				if (node.matches(TARGET_SELECTOR)) return true;
				return node.querySelector(TARGET_SELECTOR) !== null;
			};
			let frame;
			const schedule = () => {
				if (frame !== void 0) return;
				frame = root.defaultView?.requestAnimationFrame(() => {
					frame = void 0;
					decorate();
				});
			};
			const observer = new MutationObserver((records) => {
				for (const record of records) {
					const target = record.target;
					if (target instanceof Element && target.closest(TARGET_SELECTOR) !== null) {
						schedule();
						return;
					}
					for (const node of record.addedNodes) if (mightMatter(node)) {
						schedule();
						return;
					}
				}
			});
			if (root.body !== null) observer.observe(root.body, {
				childList: true,
				subtree: true
			});
			decorate();
			return () => {
				observer.disconnect();
				if (frame !== void 0) root.defaultView?.cancelAnimationFrame(frame);
				for (const button of root.querySelectorAll(`[${MARK_ATTRIBUTE}]`)) button.removeAttribute(MARK_ATTRIBUTE);
				root.querySelector(`style[${STYLE_ATTRIBUTE}]`)?.remove();
			};
		}
		//#endregion
		//#region src/client/index.tsx
		/** Slot entry id; stable so a redeploy replaces its own row. */
		const VIEW_SLOT_ID = "approval-review-ledger";
		/** The conversation tab strip, beside 轨迹 / 上下文 / 费用. */
		const VIEW_SLOT = "conversation.view";
		/**
		* Required client services.
		*
		* `remote.commands` is a named remote SERVICE, not a plain property: the client
		* remote facade throws `cannot get property "remote.commands" without inject`
		* unless the key is declared here. Declaring `remote` alone is not enough, which
		* is exactly the bug this cost once.
		*/
		const inject = [
			"slots",
			"remote",
			"remote.commands"
		];
		/** Whether copy should be Chinese, from the browser language. */
		function preferZh() {
			return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh");
		}
		/** Reviewer routes this deployment offers, read from its own projections. */
		function reviewerChoices(props, current) {
			return reviewerRouteChoices({
				current,
				sessionDefault: props.useProjection("modelSelection"),
				allowed: props.useProjection("subagentModelSelectionPolicy")
			});
		}
		/** Render the full ledger tab. */
		function ApprovalReviewLedger(props) {
			const view = props.useProjection("approvalReview");
			const current = view === void 0 || view.reviewerModel.length === 0 ? void 0 : `${view.reviewerProvider.length > 0 ? `${view.reviewerProvider}/` : ""}${view.reviewerModel}`;
			return LedgerView({
				view,
				zh: preferZh(),
				runCommand: props.runCommand,
				modelChoices: reviewerChoices(props, current),
				loadModels: props.loadModels
			});
		}
		/**
		* Register the ledger tab and the access-mode glyph.
		* @param ctx - client Cordis context.
		*/
		function apply(ctx) {
			ctx.effect(() => installAccessModeGlyph(), "approval-review: access-mode glyph");
			/**
			* The remote is resolved LAZILY, per call. Capturing `ctx.remote` in the
			* `apply` closure is wrong: `apply` can run before the remote facade finishes
			* mounting, and a captured `undefined` turns every click into a silent no-op
			* on a control that still LOOKS enabled. That was a real bug here.
			*/
			const remoteOf = () => ctx.remote?.commands;
			/**
			* The model directory, resolved LAZILY for the same reason the command remote
			* is: this client half mounts before every service it may use is up, and a
			* captured `undefined` would permanently disable the picker.
			*/
			const directoriesOf = () => ctx.get?.("modelDirectories");
			/** The per-session business face the tab's seat uses. */
			const inject = (rawSessionId) => ({
				loadModels: async () => {
					const directories = directoriesOf();
					if (directories === void 0) return [];
					try {
						return routesFromDirectory(await directories.directoryFor(rawSessionId).load());
					} catch {
						return [];
					}
				},
				runCommand: async (line) => {
					const commands = remoteOf();
					if (commands === void 0) return "the command remote is not mounted in this client";
					const sessionId = rawSessionId;
					try {
						if (!(await commands.execute(sessionId, line)).ok) return `the host refused "${line}"`;
						return null;
					} catch (error) {
						return `"${line}" failed: ${String(error)}`;
					}
				}
			});
			ctx.slots.inject(VIEW_SLOT, () => ctx.slots.register({
				name: VIEW_SLOT,
				id: VIEW_SLOT_ID,
				order: 40,
				label: () => preferZh() ? "审批" : "Approvals",
				inject
			}, ApprovalReviewLedger));
		}
		//#endregion
		exports.VIEW_SLOT_ID = VIEW_SLOT_ID;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
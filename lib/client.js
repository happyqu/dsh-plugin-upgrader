/**
 * @happyqu/dsh-plugin-upgrader — Client half.
 *
 * A STATIC client bundle, so it uses the `window.__ModuleLoader__.load({id, factory})`
 * contract and may `require` the shell's nine seeded modules. It deliberately requires
 * ONLY `react`: depending on `@deepseek-ai/dsh-client-ui-primitives` would couple this
 * plugin's UI to the DSH version, and the whole point of this plugin is to keep working
 * across runtime upgrades. Styles are plain CSS built from `--dsw-*` tokens with
 * fallbacks, so light and dark both resolve without a theme branch.
 *
 * Surfaces:
 *   settings.plugins.tab   a full "升级中心" page: every third-party plugin, its status,
 *                          a per-row upgrade, and one "全部升级" action.
 *   plugins.detail.badge   a tag beside the plugin's title when it has an update.
 *   plugins.detail.actions an upgrade button on the plugin's own page.
 *
 * Host traffic goes over the connection RPC channel, never `ctx.remote` (which is not part
 * of the published Client Service catalog).
 */
window.__ModuleLoader__.load({
  // MUST equal the package name: `dsh-client-modules` derives a bundle's id from its
  // specifier by stripping a trailing `/client`, so this registration has to match the
  // package exactly or the bundle silently fails to attach.
  id: "@happyqu/dsh-plugin-upgrader",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var ReactMod = require("react");
    // Interop: React's CJS export carries createElement directly, but an ESM namespace
    // would put it on .default.
    var React = ReactMod && ReactMod.createElement ? ReactMod : ReactMod.default;
    var h = React.createElement;

    var name = "plugin-upgrader";
    var inject = ["slots", "connection"];

    /** Endpoint name and absolute route, matching the Host registration. */
    var RPC_ENDPOINT = "plugin-upgrader";
    var RPC_CHANNEL = "/api";

    /** How often an in-flight upgrade is polled, in milliseconds. */
    var POLL_MS = 700;

    var STYLES = [
      ".dsh-upg { padding: 4px 0 24px; display: flex; flex-direction: column; gap: 12px; min-width: 0; color: inherit; }",
      ".dsh-upg-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }",
      ".dsh-upg-head h2 { margin: 0; font-size: 15px; font-weight: 600; }",
      ".dsh-upg-count { opacity: 0.65; font-size: 12px; }",
      ".dsh-upg-spacer { flex: 1; }",
      ".dsh-upg-btn { font: inherit; font-size: 12px; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.4)); background: transparent; color: inherit; cursor: pointer; }",
      ".dsh-upg-btn:hover:not(:disabled) { border-color: var(--dsw-alias-label-secondary, rgba(128,128,128,0.8)); }",
      ".dsh-upg-btn:disabled { opacity: 0.4; cursor: default; }",
      ".dsh-upg-btn-primary { border-color: var(--dsw-alias-brand-primary, #608cdc); color: var(--dsw-alias-brand-primary, #608cdc); font-weight: 600; }",
      ".dsh-upg-btn-primary:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #608cdc) 12%, transparent); }",
      ".dsh-upg-banner { border-radius: 8px; padding: 8px 12px; font-size: 12.5px; line-height: 1.55; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.07)); word-break: break-word; white-space: pre-wrap; }",
      ".dsh-upg-banner-warn { border-color: color-mix(in srgb, var(--dsw-alias-state-warning-primary, #d9a441) 45%, transparent); }",
      ".dsh-upg-banner-err { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e07070) 45%, transparent); color: var(--dsw-alias-state-error-primary, #e07070); }",
      ".dsh-upg-banner-note { border-color: color-mix(in srgb, var(--dsw-alias-label-secondary, #888888) 50%, transparent); }",
      ".dsh-upg-list { display: flex; flex-direction: column; gap: 8px; }",
      ".dsh-upg-row { border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }",
      ".dsh-upg-row-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }",
      ".dsh-upg-name { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }",
      ".dsh-upg-ver { font-size: 12px; opacity: 0.8; font-variant-numeric: tabular-nums; }",
      ".dsh-upg-tag { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.45)); opacity: 0.85; white-space: nowrap; }",
      ".dsh-upg-tag-out { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #608cdc) 60%, transparent); color: var(--dsw-alias-brand-primary, #608cdc); }",
      ".dsh-upg-tag-ok { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #6fbf73) 55%, transparent); color: var(--dsw-alias-state-success-primary, #6fbf73); }",
      ".dsh-upg-tag-err { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e07070) 55%, transparent); color: var(--dsw-alias-state-error-primary, #e07070); }",
      ".dsh-upg-desc { font-size: 12px; opacity: 0.62; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".dsh-upg-msg { font-size: 12px; opacity: 0.8; word-break: break-word; }",
      ".dsh-upg-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }",
      ".dsh-upg-log { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; line-height: 1.5; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.1)); border-radius: 6px; padding: 8px 10px; max-height: 190px; overflow: auto; white-space: pre-wrap; word-break: break-all; opacity: 0.9; }",
      ".dsh-upg-empty { opacity: 0.6; font-size: 13px; padding: 12px 0; }",
      ".dsh-upg-hint { opacity: 0.65; font-size: 12.5px; padding: 2px 0 4px; }",
      ".dsh-upg-verdict-detail { white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.55; margin-top: 4px; opacity: 0.9; }",
      ".dsh-upg-foot { font-size: 11px; opacity: 0.5; }",
      ".dsh-upg-detail { display: flex; flex-direction: column; gap: 6px; padding: 2px 0 8px; min-width: 0; }",
      ".dsh-upg-detail-line { font-size: 12.5px; display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline; }",
      ".dsh-upg-detail-k { opacity: 0.6; min-width: 68px; }",
      ".dsh-upg-detail-v { font-variant-numeric: tabular-nums; word-break: break-all; }",
    ].join("\n");

    var stylesInjected = false;

    /** Inject this plugin's stylesheet once; the returned disposer removes it. */
    function installStyles() {
      if (stylesInjected) return function () {};
      stylesInjected = true;
      var el = document.createElement("style");
      el.setAttribute("data-plugin-css", "@happyqu/dsh-plugin-upgrader");
      el.textContent = STYLES;
      document.head.appendChild(el);
      return function () {
        el.remove();
        stylesInjected = false;
      };
    }

    /** Call one plugin-upgrader Host method over the Connection RPC channel. */
    function callRpc(connection, method, payload, signal) {
      return connection.rpc
        .call(RPC_CHANNEL, RPC_ENDPOINT, { method: method, payload: payload }, signal)
        .then(function (result) {
          if (result && result.ok === true) return result.value;
          if (result && result.ok === false) {
            var error = new Error((result.error && result.error.message) || "插件升级服务请求失败");
            error.code = result.error && result.error.code;
            throw error;
          }
          return result;
        });
    }

    /** The label describing what an upgrade would move to, or null when there is none. */
    function targetOf(record) {
      if (!record || record.status !== "outdated") return null;
      if (typeof record.target === "string" && record.target !== "") return record.target;
      // Defensive: a git update has no target VERSION, only a commit, so falling back to
      // `latestVersion` must yield null rather than the string "null".
      if (typeof record.latestVersion === "string" && record.latestVersion !== "") return record.latestVersion;
      return null;
    }

    /** Whether this record can actually be upgraded by us. */
    function canUpgrade(record) {
      if (!record || record.status !== "outdated") return false;
      if (typeof record.upgradable === "boolean") return record.upgradable;
      // Defensive fallback for a Host half that predates `upgradable`.
      return record.shape === "registry" && typeof record.latestVersion === "string";
    }

    /** Status label, tag class, and colour intent for one check record. */
    function statusOf(record) {
      switch (record && record.status) {
        case "outdated":
          return { tag: "out", label: "可升级", kind: "outdated" };
        case "current":
          return { tag: "ok", label: "已是最新", kind: "current" };
        case "local":
          return { tag: "", label: "本地依赖", kind: "local" };
        case "error":
          return { tag: "err", label: "检查失败", kind: "error" };
        case "unchecked":
          return { tag: "", label: "未检查", kind: "unchecked" };
        default:
          return { tag: "", label: "未知", kind: "unknown" };
      }
    }

    /** Read the package name a detail-page subject refers to, when it has one. */
    function subjectName(subject) {
      if (!subject || typeof subject !== "object") return null;
      if (subject.kind === "bundle" || subject.kind === "row") {
        var pkg = subject.pkg;
        return pkg && typeof pkg.name === "string" ? pkg.name : null;
      }
      return null;
    }

    /**
     * Shared upgrade-centre state: the check report, one in-flight run, and errors.
     * Kept in one hook so the tab, the badge, and the detail action all agree.
     */
    function useUpgradeState(connection) {
      var reportState = React.useState(null);
      var report = reportState[0];
      var setReport = reportState[1];

      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];

      var runState = React.useState(null);
      var run = runState[0];
      var setRun = runState[1];

      var verdictState = React.useState(null);
      var verdict = verdictState[0];
      var setVerdict = verdictState[1];

      /**
       * Load the roster. This costs NO network: it only reads local profile files and the live
       * bundle inventory, so it is safe to run whenever the page opens.
       */
      var loadList = React.useCallback(
        function () {
          setError(null);
          return callRpc(connection, "list", {})
            .then(function (value) {
              setReport(value);
              return value;
            })
            .catch(function (err) {
              setError(err && err.message ? err.message : String(err));
              return null;
            });
        },
        [connection]
      );

      /**
       * Run update checks. `only` scopes one plugin; omitting it checks every plugin, which is
       * what the explicit "检查更新" button does. Results are MERGED into the roster rather than
       * replacing it, so checking one plugin never blanks the others' known state.
       *
       * `keepMessage` exists for the AUTOMATIC re-check that follows an upgrade: a run's refusal
       * is delivered through `setError`, and this function clears that channel at its start
       * because an explicit check makes any previous message stale. When the check is a
       * follow-up rather than a user action, clearing it erases the very message the user needs
       * — which is exactly how a refused upgrade came to look like a button that does nothing.
       */
      var check = React.useCallback(
        function (force, only, keepMessage) {
          setBusy(true);
          if (keepMessage !== true) setError(null);
          var payload = { force: force === true };
          if (typeof only === "string" && only !== "") payload.name = only;
          return callRpc(connection, "check", payload)
            .then(function (value) {
              if (value && Array.isArray(value.plugins)) {
                setReport(function (previous) {
                  if (!previous || !Array.isArray(previous.plugins)) return value;
                  var fresh = {};
                  for (var i = 0; i < value.plugins.length; i++) {
                    fresh[value.plugins[i].name] = value.plugins[i];
                  }
                  var merged = previous.plugins.map(function (item) {
                    return fresh[item.name] ? fresh[item.name] : item;
                  });
                  return {
                    profile: value.profile,
                    registry: value.registry,
                    ttlMs: value.ttlMs,
                    checkedAt: value.checkedAt,
                    summary: value.summary,
                    plugins: merged,
                  };
                });
              }
              return value;
            })
            .catch(function (err) {
              setError(err && err.message ? err.message : String(err));
              return null;
            })
            .then(function (value) {
              setBusy(false);
              return value;
            });
        },
        [connection]
      );

      // Poll one run until it settles. `POLL_MS` is short because an install's phases
      // change a handful of times, not continuously.
      var poll = React.useCallback(
        function (requestId) {
          var cancelled = false;
          var tick = function () {
            if (cancelled) return;
            callRpc(connection, "upgrade.status", { requestId: requestId })
              .then(function (value) {
                if (cancelled) return;
                setRun(value.run);
                setVerdict(value.verdict || null);
                if (value.run && value.run.running) {
                  setTimeout(tick, POLL_MS);
                } else {
                  setBusy(false);
                  check(true);
                }
              })
              .catch(function (err) {
                if (cancelled) return;
                setError(err && err.message ? err.message : String(err));
                setBusy(false);
              });
          };
          tick();
          return function () {
            cancelled = true;
          };
        },
        [connection, check]
      );

      /**
       * Start one upgrade and resolve once that run has SETTLED, carrying its verdict.
       * `upgradeAll` needs this: the profile write lock is global, so the next install
       * must not start until the previous one has finished. Resolving on settle rather
       * than on start is what makes the queue actually serial.
       */
      var upgradeAndWait = React.useCallback(
        function (pluginName, version) {
          // The NAME is authoritative: the Host resolves the install spec, because the correct
          // spec depends on the dependency shape and a git update's target is a commit that no
          // version number can express. That mismatch is what produced "升级到 null".
          //
          // `version` is sent ONLY when it is a real semver (a registry target). This keeps a
          // refreshed browser working against a Host half from before the change, which
          // required the field; an older Host is left to refuse the git case, which it could
          // never have handled correctly anyway.
          var payload = { name: pluginName };
          if (typeof version === "string" && /^\d+\.\d+\.\d+/.test(version)) payload.version = version;
          return callRpc(connection, "upgrade.start", payload)
            .then(function (value) {
              setRun(value);
              var requestId = value.requestId;
              return new Promise(function (resolve) {
                var settled = false;
                var tick = function () {
                  if (settled) return;
                  callRpc(connection, "upgrade.status", { requestId: requestId })
                    .then(function (status) {
                      if (settled) return;
                      setRun(status.run);
                      if (status.run && status.run.running) {
                        setTimeout(tick, POLL_MS);
                        return;
                      }
                      settled = true;
                      setVerdict(status.verdict || null);
                      resolve({ name: pluginName, verdict: status.verdict || null });
                    })
                    .catch(function (err) {
                      if (settled) return;
                      settled = true;
                      setError(err && err.message ? err.message : String(err));
                      resolve({ name: pluginName, verdict: null });
                    });
                };
                tick();
              });
            })
            .catch(function (err) {
              setError(err && err.message ? err.message : String(err));
              return { name: pluginName, verdict: null };
            });
        },
        [connection]
      );

      var upgrade = React.useCallback(
        function (pluginName, version) {
          setBusy(true);
          setError(null);
          setVerdict(null);
          setRun(null);
          return upgradeAndWait(pluginName, version).then(function (outcome) {
            setBusy(false);
            // Re-check only the plugin that changed: a full re-check would spend a network call
            // per plugin to learn one new fact.
            //
            // `keepMessage: true` is load-bearing. This re-check is a FOLLOW-UP, not a user
            // action, so it must not clear the message `upgradeAndWait` just set: a refused
            // upgrade (say the upstream renamed the package) reported through `setError` would
            // otherwise be erased a heartbeat after it appeared, leaving the user with a button
            // that appears to do nothing at all.
            check(true, pluginName, true);
            return outcome;
          });
        },
        [upgradeAndWait, check]
      );

      var cancel = React.useCallback(
        function () {
          if (!run || !run.requestId) return Promise.resolve();
          return callRpc(connection, "upgrade.cancel", { requestId: run.requestId }).then(
            function (value) {
              if (value && value.run) setRun(value.run);
              return value;
            }
          );
        },
        [connection, run]
      );

      return {
        report: report,
        run: run,
        verdict: verdict,
        busy: busy,
        error: error,
        loadList: loadList,
        check: check,
        upgrade: upgrade,
        upgradeAndWait: upgradeAndWait,
        cancel: cancel,
        setBusy: setBusy,
        setError: setError,
        setVerdict: setVerdict,
        setRun: setRun,
      };
    }

    /** Progress line for an in-flight run, from the official install phases. */
    function progressText(run) {
      if (!run) return "";
      if (run.phase === "installing") {
        var attempt = run.attempt;
        if (attempt && attempt.total > 1) {
          return "正在下载安装（注册表 " + attempt.index + "/" + attempt.total + "）…";
        }
        return "正在下载安装…";
      }
      if (run.phase === "cancelling") return "正在取消…";
      if (run.phase === "applying") return "正在应用变更…";
      if (run.phase === "done") return "已结束";
      return String(run.phase || "");
    }

    /** One plugin row: identity, status, and the actions that apply to it. */
    function PluginRow(props) {
      var record = props.record;
      var busy = props.busy;
      var run = props.run;
      var onUpgrade = props.onUpgrade;
      var info = statusOf(record);

      var isThisRun = run && run.name === record.name;
      var upgrading = isThisRun && run.running;

      return h(
        "div",
        { className: "dsh-upg-row" },
        h(
          "div",
          { className: "dsh-upg-row-top" },
          h("span", { className: "dsh-upg-name", title: record.name }, record.name),
          h(
            "span",
            { className: "dsh-upg-tag " + (info.tag ? "dsh-upg-tag-" + info.tag : "") },
            info.label
          ),
          record.enabled === false
            ? h("span", { className: "dsh-upg-tag" }, "已禁用")
            : null,
          h("span", { className: "dsh-upg-spacer" }),
          h(
            "span",
            { className: "dsh-upg-ver" },
            targetOf(record)
              ? String(record.installedVersion || "?") + " → " + String(targetOf(record))
              : String(record.installedVersion || record.latestVersion || "—")
          )
        ),
        record.description ? h("div", { className: "dsh-upg-desc" }, record.description) : null,
        h("div", { className: "dsh-upg-msg" }, record.message || ""),
        record.stale
          ? h("div", { className: "dsh-upg-msg" }, "（显示的是上次成功结果，本次检查失败）")
          : null,
        record.detail
          ? h("div", { className: "dsh-upg-log" }, String(record.detail).slice(-1500))
          : null,
        upgrading
          ? h("div", { className: "dsh-upg-msg" }, progressText(run))
          : null,
        upgrading && run.logTail && run.logTail.length > 0
          ? h("div", { className: "dsh-upg-log" }, run.logTail.slice(-12).join("\n"))
          : null,
        h(
          "div",
          { className: "dsh-upg-actions" },
          // A per-plugin check: one network call, for the row the user actually cares about.
          record.status === "unchecked" && !upgrading
            ? h(
                "button",
                {
                  className: "dsh-upg-btn",
                  disabled: busy,
                  title: "只检查这一个插件",
                  onClick: function () {
                    props.onCheck(record.name);
                  },
                },
                "检查"
              )
            : null,
          canUpgrade(record) && !upgrading
            ? h(
                "button",
                {
                  className: "dsh-upg-btn dsh-upg-btn-primary",
                  disabled: busy,
                  title: "会改写该 profile 的依赖，重启后生效",
                  onClick: function () {
                    onUpgrade(record.name, targetOf(record));
                  },
                },
                // A git update has a commit, not a version, so the label must not assume one.
                targetOf(record) ? "升级到 " + String(targetOf(record)) : "升级"
              )
            : null,
          record.status !== "unchecked" && !upgrading
            ? h(
                "button",
                {
                  className: "dsh-upg-btn",
                  disabled: busy,
                  title: "重新查询这一个插件",
                  onClick: function () {
                    props.onCheck(record.name);
                  },
                },
                "重新检查"
              )
            : null,
          upgrading
            ? h(
                "button",
                {
                  className: "dsh-upg-btn",
                  onClick: function () {
                    props.onCancel();
                  },
                },
                "取消"
              )
            : null
        )
      );
    }

    /** The verdict panel shown after one upgrade settles. */
    function VerdictPanel(props) {
      var verdict = props.verdict;
      var copiedState = React.useState(false);
      var copied = copiedState[0];
      var setCopied = copiedState[1];
      if (!verdict) return null;

      var className =
        "dsh-upg-banner"
        + (verdict.state === "failed" || verdict.state === "needs-authorization" || verdict.state === "validation-failed" ? " dsh-upg-banner-err" : "")
        + (verdict.state === "no-op" ? " dsh-upg-banner-note" : "")
        + (verdict.needsRestart ? " dsh-upg-banner-warn" : "");

      /**
       * Copy the suggested YAML. Falls back to selecting nothing on failure: the text is already
       * on screen for manual copying, so a failed clipboard write is not worth an error banner.
       */
      var copy = function () {
        var text = verdict.action && verdict.action.yaml ? verdict.action.yaml : "";
        if (text === "" || !navigator.clipboard) return;
        navigator.clipboard.writeText(text).then(
          function () { setCopied(true); },
          function () { setCopied(false); }
        );
      };

      return h(
        "div",
        { className: className },
        h("div", null, h("strong", null, verdict.headline)),
        verdict.detail ? h("div", { className: "dsh-upg-verdict-detail" }, verdict.detail) : null,
        verdict.action && verdict.action.yaml
          ? h(
              "div",
              { className: "dsh-upg-actions" },
              h(
                "button",
                { className: "dsh-upg-btn", onClick: copy },
                copied ? "已复制" : "复制这段 YAML"
              )
            )
          : null
      );
    }

    /** The full upgrade-centre page. */
    function UpgradeCenter(props) {
      var connection = props.connection;
      var state = useUpgradeState(connection);

      // Load the roster only. This performs NO update check: checking every plugin costs one
      // network call each, so opening the page must not be the expensive action.
      React.useEffect(
        function () {
          state.loadList();
        },
        [state.loadList]
      );

      var report = state.report;
      var plugins = report && Array.isArray(report.plugins) ? report.plugins : [];
      var summary = report ? report.summary : null;
      // Only plugins we can actually act on are queued; an "outdated" record we cannot upgrade
      // must never enter the batch.
      var outdated = plugins.filter(function (item) {
        return canUpgrade(item);
      });
      var unchecked = plugins.filter(function (item) {
        return item.status === "unchecked";
      });

      var upgradeAll = function () {
        // Strictly serial: the profile write lock is global, so overlapping installs
        // would only queue behind each other while interleaving their output in the UI.
        // `upgradeAndWait` resolves on settle, which is what makes this a real queue.
        if (state.busy) return;
        state.setBusy(true);
        state.setError(null);
        state.setVerdict(null);
        var queue = outdated.slice();
        var done = [];
        var step = function () {
          var item = queue.shift();
          if (item === undefined) {
            state.setBusy(false);
            // Re-check only what changed; a full sweep would re-query plugins that did not.
            // `keepMessage: true` so a refusal from one item in the batch survives the sweep —
            // otherwise the first refusal is wiped by the re-check and the batch looks silent.
            for (var i = 0; i < done.length; i++) state.check(true, done[i], true);
            return;
          }
          state.upgradeAndWait(item.name, targetOf(item)).then(function () {
            done.push(item.name);
            step();
          });
        };
        step();
      };

      return h(
        "div",
        { className: "dsh-upg" },
        h(
          "div",
          { className: "dsh-upg-head" },
          h("h2", null, "升级中心"),
          summary
            ? h(
                "span",
                { className: "dsh-upg-count" },
                "共 " + summary.total + " 个第三方插件"
                  + (summary.unchecked > 0
                    ? "，" + summary.unchecked + " 个待检查"
                    : "，" + summary.outdated + " 个可升级")
              )
            : null,
          h("span", { className: "dsh-upg-spacer" }),
          h(
            "button",
            {
              // The ONE action that spends network calls on every plugin.
              className: "dsh-upg-btn dsh-upg-btn-primary",
              disabled: state.busy,
              title: "逐个检查每个插件是否有新版本（每个插件一次网络查询）",
              onClick: function () {
                state.check(true);
              },
            },
            state.busy ? "检查中…" : "检查更新"
          ),
          h(
            "button",
            {
              className: "dsh-upg-btn",
              disabled: state.busy,
              title: "忽略 6 小时缓存，重新查询（仍然逐个检查）",
              onClick: function () {
                state.check(true);
              },
            },
            "重新检查"
          ),
          outdated.length > 0
            ? h(
                "button",
                {
                  className: "dsh-upg-btn dsh-upg-btn-primary",
                  disabled: state.busy,
                  title: "会依次升级全部可升级插件，并改写 profile 依赖",
                  onClick: upgradeAll,
                },
                "全部升级（" + outdated.length + "）"
              )
            : null
        ),
        state.error
          ? h("div", { className: "dsh-upg-banner dsh-upg-banner-err" }, state.error)
          : null,
        h(VerdictPanel, { verdict: state.verdict }),
        state.busy && !state.run
          ? h("div", { className: "dsh-upg-msg" }, "正在检查更新…")
          : null,
        report === null && !state.busy
          ? h("div", { className: "dsh-upg-empty" }, "正在读取插件列表…")
          : null,
        plugins.length === 0 && report !== null
          ? h("div", { className: "dsh-upg-empty" }, "没有发现可管理的第三方插件。")
          : null,
        unchecked.length > 0 && !state.busy
          ? h(
              "div",
              { className: "dsh-upg-hint" },
              "尚未检查更新。点击上方「检查更新」逐个查询是否有新版本。"
            )
          : null,
        h(
          "div",
          { className: "dsh-upg-list" },
          plugins.map(function (record) {
            return h(PluginRow, {
              key: record.name,
              record: record,
              busy: state.busy,
              run: state.run,
              onUpgrade: state.upgrade,
              onCancel: state.cancel,
              onCheck: function (name) {
                state.check(true, name);
              },
            });
          })
        ),
        summary && summary.local > 0
          ? h(
              "div",
              { className: "dsh-upg-foot" },
              summary.local + " 个是 link:/file: 本地依赖，没有远端可比对，需自行管理。"
            )
          : null,
        report
          ? h(
              "div",
              { className: "dsh-upg-foot" },
              "升级会把新版本写入 profile 依赖，" +
                "并在下次启动时生效。检查结果缓存 6 小时，可随时重新检查。"
            )
          : null
      );
    }

    /** A one-line badge on a plugin's detail page. */
    function PluginBadge(props) {
      var connection = props.connection;
      var pluginName = subjectName(props.subject);
      var state = React.useState(null);
      var record = state[0];
      var setRecord = state[1];

      React.useEffect(
        function () {
          if (pluginName === null) return undefined;
          var alive = true;
          // Scoped to THIS plugin. An unscoped check would query every installed plugin just to
          // draw one badge, which is exactly the cost this design avoids. Served from the 6h
          // cache when fresh, so revisiting a page is free.
          callRpc(connection, "check", { name: pluginName })
            .then(function (value) {
              if (!alive || !value) return;
              var found = (value.plugins || []).filter(function (item) {
                return item.name === pluginName;
              })[0];
              setRecord(found || null);
            })
            .catch(function () {
              // A badge is decoration: a failed check simply draws nothing.
            });
          return function () {
            alive = false;
          };
        },
        [connection, pluginName]
      );

      if (pluginName === null || record === null) return null;
      if (record.status === "outdated") {
        var target = targetOf(record);
        return h(
          "span",
          { className: "dsh-upg-tag dsh-upg-tag-out" },
          // A git update shows a commit, so the arrow must tolerate a missing version.
          target
            ? "可升级 " + String(record.installedVersion || "?") + " → " + String(target)
            : "可升级"
        );
      }
      if (record.status === "current") {
        return h("span", { className: "dsh-upg-tag dsh-upg-tag-ok" }, "已是最新");
      }
      if (record.status === "local") {
        return h("span", { className: "dsh-upg-tag" }, "本地依赖");
      }
      return null;
    }

    /** An upgrade button plus a compact version readout on a plugin's detail page. */
    function PluginDetail(props) {
      var connection = props.connection;
      var pluginName = subjectName(props.subject);
      var state = React.useState(null);
      var record = state[0];
      var setRecord = state[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var verdictState = React.useState(null);
      var verdict = verdictState[0];
      var setVerdict = verdictState[1];

      var refresh = React.useCallback(
        function (force) {
          if (pluginName === null) return Promise.resolve(null);
          // Scoped to this plugin: opening one detail page must not query every plugin.
          return callRpc(connection, "check", { name: pluginName, force: force === true })
            .then(function (value) {
              var found = (value.plugins || []).filter(function (item) {
                return item.name === pluginName;
              })[0];
              setRecord(found || null);
              return found || null;
            })
            .catch(function () {
              return null;
            });
        },
        [connection, pluginName]
      );

      React.useEffect(
        function () {
          refresh(false);
        },
        [refresh]
      );

      if (pluginName === null) return null;

      var run = function () {
        setBusy(true);
        setVerdict(null);
        // The Host resolves the spec; `version` is supplied only for a real semver target so a
        // refreshed browser still works against a pre-change Host half.
        var payload = { name: pluginName };
        var target = targetOf(record);
        if (typeof target === "string" && /^\d+\.\d+\.\d+/.test(target)) payload.version = target;
        callRpc(connection, "upgrade.start", payload)
          .then(function (value) {
            var requestId = value.requestId;
            var tick = function () {
              callRpc(connection, "upgrade.status", { requestId: requestId })
                .then(function (status) {
                  if (status.run && status.run.running) {
                    setTimeout(tick, POLL_MS);
                    return;
                  }
                  setVerdict(status.verdict || null);
                  setBusy(false);
                  refresh(true);
                })
                .catch(function () {
                  setBusy(false);
                });
            };
            tick();
          })
          .catch(function (err) {
            setVerdict({
              state: "failed",
              needsRestart: false,
              headline: "升级失败",
              detail: err && err.message ? err.message : String(err),
            });
            setBusy(false);
          });
      };

      return h(
        "div",
        { className: "dsh-upg-detail" },
        h(
          "div",
          { className: "dsh-upg-detail-line" },
          h("span", { className: "dsh-upg-detail-k" }, "当前版本"),
          h("span", { className: "dsh-upg-detail-v" }, String((record && record.installedVersion) || "—"))
        ),
        h(
          "div",
          { className: "dsh-upg-detail-line" },
          h("span", { className: "dsh-upg-detail-k" }, record && record.shape === "git" ? "最新提交" : "最新版本"),
          h(
            "span",
            { className: "dsh-upg-detail-v" },
            // A git dependency reports a commit, not a version.
            (record && targetOf(record)) || (record && record.latestVersion) || "—"
          )
        ),
        h(
          "div",
          { className: "dsh-upg-detail-line" },
          h("span", { className: "dsh-upg-detail-k" }, "依赖形态"),
          h("span", { className: "dsh-upg-detail-v" }, String((record && record.shape) || "—"))
        ),
        record && record.message
          ? h("div", { className: "dsh-upg-msg" }, record.message)
          : null,
        h(VerdictPanel, { verdict: verdict }),
        h(
          "div",
          { className: "dsh-upg-actions" },
          record && canUpgrade(record)
            ? h(
                "button",
                {
                  className: "dsh-upg-btn dsh-upg-btn-primary",
                  disabled: busy,
                  title: "会改写该 profile 的依赖，重启后生效",
                  onClick: run,
                },
                busy
                  ? "升级中…"
                  : targetOf(record) ? "升级到 " + String(targetOf(record)) : "升级"
              )
            : null,
          h(
            "button",
            { className: "dsh-upg-btn", disabled: busy, onClick: function () { refresh(true); } },
            "重新检查"
          )
        )
      );
    }

    function apply(ctx) {
      ctx.effect(function () {
        return installStyles();
      }, "plugin-upgrader: install styles");

      var connection = ctx.connection;

      ctx.slots.inject("settings.plugins.tab", function () {
        return ctx.slots.register(
          {
            name: "settings.plugins.tab",
            id: "upgrades",
            order: 90,
            label: function () {
              return "升级中心";
            },
            inject: function () {
              return { connection: connection };
            },
          },
          UpgradeCenter
        );
      });

      ctx.slots.inject("plugins.detail.badge", function () {
        return ctx.slots.register(
          {
            name: "plugins.detail.badge",
            id: "upgrader-badge",
            order: 50,
            inject: function () {
              return { connection: connection };
            },
          },
          PluginBadge
        );
      });

      ctx.slots.inject("plugins.detail.section", function () {
        return ctx.slots.register(
          {
            name: "plugins.detail.section",
            id: "upgrader-detail",
            order: 50,
            inject: function () {
              return { connection: connection };
            },
          },
          PluginDetail
        );
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;

    return module.exports;
  },
});

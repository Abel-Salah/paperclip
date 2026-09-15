# Runtime services: local acceptance

Date: 2026-09-15

## Scope and ownership

Test the combined Paperclip runtime-services stack in a fresh worktree before changing the published PR structure. This is local acceptance, not hosted Daytona or production deployment qualification.

- Worktree: `runtime-services-local-acceptance`; branch: `codex/runtime-services-local-acceptance`.
- Composed commit: `0c8ba4bdbff7eaf619de14b3015b46ab28633897` (foundation, design, and hosted-ingress companion).
- Primary agent owns the plan, diagnosis, source fixes, and acceptance decisions.
- GPT-5.6-Luna performs the routine browser walkthrough and specified test commands. Live in-app agent fixtures also explicitly use `gpt-5.6-luna`.
- Each automated suite owns a throwaway home, database, browser, and loopback port. The manual instance is on `http://127.0.0.1:3207`; its test task is `RUN-1`.
- Existing user instances, production routing, DNS, and published PR branches stay outside this test's mutations.

## Test plan

| Journey | Evidence required |
| --- | --- |
| Create and discover a service | Create from the real Services UI, associate a task, reach Running, find the service in task properties, open its URL, read logs. |
| Vite React iteration | Open the actual sandboxed app, increment a counter, edit its source, observe the heading update without navigation or counter reset. |
| Return after ten minutes | Close the manual preview, wait at least ten real minutes, reopen the exact URL and verify retained source and a working app. |
| Agent completion and warm expiry | Actual Luna agent creates the app via service tools and finishes; native runner really exits after its five-minute warm period; app stays ready for 610 seconds; a later agent run edits dirty files without restarting the service and Fast Refresh preserves the counter. Also exercise the legacy Codex adapter. |
| Start, stop, restart, and failure | Use real UI controls and keyboard activation; exhaust retries with a broken command, inspect the error/logs, repair the disposable app, recover, and stop it. |
| Uncertain requests and mobile | Delay/drop successful responses and verify retry identity, no duplicate process, preserved form input, disabled pending controls, feedback, reduced motion, and mobile layout. |
| Lifetime and activity | Verify visible/hidden preview activity, idle sleep, wake at the same URL, explicit Stop, finite keep-running deadlines, and company limits. |
| Private and shared access | Verify authenticated access, membership revocation, sign-in return paths, shared-link revocation including WebSockets, and browser cookie isolation behavior. |
| Paperclip restart | Graceful and forced control-plane restart preserve the real app, URL, dirty files, browser storage, HMR, and crash budget. |
| Data and task ownership | Verify retained storage measurement, credentials, task attachment/detachment, active-task retention guards, and deletion of only reviewed disposable task data. |

Storybook is useful design context but does not count as evidence for these runtime journeys. Fixtures may seed companies/workspace records or age retention timestamps; the result must state those boundaries. Live-agent tests preinstall dependencies unless explicitly configured otherwise.

## Findings and fixes

1. The redesigned UI moved compact Restart/Logs controls into an overflow menu and added an empty-state creation button. Old browser selectors failed despite the controls working. Updated the assertions to the current UI while retaining pending-state, keyboard, and idempotency checks. The eight basic acceptance cases then passed.
2. Concurrent local fixture servers shared Vite's dependency cache. Give each throwaway instance its own optimizer cache.
3. macOS emitted bursts of apparent edits across unchanged UI files. Verified file mtimes/ctimes remained at checkout time; the filesystem-event process saturated a CPU. Vite invalidated React context modules, the board displayed `useCompany must be used within CompanyProvider`, and the resulting reload work delayed preview health/activity checks. Cache isolation alone did not resolve this. Setting `CHOKIDAR_USEPOLLING=1` alone also left Vite's bundled native watcher enabled: a direct constructor probe returned `{usePolling:true,useFsEvents:true}`. The dev-watch helper now applies that environment setting explicitly before the watcher initializes; the same probe returns `{usePolling:true,useFsEvents:false}`. The ordinary native-watching default remains unchanged, and the macOS E2E harness opts into polling. The original source of the spurious native events is not established. The corrected configuration passed regression tests and another real manual edit with no board error.
4. Added an optional model setting to live-agent acceptance so the run can explicitly use Luna instead of the default model.
5. The manual recovery fixture was initially created as a web preview while its command only kept a worker process alive. Waiting for an HTTP readiness endpoint was correct. Repair the fixture to actually serve HTTP before judging recovery.
6. A live Connectors announcement covered the mobile deletion confirmation. The trace showed pointer interception, not a deletion-controller failure. The two deletion specs now dismiss the announcement through its normal UI button. Confirmation, request identity, failure recovery, and timeout assertions remain intact.
7. One legacy Luna attempt created its service but exhausted its 210-second run budget doing extra build/preview checks. Bound the acceptance agent's instructions to service-tool verification; the browser harness owns the browser and HMR checks. Keep the actual agent, task-completion requirement, assertions, and timeout unchanged.
8. A failed preview attempt's cleanup received a revision conflict while readiness reconciliation was updating the service. Its detached process consequently outlived the failed test. Cleanup now re-reads and retries that specific conflict within a bounded budget. Resumed only that throwaway instance, stopped the retained service through its API, and verified its endpoint port closed.

## Results

Completed: **23 distinct automated browser scenarios passed**, plus the manual walkthrough and 12 watcher regression tests. Reruns and the repeated company-policy case are excluded from that distinct-scenario count. Failed attempts remain diagnostic evidence; they are not counted as passes.

| Suite / journey | Current result |
| --- | --- |
| Basic UI, company policy, credentials, storage | 8 passed after selector updates |
| Graceful and forced controller restart | 2 passed |
| Authenticated access and sign-in return | 1 passed |
| Retention suite | 2 passed; includes one repeated company-policy case |
| Manual Vite Fast Refresh | Passed: source heading updated and Count 2 remained without reload |
| Preview gateway/lifetime/isolation | All 5 scenarios passed; the Vite/sharing case passed on its polling rerun |
| Native actual Luna, 610-second continuity | Passed (13.8 minutes including setup/agents/cleanup): original runner absent at 309,793 ms after completion; same service start/URL survived; second run edited the app and Count 2 persisted |
| Legacy actual Luna, 610-second continuity | Passed (13.8 minutes including setup/agents/cleanup): service stayed ready for 610 seconds; a second actual agent run edited retained source and Count 2 persisted at the same URL |
| Manual ten-minute return and repaired failure | Passed: original URL and edited source survived the closed-tab interval and Stop/Start; repaired HTTP app reached Running and showed recovery logs |
| Mobile task attachment/detachment | 1 passed; provider transport is simulated for stale-poll and lost-response behavior |
| Mobile deletion failure/retry | 2 passed after announcement dismissal; real API rejects deletion of external workspaces, then simulated provider responses exercise recovery |
| Mobile deletion of reviewed shared task files | 1 passed against the actual API/controller/filesystem; runtime-owned workspace record is seeded |
| Manual board after polling restart | Healthy; same service process start and URL survived restart; Luna observed no new board error |
| Manual edit after explicit polling fix | Passed: added “Second edit verified” without navigation; Count 1 remained; board stayed healthy |
| Dev-watch regression tests | 12 passed; actual Vite constructor separately verified native events disabled when polling is requested |
| UI typecheck, UI build, and token gates | Passed |

The original preview tab was closed at 14:27:42 UTC and reopened after 14:37:52 UTC. This checks an actual absence, separately from the automated visible-tab activity tests. Closing and reopening a tab is not expected to preserve React's in-memory counter; the counter preservation assertions apply to HMR in the same tab.

## Reproduction and evidence

Run each browser config with a free `PAPERCLIP_E2E_PORT`. These configs create their own throwaway instance; do not point them at a user's existing instance.

```sh
PAPERCLIP_E2E_PORT=3210 pnpm exec playwright test --config tests/e2e/runtime-services.config.ts
PAPERCLIP_E2E_PORT=3211 pnpm exec playwright test --config tests/e2e/runtime-service-previews.config.ts
PAPERCLIP_E2E_PORT=3213 pnpm exec playwright test --config tests/e2e/runtime-service-restart.config.ts
PAPERCLIP_E2E_PORT=3215 pnpm exec playwright test --config tests/e2e/runtime-service-authenticated.config.ts
PAPERCLIP_E2E_PORT=3216 pnpm exec playwright test --config tests/e2e/runtime-service-retention.config.ts
PAPERCLIP_E2E_PORT=3217 pnpm exec playwright test --config tests/e2e/runtime-service-task-workspace.config.ts
PAPERCLIP_E2E_PORT=3217 pnpm exec playwright test --config tests/e2e/runtime-service-data-deletion.config.ts
PAPERCLIP_E2E_PORT=3217 pnpm exec playwright test --config tests/e2e/runtime-service-task-data-deletion.config.ts
```

Actual-agent acceptance uses `tests/e2e/runtime-service-agents.config.ts`, with `PAPERCLIP_RUNTIME_SERVICE_LIVE_CODEX=1`, `PAPERCLIP_RUNTIME_SERVICE_AGENT_MODEL=gpt-5.6-luna`, `PAPERCLIP_RUNTIME_SERVICE_AGENT_SOAK_SECONDS=610`, and a dedicated signed-in `PAPERCLIP_RUNTIME_SERVICE_AGENT_CODEX_HOME`. Set `PAPERCLIP_RUNTIME_SERVICE_AGENT_PROFILE` to `legacy-codex` or `runner-codex`; native warm acceptance additionally requires the current compiled `PAPERCLIP_RUNNER_BINARY`. These tests make real model calls. The temporary authentication copies used in this run were removed after their launchers exited.

Evidence remains in this worktree's `test-results/local-acceptance-*` directories: screenshots, traces, provider-fixture disclosures, request-identity checks, and actual-agent run receipts. The native receipt records runner expiry at 309,793 ms, both real run IDs, service-tool calls, and the unchanged service start time. Final targeted gateway verification is in `local-acceptance-preview-final`; native and legacy receipts are in `local-acceptance-native-polling` and `local-acceptance-live-bounded`.

The manual review instance remains on port 3207, with its main Vite preview running and its disposable recovery service stopped. Automated board ports 3210–3218 were released after acceptance. The published PR stack was not restructured or updated by this local acceptance pass.

## Qualification limits

This run does not establish live Daytona retention, deployed Cloud routing/TLS, PSL registration or propagation, actual hosted cookie boundaries, remote provider loss, or all remaining requirements in the release checklist. Local `.localhost` preview routing and browser-controlled cookie probes do not substitute for those checks. No full repository typecheck/build/test claim is made for these local acceptance-only edits.

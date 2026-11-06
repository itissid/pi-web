import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, emit = async () => {}) {
  const lines = [];
  t.mock.method(console, "info", (line) => lines.push(String(line)));
  let reportError;
  const inner = {
    sessionId: "diagnostic-session", isBashRunning: false, isStreaming: false,
    extensionRunner: { emit },
    sessionManager: { getCwd: () => "/tmp", getSessionName: () => undefined, getEntries: () => [] },
    systemPrompt: "", agent: { state: {} }, getContextUsage: () => null,
    getSteeringMessages: () => [], getFollowUpMessages: () => [],
    bindExtensions: async (options) => { reportError = options.onError; },
    subscribe: () => () => {},
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.start();
  wrapper.beginExtensionBinding();
  t.after(() => wrapper.destroy());
  return {
    wrapper,
    report: (error) => reportError(error),
    records: () => lines.filter((line) => line.startsWith("[pi-web:session] ")).map((line) => JSON.parse(line.slice("[pi-web:session] ".length))),
  };
}

test("extension errors reach service diagnostics even without browser listeners, without sensitive error text", async (t) => {
  const f = fixture(t);
  await f.wrapper.send({ type: "get_state" });
  f.report({ extensionPath: "/home/dev/workspace/pi-mesh/index.ts", event: "session_shutdown", error: "This extension ctx is stale after session replacement or reload. secret-token private-handoff", stack: "Error: secret-token private-handoff\n    at detach (/home/dev/workspace/pi-mesh/src/extension/hud.ts:154:11)" });
  const record = f.records().find((row) => row.phase === "extension-error");
  assert.ok(record, "extension error must be logged before forwarding to optional browser listeners");
  assert.equal(record.sessionId, "diagnostic-session");
  assert.equal(record.event, "session_shutdown");
  assert.equal(record.errorKind, "stale_extension_context");
  assert.ok(record.wrapperId);
  assert.match(JSON.stringify(record.stackLocations), /hud.ts:154:11/);
  assert.doesNotMatch(JSON.stringify(f.records()), /secret-token|private-handoff/);
});

test("shutdown logs deadline, disposal and late error/completion under one wrapper identity", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish;
  const f = fixture(t, () => new Promise((resolve) => { finish = resolve; }));
  await f.wrapper.send({ type: "get_state" });
  const shutdown = f.wrapper.shutdown();
  await nextTurn();
  t.mock.timers.tick(5000);
  await shutdown;
  f.report({ extensionPath: "/home/dev/workspace/pi-mesh/index.ts", event: "session_shutdown", error: "This extension ctx is stale after session replacement or reload." });
  finish();
  await nextTurn();
  const records = f.records();
  const phases = records.map((row) => row.phase);
  assert.ok(phases.includes("extension-shutdown-deadline"));
  assert.ok(phases.indexOf("sdk-dispose-start") > phases.indexOf("extension-shutdown-deadline"));
  const error = records.find((row) => row.phase === "extension-error");
  assert.equal(error.disposed, true);
  assert.equal(error.shutdownOutcome, "timed-out");
  assert.equal(records.find((row) => row.phase === "extension-shutdown-complete").afterDeadline, true);
  assert.equal(new Set(records.map((row) => row.wrapperId)).size, 1);
});

test("successful shutdown finishes before disposal and reports once", async (t) => {
  const f = fixture(t);
  await Promise.all([f.wrapper.shutdown(), f.wrapper.shutdown()]);
  const phases = f.records().map((row) => row.phase);
  assert.equal(phases.filter((phase) => phase === "extension-shutdown-start").length, 1);
  assert.ok(phases.indexOf("sdk-dispose-start") > phases.indexOf("extension-shutdown-complete"));
  assert.ok(phases.includes("sdk-dispose-complete"));
  assert.ok(!phases.includes("extension-shutdown-deadline"));
});

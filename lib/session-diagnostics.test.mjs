import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { writeSessionDiagnostic } = await jiti.import("./session-diagnostics.ts");
const fields = { phase: "extension-error", sessionId: "session", wrapperId: "wrapper", closing: true, disposed: true, shutdownOutcome: "timed-out" };

test("diagnostics omit arbitrary messages, payloads, and stack prose", (t) => {
  const lines = [];
  t.mock.method(console, "info", (line) => lines.push(line));
  const error = new Error("Bearer secret-token: private handoff contents");
  error.stack = "Error: private handoff contents\n    at detach (/home/dev/workspace/pi-mesh/src/extension/hud.ts:154:11)\n    at private handoff contents";
  writeSessionDiagnostic({ ...fields, unexpectedPayload: "private handoff contents" }, error);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /secret-token|private handoff|unexpectedPayload/);
  const record = JSON.parse(lines[0].slice("[pi-web:session] ".length));
  assert.equal(record.errorKind, "other_error");
  assert.match(record.errorFingerprint, /^[a-f0-9]{16}$/);
  assert.equal(record.stackLocations.length, 1);
  assert.ok(record.at);
  assert.equal(record.pid, process.pid);
});

test("logging failures cannot escape into SDK error handling", (t) => {
  t.mock.method(console, "info", () => { throw new Error("sink failed"); });
  assert.doesNotThrow(() => writeSessionDiagnostic(fields, new Error("test")));
});

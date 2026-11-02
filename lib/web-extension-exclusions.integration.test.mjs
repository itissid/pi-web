import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createJiti } from "jiti";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const { createModelRuntimeWithExtensions } = await jiti.import("./model-runtime.ts");
const { createPiWebAgentSessionServices } = await jiti.import("./web-extension-policy.ts");
const { startRpcSession, AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { createSubagentController } = await jiti.import("./subagent-runtime.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-extension-exclusions-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd);
  allowFileRoot(cwd);
  const old = process.env.PI_CODING_AGENT_DIR;
  const offline = process.env.PI_OFFLINE;
  const home = process.env.HOME;
  const userprofile = process.env.USERPROFILE;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  t.after(() => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    if (offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = offline;
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    if (userprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = userprofile;
    rmSync(root, { recursive: true, force: true });
  });
  function extension(name, directory = join(agentDir, "extensions", name)) {
    mkdirSync(directory, { recursive: true });
    const file = join(directory, "index.ts");
    const markers = Object.fromEntries(["import", "factory", "session"].map((phase) => [phase, join(root, `${name}-${phase}`)]));
    writeFileSync(file, `
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(markers.import)}, "imported\\n");
export default function (pi: any) {
  appendFileSync(${JSON.stringify(markers.factory)}, "initialized\\n");
  pi.registerCommand(${JSON.stringify(`${name}-command`)}, { description: "Fixture command", handler: async () => {} });
  pi.registerTool({ name: ${JSON.stringify(`${name}_tool`)}, label: "Fixture", description: "Fixture",
    parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "fixture" }], details: undefined }) });
  pi.on("session_start", () => { appendFileSync(${JSON.stringify(markers.session)}, "started\\n"); });
  pi.registerProvider(${JSON.stringify(`${name}-provider`)}, {
    baseUrl: "https://example.invalid/v1", apiKey: "fixture-key", api: "openai-completions",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
  });
}
`);
    return { directory, file, markers };
  }
  const excluded = extension("excluded");
  const allowed = extension("allowed");
  const settingsPath = join(agentDir, "settings.json");
  function settings(extra = {}) {
    const text = JSON.stringify({
      defaultProvider: "allowed-provider", defaultModel: "fixture",
      piWeb: { excludedExtensions: [excluded.directory] },
      other: { preserved: true }, ...extra,
    }, null, 2);
    writeFileSync(settingsPath, text);
    return text;
  }
  function assertExcluded() {
    for (const [phase, path] of Object.entries(excluded.markers)) assert.equal(existsSync(path), false, `excluded ${phase} must never execute`);
  }
  return { root, agentDir, cwd, extension, excluded, allowed, settingsPath, settings, assertExcluded };
}

function minimalOptions(f, extra = {}) {
  return { cwd: f.cwd, agentDir: f.agentDir, resourceLoaderOptions: {
    noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
  }, ...extra };
}

test("web provider discovery excludes an extension before import without changing shared Pi settings", async (t) => {
  const f = fixture(t);
  const settings = f.settings();
  const runtime = await createModelRuntimeWithExtensions();
  f.assertExcluded();
  assert.equal(existsSync(f.allowed.markers.factory), true);
  assert.ok(runtime.getProvider("allowed-provider"));
  assert.equal(runtime.getProvider("excluded-provider"), undefined);
  assert.equal(readFileSync(f.settingsPath, "utf8"), settings);
});

test("actual web new, reloaded and reopened sessions retain allowed extensions and native Agent but never initialize excluded extensions", async (t) => {
  const f = fixture(t);
  const settings = f.settings();
  mkdirSync(join(f.agentDir, "agents"));
  writeFileSync(join(f.agentDir, "agents", "settings.json"), '{"builtInEnabled":true}');
  let wrapper;
  t.after(async () => { if (wrapper?.isAlive()) await wrapper.shutdown(); });
  wrapper = (await startRpcSession(randomUUID(), "", f.cwd)).session;
  await wrapper.waitUntilReady();
  f.assertExcluded();
  const assertTools = () => {
    const names = wrapper.inner.getAllTools().map((tool) => tool.name);
    assert.ok(names.includes("allowed_tool"));
    assert.ok(names.includes("Agent"));
    assert.equal(names.includes("excluded_tool"), false);
    assert.equal(wrapper.inner.extensionRunner.getRegisteredCommands().some((command) => command.name === "excluded-command"), false);
  };
  assertTools();
  assert.equal(existsSync(f.allowed.markers.session), true);
  await wrapper.send({ type: "reload" });
  f.assertExcluded();
  assertTools();
  wrapper.inner.sessionManager.appendMessage({ role: "user", content: "persist fixture", timestamp: Date.now() });
  const id = wrapper.sessionId;
  const file = wrapper.sessionFile;
  assert.ok(file);
  await wrapper.shutdown();
  wrapper = (await startRpcSession(id, file, f.cwd)).session;
  await wrapper.waitUntilReady();
  f.assertExcluded();
  assertTools();
  assert.equal(readFileSync(f.settingsPath, "utf8"), settings);
});

test("trust bootstrap, project force-includes and alias paths cannot re-enable excluded modules", async (t) => {
  const f = fixture(t);
  const target = join(f.root, "actual-extension");
  renameSync(f.excluded.directory, target);
  symlinkSync(target, f.excluded.directory, "dir");
  const alias = join(f.agentDir, "extensions", "another-alias");
  symlinkSync(target, alias, "dir");
  const sibling = f.extension("excluded-sibling");
  mkdirSync(join(f.cwd, ".pi"));
  const projectSettings = JSON.stringify({
    extensions: [`+${join(alias, "index.ts")}`, f.excluded.file],
    piWeb: { excludedExtensions: [] },
  });
  writeFileSync(join(f.cwd, ".pi", "settings.json"), projectSettings);
  const globalSettings = f.settings({ extensions: [join(target, "index.ts"), `+${f.excluded.file}`] });
  let trustChecked = false;
  const services = await createPiWebAgentSessionServices(minimalOptions(f, {
    resourceLoaderReloadOptions: { resolveProjectTrust: async () => {
      trustChecked = true;
      f.assertExcluded();
      return true;
    } },
  }));
  assert.equal(trustChecked, true);
  f.assertExcluded();
  assert.equal(existsSync(sibling.markers.factory), true, "a same-prefix sibling remains allowed");
  assert.equal(services.resourceLoader.getExtensions().errors.length, 0);
  await services.resourceLoader.reload({ resolveProjectTrust: async () => true });
  f.assertExcluded();
  assert.equal(readFileSync(f.settingsPath, "utf8"), globalSettings);
  assert.equal(readFileSync(join(f.cwd, ".pi", "settings.json"), "utf8"), projectSettings);

  // The same on-disk settings still load the extension through the unfiltered
  // SDK (the terminal uses this path rather than Pi Web's services adapter).
  await createAgentSessionServices(minimalOptions(f));
  assert.equal(existsSync(f.excluded.markers.import), true);
  assert.equal(existsSync(f.excluded.markers.factory), true);
});

test("package-owned entries, file packages and explicit additional paths obey the same host exclusion", async (t) => {
  const f = fixture(t);
  const packaged = f.extension("packaged", join(f.root, "package", "src"));
  const packageDir = join(f.root, "package");
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "fixture-package", pi: { extensions: ["src/index.ts"] } }));
  const packageAlias = join(f.root, "package-alias");
  symlinkSync(packageDir, packageAlias, "dir");
  const filePackage = f.extension("file-package", join(f.root, "file-package"));
  const external = f.extension("external", join(f.root, "external"));
  const text = f.settings({
    piWeb: { excludedExtensions: [f.excluded.directory, packageDir, filePackage.file, external.file] },
    packages: [{ source: packageAlias, extensions: ["+src/index.ts"] }, filePackage.file],
  });
  const services = await createPiWebAgentSessionServices(minimalOptions(f, {
    resourceLoaderOptions: { noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      additionalExtensionPaths: [external.directory, f.allowed.file] },
  }));
  f.assertExcluded();
  for (const extension of [packaged, filePackage, external]) {
    assert.equal(existsSync(extension.markers.import), false, extension.file);
    assert.equal(existsSync(extension.markers.factory), false, extension.file);
  }
  assert.ok(services.modelRuntime.getProvider("allowed-provider"));
  await services.resourceLoader.reload();
  for (const extension of [packaged, filePackage, external]) assert.equal(existsSync(extension.markers.factory), false);
  assert.equal(readFileSync(f.settingsPath, "utf8"), text);
});

test("relative entries are agent-directory-relative, duplicates are harmless and settings writes never persist virtual rules", async (t) => {
  const f = fixture(t);
  const config = { piWeb: { excludedExtensions: [relative(f.agentDir, f.excluded.directory), f.excluded.file, f.excluded.directory] }, extensions: [`+${f.excluded.file}`] };
  const text = f.settings(config);
  const services = await createPiWebAgentSessionServices(minimalOptions(f));
  f.assertExcluded();
  assert.equal(readFileSync(f.settingsPath, "utf8"), text);
  services.settingsManager.setDefaultThinkingLevel("high");
  await services.settingsManager.flush();
  const after = JSON.parse(readFileSync(f.settingsPath, "utf8"));
  assert.deepEqual(after.piWeb, config.piWeb);
  assert.deepEqual(after.extensions, config.extensions);
  assert.equal(after.defaultThinkingLevel, "high");
  assert.deepEqual(services.settingsManager.drainErrors(), []);
});

test("tilde paths and exact file exclusions match without treating glob characters as patterns", async (t) => {
  const f = fixture(t);
  const previousHome = process.env.HOME;
  process.env.HOME = f.root;
  t.after(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; });
  const literal = f.extension("literal", join(f.agentDir, "extensions", "literal[1]"));
  const unmatched = f.extension("literal1");
  f.settings({ piWeb: { excludedExtensions: ["~/agent/extensions/excluded/index.ts", literal.file] } });
  await createPiWebAgentSessionServices(minimalOptions(f));
  f.assertExcluded();
  assert.equal(existsSync(literal.markers.import), false);
  assert.equal(existsSync(unmatched.markers.factory), true);
});

for (const piWeb of [null, false, [], "invalid", { excludedExtensions: null }, { excludedExtensions: "path" }, { excludedExtensions: [""] }, { excludedExtensions: [42] }]) {
  test(`invalid global piWeb configuration fails before any extension executes: ${JSON.stringify(piWeb)}`, async (t) => {
    const f = fixture(t);
    f.settings({ piWeb });
    await assert.rejects(createPiWebAgentSessionServices(minimalOptions(f)), /piWeb/);
    f.assertExcluded();
    assert.equal(existsSync(f.allowed.markers.import), false);
  });
}

for (const extra of [{}, { piWeb: {} }, { piWeb: { excludedExtensions: [] } }]) {
  test(`absent/empty host exclusions preserve existing SDK behavior: ${JSON.stringify(extra)}`, async (t) => {
    const f = fixture(t);
    writeFileSync(f.settingsPath, JSON.stringify(extra));
    await createPiWebAgentSessionServices(minimalOptions(f));
    assert.equal(existsSync(f.excluded.markers.import), true);
    assert.equal(existsSync(f.excluded.markers.factory), true);
    assert.equal(existsSync(f.allowed.markers.factory), true);
  });
}

test("actual web child spawn, reload, resume and RPC reopen cannot opt an excluded extension back in", async (t) => {
  const f = fixture(t);
  const text = f.settings();
  mkdirSync(join(f.agentDir, "agents"));
  writeFileSync(join(f.agentDir, "agents", "fixture.md"), [
    "---", "description: Fixture child", "tools: read", "load_extensions: true", "extensions: [excluded, allowed]", "---", "Complete the fixture task.",
  ].join("\n"));
  const faux = fauxProvider({ models: [{ id: "fixture" }] });
  const runtime = await ModelRuntime.create({ authPath: join(f.agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const services = await createAgentSessionServices({ cwd: f.cwd, agentDir: f.agentDir, modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory(), resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true } });
  const { session: parent } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(f.cwd, join(f.agentDir, "sessions")), model: faux.getModel("fixture") });
  t.after(() => parent.dispose());
  let child;
  const controller = createSubagentController({
    getSession: (id) => id === parent.sessionId
      ? { inner: parent, cwd: f.cwd, sessionFile: parent.sessionFile ?? "", isAlive: () => true, isRunning: () => false }
      : child?.inner.sessionId === id ? child : undefined,
    registerSession(inner, options) {
      child = new AgentSessionWrapper(inner, options);
      child.start(); child.beginExtensionBinding();
      return child;
    },
    reopenSession: async () => { throw new Error("unused"); },
    resolveSessionPath: async () => child?.sessionFile ?? null,
    invalidateSessionList() {}, isBuiltInSubagentsEnabled: () => true,
  });
  t.after(async () => { if (child?.isAlive()) await child.shutdown(); });
  const respond = () => faux.setResponses([() => fauxAssistantMessage([fauxText("complete")])]);
  const assertTools = () => {
    const tools = child.inner.getAllTools().map((tool) => tool.name);
    assert.ok(tools.includes("allowed_tool"));
    assert.equal(tools.includes("excluded_tool"), false);
    assert.equal(Boolean(runtime.getProvider("excluded-provider")), false);
  };
  respond();
  const execution = await controller.extensionRuntime.start({ parentContext: parent, parentToolCallId: "fixture", profile: "fixture", task: "work", description: "work" });
  assert.equal((await execution.completion).status, "completed");
  f.assertExcluded();
  assertTools();
  await child.send({ type: "reload" });
  respond();
  const resumed = await controller.extensionRuntime.resume({ parentContext: parent, parentToolCallId: "resume", sessionId: child.inner.sessionId, task: "continue", description: "continue" });
  assert.equal((await resumed.completion).status, "completed");
  f.assertExcluded();
  assertTools();
  const id = child.inner.sessionId;
  const file = child.sessionFile;
  await child.shutdown();
  child = (await startRpcSession(id, file, f.cwd)).session;
  await child.waitUntilReady();
  f.assertExcluded();
  assert.ok(child.inner.getAllTools().some((tool) => tool.name === "allowed_tool"));
  assert.equal(child.inner.getAllTools().some((tool) => tool.name === "excluded_tool"), false);
  assert.equal(readFileSync(f.settingsPath, "utf8"), text);
});

for (const kind of ["listing", "default"]) {
  test(`actual web model ${kind} route applies the exclusion before provider discovery`, async (t) => {
    const f = fixture(t);
    f.settings();
    const route = kind === "listing"
      ? await jiti.import("../app/api/models/route.ts")
      : await jiti.import("../app/api/models/default/route.ts");
    const response = kind === "listing"
      ? await route.GET(new Request(`http://localhost/api/models?cwd=${encodeURIComponent(f.cwd)}`))
      : await route.PUT(new Request("http://localhost/api/models/default", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: f.cwd, thinkingLevel: "high" }) }));
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    f.assertExcluded();
    assert.equal(existsSync(f.allowed.markers.factory), true);
    const saved = JSON.parse(readFileSync(f.settingsPath, "utf8"));
    assert.deepEqual(saved.piWeb.excludedExtensions, [f.excluded.directory]);
    assert.equal(saved.extensions, undefined);
  });
}

test("reload keeps a configured directory symlink excluded after it points to a new checkout", async (t) => {
  const f = fixture(t);
  const initial = join(f.root, "initial-checkout");
  renameSync(f.excluded.directory, initial);
  symlinkSync(initial, f.excluded.directory, "dir");
  f.settings();
  const services = await createPiWebAgentSessionServices(minimalOptions(f));
  f.assertExcluded();
  const replacement = f.extension("replacement", join(f.root, "replacement-checkout"));
  unlinkSync(f.excluded.directory);
  symlinkSync(replacement.directory, f.excluded.directory, "dir");
  await services.resourceLoader.reload();
  assert.equal(existsSync(replacement.markers.import), false);
  assert.equal(existsSync(replacement.markers.factory), false);
});

for (const kind of ["file", "directory"]) {
  test(`duplicate local ${kind} package aliases cannot bypass canonical exclusion`, async (t) => {
    const f = fixture(t);
    const target = f.extension("duplicate", join(f.root, "external"));
    const alias = join(f.root, kind === "file" ? "alias.ts" : "alias-directory");
    if (kind === "directory") writeFileSync(join(target.directory, "package.json"), JSON.stringify({ name: "duplicate-package", pi: { extensions: ["index.ts"] } }));
    symlinkSync(kind === "file" ? target.file : target.directory, alias, kind === "file" ? "file" : "dir");
    const text = f.settings({ piWeb: { excludedExtensions: [f.excluded.directory, target.file] }, packages: [kind === "file" ? target.file : target.directory, alias] });
    await createPiWebAgentSessionServices(minimalOptions(f));
    assert.equal(existsSync(target.markers.import), false);
    assert.equal(existsSync(target.markers.factory), false);
    assert.equal(readFileSync(f.settingsPath, "utf8"), text);
  });
}

test("an explicit empty package extension list stays empty while applying host exclusions", async (t) => {
  const f = fixture(t);
  const packageDir = join(f.root, "disabled-package");
  const denied = f.extension("package-denied", join(packageDir, "extensions", "denied"));
  const sibling = f.extension("package-disabled", join(packageDir, "extensions", "disabled"));
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "disabled-package", pi: { extensions: ["extensions/denied/index.ts", "extensions/disabled/index.ts"] } }));
  const text = f.settings({ piWeb: { excludedExtensions: [f.excluded.directory, denied.file] }, packages: [{ source: packageDir, extensions: [] }] });
  const services = await createPiWebAgentSessionServices(minimalOptions(f));
  assert.equal(existsSync(denied.markers.import), false);
  assert.equal(existsSync(sibling.markers.import), false);
  await services.resourceLoader.reload();
  assert.equal(existsSync(sibling.markers.factory), false);
  assert.equal(readFileSync(f.settingsPath, "utf8"), text);
});

test("SDK Unicode-space import normalization cannot route an allowed discovered name into an excluded module", async (t) => {
  const f = fixture(t);
  const target = f.extension("space-target", join(f.agentDir, "extensions", "excluded x"));
  const alias = f.extension("space-alias", join(f.agentDir, "extensions", "excluded\u00a0x"));
  f.settings({ piWeb: { excludedExtensions: [f.excluded.directory, target.file] } });
  const services = await createPiWebAgentSessionServices(minimalOptions(f));
  assert.equal(existsSync(target.markers.import), false);
  assert.equal(existsSync(target.markers.factory), false);
  assert.equal(existsSync(alias.markers.import), false, "neither spelling initializes excluded code");
  await services.resourceLoader.reload();
  assert.equal(existsSync(target.markers.import), false);
});

test("reload rechecks original additional extension sources after a symlink points at excluded code", async (t) => {
  const f = fixture(t);
  f.settings();
  const allowed = f.extension("external-allowed", join(f.root, "allowed"));
  const alias = join(f.root, "additional.ts");
  symlinkSync(allowed.file, alias, "file");
  const services = await createPiWebAgentSessionServices(minimalOptions(f, {
    resourceLoaderOptions: { noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, additionalExtensionPaths: [alias] },
  }));
  assert.equal(existsSync(allowed.markers.factory), true);
  f.assertExcluded();
  unlinkSync(alias);
  symlinkSync(f.excluded.file, alias, "file");
  await services.resourceLoader.reload();
  f.assertExcluded();
  assert.equal(services.resourceLoader.getExtensions().extensions.some((extension) => extension.commands.has("excluded-command")), false);
});

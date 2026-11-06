import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sizeLimitToBytes(value) {
  if (typeof value === "number") return value;
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(value.trim());
  assert.ok(match, `unparseable SizeLimit: ${value}`);
  const units = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Number(match[1]) * units[match[2].toLowerCase()];
}

test("scopes Next.js output file tracing to the pi-web package", async () => {
  const config = await createJiti(import.meta.url).import("../next.config.ts", { default: true });

  assert.equal(config.outputFileTracingRoot, projectRoot);
});

test("allows explicitly configured private proxy hosts in source mode", async () => {
  const previous = process.env.PI_WEB_ALLOWED_HOSTS;
  process.env.PI_WEB_ALLOWED_HOSTS = " , devbox-pi-web.beaver-herring.ts.net , ";
  try {
    const config = await createJiti(import.meta.url, { moduleCache: false, fsCache: false })
      .import("../next.config.ts", { default: true });
    assert.ok(config.allowedDevOrigins.includes("devbox-pi-web.beaver-herring.ts.net"));
    assert.ok(!config.allowedDevOrigins.includes(""));
    assert.ok(!config.allowedDevOrigins.includes("*"));
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_ALLOWED_HOSTS;
    else process.env.PI_WEB_ALLOWED_HOSTS = previous;
  }
});

test("raises the proxy body buffer above the upload route's 100 MB request cap", async () => {
  const config = await createJiti(import.meta.url).import("../next.config.ts", { default: true });

  assert.ok(sizeLimitToBytes(config.experimental.proxyClientMaxBodySize) > 100 * 1024 * 1024);
});

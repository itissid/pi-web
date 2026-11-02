import {
  createAgentSessionServices,
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
  type CreateAgentSessionServicesOptions,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import { existsSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readGlobalSettings } from "./global-settings-file";

type PiSettings = ReturnType<SettingsManager["getGlobalSettings"]>;
const require = createRequire(import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Resolving the nearest existing parent also handles a not-yet-installed path
// below a directory symlink. Missing paths remain exclusions, not wildcards.
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
    const parent = dirname(path);
    return parent === path ? path : join(canonicalPath(parent), basename(path));
  }
}

async function readExcludedPaths(agentDir: string): Promise<string[]> {
  return readGlobalSettings(join(agentDir, "settings.json"), (settings) => {
    if (settings.piWeb === undefined) return [];
    if (!isRecord(settings.piWeb)) throw new Error("Invalid settings.json: piWeb must be an object");
    const entries = settings.piWeb.excludedExtensions;
    if (entries === undefined) return [];
    if (!Array.isArray(entries)) throw new Error("Invalid settings.json: piWeb.excludedExtensions must be an array of paths");
    const paths = entries.map((entry, index) => {
      if (typeof entry !== "string" || !entry.trim() || entry.includes("\0")) {
        throw new Error(`Invalid settings.json: piWeb.excludedExtensions[${index}] must be a nonempty path`);
      }
      if (entry.startsWith("~") && entry !== "~" && !entry.startsWith("~/") && !entry.startsWith("~\\")) {
        throw new Error(`Invalid settings.json: piWeb.excludedExtensions[${index}] only supports the current user's ~/ prefix`);
      }
      const expanded = entry === "~" ? homedir() : entry.startsWith("~/") || entry.startsWith("~\\")
        ? join(homedir(), entry.slice(2)) : resolve(agentDir, entry);
      return expanded;
    });
    return [...new Set(paths)];
  });
}

function isExcluded(path: string, excluded: readonly string[]): boolean {
  if (path.startsWith("builtin:")) return false;
  // Pi's extension importer normalizes these Unicode spaces before resolving
  // modules. Check both the discovered spelling and the actual import spelling.
  const spellings = [path, path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ")];
  const candidates = spellings.flatMap((path) => {
    let entry = path;
    if (existsSync(path) && statSync(path).isDirectory()) {
      // A local -e source can resolve to the directory itself; importing it
      // executes its module entry rather than the directory path we received.
      try {
        entry = require.resolve(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
        const typescriptEntry = join(path, "index.ts");
        if (existsSync(typescriptEntry)) entry = typescriptEntry;
      }
    }
    return [resolve(path), canonicalPath(path), canonicalPath(entry)];
  });
  // Keep the authored path as well as its current target: installing/updating
  // through a directory symlink must not undo an exclusion on later reloads.
  return excluded.flatMap((path) => [path, canonicalPath(path)]).some((directory) => candidates.some((canonical) => {
    const within = relative(directory, canonical);
    return within === "" || (!isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`));
  }));
}

function filteredSettings(settings: PiSettings, excluded: readonly ResolvedResource[], scope: "user" | "project", packageExclusions: ReadonlyMap<string, ResolvedResource[]>): PiSettings {
  const paths = excluded.map((resource) => `-${resource.path}`);
  return {
    ...settings,
    extensions: [...(settings.extensions ?? []), ...paths],
    packages: settings.packages?.flatMap((entry) => {
      const source = typeof entry === "string" ? entry : entry.source;
      const resources = packageExclusions.get(`${scope}\0${source}`) ?? excluded.filter((resource) => resource.metadata.scope === scope
        && resource.metadata.origin === "package" && resource.metadata.source === source);
      if (resources.length === 0) return [entry];
      // Pi treats a local single-file package as always enabled, regardless of
      // its resource filters. Such a source contains only that extension.
      if (resources.some((resource) => resource.metadata.packageRoot === undefined || resource.path === resource.metadata.packageRoot)) return [];
      // [] means no extensions; a nonempty list of only negative patterns
      // means all except those paths, which would enable disabled siblings.
      if (typeof entry !== "string" && entry.extensions?.length === 0) return [entry];
      return [{ ...(typeof entry === "string" ? { source } : entry), extensions: [
        ...(typeof entry === "string" ? [] : entry.extensions ?? []),
        ...resources.map((resource) => `-${resource.path}`),
      ] }];
    }),
  };
}

/**
 * Build Pi's services with a web-only view of extension paths. The public
 * SettingsManager getters are adapted, not its storage or private state, so
 * SDK writes still persist only the caller's real changes. Refreshing this
 * view on every SDK reload covers both project-trust passes and later reloads.
 */
export async function createPiWebAgentSessionServices(options: CreateAgentSessionServicesOptions) {
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const excludedPaths = await readExcludedPaths(agentDir);
  if (excludedPaths.length === 0) return createAgentSessionServices(options);

  const settings = options.settingsManager ?? SettingsManager.create(options.cwd, agentDir);
  const packages = new DefaultPackageManager({ cwd: options.cwd, agentDir, settingsManager: settings });
  let excludedResources: ResolvedResource[] = [];
  let packageExclusions = new Map<string, ResolvedResource[]>();
  const loaderOptions = { ...options.resourceLoaderOptions };
  const originalAdditionalPaths = [...(loaderOptions.additionalExtensionPaths ?? [])];
  const additionalPaths: string[] = [];
  const originalSkills = [...(loaderOptions.additionalSkillPaths ?? [])];
  const originalPrompts = [...(loaderOptions.additionalPromptTemplatePaths ?? [])];
  const originalThemes = [...(loaderOptions.additionalThemePaths ?? [])];
  const additionalSkills = [...originalSkills];
  const additionalPrompts = [...originalPrompts];
  const additionalThemes = [...originalThemes];
  if (originalAdditionalPaths.length > 0) {
    // Keep caller-owned option arrays: Pi reads them after settings.reload on
    // each bootstrap/final/reload pass. No loader-private fields are changed.
    loaderOptions.additionalExtensionPaths = additionalPaths;
    loaderOptions.additionalSkillPaths = additionalSkills;
    loaderOptions.additionalPromptTemplatePaths = additionalPrompts;
    loaderOptions.additionalThemePaths = additionalThemes;
  }
  const view = new Proxy(settings, {
    get(target, key) {
      if (key === "reload") return async () => {
        await target.reload();
        const resources = await packages.resolve();
        excludedResources = resources.extensions.filter((resource) => isExcluded(resource.path, excludedPaths));
        packageExclusions = new Map();
        // The SDK deduplicates canonical package identities before returning
        // resources. Inspect each raw source so dropping its first alias cannot
        // leave a second single-file alias to import on the subsequent pass.
        for (const [scope, scopedSettings] of [["user", target.getGlobalSettings()], ["project", target.getProjectSettings()]] as const) {
          for (const entry of scopedSettings.packages ?? []) {
            const source = typeof entry === "string" ? entry : entry.source;
            const installed = packages.getInstalledPath(source, scope);
            if (!installed) continue;
            const sourceResources = await packages.resolveExtensionSources([installed], { temporary: true });
            packageExclusions.set(`${scope}\0${source}`, sourceResources.extensions.filter((resource) => isExcluded(resource.path, excludedPaths)));
          }
        }
        await refreshAdditionalPaths();
      };
      if (key === "getGlobalSettings") return () => filteredSettings(target.getGlobalSettings(), excludedResources, "user", packageExclusions);
      if (key === "getProjectSettings") return () => filteredSettings(target.getProjectSettings(), excludedResources, "project", packageExclusions);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  // Explicit (-e-style) paths bypass normal settings exclusions. Re-resolve
  // original sources before every pass so a new file or retargeted symlink
  // cannot enter the loader through a previously allowed explicit source.
  async function refreshAdditionalPaths() {
    if (originalAdditionalPaths.length === 0) return;
    const paths: string[] = [];
    const skills = [...originalSkills];
    const prompts = [...originalPrompts];
    const themes = [...originalThemes];
    for (const source of originalAdditionalPaths) {
      if (source.startsWith("builtin:")) {
        paths.push(source);
        continue;
      }
      const resources = await packages.resolveExtensionSources([source], { temporary: true });
      if (!resources.extensions.some((resource) => isExcluded(resource.path, excludedPaths))) {
        paths.push(source);
        continue;
      }
      paths.push(...resources.extensions.filter((resource) => resource.enabled && !isExcluded(resource.path, excludedPaths)).map((resource) => resource.path));
      skills.push(...resources.skills.filter((resource) => resource.enabled).map((resource) => resource.path));
      prompts.push(...resources.prompts.filter((resource) => resource.enabled).map((resource) => resource.path));
      themes.push(...resources.themes.filter((resource) => resource.enabled).map((resource) => resource.path));
    }
    additionalPaths.splice(0, additionalPaths.length, ...paths);
    additionalSkills.splice(0, additionalSkills.length, ...skills);
    additionalPrompts.splice(0, additionalPrompts.length, ...prompts);
    additionalThemes.splice(0, additionalThemes.length, ...themes);
  }

  return createAgentSessionServices({ ...options, agentDir, settingsManager: view, resourceLoaderOptions: loaderOptions });
}

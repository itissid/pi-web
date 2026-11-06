import { createHash } from "node:crypto";

export interface SessionDiagnostic {
  phase: string;
  sessionId?: string;
  wrapperId: string;
  closing: boolean;
  disposed: boolean;
  shutdownOutcome: string;
  extensionPath?: string;
  event?: string;
  elapsedMs?: number;
  deadlineMs?: number;
  afterDeadline?: boolean;
}

// Do not log arbitrary exception messages: extensions may include credentials,
// tool arguments or conversation contents. Preserve a safe category, fingerprint
// and bounded source locations instead. Browser error forwarding is unchanged.
export function writeSessionDiagnostic(fields: SessionDiagnostic, error?: unknown): void {
  try {
    const record: Record<string, unknown> = {
      at: new Date().toISOString(), pid: process.pid,
      phase: fields.phase,
      level: fields.phase.includes("error") || fields.phase.includes("failed") ? "error" : fields.phase.includes("deadline") ? "warning" : "info",
      sessionId: fields.sessionId ?? "unknown",
      wrapperId: fields.wrapperId, closing: fields.closing,
      disposed: fields.disposed, shutdownOutcome: fields.shutdownOutcome,
    };
    for (const key of ["elapsedMs", "deadlineMs", "afterDeadline"] as const) {
      if (fields[key] !== undefined) record[key] = fields[key];
    }
    if (fields.event) record.event = /^[a-zA-Z0-9_:-]{1,100}$/.test(fields.event) ? fields.event : "redacted";
    if (fields.extensionPath) record.extension = safePath(fields.extensionPath);
    if (error !== undefined) {
      const info = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
      const message = typeof info.error === "string" ? info.error : typeof info.message === "string" ? info.message : typeof error === "string" ? error : "unknown error";
      record.errorKind = message.includes("This extension ctx is stale after session replacement or reload.")
        ? "stale_extension_context" : "other_error";
      record.errorFingerprint = createHash("sha256").update(message).digest("hex").slice(0, 16);
      if (typeof info.stack === "string") {
        record.stackLocations = info.stack.split("\n").filter((line) => /^\s*at\s/.test(line))
          .flatMap((line) => {
            const match = line.match(/(?:[A-Za-z]:)?[\\/][A-Za-z0-9_./@+\\-]+\.(?:[cm]?[jt]s|tsx):\d+:\d+/);
            return match ? [safePath(match[0])] : [];
          }).slice(0, 12);
      }
    }
    console.info(`[pi-web:session] ${JSON.stringify(record)}`);
  } catch {
    // Diagnostics must never interrupt SDK error dispatch or resource cleanup.
  }
}

function safePath(path: string): string {
  return path.replaceAll("\\", "/").split("/").slice(-6)
    .map((part) => /^[a-zA-Z0-9_.@+:~-]{1,100}$/.test(part) ? part : "redacted").join("/");
}

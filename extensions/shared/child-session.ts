import * as path from "node:path";
import {
  DefaultResourceLoader,
  getAgentDir,
  ProjectTrustStore,
  SettingsManager,
  type AgentSession,
  type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;

/** Tools that headless children must not receive. Everything else stays enabled. */
export const CHILD_EXCLUDED_TOOL_NAMES = [
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
  "workflow",
  "ask_user",
] as const;

/** Fresh SDK options avoid turning the denylist into an accidental allowlist. */
export function childToolPolicy() {
  return { excludeTools: [...CHILD_EXCLUDED_TOOL_NAMES] };
}

export interface ChildResourceOptions {
  cwd: string;
  projectTrusted: boolean;
  appendSystemPrompt?: string[];
  agentDir?: string;
}

/** Load normal global/package resources and trust-gated project resources. */
export async function createChildResources(options: ChildResourceOptions) {
  const agentDir = options.agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir, {
    projectTrusted: options.projectTrusted,
  });
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    ...(options.appendSystemPrompt
      ? { appendSystemPrompt: options.appendSystemPrompt }
      : {}),
  });
  await loader.reload();
  return { loader, settingsManager };
}

/**
 * Same-directory children inherit the live parent decision. An alternate cwd
 * is trusted only when Pi's persisted trust store explicitly trusts it (or a
 * containing directory); unreadable/invalid trust data fails closed.
 */
export function resolveStandaloneChildProjectTrust(options: {
  parentCwd: string;
  childCwd: string;
  parentTrusted: boolean;
  agentDir?: string;
}) {
  if (path.resolve(options.childCwd) === path.resolve(options.parentCwd)) {
    return options.parentTrusted;
  }
  try {
    const trustStore = new ProjectTrustStore(options.agentDir ?? getAgentDir());
    return trustStore.get(options.childCwd) === true;
  } catch {
    return false;
  }
}

/** Start child extension session hooks/resources in headless print mode. */
export async function bindChildSessionExtensions(
  session: Pick<AgentSession, "bindExtensions">,
) {
  await session.bindExtensions({ mode: "print" });
}

interface ChildExtensionRunner {
  hasHandlers(eventType: string): boolean;
  emit(event: SessionShutdownEvent): Promise<unknown>;
}

export interface DisposableChildSession {
  readonly extensionRunner: ChildExtensionRunner;
  abort?(): Promise<unknown>;
  dispose(): void;
}

interface ChildShutdownState {
  deadline: number;
  abortPromise?: Promise<unknown>;
  shutdown: Promise<void>;
}

const childShutdowns = new WeakMap<object, ChildShutdownState>();

function requestChildAbort(
  state: ChildShutdownState,
  session: DisposableChildSession,
) {
  if (state.abortPromise || !session.abort) return;
  try {
    state.abortPromise = Promise.resolve(session.abort()).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    state.abortPromise = Promise.resolve();
  }
}

function waitUntil(operation: Promise<unknown>, deadline: number) {
  const remainingMs = Math.max(0, deadline - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, remainingMs);
  });
  return Promise.race([
    operation.then(
      () => undefined,
      () => undefined,
    ),
    timeout,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Optionally abort, emit child session_shutdown, then dispose under one
 * absolute deadline. Every caller for a session shares the same teardown.
 */
export function shutdownAndDisposeChildSession(
  session: DisposableChildSession,
  options: { abort?: boolean; timeoutMs?: number } = {},
) {
  const existing = childShutdowns.get(session);
  if (existing) {
    if (options.abort) requestChildAbort(existing, session);
    return existing.shutdown;
  }

  const state: ChildShutdownState = {
    deadline: Date.now() + (options.timeoutMs ?? CHILD_SHUTDOWN_TIMEOUT_MS),
    shutdown: Promise.resolve(),
  };
  childShutdowns.set(session, state);
  if (options.abort) requestChildAbort(state, session);
  state.shutdown = Promise.resolve().then(async () => {
    try {
      try {
        if (state.abortPromise) {
          await waitUntil(state.abortPromise, state.deadline);
        }
      } catch {
        // Abort is best-effort; shutdown hooks still receive their chance.
      }
      try {
        if (session.extensionRunner.hasHandlers("session_shutdown")) {
          await waitUntil(
            session.extensionRunner.emit({
              type: "session_shutdown",
              reason: "quit",
            }),
            state.deadline,
          );
        }
      } catch {
        // Extension runner inspection/emission is best-effort during teardown.
      }
      // A cancellation may upgrade teardown while shutdown hooks are running.
      try {
        if (state.abortPromise) {
          await waitUntil(state.abortPromise, state.deadline);
        }
      } catch {
        // Abort remains best-effort.
      }
    } finally {
      try {
        session.dispose();
      } catch {
        // Disposal is terminal and must remain idempotent for callers.
      }
    }
  });

  return state.shutdown;
}

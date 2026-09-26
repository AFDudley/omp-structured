/**
 * `--model pool/<name>`: place this completion on a local server through the
 * omp-router CLI (local_agents/router) before resolving the model.
 *
 * omp-structured never builds an agent session, so omp extensions (where the
 * router normally runs) do not load here. Instead the router's CLI is asked for
 * a lease: it may queue (printing a warning to stderr, which is passed through)
 * and prints the chosen member as one JSON line. The lease is tied to this
 * process id, so it is freed even if the process dies; `release` frees it early.
 */
import { spawn, spawnSync } from "node:child_process";
import { REASONING_EFFORTS, type ReasoningEffort } from "./args.js";

export const ROUTER_POOL_PREFIX = "pool/";
const ROUTER_CLI = process.env.OMP_ROUTER_CLI ?? "omp-router";

export interface RouterLease {
  id: string;
  model: string;
  thinking: ReasoningEffort;
  note: string;
}

export class RouterLeaseError extends Error {}

export async function acquireRouterLease(selector: string): Promise<RouterLease> {
  const child = spawn(ROUTER_CLI, ["acquire", selector, "--pid", String(process.pid), "--label", "omp-structured"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).catch((err: unknown) => {
    throw new RouterLeaseError(`could not run ${ROUTER_CLI} (set OMP_ROUTER_CLI): ${String(err)}`);
  });
  if (code !== 0) throw new RouterLeaseError(`${ROUTER_CLI} acquire ${selector} exited ${code} (reason on stderr above)`);
  const lease: unknown = JSON.parse(stdout.trim());
  if (
    typeof lease !== "object" || lease === null ||
    !("id" in lease) || typeof lease.id !== "string" ||
    !("model" in lease) || typeof lease.model !== "string" ||
    !("thinking" in lease) || !(REASONING_EFFORTS as readonly unknown[]).includes(lease.thinking) ||
    !("note" in lease) || typeof lease.note !== "string"
  ) {
    throw new RouterLeaseError(`${ROUTER_CLI} printed an unexpected lease: ${stdout.trim()}`);
  }
  return lease as RouterLease;
}

export function releaseRouterLease(lease: RouterLease): void {
  spawnSync(ROUTER_CLI, ["release", lease.id], { stdio: "ignore" });
}

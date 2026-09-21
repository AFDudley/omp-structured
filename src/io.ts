import * as fs from "node:fs/promises";

/** Reads the entirety of stdin as UTF-8. Memoized: stdin can only be drained once per process. */
let stdinPromise: Promise<string> | undefined;
function readStdinOnce(): Promise<string> {
  if (!stdinPromise) {
    stdinPromise = (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks).toString("utf-8");
    })();
  }
  return stdinPromise;
}

/**
 * Resolve a `<path|->` CLI argument. `-` (or `undefined`, meaning "no path
 * given at all") reads stdin; anything else is read as a file. Both the
 * `--json-schema -` and the default no-`--prompt` case can legitimately want
 * stdin, but only one of them may actually consume it — the second stdin read
 * observes an already-drained empty stream, which the caller must reject with
 * a clear error rather than silently proceeding on empty input.
 */
export async function readPathOrStdin(pathArg: string | undefined): Promise<string> {
  if (pathArg === undefined || pathArg === "-") return readStdinOnce();
  return fs.readFile(pathArg, "utf-8");
}

export function isStdinRequested(pathArg: string | undefined): boolean {
  return pathArg === undefined || pathArg === "-";
}

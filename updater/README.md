# omp-structured auto-updater

A systemd `--user` timer that keeps this repo's pinned `@oh-my-pi/*` SDK current with
upstream, using the local model (via `omp`) to perform the bump/adaptation and the repo's
own real acceptance suite as the gate. The agent proposes; **acceptance decides**. There is
no fallback path — a red gate means no publish.

## Flow (`run.sh`, one poll cycle)

1. `check.sh` — refresh the maintained checkout to the branch upstream itself declares as
   default (`origin/HEAD`), forcing it there from any prior state (detached HEAD, another
   branch, or a dirty tree), then compare the pinned `@oh-my-pi/pi-ai` version to
   `npm view @oh-my-pi/pi-ai version`.
   - exit `0` up to date · exit `10` update available (prints the new version) · else error.
2. `update.sh <version>` (only when an update exists):
   - task `omp --model vllm/qwen3.8-27b-ablit` to set every `@oh-my-pi/pi-*` pin, `npm install`,
     `npm run build`, adapt `src/*.ts` if the SDK surface moved, and make `scripts/acceptance.sh` pass;
   - **independently** re-run `bash scripts/acceptance.sh` (never trust the agent's self-report);
   - confirm the pin actually moved and there is a diff, then commit and publish.
   - `NO_PUSH=1` runs everything except the final publish (rehearsal).

## Install

```bash
bash updater/install.sh
```

Copies the scripts to `~/.local/share/omp-structured-updater/bin`, installs a systemd `--user`
service + daily timer, and enables it. The maintained checkout lives at
`~/.local/share/omp-structured-updater/checkout`; run logs at `.../logs/`.

Override via env: `OMP_STRUCTURED_UPDATER_MODEL`, `OMP_STRUCTURED_UPDATE_MAX_TIME`,
`OMP_STRUCTURED_UPDATER_STATE`.

## Inspect

```bash
systemctl --user list-timers omp-structured-updater.timer
systemctl --user status  omp-structured-updater.service
journalctl --user -u omp-structured-updater.service
```

Requires `bun`, `omp`, `npm`/`node`, `gh` on PATH and a reachable vLLM backend for the model.

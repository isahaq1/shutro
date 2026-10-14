# Spikes

Throwaway experiments that answer a design question before implementation. They are not packages and are never
published. Each spike has a write-up in [`docs/spikes/`](../docs/spikes/). Its type tests are part of `pnpm typecheck`,
so the conclusions stay true while the code is still in the repo.

| Spike | Question | Result |
| ----- | -------- | ------ |
| [`recordset-types`](recordset-types/) | Can TypeScript afford RFC 0004's nested loaded-shape types? | Yes, full design kept ([write-up](../docs/spikes/0001-recordset-type-cost.md)) |
| [`driver-bench`](driver-bench/) | postgres.js or pg for `@shutro/driver-pg`? | postgres.js ([write-up](../docs/spikes/0002-driver-benchmark.md), RFC 0007) |

Re-run the measurements with:

- `node spikes/recordset-types/run.ts` (add `--fields 80,15 --label wide` for the stress run)
- `pnpm --filter @shutro-spike/driver-bench test` and `node spikes/driver-bench/src/bench.ts` (both need Docker)

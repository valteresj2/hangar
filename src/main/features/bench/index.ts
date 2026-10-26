// Feature "bench" — main process side: the model bench (tasks.ts, run.ts). Runs a fixed suite of coding tasks against
// a provider's models with and without the compat layer and scores what each delivers (docs/COMPAT.md).
import type { Feature } from '../../core/feature'
import { handle } from '../../core/handle'
import { BENCH, type BenchRequest } from '../../../shared/features/bench'
import { gatewayModels, startRun, stopRun, summarize } from './run'
import { listRuns, loadRun } from './store'
import { taskInfo, TASKS } from './tasks'

export const benchFeature: Feature = {
  name: 'bench',
  register() {
    handle(BENCH.tasks, () => TASKS.map(taskInfo))
    handle(BENCH.models, (_e, providerId: string) => gatewayModels(providerId))
    handle(BENCH.run, (_e, request: BenchRequest) => startRun(request))
    handle(BENCH.stop, (_e, runId: string) => stopRun(runId))
    handle(BENCH.list, () => listRuns().map(summarize))
    handle(BENCH.get, (_e, runId: string) => loadRun(runId))
  }
}

import { RunController, WorkflowTerminationError } from "./controller.ts";
import type { WorkflowDetails } from "./model.ts";

export interface ActiveWorkflowRun {
  details: WorkflowDetails;
  controller: RunController;
  completion?: Promise<void>;
}

/** Abort one selected run through its controller and wait for final projection. */
export async function cancelActiveWorkflowRun(
  activeRuns: ReadonlyMap<string, ActiveWorkflowRun>,
  runId: string,
): Promise<WorkflowDetails> {
  const run = activeRuns.get(runId);
  if (!run) throw new Error(`Workflow ${runId} is not active`);

  run.controller.abort(
    new WorkflowTerminationError(
      "manual_abort",
      `Workflow ${runId} cancelled by user`,
      "aborted",
    ),
  );
  await run.controller.settle({ abort: true });
  try {
    await run.completion;
  } catch {
    // The run owns failure projection and persistence; report its final details.
  }
  return run.details;
}

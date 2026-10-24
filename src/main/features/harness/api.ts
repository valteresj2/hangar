// Main-side API of the harness feature, used by the lab feature. Owned by the harness agent.
import type { HarnessSnapshot, HarnessTree, Lesson, ReflectInput, ReflectResult, SnapshotSource } from '../../../shared/harness'

/** Reads the project's harness files (see HARNESS_PATTERNS). */
export async function readHarness(_cwd: string): Promise<HarnessTree> {
  return {}
}

/** Makes `dir` contain exactly `tree` on the harness surface (adds, updates and deletes harness files only). */
export async function writeHarness(_dir: string, _tree: HarnessTree): Promise<void> {}

export async function listSnapshots(_projectCwd: string): Promise<HarnessSnapshot[]> {
  return []
}

export async function createSnapshot(
  _projectCwd: string,
  _label: string,
  _source: SnapshotSource,
  _tree?: HarnessTree,
  _note?: string
): Promise<HarnessSnapshot> {
  throw new Error('harness.createSnapshot not implemented yet')
}

export async function listLessons(_projectCwd: string): Promise<Lesson[]> {
  return []
}

/** Runs the reflector (edit rows + at most one lesson) and stores the result. */
export async function reflect(_input: ReflectInput): Promise<ReflectResult> {
  throw new Error('harness.reflect not implemented yet')
}

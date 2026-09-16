import { destroyQualification, qualificationPurpose } from "./destroy.js";
import { initializeGateway } from "./init.js";
import { smokeGateway } from "./smoke.js";

export async function qualifyGateway(input: {
  workspace: string;
  owner?: string;
  ownerId?: string;
  yes: boolean;
  organization?: string;
  repositoryRoot?: string;
}): Promise<void> {
  if (!input.workspace.startsWith("qual-")) {
    throw new Error("Qualification workspace names must start with qual-");
  }
  let qualificationError: unknown;
  try {
    await initializeGateway({ ...input, qualification: true });
    await smokeGateway(input.workspace);
  } catch (error) {
    qualificationError = error;
  }

  let teardownError: unknown;
  if (await qualificationPurpose(input.workspace)) {
    try {
      await destroyQualification({
        workspace: input.workspace,
        execute: true,
        confirm: input.workspace,
        ...(input.repositoryRoot ? { repositoryRoot: input.repositoryRoot } : {}),
      });
    } catch (error) {
      teardownError = error;
    }
  }

  if (qualificationError && teardownError) {
    throw new AggregateError(
      [qualificationError, teardownError],
      "Gateway qualification and its mandatory teardown both failed; rerun destroy after diagnosis",
    );
  }
  if (qualificationError) throw qualificationError;
  if (teardownError) throw teardownError;
  console.log("\nGateway baseline qualification passed and Cloudflare resources were deleted.");
  console.log("Complete the printed manual GitHub App deletion before considering teardown finished.");
}

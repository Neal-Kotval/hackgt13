import { copyFile } from "node:fs/promises";
import path from "node:path";

// Routes that reach a run-box job import lib/run-box-access.mjs (environment access
// policy). Copy it and its .mjs dependencies next to the transpiled routes.
export async function copyRunBoxAccess(directory) {
  for (const name of ["run-box-access", "run-box-metadata", "run-box-jobs", "aws-organization-approval"])
    await copyFile(new URL(`../lib/${name}.mjs`, import.meta.url), path.join(directory, `${name}.mjs`));
}

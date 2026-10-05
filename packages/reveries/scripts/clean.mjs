import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Remove the previous build output before compiling.
 *
 * `tsc` never deletes a file it no longer emits, so without this step a module
 * removed from `src/` stays in `dist/` and ships in the published package. The
 * lean core deleted host adapters, hook execution, receive enforcement,
 * continuity gating, and projection; none of them may reappear in the artifact.
 */
rmSync(fileURLToPath(new URL("../dist", import.meta.url)), { recursive: true, force: true });

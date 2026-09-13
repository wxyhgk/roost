import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const workspaceRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export const PORT = Number(process.env.PORT ?? 8787);
export const HOST = process.env.HOST ?? "127.0.0.1";

export const dataDir = process.env.ROOST_DATA_DIR || join(homedir(), ".roost");

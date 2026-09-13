import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { openTerminalDaemon } from "@roost/terminal-daemon";
import { createWorkspaceStore } from "@roost/workspace-store";
import { createAttachmentStore } from "./attachments";
import { createCliIconStore } from "./cli-configs";
import { createBackendServer } from "./server";
import { HOST, PORT, dataDir, workspaceRoot } from "./workspace";
import { loadAuthentication } from './auth-config';

export async function startBackend() {
  const auth = await loadAuthentication(dataDir);
  const runtime = await openTerminalDaemon({ dataDir, defaultCwd: homedir(), shell: process.env.SHELL || "/bin/zsh" });
  let store;
  try { store = createWorkspaceStore({ dataDir }); } catch (error) { runtime.dispose(); throw error; }
  let server;
  try { server = createBackendServer({ store, runtime, workspaceRoot, auth, monitorDataDir: dataDir, cliIcons: createCliIconStore(join(dataDir, "cli-icons")), attachments: createAttachmentStore({ directory: join(dataDir, "attachments") }), access: {
    allowedOrigins: process.env.ROOST_ALLOWED_ORIGINS?.split(",").map(value => value.trim()).filter(Boolean),
  } }); } catch (error) { runtime.dispose(); store.close(); throw error; }
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    server.close();
    server.closeAllConnections();
    try { runtime.dispose(); } finally { store.close(); }
  };
  server.once("error", (error) => {
    console.error("backend failed", error);
    process.exitCode = 1;
    stop();
  });
  server.listen(PORT, HOST, () => {
    console.log(`backend http://${HOST}:${(server.address() as {port:number}).port} workspace=${workspaceRoot}`);
  });
  return { server, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { stop } = await startBackend();
  const shutdown = () => {
    try { stop(); } finally { process.exit(0); }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

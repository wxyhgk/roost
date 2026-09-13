import { prepare } from './prepare.mjs';
import { runTauri } from './lib/commands.mjs';
import { parseOptions } from './lib/targets.mjs';

try {
  const [command, ...args] = process.argv.slice(2);
  if (!['build', 'dev'].includes(command)) throw Error('Expected desktop build or dev.');
  const { root, tauri, target } = await prepare(parseOptions(args));
  // Bundles come from Tauri's platform-specific configuration; never force "app" globally.
  runTauri([command, '--target', target.triple], root, tauri);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

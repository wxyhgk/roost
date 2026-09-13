import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { write } from './files.mjs';
import { runTauri } from './commands.mjs';

export async function prepareIcons({ root, desktop, cache, tauri }) {
  // One SVG source supplies ICNS, ICO and PNG. Keep the established preview appearance.
  const logo = await readFile(join(root, 'frontend/public/logos/roost-mark.svg'), 'utf8');
  const mark = logo.replace('<svg ', '<svg x="208" y="208" width="608" height="608" ').replace('fill="currentColor"', 'fill="#111111"');
  const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect x="96" y="96" width="832" height="832" rx="190" fill="#fafafa"/>${mark}</svg>`;
  const iconPath = join(cache, 'app-icon.svg');
  await write(iconPath, icon);
  await write(join(desktop, 'bootstrap/logo.svg'), icon);
  runTauri(['icon', iconPath, '--output', join(tauri, 'icons')], root, tauri);
}

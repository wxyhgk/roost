// Same-origin iframe API. No editor dependency is loaded by the workbench shell.
import type { MoleculeCanvas, MoleculeFormat } from '../../shared/chemistry/editor';

/**
 * **这个编辑器（Ketcher）声明自己能读写的格式。**
 *
 * 换编辑器时这张表跟着实现一起换，调用方不用动：哪些文件归编辑器管、下载用什么 MIME，
 * 都是从这里读出来的，没有第二处写死的扩展名列表。
 *
 * Ketcher 还认 SMILES、InChI、CDXML 等等，这里只列**能当文件原地编辑并存回去**的两种：
 * 加一行不只是加一行，`save()` 要能按这个格式回写，SDF 那样的多记录格式还得想清楚
 * 其余记录怎么保住（见 sdf.ts）。
 */
export const moleculeFormats: readonly MoleculeFormat[] = [
  { id: 'mol', extensions: ['mol'], mediaType: 'chemical/x-mdl-molfile' },
  { id: 'sdf', extensions: ['sdf'], mediaType: 'chemical/x-mdl-sdfile' },
];

export type MoleculeWindow = Window & { moleculeEditor?: MoleculeCanvas };
export const moleculeChannel = 'roost-molecule-editor-v1';

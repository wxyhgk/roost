// Same-origin iframe API. No editor dependency is loaded by the workbench shell.
export type MoleculeFormat = 'mol' | 'sdf';
export type MoleculeBridge = {
  load(content: string, format: MoleculeFormat): Promise<void>;
  /** 按载入格式回写：mol 返回 molfile，sdf 返回单记录 SDF 文本 */
  save(): Promise<string>;
  molfile(): Promise<string>;
  png(content: string): Promise<Blob>;
};
export type MoleculeWindow = Window & { moleculeEditor?: MoleculeBridge };
export const moleculeChannel = 'roost-molecule-editor-v1';

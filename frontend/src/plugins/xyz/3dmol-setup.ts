// 3Dmol's UMD bundle references a global `$3Dmol` during module init
// (e.g. `$3Dmol.workerString = ...`). Under Vite's CJS interop that global
// does not exist, so we seed it before the 3Dmol factory runs.
(globalThis as Record<string, unknown>).$3Dmol ??= {};
export {};

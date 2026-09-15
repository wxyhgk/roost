/* 逐字取自 deepseek-ai/deepseek-harness@0d1f500 packages/client/ui-primitives/src/icons/props.ts —— MIT，Copyright (c) 2026 DeepSeek。改动见 ../NOTICE.md。 */
/** Shared props for every ic_ds_* icon component. */
export interface IconProps {
  /** Square edge in px; defaults to the glyph's own drawn size. */
  size?: number | undefined
  /** Extra class for layout placement; color rides currentColor.
   * (`| undefined` for exactOptionalPropertyTypes: callers forward their own optional prop.) */
  className?: string | undefined
}

export interface ApImported {
  filename: string
  session_id: number | null
  // 1 when the sub was culled: measured, rejected and deleted rather than kept.
  // The row survives only as the night's record of what was thrown away.
  culled: number
}

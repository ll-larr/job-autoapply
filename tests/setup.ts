// node:sqlite is experimental on Node 24 and unconditionally prints an
// ExperimentalWarning the first time it's imported. We deliberately depend on
// it (see src/core/queue.ts and task-5-brief.md — it's the built-in SQLite
// module chosen specifically to avoid native-build dependencies on Windows),
// so the warning is expected noise, not a signal. Test output must stay
// pristine, so we suppress *only* this exact warning and let every other
// warning (including unrelated ExperimentalWarnings) print normally.
const defaultWarningListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  const isExpectedSqliteWarning =
    warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite');
  if (isExpectedSqliteWarning) return;
  for (const listener of defaultWarningListeners) {
    listener(warning);
  }
});

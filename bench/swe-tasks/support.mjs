// Shared shape for the swe task definition modules imported by
// bench/gen-swe-tasks.mjs (which owns writing and validation).
export const def = (difficulty, id, title, prompt, files, buggy, verify, timeoutMs = 240_000) => ({
  id, title, prompt, files, buggy, verify, timeoutMs, difficulty,
});

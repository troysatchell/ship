/**
 * The CLI's only seam onto stdout/stderr. Every command function
 * (`commands/login.ts`, `commands/whoami.ts`) takes an `Io` instead of
 * calling `console.log`/`console.error` directly, for one reason: tests need
 * to assert on exactly what a human running `ship login` would see printed
 * (this ticket's own AC — "prints user_code + verify URL") without stubbing
 * global `console` (which `vi.stubGlobal`/`vi.spyOn` can do, but leaves the
 * assertion coupled to `console`'s own call signature rather than this
 * package's actual output contract).
 */
export interface Io {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

// A CLI's whole job is printing to the terminal, so `console.*` here is the
// intended output mechanism, not a stray debug statement — this repo's
// shared `eslint.config.mjs` ruleset (`correctnessRules`) does not enable
// `no-console` at all, so no disable comment is needed (one was here
// briefly; ESLint reported it as an unused directive, correctly).
export const realIo: Io = {
  stdout: (line) => {
    console.log(line);
  },
  stderr: (line) => {
    console.error(line);
  },
};

/** Test/in-process double: captures every line instead of writing anywhere. */
export function createCapturingIo(): Io & { stdoutLines: string[]; stderrLines: string[] } {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return {
    stdoutLines,
    stderrLines,
    stdout: (line) => {
      stdoutLines.push(line);
    },
    stderr: (line) => {
      stderrLines.push(line);
    },
  };
}

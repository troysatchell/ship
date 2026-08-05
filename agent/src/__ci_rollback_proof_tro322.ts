// TRO-322 (FG-12) — deliberate CI-gate proof. This file exists ONLY to make
// `pnpm type-check` fail on this throwaway branch, as evidence that CI
// blocks a broken build from becoming mergeable (FLEETGRAPH.MD's "Rollback
// trigger and procedure", layer 1: "CI gates merge, not just deploy").
//
// This branch is never merged. See CHANGES.md's TRO-322 entry for the
// captured CI run results on both GitHub Actions and GitLab CI.
const deliberatelyBroken: number = 'this is a string, not a number — TRO-322 rollback proof';
export { deliberatelyBroken };

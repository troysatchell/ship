# Requirements Inventory — W5 (GFA_Week_5_FleetGraph_Updated (1).pdf)

Extracted 2026-08-08 by requirements-audit. Format: `~/.claude/skills/requirements-audit/references/inventory-format.md`.
User edits to this file are authoritative over extraction.

Separate file from `inventory.md` (W4) on purpose: W4 is a frozen baseline with a
published matrix. W5 IDs are `W5-R<n>` and never collide with `W4-R<n>`.

Note (not a requirement): this brief grades a *design* as heavily as an implementation —
"There is no prescribed answer" and "There is no correct answer. There is a defensible one"
appear for the two largest deliverables. Several entries below are therefore `Type: process`
whose acceptance is "a defensible documented decision exists", not a code trace. Expect
interpretation rulings at sweep time on what counts as defended.

## W5-R1
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.1
- **Quote:** "Your implementation must include a chat interface-but it must be embedded in context and scoped to what the user is looking at."
- **Meaning in code:** A chat surface exists inside Ship's document/issue/sprint views and receives the current entity as scope.
- **Type:** functional
- **Acceptance evidence:** file:line of the chat component mounted in a document view, plus the call that passes the current document/issue id as context
- **Status:** active

## W5-R2
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.1
- **Quote:** "A chat window on an issue should know about that issue. A chat window on a sprint should know about that sprint."
- **Meaning in code:** The chat's request payload carries the specific entity being viewed, and the agent's answer is grounded in it.
- **Type:** functional
- **Acceptance evidence:** file:line where entity context is attached to the chat request; an e2e or agent test asserting a grounded response
- **Status:** active

## W5-R3
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.1
- **Quote:** "A standalone chatbot is not a graph agent."
- **Meaning in code:** No standalone chat page exists as the primary interaction; chat is reachable only in context.
- **Type:** functional
- **Acceptance evidence:** absence of a standalone chat route in the router, plus the in-context mount point from W5-R1
- **Status:** active

## W5-R4
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.2
- **Quote:** "FleetGraph operates in two distinct modes. You must implement both."
- **Meaning in code:** Both a proactive (unattended) path and an on-demand (user-invoked) path exist and run.
- **Type:** functional
- **Acceptance evidence:** file:line of both entry points; a test or trace exercising each
- **Status:** active

## W5-R5
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.2
- **Quote:** "The graph runs on its own schedule or in response to Ship events. It monitors project state, detects conditions worth surfacing, and delivers findings to the team without being asked."
- **Meaning in code:** The proactive path runs unattended and delivers a finding to a user-visible surface.
- **Type:** functional
- **Acceptance evidence:** file:line of the scheduler/webhook trigger and the delivery call
- **Status:** active

## W5-R6
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.2
- **Quote:** "Both modes run through the same graph architecture."
- **Meaning in code:** One graph definition serves both triggers; the trigger differs, the graph does not.
- **Type:** functional
- **Acceptance evidence:** file:line showing both entry points invoking the same compiled graph
- **Status:** active

## W5-R7
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.2
- **Quote:** "You must define this."
- **Meaning in code:** FLEETGRAPH.md contains an Agent Responsibility section defining the agent's scope.
- **Type:** process
- **Acceptance evidence:** FLEETGRAPH.md "Agent Responsibility" section present and filled
- **Status:** active

## W5-R8
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.2
- **Quote:** "What does this agent monitor proactively?"
- **Meaning in code:** The Agent Responsibility section answers what is monitored proactively.
- **Type:** process
- **Acceptance evidence:** answered in FLEETGRAPH.md's Agent Responsibility section
- **Status:** active

## W5-R9
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.2
- **Quote:** "What can it do autonomously?"
- **Meaning in code:** The Agent Responsibility section names the actions taken without approval.
- **Type:** process
- **Acceptance evidence:** answered in FLEETGRAPH.md; cross-checks against the human-gate implementation (W5-R17)
- **Status:** active

## W5-R10
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.2
- **Quote:** "What must it always ask a human about before acting?"
- **Meaning in code:** The Agent Responsibility section names the actions that always require confirmation.
- **Type:** process
- **Acceptance evidence:** answered in FLEETGRAPH.md; the named actions are the ones gated in code
- **Status:** active

## W5-R11
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.2
- **Quote:** "How does it know who is on a project and what their role is?"
- **Meaning in code:** The agent resolves project membership and role from Ship data, and the mechanism is documented.
- **Type:** process
- **Acceptance evidence:** answered in FLEETGRAPH.md + file:line of the membership/role lookup
- **Status:** active

## W5-R12
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.2
- **Quote:** "The proactive mode must run without a user present."
- **Meaning in code:** The proactive trigger fires with no session and no browser open.
- **Type:** functional
- **Acceptance evidence:** file:line of the unattended trigger + evidence of a run with no user session
- **Status:** active

## W5-R13
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.2
- **Quote:** "Document your decision and its tradeoffs in FLEETGRAPH.md."
- **Meaning in code:** FLEETGRAPH.md's Trigger Model section states the poll/webhook/hybrid choice and its tradeoffs.
- **Type:** process
- **Acceptance evidence:** FLEETGRAPH.md Trigger Model section with a defended choice
- **Status:** active

## W5-R14
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.3
- **Quote:** "You will submit shared observability trace links as part of every deliverable."
- **Meaning in code:** Trace links are recorded in the submitted deliverable files.
- **Type:** process
- **Acceptance evidence:** trace links present in FLEETGRAPH.md
- **Status:** active

## W5-R15
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.3
- **Quote:** "Traces must demonstrate that the graph produces different execution paths under different conditions. A graph that looks identical across every run is a pipeline, not a graph."
- **Meaning in code:** At least two submitted traces show materially different node paths.
- **Type:** process
- **Acceptance evidence:** two trace links whose paths differ, identified as such in FLEETGRAPH.md
- **Status:** active

## W5-R16
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.3
- **Quote:** "Graph running with at least one proactive detection wired end-to-end"
- **Meaning in code:** One proactive detection runs from trigger through graph to a delivered result.
- **Type:** functional
- **Acceptance evidence:** file:line of the detection path end to end; a passing test or captured live run
- **Status:** active

## W5-R17
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.3
- **Quote:** "LangSmith tracing enabled with at least two shared trace links submitted showing different execution paths"
- **Meaning in code:** Tracing is configured and two differing trace links are submitted.
- **Type:** process
- **Acceptance evidence:** tracing config file:line + two links in FLEETGRAPH.md
- **Status:** active

## W5-R18
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.3
- **Quote:** "FLEETGRAPH.md submitted with Agent Responsibility and Use Cases sections completed-at least 5 use cases defined"
- **Meaning in code:** FLEETGRAPH.md has both sections filled and the Use Cases table has >= 5 rows.
- **Type:** process
- **Acceptance evidence:** count of use-case rows in FLEETGRAPH.md >= 5
- **Status:** active

## W5-R19
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.3
- **Quote:** "Graph outline complete-node types, edges, and branching conditions documented in FLEETGRAPH.md"
- **Meaning in code:** FLEETGRAPH.md documents node types, edges and branch conditions, and matches the built graph.
- **Type:** process
- **Acceptance evidence:** the outline/diagram in FLEETGRAPH.md, cross-checked against the graph definition file:line
- **Status:** active

## W5-R20
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.3
- **Quote:** "At least one human-in-the-loop gate implemented"
- **Meaning in code:** At least one agent action is blocked pending explicit human approval, in code.
- **Type:** functional
- **Acceptance evidence:** file:line of the gate + a test proving the action cannot proceed unapproved
- **Status:** active

## W5-R21
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.3
- **Quote:** "Running against real Ship data-no mocked responses"
- **Meaning in code:** The deployed agent reads a real Ship instance, not fixtures.
- **Type:** functional
- **Acceptance evidence:** deployed agent's Ship API base URL config + a live run against real data
- **Status:** active

## W5-R22
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.3
- **Quote:** "Agent chat and notifications are accessible in the UI"
- **Meaning in code:** Both the chat surface and a notification surface are reachable from Ship's UI.
- **Type:** functional
- **Acceptance evidence:** file:line of both surfaces + verify_urls.app probe or e2e test
- **Status:** active

## W5-R23
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.3
- **Quote:** "Deployed and publicly accessible via Terraform — the deployment must be described in a terraform/ directory with a config that covers the agent service, its environment-specific config (without committing secrets), and /health and /ready endpoints."
- **Meaning in code:** terraform/ declares the agent service with env config and no committed secrets; the service exposes /health and /ready.
- **Type:** functional
- **Acceptance evidence:** the .tf files + file:line of both endpoints + a live GET on each
- **Status:** active

## W5-R24
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.3
- **Quote:** "Run terraform plan before deploying and include the annotated output in your submission."
- **Meaning in code:** A saved, annotated terraform plan output for the agent deployment exists.
- **Type:** process
- **Acceptance evidence:** saved plan artifact with annotations
- **Status:** active

## W5-R25
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.3
- **Quote:** "The destroy-and-redeploy test is required: tear down the environment and re-apply from the Terraform config alone to prove the IaC is the source of truth."
- **Meaning in code:** A documented destroy + re-apply cycle succeeded from Terraform alone.
- **Type:** functional
- **Acceptance evidence:** captured destroy/apply output plus a post-apply health check
- **Status:** active

## W5-R26
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.3
- **Quote:** "Trigger model decision documented and defended in FLEETGRAPH.md"
- **Meaning in code:** FLEETGRAPH.md's Trigger Model section is present and argued, not merely stated.
- **Type:** process
- **Acceptance evidence:** the section, containing a tradeoff argument
- **Status:** active

## W5-R27
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.3
- **Quote:** "< 5 minutes from event appearing in Ship to agent surfacing it"
- **Meaning in code:** Measured latency from event creation to agent surfacing is under 5 minutes.
- **Type:** non-functional
- **Acceptance evidence:** a timed run recording both timestamps and the delta
- **Status:** active

## W5-R28
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.3
- **Quote:** "Detection latency will be verified with a timed test run. An event will be introduced into Ship and the clock starts. The agent must surface it within the window."
- **Meaning in code:** The timed test is reproducible by a grader, not only by us.
- **Type:** process
- **Acceptance evidence:** documented procedure a third party can run, plus a recorded result
- **Status:** active

## W5-R29
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.3
- **Quote:** "Cost per graph run"
- **Meaning in code:** A measured (not projected) cost per graph run is documented in FLEETGRAPH.md.
- **Type:** process
- **Acceptance evidence:** the figure in FLEETGRAPH.md plus what measured it
- **Status:** active

## W5-R30
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.3
- **Quote:** "Estimated runs per day"
- **Meaning in code:** An estimated runs-per-day figure is documented and defended in FLEETGRAPH.md.
- **Type:** process
- **Acceptance evidence:** the figure plus its stated assumptions
- **Status:** active

## W5-R31
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Quote:** "You define your own test cases. For each use case in your use case document, provide:"
- **Meaning in code:** Every use case has a corresponding test case entry.
- **Type:** process
- **Acceptance evidence:** test-case count matches use-case count in FLEETGRAPH.md
- **Status:** active

## W5-R32
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Quote:** "The Ship state that should trigger the agent"
- **Meaning in code:** Each test case names the concrete Ship state that triggers it.
- **Type:** process
- **Acceptance evidence:** the Ship State column filled for every row
- **Status:** active

## W5-R33
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Quote:** "The LangSmith trace from a run against that state"
- **Meaning in code:** Each test case carries a trace link from a real run against its state.
- **Type:** process
- **Acceptance evidence:** the Trace Link column filled for every row
- **Status:** active

## W5-R34
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Quote:** "Document all test cases and trace links in FLEETGRAPH.md."
- **Meaning in code:** The test-case table lives in FLEETGRAPH.md, not elsewhere.
- **Type:** process
- **Acceptance evidence:** the table present in FLEETGRAPH.md
- **Status:** active

## W5-R35
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Quote:** "Every agent behaviour defined in your use cases must have a corresponding regression test."
- **Meaning in code:** Each use case maps to a named regression test that the CI suite runs.
- **Type:** functional
- **Acceptance evidence:** use case -> test file:line mapping; the tests run in a suite CI executes
- **Status:** active

## W5-R36
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Quote:** "If a CI run fails, the deployment must be rolled back automatically — do not allow a failing build to remain deployed."
- **Meaning in code:** CI failure triggers an automatic rollback of the deployed agent.
- **Type:** functional
- **Acceptance evidence:** workflow file:line implementing the rollback + evidence it fired or was exercised
- **Status:** active

## W5-R37
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Quote:** "Document the rollback trigger and procedure in FLEETGRAPH.md."
- **Meaning in code:** FLEETGRAPH.md states what triggers rollback and the procedure.
- **Type:** process
- **Acceptance evidence:** the section in FLEETGRAPH.md
- **Status:** active

## W5-R38
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Quote:** "Write E2E tests covering both the proactive and on-demand modes."
- **Meaning in code:** E2E specs exist for both modes.
- **Type:** functional
- **Acceptance evidence:** both spec file:lines
- **Status:** active

## W5-R39
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Quote:** "an event is introduced into Ship and the agent surfaces it within the detection latency window"
- **Meaning in code:** An E2E test introduces an event and asserts the agent surfaces it inside the window.
- **Type:** functional
- **Acceptance evidence:** the spec file:line with the latency assertion
- **Status:** active

## W5-R40
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Quote:** "a user invokes the agent from a context-aware chat interface and receives a grounded response"
- **Meaning in code:** An E2E test drives the in-context chat and asserts the answer is grounded in the viewed entity.
- **Type:** functional
- **Acceptance evidence:** the spec file:line with the grounding assertion
- **Status:** active

## W5-R41
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Quote:** "Both tests must run in CI."
- **Meaning in code:** Both E2E specs execute in a CI job, not merely exist.
- **Type:** functional
- **Acceptance evidence:** workflow file:line invoking the suite that contains them
- **Status:** active

## W5-R42
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Quote:** "Tests that call Ship APIs or LLM providers must use stable fakes or recorded fixtures — not live services — so they pass consistently in CI regardless of network state or API availability."
- **Meaning in code:** No test performs a live Ship or LLM call; all use fakes or recorded fixtures.
- **Type:** functional
- **Acceptance evidence:** file:line of the fake/fixture layer; absence of live calls in the test suite
- **Status:** active

## W5-R43
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Quote:** "All outbound calls from the agent (to Ship APIs, LLM providers, and any external tools) must implement explicit timeouts and retry logic with exponential backoff."
- **Meaning in code:** Every outbound call path sets a timeout and retries with exponential backoff.
- **Type:** functional
- **Acceptance evidence:** file:line of the timeout and backoff implementation on each outbound client
- **Status:** active

## W5-R44
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Quote:** "The agent must degrade gracefully if Ship is unreachable — it should not crash or hang indefinitely."
- **Meaning in code:** With Ship unreachable the agent returns/degrades rather than crashing or hanging.
- **Type:** functional
- **Acceptance evidence:** a test that makes Ship unreachable and asserts bounded, non-crashing behaviour
- **Status:** active

## W5-R45
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Quote:** "Document the retry strategy and fallback behaviour in FLEETGRAPH.md, and demonstrate graceful degradation in your Architecture Defense."
- **Meaning in code:** FLEETGRAPH.md documents retry/fallback; the Architecture Defense demonstrated degradation.
- **Type:** process
- **Acceptance evidence:** the FLEETGRAPH.md section + a record of the defense demonstration
- **Status:** active

## W5-R46
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.4
- **Quote:** "Maintain a CHANGES.md at the repo root documenting every significant addition: what was built, how to run and test it locally, and how to roll it back if it fails."
- **Meaning in code:** CHANGES.md at repo root has an entry per significant addition with run/test/rollback.
- **Type:** functional
- **Acceptance evidence:** CHANGES.md entries carrying all three elements
- **Status:** active

## W5-R47
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.5
- **Quote:** "Claude API costs (input and output token breakdown)"
- **Meaning in code:** Actual Claude spend is reported split by input and output tokens.
- **Type:** process
- **Acceptance evidence:** the breakdown in the Cost Analysis section
- **Status:** active

## W5-R48
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.5
- **Quote:** "Number of graph agent invocations during development"
- **Meaning in code:** A measured invocation count is reported.
- **Type:** process
- **Acceptance evidence:** the figure plus what counted it
- **Status:** active

## W5-R49
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.5
- **Quote:** "Total development spend"
- **Meaning in code:** Total development spend is reported.
- **Type:** process
- **Acceptance evidence:** the figure in the Cost Analysis section
- **Status:** active

## W5-R50
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.5
- **Quote:** "Estimate monthly costs at scale:"
- **Meaning in code:** Monthly cost projections are given for 100 / 1,000 / 10,000 users.
- **Type:** process
- **Acceptance evidence:** all three figures filled in the Cost Analysis table
- **Status:** active

## W5-R51
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.5
- **Quote:** "PRESEARCH.md"
- **Meaning in code:** PRESEARCH.md exists at the repo root with the pre-search checklist completed.
- **Type:** process
- **Acceptance evidence:** the file, with all nine PRESEARCH sections answered
- **Status:** active

## W5-R52
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.5
- **Quote:** "FLEETGRAPH.md must contain the following completed sections at final submission:"
- **Meaning in code:** All seven named sections exist and are filled in FLEETGRAPH.md.
- **Type:** process
- **Acceptance evidence:** Agent Responsibility, Graph Diagram, Use Cases, Trigger Model, Test Cases, Architecture Decisions, Cost Analysis all present and non-empty
- **Status:** active

## W5-R53
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.9
- **Quote:** "Provide a visual map of your graph covering both proactive and on-demand modes. Include all"
- **Meaning in code:** FLEETGRAPH.md carries a graph diagram covering both modes with all nodes, edges and conditional branches.
- **Type:** process
- **Acceptance evidence:** the diagram (LangGraph Studio screenshot or Mermaid block), matching the built graph
- **Status:** active

## W5-R54
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.10
- **Quote:** "Document your key architecture decisions and the tradeoffs you considered. Cover: framework"
- **Meaning in code:** FLEETGRAPH.md's Architecture Decisions section covers framework choice, node design, state management and deployment model.
- **Type:** process
- **Acceptance evidence:** all four topics addressed in that section
- **Status:** active

## W5-R55
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.6
- **Quote:** "LangGraph is recommended; any other framework requires manual LangSmith instrumentation"
- **Meaning in code:** Either LangGraph is used, or equivalent manual instrumentation exists.
- **Type:** functional
- **Acceptance evidence:** the graph framework import file:line, or the manual instrumentation
- **Status:** active

## W5-R56
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.6
- **Quote:** "Observability with traces required from day one"
- **Meaning in code:** Tracing is wired into the agent's runtime path, not added only for submission.
- **Type:** functional
- **Acceptance evidence:** tracing initialisation file:line on the live agent path
- **Status:** active

## W5-R57
- **Source:** GFA_Week_5_FleetGraph_Updated (1).pdf, p.6
- **Quote:** "Chat interface must be embedded in context-no standalone chatbot pages"
- **Meaning in code:** Restates W5-R1/W5-R3 as a hard constraint: no standalone chatbot route exists.
- **Type:** functional
- **Acceptance evidence:** router inspection showing no standalone chat page
- **Status:** active

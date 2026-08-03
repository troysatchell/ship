# Software Factory — reference model
Agent-assisted delivery pipeline, intake to operate · example/software-factory @ reference · profile: process

14 stages · 24 connections · 4 loops · 4 open questions

## Stages

### Intake
- **Demand** [external] — Customers, support, roadmap · fan-in 0, fan-out 1, instability 1.0
  Everything that wants engineering time. Not modelled in detail — it is the boundary of the factory, drawn so the entry point is not implicit.
- **Backlog** [intake] — Issue tracker · fan-in 2, fan-out 1, instability 0.33 · emits: ticket
  The single queue. If work enters the factory anywhere else, that path is invisible to this diagram and should be added.
- **Triage & shaping** [gate] — Human + agent pass · fan-in 1, fan-out 1, instability 0.5 · emits: shaped-spec · consumes: ticket
  Decides whether a ticket is well-formed enough to enter Build. The first place ambiguity can be caught cheaply.

### Build
- **Plan synthesis** [transform] — Agent writes the plan · fan-in 2, fan-out 1, instability 0.33 · emits: plan · consumes: shaped-spec
- **Plan review** [gate] — Human approves scope · fan-in 1, fan-out 2, instability 0.67 · emits: approved-plan · consumes: plan
- **Implementation** [transform] — Agent fleet, one ticket each · fan-in 3, fan-out 1, instability 0.25 · emits: changeset · consumes: approved-plan
  Recursive by design — an agent that cannot make a test pass re-enters implementation with the failure as new context.
- **Repository** [store] — git, branch per ticket · fan-in 1, fan-out 1, instability 0.5 · consumes: changeset

### Verify
- **CI suite** [gate] — unit + integration · fan-in 1, fan-out 2, instability 0.67 · emits: test-report
- **Code review** [gate] — Human, blocking · fan-in 1, fan-out 2, instability 0.67
- **Staging soak** [transform] — 30 min bake · fan-in 1, fan-out 1, instability 0.5

### Release & operate
- **Deploy** [control] — Progressive rollout · fan-in 1, fan-out 1, instability 0.5
- **Production** [release] — Serving traffic · fan-in 1, fan-out 1, instability 0.5
- **Telemetry** [store] — Metrics, traces, logs · fan-in 1, fan-out 1, instability 0.5 · emits: signal
- **Incident response** [transform] — On-call rotation · fan-in 1, fan-out 1, instability 0.5 · consumes: signal
  The failure path for the whole factory. Everything that goes wrong downstream of deploy arrives here.

## Connections
- Demand → Backlog (requests)
- Backlog → Triage & shaping (ticket)
- Triage & shaping → Plan synthesis (shaped spec)
- Plan synthesis → Plan review (plan)
- Plan review → Implementation (approved)
- Implementation → Repository (branch push)
- Repository → CI suite
- CI suite → Code review (green)
- Code review → Staging soak (approved)
- Staging soak → Deploy
- Deploy → Production
- Production → Telemetry (data, emits signal)
- Telemetry → Incident response (control, alert fires)
- CI suite → Implementation (feedback, tests failed, polarity -, loop B1)
- Code review → Implementation (feedback, changes requested, polarity -, loop B2)
- Incident response → Backlog (feedback, remediation work, polarity +, loop R1)
- Plan review → Plan synthesis (feedback, rescope, polarity -, loop B3)
- MISSING LINK (modelled absence): Telemetry → Triage & shaping (gap, no signal reaches shaping)
  Nobody feeds production behaviour back into how work is shaped. Every ticket is written as if the last release never happened.
- Plan review → Implementation (data, approved-plan)
- Implementation → Repository (data, changeset)
- Plan synthesis → Plan review (data, plan)
- Triage & shaping → Plan synthesis (data, shaped-spec)
- Telemetry → Incident response (data, signal)
- Backlog → Triage & shaping (data, ticket)

## Loops
- **B1** (balancing): Implementation → Repository → CI suite
- **B2** (balancing): Implementation → Repository → CI suite → Code review
- **B3** (balancing): Plan synthesis → Plan review
- **R1** (reinforcing): Backlog → Triage & shaping → Plan synthesis → Plan review → Implementation → Repository → CI suite → Code review → Staging soak → Deploy → Production → Telemetry → Incident response

## Open questions (analyzer findings)
- [high] **“Triage & shaping” is a gate with no reject path**
  A gate that has no way to send work back is not a gate, it is a waypoint. Either it always passes (delete it, or stop counting it as quality control) or the reject path exists in practice and is missing from the model.
- [high] **Code review is the only unbatched human gate**
  Every change waits on one blocking human step with no parallel lane and no timeout. Throughput of the whole factory equals throughput of this one node.
- [medium] **3 stage(s) model only the happy path**
  Every outgoing edge from these stages is a success edge: Plan synthesis, Implementation, Staging soak. What happens when each of them fails? Unmodelled failure paths are where real factories silently drop work.
- [medium] **Nothing consumes “test-report”**
  “test-report” is produced but never read. Either it is a genuine external deliverable, or a downstream stage was removed and the producer was left running.

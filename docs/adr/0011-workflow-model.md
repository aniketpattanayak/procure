# ADR-0011 Workflow model: ordered stages, parallel groups, per-line quantity flow

Status: accepted (Phase 3)

A workflow is an ordered list of stages, not a free graph. Branching is expressed by per-stage `when` conditions
(skipped when false), parallelism by consecutive stages sharing `parallelGroup` (join = all), loops by `send_back`
and the `route_to` effect. This covers the brief's cases (amount/location/category routing, optional stages,
parallel sign-off, QA reject → store disposition) with a designer non-technical admins can use, and keeps the
runtime analysable (simulation, SLA per stage). Quantity flows per line through `wf_line_state` so one line can be
partly approved (moved on), partly held (stays) and partly rejected (leaves) in a single decision. Authorisation is
evaluated at action time (permission + scope + actor rules), so permission changes apply immediately; `wf_assignment`
only adds people (forward, escalation). Definitions are versioned; instances finish on their version.

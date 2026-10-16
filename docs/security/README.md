# Security work by phase

The current review is in [the threat model](../threat-model.md). P1 implements admission/isolation and [secret handling](secrets.md); P2 owns peer identity/transport, P3/P4 integrity/committed progress, P5 resume identity and P8 adversarial hardening. A parsed envelope or available API never implies authorization or durability.

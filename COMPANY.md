---
schema: agentcompanies/v1
kind: company
name: Ai Company Core
slug: ai-company-core
description: AI-run company staffed by Claude "employees," orchestrated with Paperclip and powered by a Claude Max plan subscription.
version: 0.1.0
license: MIT
goals:
  - Stand up a small, working AI org chart before scaling headcount
  - Keep every agent's output reviewable and reversible until trust is earned
  - Stay within a single Claude Max plan's shared usage limits
requirements:
  secrets: []
---

# Ai Company Core

This is the company definition for an AI-employee org running on
[Paperclip](https://github.com/paperclipai/paperclip), staffed by agents
that authenticate through a Claude Max plan subscription login rather than
a metered API key.

Rename `name`/`slug` above and edit the `goals` list to match your actual
company before importing.

See `README.md` for how to stand this up.

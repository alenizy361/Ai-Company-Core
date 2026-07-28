---
schema: agentcompanies/v1
kind: task
name: Weekly Review
assignee: ceo
recurring: true
---

# Weekly Review

Every week:

1. Summarize what each report shipped, what's blocked, and why.
2. Check actual usage against the shared Claude Max plan quota (session
   and weekly windows) in the Paperclip dashboard — if the org is running
   close to the weekly limit, scale back task cadence rather than letting
   agents get auto-paused mid-task.
3. Propose next week's priorities for the human board operator to approve.

Schedule for this task lives in `.paperclip.yaml` under `routines.weekly-review`.

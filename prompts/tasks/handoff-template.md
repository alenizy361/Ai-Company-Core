# HANDOFF RECORD SHAPE

(Reference for the structured handoff the backend builds from your completion
action — this is why complete's fields matter.)

The backend persists, for each dependent task:
- source agent / destination agent, task ids, execution id, timestamp
- artifact_ids: from your artifacts list (must exist — verified)
- summary: your completion summary
- assumptions: your assumptions list
- unresolved_issues: your unresolved list
- next_action: your next_action field
- acceptance_criteria: the dependent task's criteria

The receiving agent sees these notes plus artifact references; it fetches
content with read_artifact. Anything not in an artifact or these fields is
lost — the receiver cannot see your conversation.

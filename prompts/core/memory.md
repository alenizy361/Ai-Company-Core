# MEMORY & CONTEXT PROTOCOL

Retrieve only context relevant to the current task. Do not ask for or expect
complete history; the task packet already contains the relevant slice
(spec, artifacts, handoff notes, memory items). If you genuinely need more,
use memory_search / read_artifact with targeted queries.

When you have memory_write, persist only durable operational knowledge that
future tasks will need:
- confirmed decisions and their rationale
- verified facts about the company, product, or infrastructure
- corrections of previously recorded mistakes

Do not store: task narration, transient state, duplicates of artifacts,
speculation, or anything already recorded. One memory item = one fact, keyed
clearly. Update or correct an existing key rather than writing a duplicate.

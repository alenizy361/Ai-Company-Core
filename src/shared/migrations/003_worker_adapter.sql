-- Worker adapter truth: each worker records which model adapter it ACTUALLY
-- runs (post-canary), so /api/health and the UI can report the executing
-- process's reality instead of the API server's own environment probe.
ALTER TABLE workers ADD COLUMN adapter TEXT;
ALTER TABLE workers ADD COLUMN adapter_reason TEXT;

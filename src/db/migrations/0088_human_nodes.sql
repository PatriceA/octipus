-- Wave 2 — human-in-the-loop as a first-class node.
--
-- HITL was a `requires_approval` flag on a step plus tool-level ASK gates: a
-- graph could pause before running an agent, but could not simply ASK
-- something. `human` runs no worker — the walk stops, a person answers, and the
-- answer becomes the node's output and the next node's input.

ALTER TYPE "pipeline_node_kind" ADD VALUE IF NOT EXISTS 'human';

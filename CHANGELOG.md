# Changelog

## Unreleased

### Fixed

- Make on-demand history synchronization read OpenCode's persisted event log and exactly reconcile only affected sessions. This removes repeated full `part` table scans while preserving updates and deletions, with a one-time full reconciliation for existing sidecars and custom databases without an event log.

# yaml-flow 8.0.1

Patch release for the new public ExecutionRef invocation surface on the Node adapter.

## Highlights

- Added public board-live-cards-node exports for generic ExecutionRef invocation.
- Added evaluateArgsMassaging so downstream callers can reuse yaml-flow's argsMassaging evaluation.
- Added createExecutionRefInvoker with transport injection for custom howToRun handlers.
- Preserved the existing invokeRefSync contract for current step-machine callers.

## Built-in transport coverage

- local-node
- local-python
- local-process
- http:post
- http:get
- built-in via cliDir-backed resolution

## Validation

- Added focused tests covering sync local invocation, async HTTP invocation, argsMassaging evaluation, and custom transport registration.
- Verified lib build emits the new board-live-cards-node exports.
# Examples Catalog (Executable Only)

This file is split into two sections:

1. Runners and how to execute examples.
2. Executable example catalog.

Browser view: open `examples/index.html`.

## Runners (How To Run)

| Runner | Quick usage | Use when | Notes |
|---|---|---|---|
| TypeScript example runner (`tsx`) | `npx tsx <example-file.ts>` | Running most TS examples under `examples/` | Recommended default for `.ts` example files |
| Node script runner | `node <example-file.js>` | Running JS examples and wrappers | Used by portfolio tracker + scenario runner |
| Board live-cards CLI (repo wrapper) | `node board-live-cards-cli.js <command>` or `board-live-cards-cli <command>` | Interacting with board runtime directly | Wrapper resolves dist/src CLI automatically |
| Windows portfolio launcher | `examples\\board-live-cards\\portfolio-tracker\\portfolio-tracker.bat` | Quick run on Windows shell | Calls the Node portfolio tracker script |
| `step-machine-cli.js` (root CLI) | `node step-machine-cli.js <flow.yaml> [--handlers <handlers.js>] [--data <json>]` | Running step-machine YAML flows from the command line | Supports inline/CLI handlers, JSONata transforms, handler_vars, command templating |
| Step-machine scenario harness | `node examples/step-machine-cli/scenario-harness/run-scenario.js <scenario.json>` | Running reusable step-machine scenarios with shared flow + input + overrides | Supports multiple synthetic scenarios without duplicating orchestration logic |

## Executable Examples

| Example | Quick usage | Demonstrates | yaml-flow functionality used |
|---|---|---|---|
| `examples/node/simple-greeting.ts` | `npx tsx examples/node/simple-greeting.ts` | Basic step-machine flow with file persistence and handlers | `createEngine` (step-machine alias), `loadFlow`, `FileStore` |
| `examples/node/ai-conversation.ts` | `npx tsx examples/node/ai-conversation.ts` | AI conversation flow with retry/circuit-breaker style transitions | `createEngine`, `loadFlow`, `MemoryStore` |
| `examples/inference/pluggable-adapters.ts` | `npx tsx examples/inference/pluggable-adapters.ts` | Swappable LLM adapters for inference-based completion detection | `createLiveGraph`, `schedule`, `buildInferencePrompt`, `inferCompletions`, `applyInferences`, `createCliAdapter`, `createHttpAdapter` |
| `examples/inference/data-pipeline.ts` | `npx tsx examples/inference/data-pipeline.ts` | Iterative evidence accumulation and repeated inference rounds | `createLiveGraph`, `injectTokens`, `schedule`, `inferAndApply` |
| `examples/inference/copilot-cli.ts` | `npx tsx examples/inference/copilot-cli.ts` | Using Copilot CLI as inference backend | `createLiveGraph`, `schedule`, `buildInferencePrompt`, `inferCompletions`, `applyInferences`, `createCliAdapter` |
| `examples/inference/azure-deployment.ts` | `npx tsx examples/inference/azure-deployment.ts` | Deployment checkpoints inferred from logs | `createLiveGraph`, `schedule`, `buildInferencePrompt`, `inferAndApply` |
| `examples/event-graph/research-pipeline.ts` | `npx tsx examples/event-graph/research-pipeline.ts` | Manual event-graph driver loop with fan-out/fan-in | `next`, `apply`, `createInitialExecutionState` |
| `examples/event-graph/executor-pipeline.ts` | `npx tsx examples/event-graph/executor-pipeline.ts` | Library-mode execution loop and validation | `next`, `apply`, `createInitialExecutionState`, `validateGraph`, `validateLiveGraph` |
| `examples/event-graph/executor-diamond.ts` | `npx tsx examples/event-graph/executor-diamond.ts` | Diamond DAG execution with parallel branches | `next`, `apply`, `createInitialExecutionState` |
| `examples/event-graph/ci-cd-pipeline.ts` | `npx tsx examples/event-graph/ci-cd-pipeline.ts` | Approval gates, retries, failure routing in DAG | `next`, `apply`, `createInitialExecutionState` |
| `examples/continuous-event-graph/reactive-pipeline.ts` | `npx tsx examples/continuous-event-graph/reactive-pipeline.ts` | Self-driving reactive graph pipeline | `createReactiveGraph`, `createCallbackHandler`, `validateLiveGraph`, `validateReactiveGraph` |
| `examples/continuous-event-graph/reactive-monitoring.ts` | `npx tsx examples/continuous-event-graph/reactive-monitoring.ts` | Continuous monitoring graph with runtime behavior changes | `createReactiveGraph`, `MemoryJournal`, `createCallbackHandler`, `createFireAndForgetHandler`, `validateReactiveGraph` |
| `examples/continuous-event-graph/stock-dashboard.ts` | `npx tsx examples/continuous-event-graph/stock-dashboard.ts` | Dynamic graph mutation, snapshots, lineage queries | `createLiveGraph`, `applyEvent`, `injectTokens`, `drainTokens`, `schedule`, `inspect`, `mutateGraph`, `snapshot`, `restore`, `getUpstream`, `getDownstream` |
| `examples/continuous-event-graph/soc-incident-board.ts` | `npx tsx examples/continuous-event-graph/soc-incident-board.ts` | External-source + side-effect handler model for SOC workflows | `createReactiveGraph`, `createCallbackHandler`, `createFireAndForgetHandler`, `validateReactiveGraph` |
| `examples/continuous-event-graph/portfolio-tracker.ts` | `npx tsx examples/continuous-event-graph/portfolio-tracker.ts` | Portfolio workflow with external pushes and retrigger | `createReactiveGraph`, `createCallbackHandler`, `validateReactiveGraph` |
| `examples/continuous-event-graph/live-cards-board.ts` | `npx tsx examples/continuous-event-graph/live-cards-board.ts` | Live-card definitions bridged into reactive graph | `liveCardsToReactiveGraph`, `validateReactiveGraph` |
| `examples/continuous-event-graph/live-portfolio-dashboard.ts` | `npx tsx examples/continuous-event-graph/live-portfolio-dashboard.ts` | Large live-card portfolio board with dynamic card lifecycle | `liveCardsToReactiveGraph`, reactive task handlers |
| `examples/graph-of-graphs/url-processing-pipeline.ts` | `npx tsx examples/graph-of-graphs/url-processing-pipeline.ts` | Outer DAG orchestrating batched inner DAGs | `next`, `apply`, `createInitialExecutionState`, `batch`, `resolveVariables`, `resolveConfigTemplates` |
| `examples/graph-of-graphs/multi-stage-etl.ts` | `npx tsx examples/graph-of-graphs/multi-stage-etl.ts` | Mixed event-graph + step-machine nested orchestration | `next`, `apply`, `createInitialExecutionState`, `createStepMachine`, `batch`, `resolveVariables`, `resolveConfigTemplates` |
| `examples/batch/batch-step-machine.ts` | `npx tsx examples/batch/batch-step-machine.ts` | Batch processing with per-item step-machine flow | `batch`, `createStepMachine` |
| `examples/board-live-cards/portfolio-tracker/portfolio-tracker.js` | `node examples/board-live-cards/portfolio-tracker/portfolio-tracker.js` | End-to-end board-live-cards portfolio demo | board-live-cards CLI runtime orchestration |
| `examples/step-machine-cli/portfolio-tracker/run-portfolio-tracker.bat` | `run-portfolio-tracker.bat` (from example folder) | Portfolio tracker orchestrated by step-machine YAML with JSONata transforms, handler_vars, failure_transitions | `step-machine-cli`, `board-live-cards-cli`, JSONata, `failure_transitions` |
| `examples/step-machine-cli/scenario-harness/scenarios/portfolio-baseline.json` | `node examples/step-machine-cli/scenario-harness/run-scenario.js examples/step-machine-cli/scenario-harness/scenarios/portfolio-baseline.json` | Baseline reusable scenario using shared portfolio-tracker flow | step-machine scenario harness, input override framework |
| `examples/step-machine-cli/scenario-harness/scenarios/portfolio-price-shock.json` | `node examples/step-machine-cli/scenario-harness/run-scenario.js examples/step-machine-cli/scenario-harness/scenarios/portfolio-price-shock.json` | Price-shock synthetic scenario using same orchestration flow | step-machine scenario harness, synthetic scenario variations |

## Notes

| Item | Value |
|---|---|
| Recommended runner for TS examples | `npx tsx <file>` |
| Recommended runner for scenarios | `node examples/step-machine-cli/scenario-harness/run-scenario.js <scenario.json>` |
| CLI docs | `docs/board-live-cards-cli.html` |
| Step-machine docs | `docs/step-machine-cli.html` |

/**
 * Node.js Example: Simple Greeting Flow
 * 
 * Demonstrates basic usage with file-based persistence.
 * 
 * Run with: npx ts-node examples/node/simple-greeting.ts
 * Or after build: node examples/node/simple-greeting.js
 */

import { createEngine, loadFlow, FileStore } from '../../src/index.js';
import type { StepInput, StepContext, StepResult } from '../../src/index.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Define step handlers as pure functions
const handlers = {
  async greet(input: StepInput, ctx: StepContext): Promise<StepResult> {
    const userName = (input.initial_name as string) || 'World';
    
    console.log(`[${ctx.stepName}] Generating greeting for: ${userName}`);
    
    return {
      result: 'success',
      data: {
        greeting: 'Hello',
        user_name: userName,
      },
    };
  },

  async validate(input: StepInput, ctx: StepContext): Promise<StepResult> {
    const { greeting, user_name } = input;
    
    console.log(`[${ctx.stepName}] Validating: ${greeting} ${user_name}`);
    
    const isValid = typeof greeting === 'string' && 
                    greeting.length > 0 && 
                    typeof user_name === 'string';
    
    if (!isValid) {
      return { result: 'invalid', data: { is_valid: false } };
    }
    
    return {
      result: 'success',
      data: { is_valid: true },
    };
  },

  async personalize(input: StepInput, ctx: StepContext): Promise<StepResult> {
    const { greeting, user_name } = input;
    
    const finalMessage = `${greeting}, ${user_name}! Welcome to yaml-flow.`;
    
    console.log(`[${ctx.stepName}] Created message: ${finalMessage}`);
    
    return {
      result: 'success',
      data: { final_message: finalMessage },
    };
  },
};

async function main() {
  // Load flow from YAML file
  const flowPath = join(__dirname, '../flows/simple-greeting.yaml');
  const flow = await loadFlow(flowPath);
  
  console.log('Loaded flow:', flow.id ?? 'simple-greeting');
  console.log('Steps:', Object.keys(flow.steps).join(', '));
  console.log('---');

  // Create engine with file-based persistence
  const engine = createEngine(flow, handlers, {
    store: new FileStore({ directory: './flow-data' }),
    onStep: (step, result) => {
      console.log(`Step completed: ${step} -> ${result.result}`);
    },
    onTransition: (from, to) => {
      console.log(`Transition: ${from} -> ${to}`);
    },
  });

  // Run the flow
  const result = await engine.run({
    initial_name: 'Developer',
  });

  console.log('---');
  console.log('Flow Result:');
  console.log('  Status:', result.status);
  console.log('  Intent:', result.intent);
  console.log('  Data:', result.data);
  console.log('  Steps:', result.stepHistory.join(' -> '));
  console.log('  Duration:', result.durationMs, 'ms');
}

main().catch(console.error);

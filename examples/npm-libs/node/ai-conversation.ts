/**
 * Node.js Example: AI Conversation with External API
 * 
 * Demonstrates a more complex flow with:
 * - Component injection (AI client)
 * - Retry logic
 * - Circuit breakers
 * - Event handling
 * 
 * Run with: npx ts-node examples/npm-libs/node/ai-conversation.ts
 */

import { createEngine, loadFlow, MemoryStore } from '../../src/index.js';
import type { StepInput, StepContext, StepResult } from '../../src/index.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Simulated AI client (replace with actual OpenAI/Anthropic client)
const mockAIClient = {
  async generateResponse(prompt: string, history: string[]): Promise<{ text: string; confidence: number }> {
    // Simulate API latency
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Simulate occasional low confidence
    const confidence = Math.random() > 0.3 ? 0.85 : 0.4;
    
    return {
      text: `AI Response to: "${prompt}" (simulated)`,
      confidence,
    };
  },
};

// Define step handlers
const handlers = {
  async generate_response(input: StepInput, ctx: StepContext): Promise<StepResult> {
    const userMessage = input.user_message as string;
    const history = (input.conversation_history as string[]) || [];
    
    // Access injected AI client from components
    const ai = ctx.components.aiClient as typeof mockAIClient;
    
    console.log(`[generate] Processing: "${userMessage}"`);
    
    try {
      const response = await ai.generateResponse(userMessage, history);
      
      return {
        result: 'success',
        data: {
          ai_response: response.text,
          confidence_score: response.confidence,
        },
      };
    } catch (error) {
      console.log('[generate] API call failed, will retry...');
      return { result: 'failure' };
    }
  },

  async validate_response(input: StepInput, ctx: StepContext): Promise<StepResult> {
    const response = input.ai_response as string;
    const confidence = input.confidence_score as number;
    
    console.log(`[validate] Confidence: ${(confidence * 100).toFixed(1)}%`);
    
    // Check quality criteria
    if (confidence >= 0.7 && response.length > 10) {
      return {
        result: 'valid',
        data: {
          validation_result: 'passed',
          validation_feedback: null,
        },
      };
    }
    
    return {
      result: 'needs_refinement',
      data: {
        validation_result: 'needs_improvement',
        validation_feedback: confidence < 0.7 
          ? 'Low confidence - regenerate with more context'
          : 'Response too short',
      },
    };
  },

  async refine_response(input: StepInput, ctx: StepContext): Promise<StepResult> {
    const feedback = input.validation_feedback as string;
    const userMessage = input.user_message as string;
    
    console.log(`[refine] Refining based on: ${feedback}`);
    
    const ai = ctx.components.aiClient as typeof mockAIClient;
    
    // Enhanced prompt with feedback
    const enhancedPrompt = `${userMessage} (Note: ${feedback})`;
    const response = await ai.generateResponse(enhancedPrompt, []);
    
    return {
      result: 'success',
      data: {
        ai_response: response.text + ' [refined]',
        confidence_score: Math.min(response.confidence + 0.2, 0.95), // Boost confidence
      },
    };
  },

  async check_approval(input: StepInput, ctx: StepContext): Promise<StepResult> {
    const response = input.ai_response as string;
    
    console.log(`[approval] Response ready: "${response}"`);
    
    // Simulate user approval (in real app, this would wait for user input)
    const userApproves = Math.random() > 0.3;
    
    if (userApproves) {
      console.log('[approval] User approved!');
      return {
        result: 'approved',
        data: {
          user_approved: true,
          user_feedback: null,
        },
      };
    }
    
    console.log('[approval] User rejected, requesting changes');
    return {
      result: 'rejected',
      data: {
        user_approved: false,
        user_feedback: 'Please make it more concise',
      },
    };
  },

  async incorporate_feedback(input: StepInput, ctx: StepContext): Promise<StepResult> {
    const response = input.ai_response as string;
    const feedback = input.user_feedback as string;
    
    console.log(`[feedback] Incorporating: "${feedback}"`);
    
    return {
      result: 'success',
      data: {
        ai_response: response.replace(' [refined]', '') + ' [user-adjusted]',
        confidence_score: 0.9,
      },
    };
  },
};

async function main() {
  // Load the AI conversation flow
  const flowPath = join(__dirname, '../flows/ai-conversation.yaml');
  const flow = await loadFlow(flowPath);
  
  console.log('=== AI Conversation Flow Demo ===\n');

  // Create engine with AI client component
  const engine = createEngine(flow, handlers, {
    store: new MemoryStore(),
    components: {
      aiClient: mockAIClient,
    },
    onTransition: (from, to) => {
      console.log(`  >> ${from} -> ${to}`);
    },
  });

  // Subscribe to events
  engine.on('step:error', (event) => {
    console.log(`  !! Error in step: ${event.data.step}`);
  });

  // Run the flow
  const result = await engine.run({
    user_message: 'Explain quantum computing in simple terms',
    conversation_history: [],
  });

  console.log('\n=== Flow Complete ===');
  console.log('Status:', result.status);
  console.log('Intent:', result.intent);
  console.log('Final Response:', result.data.ai_response);
  console.log('Steps taken:', result.stepHistory.length);
  console.log('Duration:', result.durationMs, 'ms');
}

main().catch(console.error);

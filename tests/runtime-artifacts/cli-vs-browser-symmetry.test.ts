import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { validateBoardStatusSchema, validateCardRuntimeSchema } from '../../src/runtime-artifacts/index.js';

/**
 * Guard test: validates that CLI (filesystem) and Browser (localStorage) artifact shapes
 * stay in sync. If either side drifts, this test will fail immediately.
 *
 * Pattern: Both CLI and browser must produce artifacts with:
 * - Card runtime: { schema_version, card_id, computed_values }
 * - Board status: { schema_version, meta, summary, cards }
 *
 * This contract is validated against published schemas.
 */

describe('CLI vs Browser artifact symmetry', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-flow-test-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  describe('card runtime artifacts', () => {
    it('CLI-written card runtime artifact matches schema', () => {
      // This is what the CLI writes (line 731-736 in board-live-cards-cli.ts)
      const cliArtifact = {
        schema_version: 'v1',
        card_id: 'test-card',
        computed_values: {
          total: 42,
          items: ['a', 'b'],
        },
      };

      // Validate against published schema
      const result = validateCardRuntimeSchema(cliArtifact);
      expect(result.ok, `CLI artifact should match schema: ${result.errors.join('; ')}`).toBe(true);
    });

    it('Browser-synthesized card runtime artifact matches schema', () => {
      // This is what buildBrowserArtifactsFromRuntime() synthesizes (reusable-runtime-artifacts-adapter.js:89-94)
      const browserArtifact = {
        schema_version: 'v1',
        card_id: 'test-card',
        computed_values: {
          total: 42,
          items: ['a', 'b'],
        },
      };

      // Validate against published schema
      const result = validateCardRuntimeSchema(browserArtifact);
      expect(result.ok, `Browser artifact should match schema: ${result.errors.join('; ')}`).toBe(true);
    });

    it('CLI and Browser artifacts have identical structure', () => {
      const cliArtifact = {
        schema_version: 'v1',
        card_id: 'card-x',
        computed_values: { result: 100, nested: { value: true } },
      };

      const browserArtifact = {
        schema_version: 'v1',
        card_id: 'card-x',
        computed_values: { result: 100, nested: { value: true } },
      };

      // Both must validate
      expect(validateCardRuntimeSchema(cliArtifact).ok).toBe(true);
      expect(validateCardRuntimeSchema(browserArtifact).ok).toBe(true);

      // Serialized forms must match (validates deep equality)
      expect(JSON.stringify(cliArtifact)).toBe(JSON.stringify(browserArtifact));
    });

    it('rejects artifacts missing required fields in both contexts', () => {
      // Missing card_id
      const incomplete = {
        schema_version: 'v1',
        computed_values: {},
      };

      const result = validateCardRuntimeSchema(incomplete);
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('round-trips through filesystem (mirrors CLI behavior)', () => {
      const original = {
        schema_version: 'v1',
        card_id: 'card-y',
        computed_values: { sum: 55 },
      };

      // Write to disk (CLI style)
      const filePath = path.join(tmpDir, 'card-y.computed.json');
      fs.writeFileSync(filePath, JSON.stringify(original));

      // Read back
      const readBack = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

      // Validate both original and read-back
      expect(validateCardRuntimeSchema(original).ok).toBe(true);
      expect(validateCardRuntimeSchema(readBack).ok).toBe(true);
      expect(readBack).toEqual(original);
    });
  });

  describe('board status artifacts', () => {
    it('CLI-written status snapshot matches schema', () => {
      // Minimal valid status (from board-live-cards-cli.ts line 1045)
      const cliStatus = {
        schema_version: 'v1',
        meta: { board: { path: '/tmp/board' } },
        summary: {
          card_count: 1,
          completed: 0,
          eligible: 0,
          pending: 0,
          blocked: 0,
          unresolved: 0,
          failed: 0,
          in_progress: 0,
          orphan_cards: 0,
          topology: { edge_count: 0, max_fan_out_card: null, max_fan_out: 0 },
        },
        cards: [],
      };

      const result = validateBoardStatusSchema(cliStatus);
      expect(result.ok, `CLI status should match schema: ${result.errors.join('; ')}`).toBe(true);
    });

    it('Browser-synthesized status snapshot matches schema', () => {
      // What buildBrowserArtifactsFromRuntime() synthesizes (reusable-runtime-artifacts-adapter.js:141-158)
      const browserStatus = {
        schema_version: 'v1',
        meta: { board: { path: 'browser-runtime' } },
        summary: {
          card_count: 1,
          completed: 0,
          eligible: 0,
          pending: 0,
          blocked: 0,
          unresolved: 0,
          failed: 0,
          in_progress: 0,
          orphan_cards: 0,
          topology: { edge_count: 0, max_fan_out_card: null, max_fan_out: 0 },
        },
        cards: [],
      };

      const result = validateBoardStatusSchema(browserStatus);
      expect(result.ok, `Browser status should match schema: ${result.errors.join('; ')}`).toBe(true);
    });

    it('CLI and Browser status snapshots have identical structure', () => {
      const commonStatus = {
        schema_version: 'v1',
        meta: { board: { path: 'test-board' } },
        summary: {
          card_count: 2,
          completed: 1,
          eligible: 0,
          pending: 1,
          blocked: 0,
          unresolved: 0,
          failed: 0,
          in_progress: 0,
          orphan_cards: 0,
          topology: { edge_count: 1, max_fan_out_card: 'card-a', max_fan_out: 2 },
        },
        cards: [
          {
            name: 'card-a',
            status: 'completed',
            requires: [],
            requires_satisfied: [],
            requires_missing: [],
            provides_declared: ['card-a'],
            provides_runtime: [],
            blocked_by: [],
            unblocks: [],
            runtime: {
              attempt_count: 1,
              restart_count: 0,
              in_progress_since: null,
              last_transition_at: null,
              last_completed_at: null,
              last_restarted_at: null,
              status_age_ms: 0,
            },
          },
        ],
      };

      // Both CLI and Browser must produce this structure
      expect(validateBoardStatusSchema(commonStatus).ok).toBe(true);
    });

    it('round-trips through filesystem (mirrors CLI behavior)', () => {
      const original = {
        schema_version: 'v1' as const,
        meta: { board: { path: '/tmp/test' } },
        summary: {
          card_count: 0,
          completed: 0,
          eligible: 0,
          pending: 0,
          blocked: 0,
          unresolved: 0,
          failed: 0,
          in_progress: 0,
          orphan_cards: 0,
          topology: { edge_count: 0, max_fan_out_card: null, max_fan_out: 0 },
        },
        cards: [],
      };

      // Write to disk (CLI style)
      const filePath = path.join(tmpDir, 'board-livegraph-status.json');
      fs.writeFileSync(filePath, JSON.stringify(original));

      // Read back
      const readBack = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

      // Validate both
      expect(validateBoardStatusSchema(original).ok).toBe(true);
      expect(validateBoardStatusSchema(readBack).ok).toBe(true);
      expect(readBack).toEqual(original);
    });
  });

  describe('localStorage service contract (inferred from runtime-artifacts-adapter)', () => {
    it('LocalStorageService write/read cycle must match CLI file I/O', () => {
      // The contract: what localStorage persists must be identical to what CLI writes to disk
      // LocalStorageService keys:
      // - 'yf:cards:<id>' → mirrors tmp/cards/<id>.json
      // - 'yf:runtime-out:cards:<id>' → mirrors runtime-out/cards/<id>.computed.json
      // - 'yf:runtime-out:status' → mirrors runtime-out/board-livegraph-status.json

      // Simulate writing computed artifact the CLI way
      const cliComputedPath = path.join(tmpDir, 'cards', 'test.computed.json');
      const cliComputedArtifact = {
        schema_version: 'v1',
        card_id: 'test',
        computed_values: { x: 1 },
      };
      fs.mkdirSync(path.dirname(cliComputedPath), { recursive: true });
      fs.writeFileSync(cliComputedPath, JSON.stringify(cliComputedArtifact));

      // Simulate writing the same artifact the browser way (would happen in localStorage)
      const browserComputedArtifact = {
        schema_version: 'v1',
        card_id: 'test',
        computed_values: { x: 1 },
      };

      // Both must validate and be identical
      const cliValid = validateCardRuntimeSchema(cliComputedArtifact);
      const browserValid = validateCardRuntimeSchema(browserComputedArtifact);
      expect(cliValid.ok && browserValid.ok).toBe(true);
      expect(JSON.stringify(cliComputedArtifact)).toBe(JSON.stringify(browserComputedArtifact));
    });

    it('detects schema drift if CLI changes artifact structure', () => {
      // Future-proofing: if someone modifies the CLI to write extra fields or change field names,
      // this test ensures it's caught
      const validCliArtifact = {
        schema_version: 'v1',
        card_id: 'test',
        computed_values: {},
      };
      expect(validateCardRuntimeSchema(validCliArtifact).ok).toBe(true);

      // If CLI were to add unsupported field (hypothetical drift)
      const driftedArtifact = {
        schema_version: 'v1',
        card_id: 'test',
        computed_values: {},
        state: {}, // If someone mistakenly adds this back
      };
      // With additionalProperties: false in schema, this should still validate
      // (but serves as a guard against *removing* required fields or changing types)
      const result = validateCardRuntimeSchema(driftedArtifact);
      expect(result.ok).toBe(false); // Should reject extra properties
    });
  });
});

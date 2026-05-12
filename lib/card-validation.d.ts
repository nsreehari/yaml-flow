/**
 * card-validation — standalone, adapter-free card preflight validation.
 *
 * Validates card structure without requiring a board instance or platform adapter:
 *   1. JSON Schema structure / contract checks
 *   2. Runtime JSONata parser compatibility checks for compute expressions
 *   3. provides[].ref namespace checks
 *
 * For source_defs executor-based validation, use api.validateCardPreflight()
 * on a fully initialised board adapter instead.
 *
 * @example
 *   // ESM
 *   import { validateCardPreflight } from 'yaml-flow/card-validation';
 *   // CJS
 *   const { validateCardPreflight } = require('yaml-flow/card-validation');
 *
 *   const result = validateCardPreflight(myCard);
 *   if (!result.isValid) console.error(result.issues);
 */
/** Result returned by validateCardPreflight. */
interface CardPreflightResult {
    isValid: boolean;
    issues: string[];
}
/**
 * Run a preflight validation on a card object before inserting it into a board.
 * Pure function — no filesystem, no adapter, no executor required.
 *
 * @param card - The card object (plain JS object or unknown input).
 * @returns `{ isValid, issues }` — isValid is false if any issues are found.
 */
declare function validateCardPreflight(card: unknown): CardPreflightResult;

export { type CardPreflightResult, validateCardPreflight };

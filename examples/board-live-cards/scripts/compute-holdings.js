/**
 * compute-holdings.js
 * Reads board-graph.json from cwd (boardDir).
 * Joins holdings (from portfolio-form task data) with prices (from price-fetch task data).
 * Outputs rows JSON to stdout.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const boardFile = path.join(process.cwd(), 'board-graph.json');
const envelope = JSON.parse(fs.readFileSync(boardFile, 'utf-8'));
const tasks = envelope.graph.state.tasks;

const holdings = tasks['portfolio-form']?.data?.holdings ?? [];
const prices   = tasks['price-fetch']?.data?.prices ?? {};

const rows = holdings.map(h => ({
  symbol: h.symbol,
  qty:    h.qty,
  price:  prices[h.symbol] ?? 0,
  value:  h.qty * (prices[h.symbol] ?? 0),
}));

// Output keyed object: bindTo="table", provides="table"
// card.state.table = { rows: [...] }
// downstream: requires.table = { rows: [...] } → requires.table.rows = array
process.stdout.write(JSON.stringify({ rows }) + '\n');

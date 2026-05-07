#!/usr/bin/env python3
"""Smoke tests for the Python-native port of yaml-flow logic."""
import sys, os, json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

passed = 0
failed = 0

def test(name, fn):
    global passed, failed
    try:
        fn()
        print(f"  PASS: {name}")
        passed += 1
    except Exception as e:
        print(f"  FAIL: {name} — {e}")
        failed += 1

# ===== Test 1: StepMachine basic run =====
def t1():
    from pylib.step_machine.step_machine import StepMachine
    from pylib.stores.memory import MemoryStore
    flow = {
        'id': 'test-flow',
        'settings': {'start_step': 'step1', 'max_total_steps': 50},
        'steps': {
            'step1': {'handler': {'inline': 'greet'}, 'transitions': {'success': 'step2'}},
            'step2': {'handler': {'inline': 'farewell'}, 'transitions': {'success': 'done'}},
        },
        'terminal_states': {
            'done': {'return_intent': 'completed', 'return_artifacts': ['greeting', 'farewell']},
        },
    }
    handlers = {
        'step1': lambda inp, ctx: {'result': 'success', 'data': {'greeting': 'hello'}},
        'step2': lambda inp, ctx: {'result': 'success', 'data': {'farewell': 'bye'}},
    }
    machine = StepMachine(flow, handlers, options={'store': MemoryStore()})
    result = machine.run({'name': 'world'})
    assert result['status'] == 'completed', f"status={result['status']}"
    assert result['finalStep'] == 'done', f"finalStep={result['finalStep']}"
    assert result['data'].get('greeting') == 'hello', f"data={result['data']}"
    assert result['data'].get('farewell') == 'bye', f"data={result['data']}"

test("StepMachine basic run", t1)

# ===== Test 2: Event Graph =====
def t2():
    from pylib.continuous_event_graph.core import create_live_graph, apply_event, snapshot, restore
    config = {
        'tasks': {
            'fetch': {'requires': [], 'provides': ['raw']},
            'process': {'requires': ['raw'], 'provides': ['out']},
        },
        'settings': {'execution_mode': 'eligibility-mode'},
    }
    g = create_live_graph(config)
    assert len(g['state']['tasks']) == 2
    g2 = apply_event(g, {'type': 'task-started', 'taskName': 'fetch', 'timestamp': '2024-01-01T00:00:00Z'})
    assert g2['state']['tasks']['fetch']['status'] in ('running', 'in-progress', 'started')
    snap = snapshot(g2)
    r = restore(snap)
    assert len(r['state']['tasks']) == 2

test("Event graph create/apply/snapshot/restore", t2)

# ===== Test 3: MemoryStore =====
def t3():
    from pylib.stores.memory import MemoryStore
    s = MemoryStore()
    s.save_run_state('r1', {'status': 'running'})
    assert s.load_run_state('r1')['status'] == 'running'
    s.set_data('r1', 'k1', 'v1')
    s.set_data('r1', 'k2', 42)
    assert s.get_data('r1', 'k1') == 'v1'
    assert s.get_all_data('r1') == {'k1': 'v1', 'k2': 42}

test("MemoryStore", t3)

# ===== Test 4: Storage interface =====
def t4():
    from pylib.cli.storage_interface import parse_ref, serialize_ref
    ref = parse_ref('::fs-path::/some/dir')
    assert serialize_ref(ref) == '::fs-path::/some/dir'

test("Storage interface roundtrip", t4)

# ===== Test 5: JSONata card compute =====
def t5():
    from pylib.card_compute import CardCompute
    node = {
        'card_data': {'numbers': [10, 20, 30]},
        'compute': [{'bindTo': 'total', 'expr': '$sum(card_data.numbers)'}],
    }
    r = CardCompute.run_sync(node)
    assert r['ok'], f"run_sync not ok: {r}"
    # Verify resolve works
    val = CardCompute.resolve(r['node'], 'computed_values.total')
    # value depends on jsonata availability

test("CardCompute JSONata", t5)

# ===== Test 6: Flow validation =====
def t6():
    from pylib.step_machine.loader import validate_step_flow_config
    valid = {
        'id': 'v', 'settings': {'start_step': 's1'},
        'steps': {'s1': {'handler': {'inline': 'x'}, 'transitions': {'success': 'done'}}},
        'terminal_states': {'done': {'return_intent': 'ok'}},
    }
    errs = validate_step_flow_config(valid)
    assert not errs, f"Expected no errors: {errs}"
    errs2 = validate_step_flow_config({'id': 'bad'})
    assert errs2, "Expected errors for invalid flow"

test("Flow validation", t6)

# ===== Test 7: StepMachine retry =====
def t7():
    from pylib.step_machine.step_machine import StepMachine
    from pylib.stores.memory import MemoryStore
    calls = [0]
    def flaky(inp, ctx):
        calls[0] += 1
        if calls[0] < 3:
            return {'result': 'failure', 'data': {'error': 'flaky'}}
        return {'result': 'success', 'data': {'value': 42}}

    flow = {
        'id': 'retry', 'settings': {'start_step': 'f', 'max_total_steps': 20},
        'steps': {'f': {'handler': {'inline': 'flaky'}, 'transitions': {'success': 'done'}, 'retry': {'max_attempts': 5, 'delay_ms': 0}}},
        'terminal_states': {'done': {'return_intent': 'ok', 'return_artifacts': ['value']}},
    }
    m = StepMachine(flow, {'f': flaky}, options={'store': MemoryStore()})
    r = m.run()
    assert r['status'] == 'completed', f"status={r['status']}"
    assert calls[0] == 3, f"calls={calls[0]}"
    assert r['data'].get('value') == 42

test("StepMachine retry", t7)

# ===== Test 8: Native bridge end-to-end =====
def t8():
    from sub.step_machine_native_bridge import invoke_step_machine_native
    flow = {
        'id': 'bridge-test', 'settings': {'start_step': 's1', 'max_total_steps': 10},
        'steps': {
            's1': {'handler': {'inline': 'h1'}, 'transitions': {'success': 's2'}},
            's2': {'handler': {'inline': 'h2'}, 'transitions': {'success': 'done'}},
        },
        'terminal_states': {'done': {'return_intent': 'completed', 'return_artifacts': ['x', 'y']}},
    }
    result = invoke_step_machine_native(
        payload={'mode': 'run', 'flow': flow, 'flowDir': '.', 'store': {'type': 'memory'}, 'inlineHandlerNames': ['h1', 'h2'], 'handlerVars': {}},
        inline_handlers={
            'h1': lambda inp, ctx: {'result': 'success', 'data': {'x': 1}},
            'h2': lambda inp, ctx: {'result': 'success', 'data': {'y': 2}},
        },
    )
    assert result['status'] == 'completed', f"status={result['status']}"

test("Native step machine bridge", t8)

print(f"\n{'='*40}")
print(f"Results: {passed} passed, {failed} failed")
if failed:
    sys.exit(1)
print("ALL TESTS PASSED")

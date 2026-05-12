"""
Step Machine — Loader

Utilities for loading and validating step-machine flow configurations.

Port of src/step-machine/loader.ts
"""
from __future__ import annotations

import json
import os
from typing import Any

import yaml


def parse_step_flow_yaml(yaml_string: str) -> dict:
    """Parse a YAML string into a StepFlowConfig dict."""
    return yaml.safe_load(yaml_string)


def load_step_flow_from_file(file_path: str) -> dict:
    """Load a step flow config from a file (YAML or JSON)."""
    with open(file_path, "r", encoding="utf-8") as f:
        text = f.read()
    if file_path.endswith(".json"):
        return json.loads(text)
    return parse_step_flow_yaml(text)


def validate_step_flow_config(flow: Any) -> list[str]:
    """Validate a step flow config dict. Returns a list of error strings."""
    errors: list[str] = []

    if not flow or not isinstance(flow, dict):
        return ["Flow must be an object"]

    # settings
    settings = flow.get("settings")
    if not settings or not isinstance(settings, dict):
        errors.append('Flow must have a "settings" object')
    else:
        if not isinstance(settings.get("start_step"), str):
            errors.append("settings.start_step must be a string")

    # steps
    steps = flow.get("steps")
    if not steps or not isinstance(steps, dict):
        errors.append('Flow must have a "steps" object')
    else:
        for step_name, step_config in steps.items():
            if not step_config or not isinstance(step_config, dict):
                errors.append(f'Step "{step_name}" must be an object')
                continue
            transitions = step_config.get("transitions")
            if not transitions or not isinstance(transitions, dict):
                errors.append(f'Step "{step_name}" must have a "transitions" object')
            ft = step_config.get("failure_transitions")
            if ft is not None and not isinstance(ft, dict):
                errors.append(
                    f'Step "{step_name}" failure_transitions must be an object when provided'
                )

    # terminal_states
    terminal_states = flow.get("terminal_states")
    if not terminal_states or not isinstance(terminal_states, dict):
        errors.append('Flow must have a "terminal_states" object')
    else:
        for name, config in terminal_states.items():
            if not config or not isinstance(config, dict):
                errors.append(f'Terminal state "{name}" must be an object')
                continue
            if not isinstance(config.get("return_intent"), str):
                errors.append(
                    f'Terminal state "{name}" must have a "return_intent" string'
                )

    return errors


def load_step_flow(source: Any) -> dict:
    """
    Load a step flow config from a source.

    source can be:
    - A file path string (loads from file)
    - A JSON string containing '{'
    - A dict (passthrough)

    Validates the config and raises on errors.
    """
    if isinstance(source, str):
        if "{" in source:
            flow = json.loads(source)
        else:
            flow = load_step_flow_from_file(source)
    elif isinstance(source, dict):
        flow = source
    else:
        raise TypeError(f"Unsupported source type: {type(source)}")

    errors = validate_step_flow_config(flow)
    if errors:
        raise ValueError(
            "Invalid step flow configuration:\n- " + "\n- ".join(errors)
        )
    return flow

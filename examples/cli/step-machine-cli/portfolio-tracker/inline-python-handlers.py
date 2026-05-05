from __future__ import annotations


def greet_user(input_obj, ctx=None):
    payload = input_obj if isinstance(input_obj, dict) else {}
    name = payload.get("name", "world")
    return {
        "result": "success",
        "data": {
            "message": f"Hello, {name}!",
        },
    }


def add_numbers(input_obj, ctx=None):
    payload = input_obj if isinstance(input_obj, dict) else {}
    a = payload.get("a", 0)
    b = payload.get("b", 0)
    try:
        total = float(a) + float(b)
    except Exception:
        return {
            "result": "failure",
            "data": {"error": f"Cannot add values: a={a!r}, b={b!r}"},
        }

    if total.is_integer():
        total = int(total)

    return {
        "result": "success",
        "data": {"total": total},
    }


handlers = {
    "greet_user": greet_user,
    "add_numbers": add_numbers,
}

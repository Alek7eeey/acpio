"""Thin CLI over the installed swebench package, called by bench/swe/run-swe.mjs.

Usage:
  python3 swebench_cli.py spec  <instance.json>            # print eval script (bash)
  python3 swebench_cli.py grade <instance.json> <test.log> # print verdict JSON

<instance.json> is one line of bench/swe/data/swe-bench-verified.jsonl (the
swebench 5.x dataset format: eval_script, log_parser, FAIL_TO_PASS, ...).
Everything clever — eval script semantics, log parsing, resolution rules —
stays in the swebench package; this file only adapts its API to a CLI.
"""
import json
import sys

from swebench.harness.grading import get_eval_report
from swebench.harness.utils import make_test_spec


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def eval_script(row):
    spec = make_test_spec(row)
    script = getattr(spec, "eval_script", None)
    if isinstance(script, list):
        script = "\n".join(script)
    if not script:
        raise SystemExit(f"{row.get('instance_id')}: empty eval script")
    return script


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "spec":
        # Binary stdout: Windows text mode would translate \n to \r\n and the
        # eval script would arrive at the container with CRLF line endings.
        sys.stdout.buffer.write(eval_script(load(sys.argv[2])).encode("utf-8"))
    elif cmd == "grade":
        row = load(sys.argv[2])
        spec = make_test_spec(row)
        prediction = {
            "instance_id": row["instance_id"],
            "model_name_or_path": "acpio-builtin",
            "model_patch": row.get("_patch", ""),
        }
        # swebench 5.x: get_eval_report answers {instance_id: {resolved, tests_status, ...}},
        # with the resolution already computed per FAIL_TO_PASS / PASS_TO_PASS.
        report = get_eval_report(spec, prediction, sys.argv[3], include_tests_status=True)
        entry = report[row["instance_id"]]
        if entry["resolved"]:
            status = "RESOLVED_FULL"
        elif entry.get("infra_failure"):
            status = "INFRA_FAILURE"
        else:
            status = "NOT_RESOLVED"
        print(
            json.dumps(
                {
                    "status": status,
                    "resolved": bool(entry["resolved"]),
                    "report": entry.get("tests_status", {}),
                    "patch_successfully_applied": entry.get("patch_successfully_applied"),
                    "infra_failure_reason": entry.get("infra_failure_reason"),
                },
                ensure_ascii=False,
            )
        )
    else:
        raise SystemExit(f"unknown command: {cmd!r}")


if __name__ == "__main__":
    main()

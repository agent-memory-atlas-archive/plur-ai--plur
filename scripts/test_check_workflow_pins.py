#!/usr/bin/env python3
"""Self-test for check-workflow-pins.py. Run: python3 scripts/test_check_workflow_pins.py"""
import importlib.util
import tempfile
import textwrap
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location('check_workflow_pins', Path(__file__).with_name('check-workflow-pins.py'))
pins = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pins)

SHA = '11d5960a326750d5838078e36cf38b85af677262'


def check(workflow: str, action: str | None = None) -> list[str]:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / '.github/workflows').mkdir(parents=True)
        (root / '.github/workflows/w.yml').write_text(textwrap.dedent(workflow))
        if action is not None:
            (root / '.github/actions/local').mkdir(parents=True)
            (root / '.github/actions/local/action.yml').write_text(textwrap.dedent(action))
        return list(pins.violations(root))


def job(steps: str) -> str:
    return 'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n' + textwrap.indent(textwrap.dedent(steps), '      ')


class Rejects(unittest.TestCase):
    def test_plain_tag(self):
        self.assertEqual(len(check(job('- uses: actions/checkout@v4\n'))), 1)

    def test_flow_mapping(self):
        self.assertEqual(len(check(job('- {uses: actions/checkout@v4}\n'))), 1)

    def test_quoted_key(self):
        self.assertEqual(len(check(job('- "uses": actions/checkout@v4\n'))), 1)

    def test_space_before_colon(self):
        self.assertEqual(len(check(job('- uses : actions/checkout@v4\n'))), 1)

    def test_branch_and_short_sha(self):
        self.assertEqual(len(check(job('- uses: actions/checkout@main\n- uses: actions/checkout@11d5960\n'))), 2)

    def test_docker_reference(self):
        self.assertEqual(len(check(job('- uses: docker://alpine:3.20\n'))), 1)

    def test_job_level_reusable_workflow(self):
        workflow = 'on: push\njobs:\n  a:\n    uses: owner/repo/.github/workflows/x.yml@v1\n'
        self.assertEqual(len(check(workflow)), 1)

    def test_local_composite_action(self):
        action = 'runs:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v4\n'
        self.assertEqual(len(check(job(f'- uses: actions/checkout@{SHA}\n'), action)), 1)

    def test_unparseable_file_fails_closed(self):
        self.assertEqual(len(check('jobs: [\n')), 1)

    def test_reports_line_number(self):
        self.assertIn('w.yml:7:', check(job(f'- uses: actions/checkout@{SHA}\n- uses: actions/checkout@v4\n'))[0])


class Accepts(unittest.TestCase):
    def test_pinned(self):
        self.assertEqual(check(job(f'- uses: actions/checkout@{SHA} # v4.4.0\n')), [])

    def test_quoted_pinned_value(self):
        self.assertEqual(check(job(f"- uses: 'actions/checkout@{SHA}'\n- uses: \"actions/checkout@{SHA}\"\n")), [])

    def test_local_action(self):
        self.assertEqual(check(job('- uses: ./.github/actions/local\n')), [])

    def test_pinned_reusable_workflow(self):
        workflow = f'on: push\njobs:\n  a:\n    uses: owner/repo/.github/workflows/x.yml@{SHA}\n'
        self.assertEqual(check(workflow), [])

    def test_uses_as_ordinary_text_is_ignored(self):
        self.assertEqual(check(job("- run: 'echo uses: actions/checkout@v4'\n")), [])


if __name__ == '__main__':
    unittest.main()

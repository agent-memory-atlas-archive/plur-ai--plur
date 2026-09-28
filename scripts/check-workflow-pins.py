#!/usr/bin/env python3
"""Fail CI when an external action is executable through a mutable reference.

Every `uses:` value in every workflow (step actions and job-level reusable
workflows) and in every local composite action under .github/actions/ must
be either a local path (`./...`) or `owner/repo[/path]@<40-hex commit SHA>`.

The check walks the parsed YAML rather than matching lines, so every form
GitHub Actions accepts is covered: flow mappings (`- {uses: x@v4}`), quoted
keys (`"uses": x@v4`), a space before the colon, and quoted values. It fails
closed: a file that does not parse, or a missing YAML parser, is an error,
never a pass.
"""
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - exercised only on a broken runner
    raise SystemExit('check-workflow-pins: PyYAML is required (python3-yaml); refusing to pass without it')

PINNED = re.compile(r'[\w.-]+/[\w./-]+@[0-9a-f]{40}')


def files(root: Path):
    yield from sorted((root / '.github/workflows').glob('*.y*ml'))
    actions = root / '.github/actions'
    if actions.is_dir():
        yield from sorted(actions.glob('**/action.y*ml'))


def uses_nodes(node):
    """Yield (key_node, value_node) for every mapping key named `uses`."""
    if isinstance(node, yaml.MappingNode):
        for key, value in node.value:
            if isinstance(key, yaml.ScalarNode) and key.value == 'uses':
                yield key, value
            yield from uses_nodes(value)
    elif isinstance(node, yaml.SequenceNode):
        for item in node.value:
            yield from uses_nodes(item)


def violations(root: Path):
    for path in files(root):
        name = path.relative_to(root)
        try:
            document = yaml.compose(path.read_text(), Loader=yaml.SafeLoader)
        except yaml.YAMLError as error:
            yield f'{name}: cannot parse YAML, so its actions cannot be checked: {error}'
            continue
        for key, value in uses_nodes(document):
            line = key.start_mark.line + 1
            if not isinstance(value, yaml.ScalarNode):
                yield f'{name}:{line}: `uses` must be a single string reference'
                continue
            reference = value.value.strip()
            if reference.startswith('./'):
                continue
            if not PINNED.fullmatch(reference):
                yield f'{name}:{line}: external action must use a full commit SHA: {reference}'


def main(root: Path) -> int:
    errors = list(violations(root))
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        return 1
    print('All external workflow actions use immutable commit IDs.')
    return 0


if __name__ == '__main__':
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
    sys.exit(main(target))

#!/usr/bin/env python3
"""Explicitly port cumulative v2 records to the current incremental-round format."""
import argparse
import copy
from contextlib import ExitStack
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from manuscript_review.anchors import SourceSpan
from manuscript_review.comparison import build_snapshot, git, read_blob
from manuscript_review.editing import selected_content
from manuscript_review.feedback import feedback_report
from manuscript_review.history import build_history
from manuscript_review.storage import SCHEMA, FileLock, atomic_bytes, atomic_json, read_json, validate_record
from manuscript_review.versions import selected_version


def selected_sources(record):
    return {file['path']: selected_content(file, record['decisions']) for file in record['snapshot']['files']}


def port_ui(ui, previous, current):
    ui = copy.deepcopy(ui)
    position = {key: ui.pop(key) for key in ('active', 'passage', 'edit', 'view', 'overrides') if key in ui}
    old_files, new_files = previous['files'], current['files']
    if old_files:
        old_file = old_files[min(position.get('active', 0), len(old_files)-1)]
        position['active'] = next((i for i, f in enumerate(new_files) if f['path'] == old_file['path']), 0)
    if previous['base'] != current['base'] or previous['proposed'] != current['proposed']:
        position['passage'] = position['edit'] = 0
    valid = {h['id'] for f in new_files for h in f['hunks']}
    if set(ui.get('drafts', {})) - valid:
        raise ValueError('Save active passage drafts before upgrading this review.')
    position['overrides'] = {key: value for key, value in position.get('overrides', {}).items() if key in valid}
    ui.update(scope='round', positions={'round': position})
    return ui


def port_record(old, parent, directory):
    if old['schema'] != 2:
        raise ValueError('Expected a v2 review record.')
    old = copy.deepcopy(old)
    for entry in old['history']:
        entry['author'] = 'user'
    record = copy.deepcopy(old)
    previous = old['snapshot']
    record['baseline'] = parent['baseline'] if parent else previous['base']
    old_result = selected_version(old)
    if parent:
        current = build_snapshot(previous['repo'], parent['result'], previous['proposed'], text_only=True)
        current.update({key: previous[key] for key in ('created', 'token', 'source_head', 'entry')})
        old_files = {f['path']: f for f in previous['files']}
        choices = {}
        for file in current['files']:
            original = old_files.get(file['path'], {'edits': []})
            for group in file['edits']:
                span = SourceSpan(*group['proposal_span'])
                values = {old['decisions'].get(g['id'], 'pending') for g in original['edits']
                          if span.overlaps(SourceSpan(*g['proposal_span']))}
                if len(values) == 1 and 'pending' not in values:
                    choices[group['id']] = values.pop()
        record.update(snapshot=current, decisions=choices)
        # Some old cumulative rejections cannot be expressed as a decision on a
        # smaller incremental edit. Preserve their selected manuscript as the
        # migrated proposal; the exact old choices remain in the byte archive.
        paths = set(selected_sources(old)) | {f['path'] for f in current['files']}
        projected = {f['path']: selected_content(f, choices) for f in current['files']}
        expected = selected_sources(old)
        if any(projected.get(path, read_blob(previous['repo'], current['proposed'], path)) !=
               expected.get(path, read_blob(previous['repo'], old_result, path)) for path in paths):
            current = build_snapshot(previous['repo'], parent['result'], old_result, text_only=True)
            current.update({key: previous[key] for key in ('created', 'token', 'source_head', 'entry')})
            record.update(snapshot=current, decisions={g['id']: 'accept' for f in current['files'] for g in f['edits']})
        report = feedback_report(previous, old['decisions'], old['comments'], old['history'])
        record['history'] = build_history(previous, current, old, report, old['history'], directory)
        record['comments'] = {}
        record['metadata']['base'] = current['base']
        record['metadata']['base_label'] = 'Starting draft · ' + current['base'][:7]
        record['metadata']['baseline_label'] = parent['metadata'].get('baseline_label', parent['metadata']['base_label'])
        record['metadata']['previous_revision'] = parent['revision']
        record['metadata']['preview_status'] = 'queued' if current['entry'] else 'none'
    else:
        current = previous
        record['metadata']['baseline_label'] = record['metadata']['base_label']
    record['metadata'].pop('carried', None)
    record['metadata'].pop('baseline_preview_status', None)
    record['metadata'].pop('baseline_preview_error', None)
    record['schema'] = SCHEMA
    record['result'] = selected_version(record)
    record['ui'] = port_ui(old['ui'], previous, current)
    record['drafts'] = record['ui'].pop('drafts', {})
    # Verify every old selected file, including files that disappeared from the
    # incremental comparison. No manuscript content may change during migration.
    for path, text in selected_sources(old).items():
        if read_blob(previous['repo'], record['result'], path) != text:
            raise ValueError('Migration changed selected wording in ' + path)
    return validate_record(record)


def cache_baseline(directory, old, current):
    snapshot = old['snapshot']
    if (snapshot['base'], snapshot['proposed']) == (current['baseline'], current['result']):
        cache = directory / 'comparisons' / (current['baseline'] + '-' + current['result'] + '.json')
        if not cache.exists():
            atomic_json(cache, snapshot)


def upgrade(home):
    home = Path(home).expanduser().resolve()
    directories = sorted((home / 'reviews').glob('*/review.json'))
    with FileLock(home / '.prepare.lock'), ExitStack() as locks:
        originals, records, converted = {}, {}, {}
        for path in directories:
            locks.enter_context(FileLock(path.parent / '.session.lock'))
            if (path.parent / 'transaction.json').exists():
                raise ValueError('Recover an interrupted manuscript save before upgrading.')
            originals[path.parent.name] = path.read_bytes()
            records[path.parent.name] = read_json(path)
        visiting = set()
        def visit(identifier):
            if identifier in converted:
                return converted[identifier]
            if identifier in visiting:
                raise ValueError('Review history contains a cycle.')
            visiting.add(identifier)
            old = records[identifier]
            if old['schema'] == SCHEMA:
                current = validate_record(old)
            else:
                previous = old['metadata'].get('previous')
                if previous and previous not in records:
                    raise ValueError('Missing earlier round: ' + previous)
                current = port_record(old, visit(previous) if previous else None, home / 'reviews' / identifier)
            visiting.remove(identifier)
            converted[identifier] = current
            return current
        for identifier in records:
            visit(identifier)
        # All records are validated before the first canonical replacement.
        for identifier, current in converted.items():
            if records[identifier]['schema'] == SCHEMA:
                original = read_json(home / 'reviews' / identifier / 'migration-v2/review.json')
                if original:
                    cache_baseline(home / 'reviews' / identifier, original, current)
                continue
            directory = home / 'reviews' / identifier
            archive = directory / 'migration-v2' / 'review.json'
            if archive.exists() and archive.read_bytes() != originals[identifier]:
                raise ValueError('The v2 record changed after an interrupted migration; its archive is retained.')
            atomic_bytes(archive, originals[identifier])
            snapshot = current['snapshot']
            manifest_path = directory / 'renders/manifest.json'
            manifest = read_json(manifest_path)
            if snapshot['base'] == records[identifier]['snapshot']['base'] and manifest and manifest.get('proposed') == snapshot['proposed']:
                manifest['base'] = snapshot['base']
                atomic_json(manifest_path, manifest)
            for name, revision in {'base': snapshot['base'], 'proposed': snapshot['proposed'],
                                   'baseline': current['baseline'], 'result': current['result']}.items():
                git(snapshot['repo'], 'update-ref', f'refs/manuscript-review/{identifier}/{name}', revision)
            atomic_json(directory / 'review.json', current)
            cache_baseline(directory, records[identifier], current)
        return converted


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('home', type=Path)
    args = parser.parse_args()
    records = upgrade(args.home)
    print(f'Upgraded {len(records)} reviews; original records retained in migration-v2/.')

#!/usr/bin/env python3
"""One-time import of the retired multi-file format. The app never reads v1 data."""
import argparse
import copy
import json
import re
import secrets
import shutil
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from manuscript_review.anchors import SourceMap, SourceSpan
from manuscript_review.application import digest
from manuscript_review.comparison import build_snapshot, compare, enrich_snapshot, git, stable_id
from manuscript_review.history import attach
from manuscript_review.storage import atomic_json, new_record, read_json
from manuscript_review.migrations import port_thread_origins
from manuscript_review.versions import source_version, selected_version


def import_v1(source, destination, reviewed_ref=None, history_source=None):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if destination.exists():
        raise ValueError('Choose a new destination; originals are never overwritten.')
    raw = read_json(source / 'snapshot.json')
    state = read_json(source / 'state.json')
    if state is None:
        state = {key: read_json(source / (key + '.json'), {}) for key in ('decisions', 'comments', 'revisions')}
        state['revision'] = 0
    identifier = destination.name
    old = copy.deepcopy(raw)
    for file in old['files']:
        for h in file['hunks']:
            start = len(''.join((file['before'] or '').splitlines(keepends=True)[:h['line'] - 1]))
            before = ''.join(p.get('text', p.get('old', '')) for p in h['segments'])
            after = ''.join(p.get('text', p.get('new', '')) for p in h['segments'])
            old_pos = new_pos = 0
            for piece in file['pieces']:
                end = old_pos + len(piece['old'])
                if old_pos <= start < end:
                    new_pos += start - old_pos
                    break
                if old_pos == start:
                    break
                new_pos += len(piece['new']);old_pos = end
            h['base_span'] = [start, start + len(before)]
            h['proposal_span'] = [new_pos, new_pos + len(after)]
    enrich_snapshot(old)
    # The old files store exact opcodes. IDs are decoded here solely to port data.
    lookup, passages = {}, {}
    for file in old['files']:
        for group in file['edits']:
            keys, running = [], []
            for piece in file['pieces'][group['start']:group['stop']]:
                if 'id' in piece:
                    running.append(piece['id'])
                elif piece['old'].strip() or '\n' in piece['old']:
                    keys.append(stable_id('edit', [file['path'], *running]));running=[]
            if running:
                keys.append(stable_id('edit', [file['path'], *running]))
            keys.append(stable_id('edit', [file['path'], *group['members']]))
            for key in keys:
                lookup[key] = file, group
        for passage in file['hunks']:
            key = stable_id('passage', [file['path'], *passage['piece_ids']])
            passages[key] = file, passage
    snapshot = build_snapshot(raw['repo'], raw['base'], reviewed_ref or raw['proposed'], text_only=True)
    snapshot['created'] = raw['created']
    snapshot['source_head'] = raw.get('source_head', raw['proposed'])
    snapshot['entry'] = raw.get('entry', 'main.tex')
    decisions, notes = {}, {}
    if reviewed_ref:
        decisions = {g['id']: 'accept' for f in snapshot['files'] for g in f['edits']}
    else:
        for file in snapshot['files']:
            original = next(f for f in old['files'] if f['path'] == file['path'])
            after = original['after'] or ''
            for group in reversed(original['edits']):
                key = stable_id('edit', [file['path'], *group['members']])
                values = {state['decisions'].get(member, 'pending') for member in group['members']}
                replacement = state['revisions'].get(key)
                if replacement is None and len(values) > 1:
                    replacement = ''.join(p['old'] if state['decisions'].get(p.get('id')) == 'reject' else p['new'] for p in original['pieces'][group['start']:group['stop']])
                if replacement is not None and values != {'reject'}:
                    lo, hi = group['proposal_span'];after = after[:lo] + replacement + after[hi:]
            if after != (file['after'] or ''):
                snapshot['proposed'] = source_version(raw['repo'], snapshot['proposed'], {file['path']: after},
                                                     'refs/manuscript-review/' + identifier + '/versions', 'Import manual manuscript revision')
            rebuilt = enrich_snapshot({'files': [compare(file['path'], file['before'], None if file['after'] is None else after)]})['files'][0]
            file.update(rebuilt)
            for group in file['edits']:
                matching = next((g for g in original['edits'] if g['base_span'] == group['base_span']), None)
                if matching:
                    values = {state['decisions'].get(member, 'pending') for member in matching['members']}
                    key = stable_id('edit', [file['path'], *matching['members']])
                    value = 'accept' if key in state['revisions'] and values != {'reject'} or len(values) > 1 else next(iter(values))
                    if value != 'pending':
                        decisions[group['id']] = value
    files = {f['path']: f for f in snapshot['files']}
    history = read_json(source / 'history.json', {'entries': []})['entries']
    if history_source:
        imported = read_json(Path(history_source) / 'history.json')['entries']
        history = list({e['id']: e for e in [*history, *imported]}.values())
    maps = {}
    for entry in history:
        entry['author'] = 'user'
        path, anchor = entry['file'], entry['anchor']
        if anchor['revision'] != snapshot['base']:
            def blob(ref):
                result = git(raw['repo'], 'show', ref + ':' + path)
                return result.decode()
            key = path, anchor['revision']
            if key not in maps:
                maps[key] = SourceMap(blob(anchor['revision']), blob(snapshot['base']))
            span = maps[key].project(SourceSpan(anchor['start'], anchor['end']))
            entry['anchor'] = {'revision': snapshot['base'], 'start': span.start, 'end': span.end}
        entry.pop('member_ids', None)
        reply = entry.pop('response', None)
        entry['replies'] = [{'id': stable_id('reply', [entry['id'], reply]), 'text': reply, 'created': entry['created']}] if reply else []
        attach(entry, files.get(path))
    for key, text in state['comments'].items():
        if key not in lookup and key not in passages:
            raise ValueError('Cannot locate saved comment: ' + key)
        file, item = lookup.get(key) or passages[key]
        kind = 'edit' if key in lookup else 'passage'
        context = next(h for h in file['hunks'] if item is h or item in h['edits'])
        lo, hi = item['base_span']
        existing = next((e for e in history if e['origin_id'] == key and e['comment'] == text), None)
        if existing is None:
            existing = {'id': stable_id('discussion', [raw['repo'], raw['base'], raw['proposed'], raw['created'], key, text]),
                        'author': 'user', 'origin_id': key, 'origin_review': str(source), 'kind': kind, 'file': file['path'],
                        'line': context['line'], 'created': raw['created'], 'base': raw['base'],
                        'source_proposed': raw['proposed'], 'comment': text, 'replies': [],
                        'before': item['old'] if kind == 'edit' else item['before'],
                        'proposed': item['new'] if kind == 'edit' else item['after'],
                        'context_before': context['before'],
                        'anchor': {'revision': snapshot['base'], 'start': lo, 'end': hi}}
            attach(existing, files.get(file['path']));history.append(existing)
        if not reviewed_ref and item['id'] in {g['id'] for f in snapshot['files'] for g in f['edits']} | {h['id'] for f in snapshot['files'] for h in f['hunks']}:
            notes[item['id']] = text
    meta = read_json(source / 'review.json', {})
    metadata = {'id': identifier, 'repo': raw['repo'], 'title': meta.get('name', 'Completed manuscript review' if reviewed_ref else Path(raw['repo']).name),
                'base': raw['base'], 'proposed': 'working', 'entry': snapshot['entry'], 'created': raw['created'],
                'base_label': meta.get('base_label', raw['base'][:7]),
                'proposal_label': 'Your reviewed draft' if reviewed_ref else meta.get('proposal_label', raw['proposed'][:7]),
                'preview_status': 'queued' if snapshot['entry'] else 'none', 'imported_from': str(source)}
    record = port_thread_origins(new_record(snapshot, metadata, decisions, notes, history))
    record['result'] = selected_version(record)
    record['revision'] = state['revision']
    record['applied'] = read_json(source / 'applied.json', {})
    if reviewed_ref:
        record['applied'] = {f['path']: digest(f['after']) for f in snapshot['files']}
    old_ui = read_json(source / 'ui.json', {})
    record['ui'] = {'positions': {'round': {key: old_ui[key] for key in ('active', 'passage', 'edit', 'view', 'overrides') if key in old_ui}},
                    **{key: value for key, value in old_ui.items() if key not in ('active', 'passage', 'edit', 'view', 'overrides')}}
    record['drafts'] = record['ui'].pop('drafts', {})
    from manuscript_review.migrations.v5 import port_drafts
    record = port_drafts(record)
    destination.mkdir(parents=True)
    # A byte-exact archive retains primitive decisions and the four original
    # manual replacements as provenance, outside the supported runtime format.
    backup = destination / 'migration-original'
    backup.mkdir()
    for name in ('snapshot.json', 'state.json', 'decisions.json', 'comments.json', 'revisions.json', 'history.json', 'review.json', 'ui.json', 'applied.json'):
        if (source / name).is_file():
            shutil.copy2(source / name, backup / name)
    manifest = read_json(source / 'renders/manifest.json')
    if manifest and snapshot['proposed'] == raw['proposed']:
        output = destination / 'renders';output.mkdir()
        mapped = {}
        for file in old['files']:
            for passage in file['hunks']:
                old_id = stable_id('passage', [file['path'], *passage['piece_ids']])
                if old_id in manifest:
                    mapped[passage['id']] = manifest[old_id]
        for asset in (source / 'renders').glob('*.svg'):
            shutil.copy2(asset, output / asset.name)
        atomic_json(output / 'manifest.json', {'base': snapshot['base'], 'proposed': snapshot['proposed'], 'passages': mapped})
        metadata['preview_status'] = 'ready'
    atomic_json(destination / 'review.json', record)
    git(raw['repo'], 'update-ref', f'refs/manuscript-review/{identifier}/base', snapshot['base'])
    git(raw['repo'], 'update-ref', f'refs/manuscript-review/{identifier}/proposed', snapshot['proposed'])
    return record


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--reviewed-ref')
    parser.add_argument('--history-source', type=Path)
    args = parser.parse_args()
    record = import_v1(args.source, args.destination, args.reviewed_ref, args.history_source)
    print(f'Imported {len(record["history"])} discussion records; originals preserved.')

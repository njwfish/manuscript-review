"""Pinned Git snapshots, exact word differences, and grouped edit identities."""
import difflib
import hashlib
import re
import secrets
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from .editing import selected_content
from .alignment import TOKEN, token_opcodes

def stable_id(prefix, values):
    return prefix + '-' + hashlib.sha256('\0'.join(values).encode()).hexdigest()[:20]


def nontrivial_latex_at(source, start, end):
    names = r'equation\*?|align\*?|aligned|gather\*?|multline\*?|algorithm\*?|algorithmic|tabular\*?|array|tikzpicture'
    tokens = re.finditer(r'\\(begin|end)\{(' + names + r')\}|\\[\[\]]', re.sub(r'%[^\n]*', '', source[:start]))
    stack = []
    for match in tokens:
        token = match.group()
        if token == '\\[' or match[1] == 'begin':
            stack.append(token if token == '\\[' else match[2])
        elif stack:
            stack.pop()
    fragment = source[start:end]
    return bool(stack) or bool(re.search(r'\\\[|\\begin\{(' + names + r')\}|\\(?:frac|sum|sqrt|int|prod|mathop)\b', fragment))


def enrich_snapshot(data):
    """Derive conceptual edits and exact source spans from diff opcodes."""
    for f in data['files']:
        groups = []
        pieces = f['pieces']
        old_offsets, new_offsets = [0], [0]
        for p in pieces:
            old_offsets.append(old_offsets[-1] + len(p['old']))
            new_offsets.append(new_offsets[-1] + len(p['new']))
        i = 0
        while i < len(pieces):
            p = pieces[i]
            if 'id' not in p:
                i += 1
                continue
            parts = [p]
            first = i
            i += 1
            while i + 1 < len(pieces):
                bridge, following = pieces[i:i + 2]
                # Retained spaces, punctuation, and math delimiters inside one
                # replacement do not form independent conceptual edits.
                if ('id' in bridge or 'id' not in following
                        or not re.fullmatch(r'[\s{},_^\[\]()\-+*/=<>|\\]*', bridge['old'])
                        or re.search(r'\n[ \t]*\n', bridge['old'])):
                    break
                parts.extend([bridge, following])
                i += 2
            members = [q['id'] for q in parts if 'id' in q]
            groups.append({'id': stable_id('edit', [f['path'], str(old_offsets[first]), str(old_offsets[i]), ''.join(q['new'] for q in parts)]), 'members': members,
                           'base_span': [old_offsets[first], old_offsets[i]],
                           'proposal_span': [new_offsets[first], new_offsets[i]],
                           'start': first, 'stop': i,
                           'old': ''.join(q['old'] for q in parts),
                           'new': ''.join(q['new'] for q in parts),
                           'removed': sum(q.get('removed', 0) for q in parts),
                           'added': sum(q.get('added', 0) for q in parts),
                           'math': nontrivial_latex_at(f['before'] or '', old_offsets[first], old_offsets[i])
                                   or nontrivial_latex_at(f['after'] or '', new_offsets[first], new_offsets[i])})
        f['edits'] = groups
        lookup = {member: group for group in groups for member in group['members']}
        for h in f['hunks']:
            segments = h['segments']
            h['piece_ids'] = [p['id'] for p in segments if 'id' in p]
            h['id'] = stable_id('passage', [f['path'], *map(str, h['base_span'])])
            h['before'] = ''.join(p.get('text', p.get('old', '')) for p in segments)
            h['after'] = ''.join(p.get('text', p.get('new', '')) for p in segments)
            grouped, skip = [], set()
            for i, p in enumerate(segments):
                if i in skip:
                    continue
                if 'id' not in p:
                    grouped.append(p)
                    continue
                g = lookup[p['id']]
                grouped.append(g)
                if len(g['members']) > 1:
                    last = next(j for j in range(i, len(segments)) if segments[j].get('id') == g['members'][-1])
                    skip.update(range(i + 1, last + 1))
            h['edits'] = [g for g in grouped if 'members' in g]
            h['grouped_segments'] = grouped
    return data


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args])


def read_blob(repo, revision, path):
    result = subprocess.run(['git', '-C', str(repo), 'show', f'{revision}:{path}'],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return result.stdout.decode('utf-8') if result.returncode == 0 else None


def word_count(text):
    return len(re.findall(r"\w+(?:['’]\w+)*", text))


def compare(path, before, after):
    old, new = before or '', after or ''
    a, b = TOKEN.findall(old), TOKEN.findall(new)
    assert ''.join(a) == old and ''.join(b) == new
    pieces, spans = [], []
    offsets = [0]
    for token in a:
        offsets.append(offsets[-1] + len(token))
    for tag, i1, i2, j1, j2 in token_opcodes(a, b):
        piece = {'old': ''.join(a[i1:i2]), 'new': ''.join(b[j1:j2])}
        if tag != 'equal':
            piece['id'] = f'{path}:{len(pieces)}'
            piece['removed'] = word_count(piece['old'])
            piece['added'] = word_count(piece['new'])
        pieces.append(piece)
        spans.append((offsets[i1], offsets[i2], piece))
    hunks = []
    # Show whole source paragraphs, so the context never starts inside an equation
    # or command. The decision units still use the exact word/symbol opcodes.
    ranges = []
    for start, end, piece in spans:
        if 'id' not in piece:
            continue
        left = old.rfind('\n\n', 0, start)
        left = left + 2 if left >= 0 else 0
        right = old.find('\n\n', end)
        right = right if right >= 0 else len(old)
        if ranges and left <= ranges[-1][1]:
            ranges[-1][1] = max(ranges[-1][1], right)
        else:
            ranges.append([left, right])
    for start, end in ranges:
        segments = []
        for lo, hi, piece in spans:
            if 'id' in piece:
                if start <= lo and hi <= end:
                    segments.append(piece)
            elif lo < end and hi > start:
                segments.append({'text': old[max(start, lo):min(end, hi)]})
        new_start = sum(len(p['new']) for lo, hi, p in spans if hi <= start and lo < start)
        # Paragraph boundaries lie in retained text; include its partial prefix.
        for lo, hi, p in spans:
            if lo < start < hi and 'id' not in p:
                new_start += start - lo
                break
        new_length = sum(len(p.get('text', p.get('new', ''))) for p in segments)
        hunks.append({'base_span': [start, end], 'proposal_span': [new_start, new_start + new_length],
                      'segments': segments, 'line': old[:start].count('\n') + 1,
                      'leading': start > 0, 'trailing': end < len(old)})
    result = {'path': path, 'before': before, 'after': after, 'pieces': pieces,
              'hunks': hunks, 'supporting': not path.endswith(('.tex', '.bib')),
              'status': 'new' if before is None else 'deleted' if after is None else 'modified'}
    # A new/deleted file is a single decision, even if empty.
    if before is None or after is None:
        result['pieces'] = [{'id': f'{path}:file', 'old': old, 'new': new,
                             'removed': word_count(old), 'added': word_count(new)}]
        result['hunks'] = [{'base_span': [0, len(old)], 'proposal_span': [0, len(new)],
                            'segments': result['pieces'], 'line': 1,
                            'leading': False, 'trailing': False}]
    return result


def build_snapshot(repo, base, proposed, text_only=False):
    repo = Path(repo).resolve()
    base = git(repo, 'rev-parse', '--verify', f'{base}^{{commit}}').decode().strip()
    proposed = git(repo, 'rev-parse', '--verify', f'{proposed}^{{commit}}').decode().strip()
    paths = git(repo, 'diff', '--no-renames', '--name-only', '-z', base, proposed).decode().split('\0')
    files, skipped = [], []
    for path in filter(None, paths):
        unsupported = False
        for ref in (base, proposed):
            entry = git(repo, 'ls-tree', ref, '--', path).decode()
            if entry and not entry.startswith('100644 '):
                if not text_only:
                    raise ValueError(f'Unsupported file mode for {path}: {entry.split()[0]}')
                unsupported = True
        if unsupported:
            skipped.append(path)
            continue
        try:
            before, after = read_blob(repo, base, path), read_blob(repo, proposed, path)
        except UnicodeError:
            if not text_only:
                raise
            skipped.append(path)
            continue
        if '\0' in (before or '') + (after or ''):
            if not text_only:
                raise ValueError(f'Cannot word-review binary file: {path}')
            skipped.append(path)
            continue
        file = compare(path, before, after)
        enrich_snapshot({'files': [file]})
        assert selected_content(file, {}) == after
        rejected = {g['id']: 'reject' for g in file['edits']}
        assert selected_content(file, rejected) == before
        files.append(file)
    def order(file):
        p = file['path']
        return (file['supporting'], 0 if p.startswith('methods/') else
                1 if p.startswith('supplement/') else 2, p)
    files.sort(key=order)
    return {'version': 2, 'repo': str(repo), 'base': base, 'proposed': proposed,
            'created': datetime.now(timezone.utc).isoformat(), 'token': secrets.token_urlsafe(32),
            'files': files, 'skipped': skipped}


def validate_decisions(data, decisions):
    valid = {g['id'] for f in data['files'] for g in f['edits']}
    if not isinstance(decisions, dict) or not set(decisions) <= valid:
        raise ValueError('Unknown edit in decisions.')
    if any(v not in ('accept', 'reject', 'pending') for v in decisions.values()):
        raise ValueError('Invalid decision value.')


def make_patch(data, decisions):
    result = []
    for f in data['files']:
        old, new = f['before'], selected_content(f, decisions)
        if old == new:
            continue
        path = f['path']
        result.append(f'diff --git a/{path} b/{path}\n')
        if old is None:
            result.append('new file mode 100644\n')
        if new is None:
            result.append('deleted file mode 100644\n')
        for line in difflib.unified_diff((old or '').splitlines(keepends=True),
                                         (new or '').splitlines(keepends=True),
                                         fromfile='/dev/null' if old is None else f'a/{path}',
                                         tofile='/dev/null' if new is None else f'b/{path}'):
            result.append(line if line.endswith('\n') else line + '\n\\ No newline at end of file\n')
    return ''.join(result)

"""Project conceptual decisions onto source; passage edits replace the proposal itself."""
from dataclasses import dataclass


@dataclass(frozen=True)
class SelectedSource:
    content: str | None
    ranges: dict[str, tuple[int, int]]


def group_text(file, group, decisions):
    return group['old'] if decisions.get(group['id']) == 'reject' else group['new']


def project_source(file, decisions):
    groups = {g['start']: g for g in file['edits']}
    content, ranges, index, offset = [], {}, 0, 0
    while index < len(file['pieces']):
        group = groups.get(index)
        if group:
            text = group_text(file, group, decisions)
            ranges[group['id']] = (offset, offset + len(text))
            index = group['stop']
        else:
            text = file['pieces'][index]['new']
            index += 1
        content.append(text)
        offset += len(text)
    absent = (file['status'] == 'new' and decisions.get(file['edits'][0]['id']) == 'reject'
              or file['status'] == 'deleted' and decisions.get(file['edits'][0]['id']) != 'reject')
    return SelectedSource(None if absent else ''.join(content), ranges)


def selected_content(file, decisions):
    return project_source(file, decisions).content


def passage_text(file, hunk, decisions):
    return ''.join(group_text(file, segment, decisions) if 'members' in segment else segment['text']
                   for segment in hunk['grouped_segments'])

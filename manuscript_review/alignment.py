"""Exact token alignment shared by word diffs and source anchors."""
import difflib
import re
from bisect import bisect_left
from collections import Counter

TOKEN = re.compile(r"\\[A-Za-z@]+|\w+|[^\w\s]|\s+")


def unique_anchors(old, new):
    """Return unique shared tokens in a longest increasing sequence."""
    counts = Counter(old)
    positions = {token: i for i, token in enumerate(new) if counts[token] == 1}
    repeated = Counter(new)
    pairs = [(i, positions[token]) for i, token in enumerate(old)
             if token in positions and repeated[token] == 1]
    tails, indices, previous = [], [], []
    for index, (_, target) in enumerate(pairs):
        at = bisect_left(tails, target)
        previous.append(indices[at-1] if at else -1)
        if at == len(tails):
            tails.append(target)
            indices.append(index)
        else:
            tails[at] = target
            indices[at] = index
    result, index = [], indices[-1] if indices else -1
    while index >= 0:
        result.append(pairs[index])
        index = previous[index]
    return result[::-1]


def token_opcodes(old, new):
    prefix = 0
    while prefix < min(len(old), len(new)) and old[prefix] == new[prefix]:
        prefix += 1
    old_end, new_end = len(old), len(new)
    while old_end > prefix and new_end > prefix and old[old_end-1] == new[new_end-1]:
        old_end -= 1
        new_end -= 1
    result = [('equal', 0, prefix, 0, prefix)] if prefix else []
    old_middle, new_middle = old[prefix:old_end], new[prefix:new_end]
    anchors = unique_anchors(old_middle, new_middle) if max(len(old_middle), len(new_middle)) > 2000 else []
    i, k = 0, 0
    for j, l in [*anchors, (len(old_middle), len(new_middle))]:
        for tag, a, b, c, d in difflib.SequenceMatcher(None, old_middle[i:j], new_middle[k:l], autojunk=False).get_opcodes():
            result.append((tag, prefix+i+a, prefix+i+b, prefix+k+c, prefix+k+d))
        if j < len(old_middle):
            result.append(('equal', prefix+j, prefix+j+1, prefix+l, prefix+l+1))
        i, k = j+1, l+1
    if old_end < len(old):
        result.append(('equal', old_end, len(old), new_end, len(new)))
    merged = []
    for opcode in result:
        if merged and opcode[0] == merged[-1][0] and opcode[1] == merged[-1][2] and opcode[3] == merged[-1][4]:
            previous = merged.pop()
            opcode = (opcode[0], previous[1], opcode[2], previous[3], opcode[4])
        merged.append(opcode)
    return merged

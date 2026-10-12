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


def bisect_opcodes(old, new, budget):
    """Linear-space Myers alignment with a shared work bound for repetitive gaps.

    Exhausting the bound keeps the remaining interval as one exact replacement.
    This can widen a diff, but never fabricates equal source or drops wording.
    """
    prefix = 0
    while prefix < min(len(old), len(new)) and old[prefix] == new[prefix]:
        prefix += 1
    old_end, new_end = len(old), len(new)
    while old_end > prefix and new_end > prefix and old[old_end-1] == new[new_end-1]:
        old_end -= 1
        new_end -= 1
    result = [('equal', 0, prefix, 0, prefix)] if prefix else []
    left, right = old[prefix:old_end], new[prefix:new_end]
    n, m = len(left), len(right)
    split = None
    if n and m and budget[0] > 0:
        distance = (n+m+1)//2
        offset = distance+1
        size = 2*distance+3
        forward, backward = [-1]*size, [-1]*size
        forward[offset+1] = backward[offset+1] = 0
        delta, odd = n-m, (n-m)%2 != 0
        for d in range(distance+1):
            if budget[0] <= 0 or split:
                break
            for vector, reverse in ((forward, False), (backward, True)):
                for k in range(-d, d+1, 2):
                    budget[0] -= 1
                    if budget[0] <= 0:
                        break
                    at = offset+k
                    x = vector[at+1] if k == -d or (k != d and vector[at-1] < vector[at+1]) else vector[at-1]+1
                    y = x-k
                    while 0 <= x < n and 0 <= y < m and (left[n-x-1] == right[m-y-1] if reverse else left[x] == right[y]):
                        x += 1
                        y += 1
                        budget[0] -= 1
                        if budget[0] <= 0:
                            break
                    vector[at] = x
                    other = offset+delta-k
                    if reverse == odd or not 0 <= other < size:
                        continue
                    other_x = (forward if reverse else backward)[other]
                    if other_x >= 0 and x+other_x >= n:
                        split = (other_x, other_x-(delta-k)) if reverse else (x,y)
                        break
                if split or budget[0] <= 0:
                    break
    if split and split not in ((0,0),(n,m)):
        x, y = split
        if 0 <= x <= n and 0 <= y <= m:
            middle = bisect_opcodes(left[:x],right[:y],budget)
            middle += [(tag,a+x,b+x,c+y,d+y) for tag,a,b,c,d in bisect_opcodes(left[x:],right[y:],budget)]
        else:
            middle = [('replace',0,n,0,m)]
    else:
        middle = [('replace' if n and m else 'delete' if n else 'insert',0,n,0,m)] if n or m else []
    result += [(tag,a+prefix,b+prefix,c+prefix,d+prefix) for tag,a,b,c,d in middle]
    if old_end < len(old):
        result.append(('equal',old_end,len(old),new_end,len(new)))
    return result


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
    budget = [2_000_000]
    for j, l in [*anchors, (len(old_middle), len(new_middle))]:
        left, right = old_middle[i:j], new_middle[k:l]
        right_counts = Counter(right)
        pairs = sum(count*right_counts.get(token,0) for token,count in Counter(left).items())
        blocks = bisect_opcodes(left,right,budget) if pairs > 100_000 else difflib.SequenceMatcher(None,left,right,autojunk=False).get_opcodes()
        for tag, a, b, c, d in blocks:
            result.append((tag, prefix+i+a, prefix+i+b, prefix+k+c, prefix+k+d))
        if j < len(old_middle):
            result.append(('equal', prefix+j, prefix+j+1, prefix+l, prefix+l+1))
        i, k = j+1, l+1
    if old_end < len(old):
        result.append(('equal', old_end, len(old), new_end, len(new)))
    merged = []
    for opcode in result:
        if merged and (opcode[0] == merged[-1][0] or opcode[0] != 'equal' and merged[-1][0] != 'equal') and opcode[1] == merged[-1][2] and opcode[3] == merged[-1][4]:
            previous = merged.pop()
            tag = 'replace' if opcode[0] != previous[0] else opcode[0]
            opcode = (tag, previous[1], opcode[2], previous[3], opcode[4])
        merged.append(opcode)
    return merged

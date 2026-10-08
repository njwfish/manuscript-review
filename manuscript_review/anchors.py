"""Character spans and conservative mapping between immutable source versions."""
from dataclasses import dataclass
from itertools import accumulate
from .alignment import TOKEN, token_opcodes


@dataclass(frozen=True)
class SourceSpan:
    start: int
    end: int

    def __post_init__(self):
        if self.start < 0 or self.end < self.start:
            raise ValueError('Invalid source span.')

    def overlaps(self, other):
        if self.start == self.end:
            return other.start <= self.start <= other.end
        if other.start == other.end:
            return self.start <= other.start <= self.end
        return self.start < other.end and other.start < self.end


class SourceMap:
    """Reuse one alignment per file; rewritten text maps to its enclosing change."""
    def __init__(self, before, after):
        self.before, self.after = before, after
        old, new = TOKEN.findall(before), TOKEN.findall(after)
        a, b = [0, *accumulate(map(len, old))], [0, *accumulate(map(len, new))]
        self.blocks = []
        if before == after:
            return
        for tag, i, j, k, l in token_opcodes(old, new):
            self.blocks.append((tag, a[i], a[j], b[k], b[l]))

    def project(self, span):
        if span.end > len(self.before):
            raise ValueError('Source anchor is outside its pinned version.')
        if self.before == self.after:
            return span
        if span.start == span.end:
            for tag, a, b, c, d in self.blocks:
                if tag == 'insert' and a == span.start:
                    return SourceSpan(c, d)
        return SourceSpan(self._position(span.start, False), self._position(span.end, True))

    def _position(self, point, end):
        for tag, a, b, c, d in self.blocks:
            inside = a < point <= b if end else a <= point < b
            if inside:
                return c + point - a if tag == 'equal' else d if end else c
        return 0 if point == 0 else len(self.after)

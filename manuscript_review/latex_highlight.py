"""Add color to changed, balanced TeX units without rewriting their contents.

Text uses word granularity. Math keeps commands with their arguments and scripts,
so a changed fraction, accent, or indexed symbol remains a valid TeX atom.
Structural commands (environments, labels, spacing, algorithm control flow) are
left intact; their visible arguments are compared normally.
"""
import re
from .alignment import TOKEN, token_opcodes

COMMAND = re.compile(r'\\[A-Za-z@]+\*?|\\.')
MATH_ENVS = {'equation', 'equation*', 'align', 'align*', 'aligned', 'gather',
             'gather*', 'multline', 'multline*', 'displaymath', 'math', 'array'}
METADATA = {'label', 'includegraphics', 'input', 'include', 'bibliography',
            'bibliographystyle', 'setcounter', 'addtocounter', 'newcommand',
            'renewcommand', 'providecommand', 'captionsetup', 'vspace', 'hspace'}
TEXT_ARGS = {'text', 'textrm', 'textsf', 'textnormal', 'textbf', 'textit',
             'emph', 'mbox', 'caption', 'caption*', 'contcaption', 'conttablecaption',
             'section', 'subsection', 'subsubsection', 'paragraph',
             'For', 'ForAll', 'If', 'ElsIf', 'While', 'Until', 'Function', 'Procedure'}
BARE_ARGS = {'frac': 2, 'dfrac': 2, 'tfrac': 2, 'binom': 2,
             'not': 1,
             'mathcal': 1, 'mathbb': 1, 'mathbf': 1, 'mathrm': 1, 'mathsf': 1,
             'mathit': 1, 'mathnormal': 1, 'boldsymbol': 1, 'bm': 1,
             'widehat': 1, 'hat': 1, 'bar': 1, 'overline': 1, 'tilde': 1,
             'widetilde': 1, 'vec': 1, 'sqrt': 1, 'operatorname': 1,
             'underbrace': 1, 'overbrace': 1}
MATH_STRUCTURE = {'begin', 'end', 'label', 'tag', 'nonumber', 'notag',
                  'limits', 'nolimits', 'displaystyle', 'textstyle',
                  'scriptstyle', 'scriptscriptstyle', 'rm', 'bf', 'it',
                  'quad', 'qquad', ',', ';', '!', ':', ' ', '\\',
                  'right', 'middle', 'big', 'Big', 'bigg', 'Bigg',
                  'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'Biggl', 'Biggr'}


def changed_ranges(before, after, side):
    tokens = [list(TOKEN.finditer(s)) for s in (before, after)]
    opcodes = token_opcodes([m.group() for m in tokens[0]], [m.group() for m in tokens[1]])
    index = 0 if side == 'before' else 1
    ranges = []
    for op, a, b, c, d in opcodes:
        if op != 'equal':
            for m in tokens[index][a:b] if index == 0 else tokens[index][c:d]:
                if m.group().strip():
                    ranges.append((m.start(), m.end()))
    return ranges


class Units:
    def __init__(self, source):
        self.source = source
        self.units = []

    def whitespace(self, i):
        while i < len(self.source) and self.source[i].isspace():
            i += 1
        return i

    def group_end(self, i, opening='{', closing='}'):
        s, depth = self.source, 0
        while i < len(s):
            if s[i] == '\\':
                m = COMMAND.match(s, i)
                i = m.end() if m else i + 1
                continue
            if s[i] == '%':
                i = s.find('\n', i)
                if i < 0:
                    return len(s)
                continue
            if s[i] == opening:
                depth += 1
            elif s[i] == closing:
                depth -= 1
                if depth == 0:
                    return i + 1
            i += 1
        return len(s)

    def argument_end(self, i):
        i = self.whitespace(i)
        if i >= len(self.source):
            return i
        if self.source[i] == '{':
            return self.group_end(i)
        if self.source[i] == '\\':
            m = COMMAND.match(self.source, i)
            return self.atom_end(i, m.end(), m.group()[1:]) if m else i + 1
        return i + 1

    def scripts_end(self, i):
        while True:
            j = self.whitespace(i)
            if j < len(self.source) and self.source[j] in '_^':
                i = self.argument_end(j + 1)
            else:
                return i

    def atom_end(self, start, end, command=None):
        s, i = self.source, end
        # Optional root degree belongs to the radical, not to the surrounding math.
        j = self.whitespace(i)
        if command == 'sqrt' and j < len(s) and s[j] == '[':
            i = self.group_end(j, '[', ']')
        if command in BARE_ARGS:
            for _ in range(BARE_ARGS[command]):
                i = self.argument_end(i)
        else:
            while True:
                j = self.whitespace(i)
                if j < len(s) and s[j] == '{':
                    i = self.group_end(j)
                else:
                    break
        limit = re.match(r'\s*\\(?:limits|nolimits)(?![A-Za-z@])', s[i:])
        if limit:
            i += limit.end()
        return self.scripts_end(i)

    def paired_delimiter_end(self, i, end):
        depth = 1
        for m in re.finditer(r'\\(left|right)\b', self.source[i:end]):
            depth += 1 if m[1] == 'left' else -1
            if depth == 0:
                j = self.whitespace(i + m.end())
                delimiter = COMMAND.match(self.source, j)
                return delimiter.end() if delimiter else j + 1
        return end

    def parse(self, start=0, end=None, math=False):
        s = self.source
        end = len(s) if end is None else end
        i = start
        while i < end:
            if s[i].isspace():
                i += 1
                continue
            if s[i] == '%':
                newline = s.find('\n', i, end)
                i = end if newline < 0 else newline + 1
                continue
            if not math and (s[i] == '$' or s.startswith(('\\(', '\\['), i)):
                opener = '$$' if s.startswith('$$', i) else '$' if s[i] == '$' else s[i:i+2]
                closer = {'\\(': '\\)', '\\[': '\\]'}.get(opener, opener)
                j = i + len(opener)
                match = re.search(r'(?<!\\)' + re.escape(closer), s[j:end]) if closer.startswith('$') else re.search(re.escape(closer), s[j:end])
                k = j + match.start() if match else end
                self.parse(j, k, True)
                i = k + len(closer)
                continue
            if s[i] == '{':
                j = self.group_end(i)
                if math and self.scripts_end(j) != j:
                    self.units.append((i, self.scripts_end(j)))
                    i = self.scripts_end(j)
                else:
                    self.parse(i + 1, j - 1, math)
                    i = j
                continue
            if s[i] == '\\':
                m = COMMAND.match(s, i)
                if not m:
                    i += 1
                    continue
                command, j = m.group()[1:], m.end()
                if command in ('begin', 'end'):
                    a = self.whitespace(j)
                    b = self.group_end(a) if a < end and s[a] == '{' else j
                    env = s[a+1:b-1]
                    if command == 'begin' and env in MATH_ENVS:
                        stop = s.find('\\end{' + env + '}', b, end)
                        if stop >= 0:
                            body = self.whitespace(b)
                            if env == 'array':
                                if body < stop and s[body] == '[':
                                    body = self.whitespace(self.group_end(body, '[', ']'))
                                if body < stop and s[body] == '{':
                                    body = self.group_end(body)
                            self.parse(body, stop, True)
                            i = stop + len('\\end{' + env + '}')
                            continue
                    i = b
                    a = self.whitespace(i)
                    if a < end and s[a] == '[':
                        i = self.group_end(a, '[', ']')
                    continue
                if command in METADATA:
                    a = self.whitespace(j)
                    if a < end and s[a] == '[':
                        a = self.group_end(a, '[', ']')
                    while True:
                        a = self.whitespace(a)
                        if a < end and s[a] == '{':
                            a = self.group_end(a)
                        else:
                            break
                    i = a
                    continue
                if command in TEXT_ARGS:
                    a = self.whitespace(j)
                    if a < end and s[a] == '[':
                        a = self.group_end(a, '[', ']')
                    while True:
                        a = self.whitespace(a)
                        if a < end and s[a] == '{':
                            b = self.group_end(a)
                            self.parse(a+1, b-1, False)
                            a = b
                        else:
                            break
                    i = a
                    continue
                if math and command == 'left':
                    a = self.whitespace(j)
                    delimiter = COMMAND.match(s, a)
                    b = delimiter.end() if delimiter else a + 1
                    k = self.paired_delimiter_end(b, end)
                    # A changed delimiter needs the complete balanced expression.
                    right = s.rfind('\\right', b, k)
                    self.units.append((i, k, ((i, b), (right, k))))
                    self.parse(b, k - (2 if s[k-2:k].startswith('\\') else 1), True)
                    i = k
                    continue
                if math and command not in MATH_STRUCTURE:
                    k = self.atom_end(i, j, command)
                    self.units.append((i, k))
                    i = k
                    continue
                if not math and command not in {'State', 'Statex', 'Require', 'Ensure',
                        'Return', 'EndFor', 'EndIf', 'Else', 'EndWhile', 'EndFunction',
                        'EndProcedure', 'small', 'footnotesize', 'normalsize', 'item',
                        'noindent', 'par', 'begingroup', 'endgroup'}:
                    k = j
                    a = self.whitespace(k)
                    while a < end and s[a] == '[':
                        k = self.group_end(a, '[', ']')
                        a = self.whitespace(k)
                    while a < end and s[a] == '{':
                        k = self.group_end(a)
                        a = self.whitespace(k)
                    self.units.append((i, k))
                    i = k
                    continue
                # Algorithm commands and declarations stay outside color groups.
                # Their braced text/math is visited on subsequent iterations.
                i = j
                continue
            if s[i] in '{}&' or (math and s[i] in '_^'):
                i = self.argument_end(i+1) if s[i] in '_^' else i+1
                continue
            if math:
                j = self.scripts_end(i+1)
            else:
                word = re.match(r'[^\s\\{}$%&]+', s[i:end])
                j = i + len(word.group()) if word else i+1
            self.units.append((i, j))
            i = j
        return self.units


def highlight_changes(before, after, side):
    source = before if side == 'before' else after
    changes = changed_ranges(before, after, side)
    units = Units(source).parse()
    marked = []
    for unit in units:
        lo, hi = unit[:2]
        tests = unit[2] if len(unit) == 3 else ((lo, hi),)
        if any(a < test_hi and b > test_lo for test_lo, test_hi in tests for a, b in changes):
            marked.append((lo, hi))
    # Outer atoms supersede their nested ranges; adjacent words may share color.
    ranges = []
    for lo, hi in sorted(marked, key=lambda r: (r[0], -r[1])):
        if ranges and lo <= ranges[-1][1]:
            ranges[-1] = (ranges[-1][0], max(hi, ranges[-1][1]))
        else:
            ranges.append((lo, hi))
    macro = 'reviewRemove' if side == 'before' else 'reviewAdd'
    content = source
    for lo, hi in reversed(ranges):
        # The macro expands to TeX grouping, preserving math atom classes. Its
        # argument braces also preserve following text spaces, which a literal
        # endgroup control word would otherwise consume while tokenizing.
        content = content[:lo] + '\\' + macro + '{' + content[lo:hi] + '}' + content[hi:]
    return content

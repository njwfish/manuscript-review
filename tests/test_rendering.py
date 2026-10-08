import unittest
from manuscript_review.comparison import compare, enrich_snapshot
from manuscript_review.render_latex import render_context
from manuscript_review.latex_highlight import highlight_changes, Units

class RenderingTests(unittest.TestCase):
    def test_render_context_clips_document_wrappers_without_losing_equations(self):
        source = "\\documentclass{article}\n\\begin{document}\nText.\n\n\\[E=2\\]\n\\end{document}\n"
        rendered = render_context(source, [source.index('\\[E=2'), len(source)])
        self.assertIn("\\[E=2\\]", rendered)
        self.assertNotIn('end{document}', rendered)
        self.assertNotIn('documentclass', render_context(source, [0, len(source)]))

    def test_render_context_preserves_algorithm_and_math_blocks(self):
        source = 'Intro.\n\n\\begin{algorithm}[t]\n\\begin{algorithmic}\n\n\\State Old.\n\n\\State Other.\n\\end{algorithmic}\n\\end{algorithm}\n\nEnd.'
        start = source.index('\\State Old.')
        context = render_context(source, [start, start + len('\\State Old.')])
        self.assertIn('\\begin{algorithm}[t]', context)
        self.assertIn('\\end{algorithm}', context)
        self.assertNotIn('Intro.', context)
        source = 'Intro.\n\n\\contcaption{Caption one.\n\nCaption two $x$.}\n\nEnd.'
        start = source.index('Caption two $x$.')
        self.assertIn('\\contcaption{', render_context(source, [start, start + len('Caption two $x$.')]))

    def test_repeated_algorithm_text_uses_the_recorded_passage(self):
        block = '\\begin{algorithm}\n\\begin{algorithmic}\n\n\\State Count cells.\n\n\\State CALCULATION.\n\\end{algorithmic}\n\\end{algorithm}\n'
        source = block.replace('CALCULATION', 'FIRST') + '\n' + block.replace('CALCULATION', 'SECOND')
        position = source.rindex('Count cells.')
        proposed = source[:position] + source[position:].replace('Count cells.', 'Measure cells.', 1)
        file = enrich_snapshot({'files': [compare('algorithms.tex', source, proposed)]})['files'][0]
        passage = file['hunks'][0]
        before = render_context(source, passage['base_span'])
        after = render_context(proposed, passage['proposal_span'])
        self.assertIn('SECOND', before)
        self.assertIn('SECOND', after)
        self.assertNotIn('FIRST', before + after)

    def test_default_math_classification_tracks_changed_formula_not_prose(self):
        source = 'We score cells.\n\n\\[E=2\\]\n'
        f = compare('test.tex', source, source.replace('cells', 'leaves').replace('E=2', 'E=1'))
        enrich_snapshot({'files': [f]})
        self.assertFalse(f['edits'][0]['math'])
        self.assertTrue(f['edits'][1]['math'])
        f = compare('test.tex', 'For $t$ we use one sample.', 'For $t$ we use two samples.')
        enrich_snapshot({'files': [f]})
        self.assertFalse(any(g['math'] for g in f['edits']))

    def test_typeset_highlight_keeps_math_commands_and_scripts_together(self):
        old = r'\[x=\frac{a}{b}+\mathcal I_0+\sum\limits_{i=1}^n x_i\]'
        new = r'\[x=\frac{2a}{b}+\mathcal J_0+\sum\limits_{i=2}^n x_i\]'
        colored = highlight_changes(old, new, 'after')
        for atom in (r'\frac{2a}{b}', r'\mathcal J_0', r'\sum\limits_{i=2}^n'):
            self.assertIn(r'\reviewAdd{' + atom + '}', colored)
        self.assertTrue(colored.startswith(r'\[x='))
        self.assertIn(' x_i', colored)
        # Color uses TeX grouping rather than a braced math atom, preserving
        # relation/operator spacing in the actual typeset formula.
        self.assertNotIn(r'{\color', colored)
        removed = highlight_changes(old, new, 'before')
        self.assertIn(r'\reviewRemove{\frac{a}{b}}', removed)
        self.assertNotIn('reviewAdd{', removed)

    def test_typeset_highlight_preserves_algorithm_structure_and_metadata(self):
        old = '\\begin{algorithm}\n\\label{old}\n\\For{$i\\in I$}\n\\State sample a cell\n\\EndFor\n\\end{algorithm}'
        new = old.replace('{old}', '{new}').replace('I$', '\\mathcal I$').replace('a cell', 'a hidden cell')
        colored = highlight_changes(old, new, 'after')
        self.assertIn(r'\For{$i\in \reviewAdd{\mathcal I}$}', colored)
        self.assertIn(r'\State sample a \reviewAdd{hidden} cell', colored)
        self.assertIn(r'\label{new}', colored)
        self.assertIn(r'\EndFor', colored)
        self.assertNotIn(r'\reviewAdd{\For', colored)
        self.assertNotIn(r'\reviewAdd{new', colored)

    def test_typeset_highlight_preserves_original_source_on_both_sides(self):
        import re
        cases = [
            ('Words are short. % old comment\n', 'Words remain short. % new comment\n'),
            (r'\[x=\left(a+b\right)\]', r'\[x=\left[a+c\right]\]'),
            (r'\caption{One $x_1$ sample.}', r'\caption{Two $x_2$ samples.}'),
            (r'\[\begin{array}{cc}a&b\\c&d\end{array}\]', r'\[\begin{array}{rr}a&b\\c&e\end{array}\]'),
        ]
        prefix = re.compile(r'\\review(?:Add|Remove)\{')
        for old, new in cases:
            for side, original in (('before', old), ('after', new)):
                content = highlight_changes(old, new, side)
                plain = content
                while (m := prefix.search(plain)):
                    end = Units(plain).group_end(m.end()-1)
                    plain = plain[:m.start()] + plain[m.end():end-1] + plain[end:]
                self.assertEqual(plain, original)
        colored = highlight_changes(*cases[3], 'after')
        self.assertIn(r'\begin{array}{rr}', colored)
        self.assertIn(r'\reviewAdd{e}', colored)

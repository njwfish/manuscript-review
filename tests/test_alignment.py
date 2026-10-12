import random
import time
import unittest
from manuscript_review.alignment import TOKEN, token_opcodes, bisect_opcodes
from manuscript_review.comparison import compare, enrich_snapshot
from manuscript_review.anchors import SourceMap


class AlignmentTests(unittest.TestCase):
    def assert_reconstruction(self, old, new, blocks):
        left = right = 0
        for tag, a, b, c, d in blocks:
            self.assertEqual((a, c), (left, right))
            if tag == 'equal':
                self.assertEqual(old[a:b], new[c:d])
            left, right = b, d
        self.assertEqual((left, right), (len(old), len(new)))

    def test_repetitive_manuscript_changes_remain_word_edits_without_quadratic_delay(self):
        old = 'We score all nodes and retain the explanation.\n\n' * 100
        new = old.replace('all nodes', 'measured leaves')
        started = time.monotonic()
        snapshot = enrich_snapshot({'files': [compare('main.tex', old, new)]})
        mapping = SourceMap(old, new)
        self.assertLess(time.monotonic()-started, 4)
        self.assert_reconstruction(old, new, mapping.blocks)
        self.assertEqual(len(snapshot['files'][0]['edits']), 100)
        self.assertTrue(all(edit['old'] == 'all nodes' and edit['new'] == 'measured leaves'
                            for edit in snapshot['files'][0]['edits']))

    def test_bounded_alignment_and_exhaustion_preserve_exact_source(self):
        generator = random.Random(7)
        for budget in (0, 40, 100000):
            for _ in range(100):
                old = [generator.randrange(8) for _ in range(generator.randrange(100))]
                new = [generator.randrange(8) for _ in range(generator.randrange(100))]
                self.assert_reconstruction(old, new, bisect_opcodes(old, new, [budget]))
        self.assert_reconstruction(['x']*4000, ['y']*4000, token_opcodes(['x']*4000, ['y']*4000))

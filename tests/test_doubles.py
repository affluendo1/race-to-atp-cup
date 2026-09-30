import unittest

import numpy as np

from generate_site_data import doubles_identifiability


class DoublesIdentifiabilityTests(unittest.TestCase):
    def test_connected_network_has_only_the_expected_common_null_direction(self):
        design = np.array([[1.0, -1.0, 0.0], [0.0, 1.0, -1.0]])
        rank, exposure = doubles_identifiability(design)
        self.assertEqual(rank, 2)
        self.assertTrue(np.allclose(exposure, 0.0))

    def test_extra_null_direction_is_reported(self):
        # Two isolated pair comparisons have two more unresolved directions
        # beyond the ordinary common shift.
        design = np.array([[1.0, -1.0, 0.0, 0.0], [0.0, 0.0, 1.0, -1.0]])
        rank, exposure = doubles_identifiability(design)
        self.assertEqual(rank, 2)
        self.assertTrue(np.all(exposure > 0.05))


if __name__ == "__main__":
    unittest.main()

import unittest

import numpy as np

from model import centred_covariance


class CentredCovarianceTests(unittest.TestCase):
    def test_removes_common_shift_uncertainty(self):
        covariance = np.array([[4.0, 1.0], [1.0, 9.0]])
        centred = centred_covariance(covariance)
        self.assertTrue(np.allclose(centred, centred.T))
        self.assertTrue(np.allclose(centred @ np.ones(2), np.zeros(2)))
        self.assertLess(centred[0, 0], covariance[0, 0])
        self.assertLess(centred[1, 1], covariance[1, 1])


if __name__ == "__main__":
    unittest.main()

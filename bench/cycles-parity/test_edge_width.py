"""Self-check for edge-width.py on a synthetic disc with a known linear falloff.
Run: uv run --no-project --with numpy python -m unittest bench/cycles-parity/test_edge_width.py"""
import importlib.util
import os
import tempfile
import unittest

import numpy

SCRIPT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "edge-width.py")
specification = importlib.util.spec_from_file_location("edge_width", SCRIPT_PATH)
edge_width = importlib.util.module_from_spec(specification)
specification.loader.exec_module(edge_width)

WIDTH = 400
HEIGHT = 300
RADIUS = 100.0
CORE_VALUE = 1.0
BACKGROUND_VALUE = 0.2


def linear_falloff_disc(edge_start_in_radii, edge_end_in_radii):
    rows, columns = numpy.mgrid[0:HEIGHT, 0:WIDTH]
    distance = numpy.hypot(columns - (WIDTH - 1) / 2, rows - (HEIGHT - 1) / 2) / RADIUS
    progress = numpy.clip((distance - edge_start_in_radii) / (edge_end_in_radii - edge_start_in_radii), 0, 1)
    return BACKGROUND_VALUE + (CORE_VALUE - BACKGROUND_VALUE) * (1 - progress)


class EdgeWidthTest(unittest.TestCase):
    def measure(self, luminance):
        return edge_width.measure_edge_width(luminance, RADIUS, (WIDTH - 1) / 2, (HEIGHT - 1) / 2, BACKGROUND_VALUE)

    def test_linear_falloff_reports_its_80_percent_span(self):
        result = self.measure(linear_falloff_disc(0.6, 1.0))
        self.assertAlmostEqual(result["edgeWidthRadii"], 0.8 * 0.4, delta=0.01)
        self.assertAlmostEqual(result["core"], CORE_VALUE, places=6)
        self.assertEqual(result["raysUsed"], edge_width.RAY_COUNT)

    def test_wider_falloff_reads_wider(self):
        narrow = self.measure(linear_falloff_disc(0.8, 1.0))["edgeWidthRadii"]
        wide = self.measure(linear_falloff_disc(0.4, 1.0))["edgeWidthRadii"]
        self.assertGreater(wide, 2 * narrow)

    def test_size_mismatch_names_the_expected_size(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "wrong-size.f32")
            numpy.zeros(10, dtype="<f4").tofile(path)
            with self.assertRaisesRegex(ValueError, "need 360000"):
                edge_width.load_float_image(path, WIDTH, HEIGHT, 3)


if __name__ == "__main__":
    unittest.main()

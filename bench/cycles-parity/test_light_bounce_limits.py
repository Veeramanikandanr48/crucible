"""Checks for light_bounce_limits.py. Run from the repository root:

  uv run --no-project python -m unittest bench/cycles-parity/test_light_bounce_limits.py
"""
import importlib.util
import os
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
specification = importlib.util.spec_from_file_location("light_bounce_limits", os.path.join(HERE, "light_bounce_limits.py"))
limits = importlib.util.module_from_spec(specification)
specification.loader.exec_module(limits)


def make_object(name, object_type="LIGHT", max_bounces=1024, with_cycles=True):
    cycles = types.SimpleNamespace(max_bounces=max_bounces) if with_cycles else None
    data = types.SimpleNamespace(cycles=cycles) if with_cycles else types.SimpleNamespace()
    return types.SimpleNamespace(name=name, type=object_type, data=data)


class ClearLightBounceLimitsTests(unittest.TestCase):
    def test_a_limited_light_is_cleared_and_its_old_limit_reported(self):
        sun = make_object("sun", max_bounces=2)
        self.assertEqual(limits.clear_light_bounce_limits([sun]), {"sun": 2})
        self.assertEqual(sun.data.cycles.max_bounces, limits.UNLIMITED_LIGHT_BOUNCES)

    def test_an_unlimited_light_is_not_reported(self):
        lamp = make_object("lamp")
        self.assertEqual(limits.clear_light_bounce_limits([lamp]), {})

    def test_meshes_and_lights_without_cycles_settings_are_left_alone(self):
        mesh = make_object("wall", object_type="MESH", max_bounces=3)
        bare = make_object("bare", with_cycles=False)
        self.assertEqual(limits.clear_light_bounce_limits([mesh, bare]), {})
        self.assertEqual(mesh.data.cycles.max_bounces, 3)


if __name__ == "__main__":
    unittest.main()

"""Clears the per-light bounce limit of Cycles lights on a scene, so the original file can be rendered the way the exported JSON is.

The JSON scene format carries one bounce limit for the whole render and no per-light limit, so a light that stops at
two bounces in the original runs to the full limit in the export. Rendering the original with the limits cleared
shows how much of the brightness gap between the two comes from that limit alone.

This module does not import bpy: it reads and writes `light_object.data.cycles.max_bounces` only, so a test can pass
plain stand-in objects.
"""

# Blender's own default for a light's `cycles.max_bounces`; the Cycles kernel treats it as "no limit of its own".
UNLIMITED_LIGHT_BOUNCES = 1024


def clear_light_bounce_limits(light_objects, unlimited=UNLIMITED_LIGHT_BOUNCES):
    """Sets every light's own bounce limit to `unlimited` and returns {light name: limit it had} for the lights that changed.

    Objects that are not lights, and lights whose data has no Cycles settings, are left alone."""
    previous_limits = {}
    for light_object in light_objects:
        if light_object.type != "LIGHT":
            continue
        cycles_settings = getattr(light_object.data, "cycles", None)
        if cycles_settings is None or not hasattr(cycles_settings, "max_bounces"):
            continue
        if cycles_settings.max_bounces == unlimited:
            continue
        previous_limits[light_object.name] = cycles_settings.max_bounces
        cycles_settings.max_bounces = unlimited
    return previous_limits

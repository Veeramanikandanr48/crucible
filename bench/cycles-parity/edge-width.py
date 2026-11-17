"""Measure how wide the soft edge of a lit disc is, in disc radii.

For each image the script casts rays outward from the disc centre, smooths the
luminance along each ray and measures the distance between the 90 percent and
the 10 percent crossing, where 0 percent is the background and 100 percent is
the core. It prints the median over all rays as JSON.

Input is a headerless little-endian float32 file of height x width x channels
values, row 0 at the top. Linear light gives a meaningful edge; make it with
capture-volume-edge.mjs and linearize-display-floats.mjs, or with any tool that
writes scene-linear floats.

Run: uv run --no-project --with numpy python bench/cycles-parity/edge-width.py \
    --width 960 --height 540 --channels 3 --radius 174.79775107469544 frame.f32
"""
import argparse
import json
import os
import sys

import numpy

RAY_COUNT = 360
SAMPLES_PER_RAY = 800
RAY_LENGTH_IN_RADII = 1.4
CORE_RADIUS_IN_RADII = 0.1
SMOOTHING_TAPS = 9
UPPER_FRACTION = 0.9
LOWER_FRACTION = 0.1
REC709_LUMINANCE_WEIGHTS = (0.2126, 0.7152, 0.0722)


def load_float_image(path, width, height, channels):
    expected_values = width * height * channels
    values = numpy.fromfile(path, dtype="<f4")
    if values.size != expected_values:
        raise ValueError(
            f"{path} holds {values.size} float32 values but --width {width} --height {height} "
            f"--channels {channels} need {expected_values}; pass the size the frame was written with"
        )
    return values.reshape(height, width, channels)


def luminance_of(image):
    if image.shape[2] == 1:
        return image[..., 0]
    if image.shape[2] < 3:
        raise ValueError("--channels must be 1 or at least 3 so luminance can be computed")
    red_weight, green_weight, blue_weight = REC709_LUMINANCE_WEIGHTS
    return red_weight * image[..., 0] + green_weight * image[..., 1] + blue_weight * image[..., 2]


def core_luminance(luminance, center_x, center_y, radius):
    rows, columns = numpy.mgrid[0:luminance.shape[0], 0:luminance.shape[1]]
    distance = numpy.hypot(columns - center_x, rows - center_y)
    return float(luminance[distance < CORE_RADIUS_IN_RADII * radius].mean())


def sample_bilinear(luminance, sample_x, sample_y):
    left = sample_x.astype(int)
    top = sample_y.astype(int)
    across = sample_x - left
    down = sample_y - top
    return (
        luminance[top, left] * (1 - across) * (1 - down)
        + luminance[top, left + 1] * across * (1 - down)
        + luminance[top + 1, left] * (1 - across) * down
        + luminance[top + 1, left + 1] * across * down
    )


def last_index_at_or_above(profile, level):
    indices = numpy.nonzero(profile >= level)[0]
    return int(indices.max()) if indices.size else 0


def edge_width_of_ray(luminance, center_x, center_y, radius, angle, background, core):
    height, width = luminance.shape
    distances = numpy.linspace(0, RAY_LENGTH_IN_RADII * radius, SAMPLES_PER_RAY)
    sample_x = center_x + distances * numpy.cos(angle)
    sample_y = center_y + distances * numpy.sin(angle)
    inside_image = (sample_x >= 0) & (sample_x < width - 1) & (sample_y >= 0) & (sample_y < height - 1)
    if not inside_image.all():
        return None
    profile = sample_bilinear(luminance, sample_x, sample_y)
    profile = numpy.convolve(profile, numpy.ones(SMOOTHING_TAPS) / SMOOTHING_TAPS, mode="same")
    upper_level = background + UPPER_FRACTION * (core - background)
    lower_level = background + LOWER_FRACTION * (core - background)
    upper_index = last_index_at_or_above(profile, upper_level)
    lower_index = last_index_at_or_above(profile, lower_level)
    if lower_index <= upper_index:
        return None
    return (distances[lower_index] - distances[upper_index]) / radius


def measure_edge_width(luminance, radius, center_x, center_y, background):
    core = core_luminance(luminance, center_x, center_y, radius)
    widths = []
    for ray_index in range(RAY_COUNT):
        angle = 2 * numpy.pi * ray_index / RAY_COUNT
        width = edge_width_of_ray(luminance, center_x, center_y, radius, angle, background, core)
        if width is not None:
            widths.append(width)
    if not widths:
        raise ValueError(
            "no ray produced an edge: check --radius and the centre, and that the disc "
            f"and {RAY_LENGTH_IN_RADII} radii around it fit inside the image"
        )
    return {"core": core, "edgeWidthRadii": float(numpy.median(widths)), "raysUsed": len(widths)}


def parse_background_pixel(text):
    parts = text.split(",")
    if len(parts) != 2 or not all(part.strip().isdigit() for part in parts):
        raise argparse.ArgumentTypeError("--background-pixel is COLUMN,ROW, for example 2,2")
    return int(parts[0]), int(parts[1])


def parse_arguments(argument_list):
    parser = argparse.ArgumentParser(description="Median 90%-10% edge width of a disc, in radii.")
    parser.add_argument("images", nargs="+", help="float32 image files, row 0 at the top")
    parser.add_argument("--width", type=int, required=True, help="image width in pixels")
    parser.add_argument("--height", type=int, required=True, help="image height in pixels")
    parser.add_argument("--channels", type=int, required=True, help="values per pixel in the file (3 for RGB, 4 for RGBA)")
    parser.add_argument("--radius", type=float, required=True, help="disc radius in pixels")
    parser.add_argument("--center-x", type=float, help="disc centre column; default (width - 1) / 2")
    parser.add_argument("--center-y", type=float, help="disc centre row; default (height - 1) / 2")
    parser.add_argument("--background", type=float, help="background luminance; default the pixel from --background-pixel")
    parser.add_argument("--background-pixel", type=parse_background_pixel, default=(2, 2), help="COLUMN,ROW sampled for the background (default 2,2)")
    return parser.parse_args(argument_list)


def main(argument_list):
    arguments = parse_arguments(argument_list)
    center_x = arguments.center_x if arguments.center_x is not None else (arguments.width - 1) / 2
    center_y = arguments.center_y if arguments.center_y is not None else (arguments.height - 1) / 2
    results = []
    for path in arguments.images:
        luminance = luminance_of(load_float_image(path, arguments.width, arguments.height, arguments.channels))
        background_column, background_row = arguments.background_pixel
        background = arguments.background if arguments.background is not None else float(luminance[background_row, background_column])
        measurement = measure_edge_width(luminance, arguments.radius, center_x, center_y, background)
        results.append({"image": os.path.basename(path), "background": background, **measurement})
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (ValueError, OSError) as error:
        sys.exit(f"edge-width.py: {error}")

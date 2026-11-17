"""Normal map parity (#1111): Cook against Blender Cycles' Normal Map node on a normal-mapped plane and sphere.

Run from the repository root on a machine with Blender 5.3, Node, a GPU and the Cook native addon:
    uv run --no-project --with numpy python bench/cycles-parity/run-normal-map-parity.py <outputDirectory> [options]

It writes the `normal-*` scenes of texture-scenes.mjs, renders each one with Cycles (the Normal Map node reads the map with its
green channel inverted, see render-cycles.py) and with Cook, and prints the mean ratio, relMSE and the 8 x 8 tile ratios of each.
Options:
    --samples 256  --width 480  --height 270  --bounces 8
    --scenes a,b          only these scenes (default: all normal-* scenes)
    --label before        name of the Cook run in the output
    --instancing          trace with instances instead of one flattened mesh, so the object matrix reaches the kernel
    --reference-scenes a  reference scenes exported with export-scene.mjs and run beside the normal-* ones (default brick-graph,
                          whose wall carries a tangent-space normal map; "none" skips them). The add-on's `maps` scene is built in
                          Blender, so it runs through packages/blender-addon/tests/render_cook_and_cycles.py instead.
A Cook checkout other than the installed package is read through NODE_OPTIONS (an `--import` of a module hook) in the environment.
"""
import glob
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SCENE_PREFIX = "normal-"
DEFAULT_REFERENCE_SCENES = "brick-graph"
TILE_GATE_FRACTION = 0.05
MEAN_GATE_FRACTION = 0.02


def load_sphere_light_runner():
    specification = importlib.util.spec_from_file_location("sphere_light_runner", os.path.join(HERE, "run-sphere-light-parity.py"))
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def export_reference_scenes(runner, output_directory, reference_scene_names):
    for name in reference_scene_names:
        runner.run(["node", os.path.join(HERE, "export-scene.mjs"), output_directory, "--scene", name])


def passes_gates(summary):
    mean_ok = all(abs(ratio - 1.0) <= MEAN_GATE_FRACTION for ratio in summary["meanRatio"])
    tiles_ok = summary["tilesWithinFivePercent"] == summary["tilesEligible"]
    return mean_ok and tiles_ok


def main():
    runner = load_sphere_light_runner()
    argument_list = sys.argv[1:]
    options = {
        "output_directory": os.path.abspath(argument_list[0]),
        "samples": int(runner.read_flag(argument_list, "--samples", "256")),
        "width": int(runner.read_flag(argument_list, "--width", "480")),
        "height": int(runner.read_flag(argument_list, "--height", "270")),
        "bounces": int(runner.read_flag(argument_list, "--bounces", "8")),
    }
    label = runner.read_flag(argument_list, "--label", "cook")
    wanted = [name for name in runner.read_flag(argument_list, "--scenes", "").split(",") if name]
    blender = runner.find_blender()
    os.makedirs(os.path.join(options["output_directory"], "renders"), exist_ok=True)
    runner.run(["node", os.path.join(HERE, "texture-scenes.mjs"), options["output_directory"]])
    reference_flag = runner.read_flag(argument_list, "--reference-scenes", DEFAULT_REFERENCE_SCENES)
    reference_scene_names = [name for name in reference_flag.split(",") if name and name != "none"]
    export_reference_scenes(runner, options["output_directory"], reference_scene_names)
    scene_names = sorted(os.path.basename(path)[:-5] for path in glob.glob(os.path.join(options["output_directory"], "scenes", f"{SCENE_PREFIX}*.json")))
    scene_names += reference_scene_names
    if wanted:
        scene_names = [name for name in scene_names if name in wanted]
    results = {}
    for name in scene_names:
        scene_path = os.path.join(options["output_directory"], "scenes", f"{name}.json")
        cook_prefix = os.path.join(options["output_directory"], "renders", f"{name}-{label}")
        cycles_prefix = os.path.join(options["output_directory"], "renders", f"{name}-cycles")
        runner.render_cook(scene_path, cook_prefix, options, options["bounces"], "--instancing" in argument_list, False)
        runner.render_cycles(blender, scene_path, cycles_prefix, options, options["bounces"], 1, runner.FOLLOW_SCENE, False)
        summary = runner.summarize(f"{cycles_prefix}.npy", f"{cook_prefix}.npy")
        summary["passesGates"] = passes_gates(summary)
        results[name] = summary
        print("PARITY", name, json.dumps({key: value for key, value in summary.items() if key != "tileRatios"}), flush=True)
    with open(os.path.join(options["output_directory"], f"normal-map-{label}.json"), "w", encoding="utf-8") as handle:
        json.dump(results, handle, indent=1)
    print("DONE", len(results))


if __name__ == "__main__":
    main()

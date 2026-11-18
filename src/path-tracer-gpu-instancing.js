// The GLSL the GPU path tracer adds for an instanced scene (see path-tracer-gpu-instance-pack.js for the tables it reads). A scene
// whose copies share one mesh holds that mesh's triangles and bottom-level BVH once; a top-level BVH over the copies holds one
// record per copy: the world to mesh matrix, the mesh to world matrix, the root of its bottom-level BVH and its material.
// The ray of a copy is moved into mesh space without being normalised, so a distance there is the same distance in the world.

/** Texels per instance: three rows of the world to mesh matrix, three columns of the mesh to world matrix, then (bottom-level root node, material, 0, 0). */
export const INSTANCE_TEXELS = 7;

export const INSTANCE_UNIFORMS = `uniform sampler2D uInstances;
uniform int uTopRoot;
const int INSTANCE_TEXELS = ${INSTANCE_TEXELS};
`;

// A flat scene keeps the material in each triangle record and its triangles already sit in world space.
export const FLAT_HIT_STATE = `int nearestMaterialIndex() {
  return int(fetchData(uTriangles, nearestSlot * TRIANGLE_TEXELS).w);
}

vec3 surfaceVectorToWorld(vec3 local) {
  return local;
}

vec3 normalToWorld(vec3 local) {
  return local;
}`;

export const INSTANCE_HIT_STATE = `int nearestInstance = -1;
int nearestMaterial = 0;

int nearestMaterialIndex() {
  return nearestMaterial;
}

// An edge of the nearest triangle, moved from mesh space to the world by the columns of the instance's matrix.
vec3 surfaceVectorToWorld(vec3 local) {
  int base = nearestInstance * INSTANCE_TEXELS;
  return fetchData(uInstances, base + 3).xyz * local.x + fetchData(uInstances, base + 4).xyz * local.y + fetchData(uInstances, base + 5).xyz * local.z;
}

// A vertex normal moves by the transpose of the inverse, which is the transpose of the three rows stored for the ray, and is unit length
// again, as the flattened scene stores it, before the corners are blended (a stretched copy would otherwise weigh its corners unevenly).
vec3 normalToWorld(vec3 local) {
  int base = nearestInstance * INSTANCE_TEXELS;
  vec3 world = fetchData(uInstances, base).xyz * local.x + fetchData(uInstances, base + 1).xyz * local.y + fetchData(uInstances, base + 2).xyz * local.z;
  float worldLength = length(world);
  return world / (worldLength == 0.0 ? 1.0 : worldLength);
}`;

export const INSTANCED_TRACE_RAY = `// Walks the bottom-level BVH of one instance with the ray moved into mesh space; true when an any-hit query found a hit.
bool traceInstance(int instance, vec3 origin, vec3 direction, bool anyHit) {
  int base = instance * INSTANCE_TEXELS;
  vec4 rowX = fetchData(uInstances, base);
  vec4 rowY = fetchData(uInstances, base + 1);
  vec4 rowZ = fetchData(uInstances, base + 2);
  vec4 link = fetchData(uInstances, base + 6);
  vec3 localOrigin = vec3(dot(rowX.xyz, origin) + rowX.w, dot(rowY.xyz, origin) + rowY.w, dot(rowZ.xyz, origin) + rowZ.w);
  vec3 localDirection = vec3(dot(rowX.xyz, direction), dot(rowY.xyz, direction), dot(rowZ.xyz, direction));
  vec3 inverse = safeInverse(localDirection);
  float distanceBefore = nearestDistance;
  int nodeStack[STACK_SIZE];
  float entryStack[STACK_SIZE];
  int stackSize = 1;
  nodeStack[0] = int(link.x);
  entryStack[0] = 0.0;
  bool found = false;
  while (stackSize > 0 && !found) {
    stackSize--;
    int node = nodeStack[stackSize];
    if (!(entryStack[stackSize] < nearestDistance)) continue;
    vec4 header = fetchData(uNodes, node * 2);
    if (header.w < 0.0) {
      found = visitLeaf(node, localOrigin, localDirection, anyHit);
      continue;
    }
    int left = node + 1;
    int right = int(header.w);
    float leftEntry = boxEntry(left, localOrigin, inverse);
    float rightEntry = boxEntry(right, localOrigin, inverse);
    bool nearFirst = leftEntry <= rightEntry;
    nodeStack[stackSize] = nearFirst ? right : left;
    entryStack[stackSize] = nearFirst ? rightEntry : leftEntry;
    nodeStack[stackSize + 1] = nearFirst ? left : right;
    entryStack[stackSize + 1] = nearFirst ? leftEntry : rightEntry;
    stackSize += 2;
  }
  if (nearestDistance < distanceBefore) {
    nearestInstance = instance;
    nearestMaterial = int(link.y);
  }
  return found;
}

void traceRay(vec3 origin, vec3 direction, float limit, bool anyHit) {
  nearestDistance = limit;
  nearestSlot = -1;
  nearestInstance = -1;
  vec3 inverse = safeInverse(direction);
  int nodeStack[STACK_SIZE];
  float entryStack[STACK_SIZE];
  int stackSize = 1;
  nodeStack[0] = uTopRoot;
  entryStack[0] = 0.0;
  while (stackSize > 0) {
    stackSize--;
    int node = nodeStack[stackSize];
    if (!(entryStack[stackSize] < nearestDistance)) continue;
    vec4 header = fetchData(uNodes, node * 2);
    if (header.w < 0.0) {
      int first = int(fetchData(uNodes, node * 2 + 1).w);
      int last = first + int(-header.w);
      for (int instance = first; instance < last; instance++) {
        if (traceInstance(instance, origin, direction, anyHit)) return;
      }
      continue;
    }
    int left = node + 1;
    int right = int(header.w);
    float leftEntry = boxEntry(left, origin, inverse);
    float rightEntry = boxEntry(right, origin, inverse);
    bool nearFirst = leftEntry <= rightEntry;
    nodeStack[stackSize] = nearFirst ? right : left;
    entryStack[stackSize] = nearFirst ? rightEntry : leftEntry;
    nodeStack[stackSize + 1] = nearFirst ? left : right;
    entryStack[stackSize + 1] = nearFirst ? leftEntry : rightEntry;
    stackSize += 2;
  }
}`;

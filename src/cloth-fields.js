import { bakeCloth } from './cloth.js';
import { addFieldAcceleration } from './force-fields.js';

// A drag field slows a particle by `strength * dt` of its speed each substep. Past 1 that overshoots and the speed grows
// with every substep, so a drag can bring a component to rest but never carry it past rest.
function limitedDragChange(velocity, dragChange) {
  return velocity * (velocity + dragChange) < 0 ? -velocity : dragChange;
}

// Adds every field's acceleration to the velocity of every particle for one substep.
function createFieldApplier(fields) {
  const position = [0, 0, 0];
  const velocity = [0, 0, 0];
  const acceleration = [0, 0, 0];
  const dragAcceleration = [0, 0, 0];
  return (positions, velocities, time, substepSeconds) => {
    for (let particle = 0; particle < positions.length / 3; particle++) {
      for (let axis = 0; axis < 3; axis++) {
        position[axis] = positions[particle * 3 + axis];
        velocity[axis] = velocities[particle * 3 + axis];
        acceleration[axis] = 0;
        dragAcceleration[axis] = 0;
      }
      for (const field of fields) {
        addFieldAcceleration(field, position, velocity, time, field.type === 'drag' ? dragAcceleration : acceleration);
      }
      for (let axis = 0; axis < 3; axis++) {
        const dragChange = limitedDragChange(velocity[axis], dragAcceleration[axis] * substepSeconds);
        velocities[particle * 3 + axis] += acceleration[axis] * substepSeconds + dragChange;
      }
    }
  };
}

/** `bakeCloth` with the shared force field evaluation attached. Used inline and by the kernel worker alike. */
export function bakeClothWithFields(positions, triangles, options) {
  return bakeCloth(positions, triangles, options.fields?.length ? { ...options, applyFields: createFieldApplier(options.fields) } : options);
}

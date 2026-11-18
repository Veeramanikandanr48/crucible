import { invalidField } from '../src/field-error.js';

// The preview samples a scene at 0 to place its automatic floor before it samples the time the caller asked for. A scene
// with nothing to sample refuses that 0 with a field named `time`, which the caller never sent, so the refusal is
// restated against the motionTime they did send.
export function sampleMotionAtZeroForGround(scene, requestedMotionTime) {
  try {
    scene.sampleMotion(0);
  } catch (error) {
    if (error.fieldPath !== 'time') {
      throw error;
    }
    throw invalidField('motionTime', requestedMotionTime, 'null, because this scene has no motion, physics, cloth, particles, placed asset clip or grid volume frames to sample; add motion first');
  }
}

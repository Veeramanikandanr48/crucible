import { register } from 'node:module';

register('./browser-root-loader.mjs', import.meta.url);

export const CHUNK_SIZE = 16;
export const RENDER_DISTANCE = 5;
export const MAX_HEIGHT = 64;
export const DEBUG = true;

// New constants for multithreading and optimization
export const WORKER_COUNT = navigator.hardwareConcurrency || 4;
export const TASK_PRIORITY_DISTANCE = CHUNK_SIZE * 2; // Distance at which tasks get priority
export const BUFFER_POOL_SIZE = 50; // Maximum number of buffers to keep in pool
export const ENABLE_FRUSTUM_CULLING = true; // Enable/disable frustum culling
export const DEBUG_FRUSTUM_CULLING = true; // When true, will log frustum culling info
export const ENABLE_MULTITHREADING = true; // Enable/disable multithreading
export const ENABLE_TEXTURE_ATLAS = true; // Enable/disable texture atlas
export const USE_TIGHT_BOUNDS = true; // Use tight bounding boxes for culling
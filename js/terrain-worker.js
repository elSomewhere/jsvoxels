// terrain-worker.js

// Add debug logging
console.log('Worker started successfully at:', self.location.href);

// Get the base URL for imports
const baseUrl = self.location.href.substring(0, self.location.href.lastIndexOf('/') + 1);
console.log('Worker base URL for imports:', baseUrl);

// Import necessary modules with full paths
importScripts(baseUrl + 'constants.js');
importScripts(baseUrl + 'voxel-types.js');
importScripts(baseUrl + 'voxel-data.js');
importScripts(baseUrl + 'world-generator.js');

let worldGenerator = null;

// Initialize required components
function initialize(seed) {
    worldGenerator = new WorldGenerator();
    if (seed !== undefined) {
        worldGenerator.seed = seed;
    }
}

// Add enhanced error handling
self.addEventListener('error', function (e) {
    console.error('Worker error:', e.message, e.filename, e.lineno);
    self.postMessage({
        error: {
            message: e.message,
            filename: e.filename,
            lineno: e.lineno,
            stack: e.error ? e.error.stack : 'Stack not available'
        }
    });
});

// Wrap the onmessage handler in a try-catch to catch runtime errors
const originalOnmessage = function (e) {
    const { taskId, taskType, data } = e.data;

    try {
        if (taskType === 'init') {
            initialize(data.seed);
            self.postMessage({ taskId, result: { initialized: true } });
            return;
        }

        // Ensure world generator is initialized
        if (!worldGenerator) {
            initialize();
        }

        if (taskType === 'generateChunk') {
            const { chunkX, chunkY, chunkZ } = data;

            // Generate the chunk
            const chunk = worldGenerator.generateChunk(chunkX, chunkY, chunkZ);

            // Serialize the chunk data for transfer
            // We'll create a compact representation of the octree
            const serializedChunk = serializeChunk(chunk);

            // Send the result back
            self.postMessage({
                taskId,
                result: {
                    chunkX,
                    chunkY,
                    chunkZ,
                    chunkData: serializedChunk
                }
            }, [serializedChunk.buffer]);
        } else {
            throw new Error(`Unknown task type: ${taskType}`);
        }
    } catch (error) {
        console.error('Error in terrain worker:', error);
        self.postMessage({
            taskId,
            error: {
                message: error.message,
                stack: error.stack
            }
        });
    }
};

self.onmessage = function (e) {
    try {
        originalOnmessage(e);
    } catch (error) {
        console.error('Error in worker:', error);
        self.postMessage({
            taskId: e.data.taskId,
            error: {
                message: error.message,
                stack: error.stack
            }
        });
    }
};

// Serialize a chunk's octree to a flat buffer for efficient transfer
function serializeChunk(chunk) {
    // We'll create a simple format that stores voxel types in a serialized way
    // For a more complex octree, a more sophisticated serialization would be needed

    // This is a simple approach - serialize to array
    const voxelData = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
    let nonEmptyCount = 0;

    // Fill the array with voxel types
    for (let y = 0; y < CHUNK_SIZE; y++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
            for (let x = 0; x < CHUNK_SIZE; x++) {
                const index = (y * CHUNK_SIZE * CHUNK_SIZE) + (z * CHUNK_SIZE) + x;
                const voxelType = chunk.getVoxel(x, y, z);
                voxelData[index] = voxelType;

                if (voxelType !== 0) {
                    nonEmptyCount++;
                }
            }
        }
    }

    return voxelData;
}

// Report that worker is ready
self.postMessage({ ready: true });
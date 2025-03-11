// Worker thread for voxel engine processing
// Import required modules
import { CHUNK_SIZE, MAX_HEIGHT } from './constants.js';
import { VoxelType } from './voxel-types.js';
import { MeshGenerator } from './mesh-generator.js';

// Cache for noise functions and other computations
const noiseCache = new Map();
let seed = Math.random() * 10000;

// Create mesh generator instance
const meshGenerator = new MeshGenerator();

// Initialize worker
console.log('Voxel Engine Worker initialized with CHUNK_SIZE:', CHUNK_SIZE);

// Message handler
self.onmessage = function (e) {
    const { taskId, type, data } = e.data;

    let result;
    let transferables = [];

    try {
        switch (type) {
            case 'generateChunk':
                result = generateChunk(data);
                // If result has a buffer for transferring, add it to transferables
                if (result.voxelData && result.voxelData.buffer) {
                    transferables.push(result.voxelData.buffer);
                }
                break;

            case 'generateMesh':
                result = generateMesh(data);
                // Add buffer for zero-copy transfer
                if (result.vertexBuffer) {
                    transferables.push(result.vertexBuffer.buffer);
                }
                if (result.normalBuffer) {
                    transferables.push(result.normalBuffer.buffer);
                }
                if (result.colorBuffer) {
                    transferables.push(result.colorBuffer.buffer);
                }
                if (result.indexBuffer) {
                    transferables.push(result.indexBuffer.buffer);
                }
                break;

            case 'createCrater':
                result = createCrater(data);
                // Add modified chunk buffers to transferables
                if (result.modifiedChunks) {
                    for (const chunk of result.modifiedChunks) {
                        if (chunk.voxelData && chunk.voxelData.buffer) {
                            transferables.push(chunk.voxelData.buffer);
                        }
                    }
                }
                break;

            case 'setSeed':
                seed = data.seed;
                result = { success: true };
                break;

            default:
                throw new Error(`Unknown task type: ${type}`);
        }

        // Send result back to main thread
        self.postMessage({
            taskId,
            result
        }, transferables);

    } catch (error) {
        // Send error back to main thread
        self.postMessage({
            taskId,
            error: error.message
        });
    }
};

// Chunk generation function
function generateChunk(data) {
    const { chunkX, chunkY, chunkZ } = data;

    // Create serializable chunk data
    const voxelData = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);

    // Calculate world position of chunk
    const worldX = chunkX * CHUNK_SIZE;
    const worldY = chunkY * CHUNK_SIZE;
    const worldZ = chunkZ * CHUNK_SIZE;

    // Generate terrain
    for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
            // World coordinates
            const wx = worldX + x;
            const wz = worldZ + z;

            // Generate a height value using noise
            const baseHeight = getHeight(wx, wz);

            // Fill voxels up to the height
            for (let y = 0; y < CHUNK_SIZE; y++) {
                const wy = worldY + y;
                const index = (y * CHUNK_SIZE * CHUNK_SIZE) + (z * CHUNK_SIZE) + x;

                // Determine voxel type based on height
                let voxelType = VoxelType.AIR;

                if (wy < baseHeight) {
                    // Below surface
                    if (wy < 1) {
                        voxelType = VoxelType.BEDROCK;
                    } else if (wy < baseHeight - 5) {
                        voxelType = VoxelType.STONE;
                    } else if (wy < baseHeight - 1) {
                        voxelType = VoxelType.DIRT;
                    } else {
                        voxelType = VoxelType.GRASS;
                    }

                    // Cave generation
                    if (voxelType !== VoxelType.BEDROCK && getCaveNoise(wx, wy, wz) > 0.7) {
                        voxelType = VoxelType.AIR;
                    }
                } else if (wy < 8) {
                    // Water - keep as opaque water
                    voxelType = VoxelType.WATER;
                }

                voxelData[index] = voxelType;
            }
        }
    }

    return {
        chunkX,
        chunkY,
        chunkZ,
        voxelData
    };
}

// Mesh generation function for worker
function generateMesh(data) {
    const { chunkData, x, y, z, neighbors } = data;

    // Convert flattened data into a format we can work with
    const chunk = {
        getVoxel: function (lx, ly, lz) {
            if (lx < 0 || lx >= CHUNK_SIZE || ly < 0 || ly >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) {
                return 0; // Air for out of bounds (will be handled by neighbor lookup)
            }
            const index = (ly * CHUNK_SIZE * CHUNK_SIZE) + (lz * CHUNK_SIZE) + lx;
            return chunkData[index];
        },
        isEmpty: function () {
            // Check if chunk is completely empty
            for (let i = 0; i < chunkData.length; i++) {
                if (chunkData[i] !== 0) return false;
            }
            return true;
        }
    };

    // Function to get neighboring chunks
    function getNeighborChunk(nx, ny, nz) {
        // Check if this neighbor exists in our provided neighbors
        for (const neighbor of neighbors) {
            if (neighbor.x === nx && neighbor.y === ny && neighbor.z === nz) {
                return {
                    getVoxel: function (lx, ly, lz) {
                        if (lx < 0 || lx >= CHUNK_SIZE || ly < 0 || ly >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) {
                            return 0; // Air for out of bounds
                        }
                        const index = (ly * CHUNK_SIZE * CHUNK_SIZE) + (lz * CHUNK_SIZE) + lx;
                        return neighbor.voxelData[index];
                    }
                };
            }
        }
        return null;
    }

    // Use the mesh generator
    const mesh = meshGenerator.generateMesh(chunk, x, y, z, getNeighborChunk);

    // Convert mesh data to typed arrays for efficient transfer
    const vertexBuffer = new Float32Array(mesh.positions);
    const normalBuffer = new Float32Array(mesh.normals);
    const colorBuffer = new Float32Array(mesh.colors);
    const indexBuffer = new Uint16Array(mesh.indices);

    return {
        x, y, z,
        vertexCount: mesh.indices.length,
        vertexBuffer,
        normalBuffer,
        colorBuffer,
        indexBuffer
    };
}

// Create crater function
function createCrater(data) {
    const { centerX, centerY, centerZ, radius, chunks } = data;

    // Process each affected chunk
    const modifiedChunks = {};

    // We need to track which chunks were actually modified
    const modifiedChunkKeys = new Set();

    // Calculate extended bounding box for the crater to ensure we check all affected voxels
    const minX = Math.floor(centerX - radius - 1);
    const minY = Math.floor(centerY - radius - 1);
    const minZ = Math.floor(centerZ - radius - 1);
    const maxX = Math.ceil(centerX + radius + 1);
    const maxY = Math.ceil(centerY + radius + 1);
    const maxZ = Math.ceil(centerZ + radius + 1);

    // Iterate through the bounding box of the crater
    for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
            for (let z = minZ; z <= maxZ; z++) {
                // Check if this point is within the crater radius
                const dx = x - centerX;
                const dy = y - centerY;
                const dz = z - centerZ;
                const distSquared = dx * dx + dy * dy + dz * dz;

                if (distSquared > radius * radius) continue;

                // Calculate chunk coordinates
                const chunkX = Math.floor(x / CHUNK_SIZE);
                const chunkY = Math.floor(y / CHUNK_SIZE);
                const chunkZ = Math.floor(z / CHUNK_SIZE);
                const chunkKey = `${chunkX},${chunkY},${chunkZ}`;

                // Get or create chunk data
                if (!modifiedChunks[chunkKey]) {
                    // Find this chunk in the provided chunks
                    const chunkData = chunks.find(c =>
                        c.chunkX === chunkX && c.chunkY === chunkY && c.chunkZ === chunkZ
                    );

                    if (chunkData) {
                        // Important: Create a copy of the voxel data to avoid modifying the original
                        modifiedChunks[chunkKey] = {
                            chunkX,
                            chunkY,
                            chunkZ,
                            voxelData: new Uint8Array(chunkData.voxelData)
                        };
                    } else {
                        // Skip if we don't have this chunk's data
                        // It's better to skip than to create a new empty chunk
                        continue;
                    }
                }

                // Calculate local coordinates
                const localX = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
                const localY = ((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
                const localZ = ((z % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;

                // Get current voxel type
                const index = (localY * CHUNK_SIZE * CHUNK_SIZE) + (localZ * CHUNK_SIZE) + localX;
                const chunk = modifiedChunks[chunkKey];

                // Only set to air if it's not already air
                if (chunk.voxelData[index] !== 0) {
                    chunk.voxelData[index] = 0;
                    modifiedChunkKeys.add(chunkKey);

                    // If this voxel is on a chunk boundary, we need to mark neighbor chunks
                    // even if they don't have any voxels changed
                    if (localX === 0 || localX === CHUNK_SIZE - 1 ||
                        localY === 0 || localY === CHUNK_SIZE - 1 ||
                        localZ === 0 || localZ === CHUNK_SIZE - 1) {

                        // Determine which neighbor chunk this affects
                        const neighborOffsets = [];

                        if (localX === 0) neighborOffsets.push([-1, 0, 0]);
                        if (localX === CHUNK_SIZE - 1) neighborOffsets.push([1, 0, 0]);
                        if (localY === 0) neighborOffsets.push([0, -1, 0]);
                        if (localY === CHUNK_SIZE - 1) neighborOffsets.push([0, 1, 0]);
                        if (localZ === 0) neighborOffsets.push([0, 0, -1]);
                        if (localZ === CHUNK_SIZE - 1) neighborOffsets.push([0, 0, 1]);

                        // Add all affected neighbor chunks to the modified set
                        for (const [dx, dy, dz] of neighborOffsets) {
                            const neighborKey = `${chunkX + dx},${chunkY + dy},${chunkZ + dz}`;
                            modifiedChunkKeys.add(neighborKey);

                            // Ensure the neighbor chunk is included in the result even if no voxels change
                            if (!modifiedChunks[neighborKey]) {
                                const neighborData = chunks.find(c =>
                                    c.chunkX === chunkX + dx &&
                                    c.chunkY === chunkY + dy &&
                                    c.chunkZ === chunkZ + dz
                                );

                                if (neighborData) {
                                    modifiedChunks[neighborKey] = {
                                        chunkX: chunkX + dx,
                                        chunkY: chunkY + dy,
                                        chunkZ: chunkZ + dz,
                                        voxelData: new Uint8Array(neighborData.voxelData)
                                    };
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Only return chunks that were actually modified or need to be rebuilt
    const result = [];
    for (const key of modifiedChunkKeys) {
        if (modifiedChunks[key]) {
            result.push(modifiedChunks[key]);
        }
    }

    return {
        modifiedChunks: result
    };
}

// Height map generation
function getHeight(x, z) {
    const cacheKey = `height_${x}_${z}`;
    if (noiseCache.has(cacheKey)) {
        return noiseCache.get(cacheKey);
    }

    // Large scale terrain features
    const mountainHeight = smoothNoise(x * 0.01, z * 0.01) * 40;

    // Medium scale rolling hills
    const hillHeight = smoothNoise(x * 0.05, z * 0.05) * 10;

    // Small scale detail
    const detailHeight = smoothNoise(x * 0.2, z * 0.2) * 3;

    // Combine the different scales
    const height = Math.floor(10 + mountainHeight + hillHeight + detailHeight);

    noiseCache.set(cacheKey, height);
    return height;
}

// Cave noise function
function getCaveNoise(x, y, z) {
    const cacheKey = `cave_${x}_${y}_${z}`;
    if (noiseCache.has(cacheKey)) {
        return noiseCache.get(cacheKey);
    }

    // 3D noise for cave generation
    const noise = smoothNoise3D(x * 0.1, y * 0.1, z * 0.1);

    noiseCache.set(cacheKey, noise);
    return noise;
}

// Noise functions
function smoothNoise(x, z) {
    // Get integer coordinates
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);

    // Get fractional part
    const xf = x - x0;
    const zf = z - z0;

    // Get corners
    const n00 = noise2D(x0, z0);
    const n10 = noise2D(x0 + 1, z0);
    const n01 = noise2D(x0, z0 + 1);
    const n11 = noise2D(x0 + 1, z0 + 1);

    // Interpolate
    const nx0 = lerp(n00, n10, xf);
    const nx1 = lerp(n01, n11, xf);
    return lerp(nx0, nx1, zf);
}

function smoothNoise3D(x, y, z) {
    // Simplified 3D noise
    const xy = smoothNoise(x, y) * 0.5 + 0.5;
    const yz = smoothNoise(y, z) * 0.5 + 0.5;
    const xz = smoothNoise(x, z) * 0.5 + 0.5;

    return (xy + yz + xz) / 3;
}

function noise2D(x, z) {
    // Simple hash function with seed
    const n = Math.sin(x * 12.9898 + z * 78.233 + seed) * 43758.5453;
    return n - Math.floor(n);
}

function lerp(a, b, t) {
    // Smooth interpolation
    const t2 = (1 - Math.cos(t * Math.PI)) / 2;
    return a * (1 - t2) + b * t2;
}
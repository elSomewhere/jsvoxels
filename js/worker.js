// Worker thread for voxel engine processing
// Import required modules
import { CHUNK_SIZE, MAX_HEIGHT } from './constants.js';
import { VoxelType } from './voxel-types.js';

// Cache for noise functions and other computations
const noiseCache = new Map();
let seed = Math.random() * 10000;

// Texture data storage for worker
let textureData = {};

// Initialize worker
console.log('Voxel Engine Worker initialized');

// Message handler
self.onmessage = function (e) {
    const { taskId, type, data } = e.data;

    let result;
    let transferables = [];

    try {
        switch (type) {
            case 'initializeTextures':
                textureData = data.textureData;
                result = { success: true };
                break;

            case 'generateChunk':
                result = generateChunk(data);
                // If result has a buffer for transferring, add it to transferables
                if (result.buffer) {
                    transferables.push(result.buffer);
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
                if (result.uvBuffer) {
                    transferables.push(result.uvBuffer.buffer);
                }
                break;

            case 'createCrater':
                result = createCrater(data);
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
            type,
            data: result,
            transferables
        }, transferables);

    } catch (error) {
        // Send error back to main thread
        self.postMessage({
            taskId,
            type,
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
                    // Water
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
        voxelData,
        buffer: voxelData.buffer
    };
}

// Mesh generation function for worker
function generateMesh(data) {
    const { chunkData, x, y, z, neighbors } = data;

    // Convert flattened data into a format we can work with
    const chunk = {
        getVoxel: function (lx, ly, lz) {
            if (lx < 0 || lx >= CHUNK_SIZE || ly < 0 || ly >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) {
                // Try to get voxel from neighbor chunks
                for (const neighbor of neighbors) {
                    if ((lx < 0 && neighbor.x === x - 1) ||
                        (lx >= CHUNK_SIZE && neighbor.x === x + 1) ||
                        (ly < 0 && neighbor.y === y - 1) ||
                        (ly >= CHUNK_SIZE && neighbor.y === y + 1) ||
                        (lz < 0 && neighbor.z === z - 1) ||
                        (lz >= CHUNK_SIZE && neighbor.z === z + 1)) {

                        // Convert coordinates to neighbor's local space
                        let nx = lx, ny = ly, nz = lz;
                        if (lx < 0) nx = CHUNK_SIZE + lx;
                        else if (lx >= CHUNK_SIZE) nx = lx - CHUNK_SIZE;

                        if (ly < 0) ny = CHUNK_SIZE + ly;
                        else if (ly >= CHUNK_SIZE) ny = ly - CHUNK_SIZE;

                        if (lz < 0) nz = CHUNK_SIZE + lz;
                        else if (lz >= CHUNK_SIZE) nz = lz - CHUNK_SIZE;

                        // Get voxel from neighbor data
                        const index = (ny * CHUNK_SIZE * CHUNK_SIZE) + (nz * CHUNK_SIZE) + nx;
                        return neighbor.voxelData[index];
                    }
                }
                return 0; // Default to air if no neighbor found
            }

            const index = (ly * CHUNK_SIZE * CHUNK_SIZE) + (lz * CHUNK_SIZE) + lx;
            return chunkData[index];
        }
    };

    // Generate mesh data
    const positions = [];
    const normals = [];
    const colors = [];
    const indices = [];
    const uvs = [];
    let indexOffset = 0;

    // Implementation of greedy meshing algorithm similar to mesher.js
    // This is a simplified version for the worker

    // Helper functions for meshing
    function isTransparent(voxelType) {
        return voxelType === 0 || voxelType === VoxelType.WATER;
    }

    function getColor(voxelType, face) {
        // Color lookup based on voxel type and face
        switch (voxelType) {
            case VoxelType.GRASS:
                if (face === 'top') return [0.3, 0.75, 0.3, 1.0];
                if (face === 'bottom') return [0.5, 0.3, 0.1, 1.0];
                return [0.4, 0.5, 0.2, 1.0];
            case VoxelType.DIRT:
                return [0.5, 0.3, 0.1, 1.0];
            case VoxelType.STONE:
                return [0.5, 0.5, 0.5, 1.0];
            case VoxelType.BEDROCK:
                return [0.2, 0.2, 0.2, 1.0];
            case VoxelType.WATER:
                return [0.0, 0.3, 0.8, 0.7];
            default:
                return [1.0, 0.0, 1.0, 1.0]; // Magenta for unknown types
        }
    }

    function getTextureUVs(voxelType, face) {
        // Get texture coordinates from the texture data
        if (!textureData[voxelType]) {
            return [0, 0, 1, 0, 1, 1, 0, 1]; // Default UVs
        }

        let mapping = textureData[voxelType][face];
        if (!mapping) {
            mapping = textureData[voxelType].all;
        }

        if (!mapping) {
            return [0, 0, 1, 0, 1, 1, 0, 1]; // Default UVs
        }

        const tileSize = 16;
        const atlasSize = 256;

        const u0 = mapping.tileX * tileSize / atlasSize;
        const v0 = mapping.tileY * tileSize / atlasSize;
        const u1 = (mapping.tileX + 1) * tileSize / atlasSize;
        const v1 = (mapping.tileY + 1) * tileSize / atlasSize;

        return [u0, v0, u1, v0, u1, v1, u0, v1];
    }

    // For each of the 3 axis directions
    for (let dim = 0; dim < 3; dim++) {
        // Setup axes based on current dimension
        const u = (dim + 1) % 3;
        const v = (dim + 2) % 3;
        const w = dim;

        // Direction vectors for u, v, w
        const uDir = [0, 0, 0];
        const vDir = [0, 0, 0];
        const wDir = [0, 0, 0];

        uDir[u] = 1;
        vDir[v] = 1;
        wDir[w] = 1;

        // Face names and normals based on dimension and direction
        const posDirection = ['right', 'top', 'front']; // +X, +Y, +Z
        const negDirection = ['left', 'bottom', 'back']; // -X, -Y, -Z
        const posNormals = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]; // +X, +Y, +Z
        const negNormals = [[-1, 0, 0], [0, -1, 0], [0, 0, -1]]; // -X, -Y, -Z

        // Iterate through each slice of the dimension
        for (let wValue = 0; wValue < CHUNK_SIZE; wValue++) {
            // Two masks for each direction (positive and negative)
            const maskPos = Array(CHUNK_SIZE).fill().map(() =>
                Array(CHUNK_SIZE).fill({ voxelType: 0, transparent: true, visible: false })
            );

            const maskNeg = Array(CHUNK_SIZE).fill().map(() =>
                Array(CHUNK_SIZE).fill({ voxelType: 0, transparent: true, visible: false })
            );

            // Fill both masks for this slice
            for (let vValue = 0; vValue < CHUNK_SIZE; vValue++) {
                for (let uValue = 0; uValue < CHUNK_SIZE; uValue++) {
                    // Set coordinates based on current dimension
                    const x1 = (dim === 0) ? wValue : ((dim === 1) ? uValue : uValue);
                    const y1 = (dim === 0) ? uValue : ((dim === 1) ? wValue : vValue);
                    const z1 = (dim === 0) ? vValue : ((dim === 1) ? vValue : wValue);

                    // Get current voxel
                    const voxel = chunk.getVoxel(x1, y1, z1);
                    const isTransparent1 = isTransparent(voxel);

                    // Get adjacent voxel in positive direction
                    let x2 = x1 + wDir[0];
                    let y2 = y1 + wDir[1];
                    let z2 = z1 + wDir[2];

                    const voxelPos = chunk.getVoxel(x2, y2, z2);
                    const isTransparent2 = isTransparent(voxelPos);

                    // Determine if faces should be created
                    // For positive direction: current solid, next transparent
                    if (voxel !== 0 && (voxelPos === 0 || (isTransparent2 && !isTransparent1))) {
                        maskPos[vValue][uValue] = {
                            voxelType: voxel,
                            transparent: isTransparent1,
                            visible: true
                        };
                    }

                    // For negative direction: current transparent, next solid
                    if (voxelPos !== 0 && (voxel === 0 || (!isTransparent2 && isTransparent1))) {
                        maskNeg[vValue][uValue] = {
                            voxelType: voxelPos,
                            transparent: isTransparent2,
                            visible: true
                        };
                    }
                }
            }

            // Perform greedy meshing on the masks
            // Positive direction mask
            indexOffset = greedyMeshDirection(
                maskPos, dim, wValue, wDir, uDir, vDir, posDirection[dim],
                posNormals[dim], positions, normals, colors, indices, uvs, indexOffset
            );

            // Negative direction mask
            indexOffset = greedyMeshDirection(
                maskNeg, dim, wValue, wDir, uDir, vDir, negDirection[dim],
                negNormals[dim], positions, normals, colors, indices, uvs, indexOffset
            );
        }
    }

    // Helper function to perform greedy meshing on a mask
    function greedyMeshDirection(mask, dim, wValue, wDir, uDir, vDir, faceName, normal,
        positions, normals, colors, indices, uvs, indexOffset) {
        const size = CHUNK_SIZE;

        // Create a visited mask
        const visited = Array(size).fill().map(() => Array(size).fill(false));

        // For each position in the slice
        for (let vStart = 0; vStart < size; vStart++) {
            for (let uStart = 0; uStart < size; uStart++) {
                // Skip if already visited or not visible
                if (visited[vStart][uStart] || !mask[vStart][uStart].visible) {
                    continue;
                }

                // Get voxel type at this position
                const voxelType = mask[vStart][uStart].voxelType;
                const isTransparentVoxel = mask[vStart][uStart].transparent;

                // Find maximum width (u direction)
                let uEnd = uStart;
                while (uEnd + 1 < size &&
                    !visited[vStart][uEnd + 1] &&
                    mask[vStart][uEnd + 1].visible &&
                    mask[vStart][uEnd + 1].voxelType === voxelType &&
                    mask[vStart][uEnd + 1].transparent === isTransparentVoxel) {
                    uEnd++;
                }

                // Find maximum height (v direction)
                let vEnd = vStart;
                let canExpandV = true;

                while (vEnd + 1 < size && canExpandV) {
                    // Check if the entire row can be used
                    for (let u = uStart; u <= uEnd; u++) {
                        if (visited[vEnd + 1][u] ||
                            !mask[vEnd + 1][u].visible ||
                            mask[vEnd + 1][u].voxelType !== voxelType ||
                            mask[vEnd + 1][u].transparent !== isTransparentVoxel) {
                            canExpandV = false;
                            break;
                        }
                    }

                    if (canExpandV) {
                        vEnd++;
                    }
                }

                // Mark all cells in this quad as visited
                for (let v = vStart; v <= vEnd; v++) {
                    for (let u = uStart; u <= uEnd; u++) {
                        visited[v][u] = true;
                    }
                }

                // Create the quad for this merged face
                const width = uEnd - uStart + 1;
                const height = vEnd - vStart + 1;

                // Calculate corner positions based on dimension
                let x1, y1, z1, x2, y2, z2, x3, y3, z3, x4, y4, z4;

                // Set the w coordinate
                const w = wValue + (dim === 0 ? wDir[0] : 0) + (dim === 1 ? wDir[1] : 0) + (dim === 2 ? wDir[2] : 0);

                // Determine coordinates based on dimension
                if (dim === 0) { // X dimension
                    // Order: bottom-left, bottom-right, top-right, top-left
                    x1 = x2 = x3 = x4 = w;
                    z1 = vStart;
                    y1 = uStart;
                    z2 = vStart;
                    y2 = uStart + width;
                    z3 = vStart + height;
                    y3 = uStart + width;
                    z4 = vStart + height;
                    y4 = uStart;
                } else if (dim === 1) { // Y dimension
                    y1 = y2 = y3 = y4 = w;
                    x1 = uStart;
                    z1 = vStart;
                    x2 = uStart + width;
                    z2 = vStart;
                    x3 = uStart + width;
                    z3 = vStart + height;
                    x4 = uStart;
                    z4 = vStart + height;
                } else { // Z dimension
                    z1 = z2 = z3 = z4 = w;
                    x1 = uStart;
                    y1 = vStart;
                    x2 = uStart + width;
                    y2 = vStart;
                    x3 = uStart + width;
                    y3 = vStart + height;
                    x4 = uStart;
                    y4 = vStart + height;
                }

                // Add vertices for this quad
                positions.push(
                    x1, y1, z1,
                    x2, y2, z2,
                    x3, y3, z3,
                    x4, y4, z4
                );

                // Add normals
                for (let i = 0; i < 4; i++) {
                    normals.push(normal[0], normal[1], normal[2]);
                }

                // Add colors or texture coordinates
                if (Object.keys(textureData).length > 0) {
                    // Use texture coordinates if texture data is available
                    const faceUVs = getTextureUVs(voxelType, faceName);
                    uvs.push(...faceUVs);
                } else {
                    // Otherwise use colors
                    const color = getColor(voxelType, faceName);

                    // Simple directional shading
                    const shade = 1.0 - 0.2 * Math.abs(dim);
                    const finalColor = [
                        color[0] * shade,
                        color[1] * shade,
                        color[2] * shade,
                        color[3]
                    ];

                    // Add colors
                    for (let i = 0; i < 4; i++) {
                        colors.push(...finalColor);
                    }
                }

                // Add indices (two triangles)
                indices.push(
                    indexOffset, indexOffset + 1, indexOffset + 2,
                    indexOffset, indexOffset + 2, indexOffset + 3
                );

                indexOffset += 4;
            }
        }

        return indexOffset;
    }

    // Convert to typed arrays for efficient transfer
    const vertexBuffer = new Float32Array(positions);
    const normalBuffer = new Float32Array(normals);
    const colorBuffer = new Float32Array(colors);
    const indexBuffer = new Uint16Array(indices);
    const uvBuffer = new Float32Array(uvs);

    return {
        x, y, z,
        vertexCount: indices.length,
        vertexBuffer,
        normalBuffer,
        colorBuffer,
        indexBuffer,
        uvBuffer: uvs.length > 0 ? uvBuffer : null
    };
}

// Create crater function
function createCrater(data) {
    const { centerX, centerY, centerZ, radius, chunks } = data;

    // Process each affected chunk
    const modifiedChunks = {};

    // Iterate through the spherical crater volume
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dz = -radius; dz <= radius; dz++) {
                const distSquared = dx * dx + dy * dy + dz * dz;
                if (distSquared > radius * radius) continue;

                const x = centerX + dx;
                const y = centerY + dy;
                const z = centerZ + dz;

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
                        modifiedChunks[chunkKey] = {
                            chunkX,
                            chunkY,
                            chunkZ,
                            voxelData: new Uint8Array(chunkData.voxelData)
                        };
                    } else {
                        // Create new chunk data if not found
                        modifiedChunks[chunkKey] = {
                            chunkX,
                            chunkY,
                            chunkZ,
                            voxelData: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE)
                        };
                    }
                }

                // Set voxel to air (0)
                const localX = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
                const localY = ((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
                const localZ = ((z % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;

                const index = (localY * CHUNK_SIZE * CHUNK_SIZE) + (localZ * CHUNK_SIZE) + localX;
                modifiedChunks[chunkKey].voxelData[index] = 0;
            }
        }
    }

    return {
        modifiedChunks: Object.values(modifiedChunks)
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
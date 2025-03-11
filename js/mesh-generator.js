// mesh-generator.js - Unified meshing implementation for both main thread and workers
import { CHUNK_SIZE } from './constants.js';
import { debugLog } from './math-utils.js';

// Export a class that handles meshing for both main thread and workers
export class MeshGenerator {
    constructor(voxelTypes) {
        this.voxelTypes = voxelTypes;
    }

    // Main meshing function that works for both environments
    generateMesh(chunk, chunkX, chunkY, chunkZ, getNeighborChunk) {
        const positions = [];
        const normals = [];
        const colors = [];
        const indices = [];
        let indexOffset = 0;

        // Skip if chunk is empty
        if (chunk.isEmpty && chunk.isEmpty()) {
            return { positions, normals, colors, indices };
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
                        const voxel = this.getVoxel(chunk, x1, y1, z1, chunkX, chunkY, chunkZ, getNeighborChunk);
                        const isTransparent1 = this.isVoxelTransparent(voxel);

                        // Get adjacent voxel in positive direction
                        let x2 = x1 + wDir[0];
                        let y2 = y1 + wDir[1];
                        let z2 = z1 + wDir[2];

                        const voxelPos = this.getVoxel(chunk, x2, y2, z2, chunkX, chunkY, chunkZ, getNeighborChunk);
                        const isTransparent2 = this.isVoxelTransparent(voxelPos);

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

                // Greedy mesh algorithm for positive direction
                indexOffset = this.greedyMeshDirection(
                    maskPos, dim, wValue, wDir, uDir, vDir, posDirection[dim],
                    posNormals[dim], positions, normals, colors, indices, indexOffset
                );

                // Greedy mesh algorithm for negative direction
                indexOffset = this.greedyMeshDirection(
                    maskNeg, dim, wValue, wDir, uDir, vDir, negDirection[dim],
                    negNormals[dim], positions, normals, colors, indices, indexOffset
                );
            }
        }

        return {
            positions,
            normals,
            colors,
            indices
        };
    }

    // Helper method to get voxel type, handling neighbor chunks correctly
    getVoxel(chunk, x, y, z, chunkX, chunkY, chunkZ, getNeighborChunk) {
        if (x < 0 || x >= CHUNK_SIZE || y < 0 || y >= CHUNK_SIZE || z < 0 || z >= CHUNK_SIZE) {
            // Calculate neighbor chunk coordinates
            let neighborChunkX = chunkX;
            let neighborChunkY = chunkY;
            let neighborChunkZ = chunkZ;

            let nx = x;
            let ny = y;
            let nz = z;

            if (x < 0) {
                neighborChunkX--;
                nx = CHUNK_SIZE + x; // Wrap around to the other side
            } else if (x >= CHUNK_SIZE) {
                neighborChunkX++;
                nx = x - CHUNK_SIZE;
            }

            if (y < 0) {
                neighborChunkY--;
                ny = CHUNK_SIZE + y; // Wrap around to the other side
            } else if (y >= CHUNK_SIZE) {
                neighborChunkY++;
                ny = y - CHUNK_SIZE;
            }

            if (z < 0) {
                neighborChunkZ--;
                nz = CHUNK_SIZE + z; // Wrap around to the other side
            } else if (z >= CHUNK_SIZE) {
                neighborChunkZ++;
                nz = z - CHUNK_SIZE;
            }

            // Try to get the neighbor chunk
            const neighborChunk = getNeighborChunk(neighborChunkX, neighborChunkY, neighborChunkZ);
            if (!neighborChunk) {
                return 0; // Assume air if no neighbor chunk
            }

            // Get voxel from neighbor chunk
            return neighborChunk.getVoxel(nx, ny, nz);
        }

        // Get voxel from current chunk
        return chunk.getVoxel(x, y, z);
    }

    // Check if a voxel type is transparent
    isVoxelTransparent(voxelType) {
        if (this.voxelTypes) {
            return this.voxelTypes.isTransparent(voxelType);
        }
        // Default implementation for workers that might not have voxelTypes
        return voxelType === 0 || voxelType === 5; // 5 is water
    }

    // Get color for a voxel type and face
    getVoxelColor(voxelType, face) {
        if (this.voxelTypes) {
            return this.voxelTypes.getColor(voxelType, face);
        }

        // Default implementation for workers
        switch (voxelType) {
            case 1: // GRASS
                if (face === 'top') return [0.3, 0.75, 0.3, 1.0];
                if (face === 'bottom') return [0.5, 0.3, 0.1, 1.0];
                return [0.4, 0.5, 0.2, 1.0];
            case 2: // BEDROCK
                return [0.2, 0.2, 0.2, 1.0];
            case 3: // STONE
                return [0.5, 0.5, 0.5, 1.0];
            case 4: // DIRT
                return [0.5, 0.3, 0.1, 1.0];
            case 5: // WATER
                return [0.0, 0.3, 0.8, 0.7];
            default:
                return [1.0, 0.0, 1.0, 1.0]; // Magenta for unknown
        }
    }

    // Greedy mesh algorithm for a single direction
    greedyMeshDirection(mask, dim, wValue, wDir, uDir, vDir, faceName, normal, positions, normals, colors, indices, indexOffset) {
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

                // Set the w coordinate with proper offset for the face direction
                const w = wValue + (dim === 0 ? wDir[0] : 0) + (dim === 1 ? wDir[1] : 0) + (dim === 2 ? wDir[2] : 0);

                // Determine coordinates based on dimension
                if (dim === 0) { // X dimension
                    // Order: bottom-left, bottom-right, top-right, top-left
                    x1 = x2 = x3 = x4 = w;
                    y1 = uStart;
                    z1 = vStart;
                    y2 = uStart + width;
                    z2 = vStart;
                    y3 = uStart + width;
                    z3 = vStart + height;
                    y4 = uStart;
                    z4 = vStart + height;
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

                // Add colors
                const color = this.getVoxelColor(voxelType, faceName);

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
}
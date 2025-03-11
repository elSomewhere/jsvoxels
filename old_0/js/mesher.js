import { CHUNK_SIZE } from './constants.js';
import { debugLog } from './math-utils.js';
import { VoxelType, VoxelTypeManager } from './voxel-types.js';

export class Mesher {
    constructor(voxelTypeManager) {
        this.voxelTypes = voxelTypeManager;
    }

    // Generate mesh from chunk data
    generateMesh(chunk, chunkX, chunkY, chunkZ, getNeighborChunk) {
        const positions = [];
        const normals = [];
        const colors = [];
        const indices = [];
        let indexOffset = 0;

        // Skip empty chunks
        if (chunk.isEmpty()) {
            return { positions, normals, colors, indices };
        }

        // Directions for checking adjacent voxels
        const directions = [
            [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
        ];

        // Face names for color selection
        const faceNames = ['right', 'left', 'top', 'bottom', 'front', 'back'];

        // Corresponding face normals
        const faceNormals = [
            [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
        ];

        // Vertex offsets for each face (CCW winding)
        const faceVertices = [
            // Right face (+X)
            [[1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0]],
            // Left face (-X)
            [[0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]],
            // Top face (+Y)
            [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]],
            // Bottom face (-Y)
            [[0, 0, 0], [0, 0, 1], [1, 0, 1], [1, 0, 0]],
            // Front face (+Z)
            [[0, 0, 1], [0, 1, 1], [1, 1, 1], [1, 0, 1]],
            // Back face (-Z)
            [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]
        ];

        // Loop through all voxels in this chunk
        for (let y = 0; y < CHUNK_SIZE; y++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                for (let x = 0; x < CHUNK_SIZE; x++) {
                    const voxelType = chunk.getVoxel(x, y, z);

                    // Skip if air
                    if (voxelType === VoxelType.AIR) continue;

                    // Check all six faces
                    for (let faceDir = 0; faceDir < 6; faceDir++) {
                        const dir = directions[faceDir];
                        const nx = x + dir[0];
                        const ny = y + dir[1];
                        const nz = z + dir[2];

                        // Get neighbor voxel type
                        let neighborVoxel;

                        // Check if neighbor is in another chunk
                        if (nx < 0 || nx >= CHUNK_SIZE || ny < 0 || ny >= CHUNK_SIZE || nz < 0 || nz >= CHUNK_SIZE) {
                            // Calculate neighbor chunk coordinates
                            let neighborChunkX = chunkX;
                            let neighborChunkY = chunkY;
                            let neighborChunkZ = chunkZ;
                            let neighborLocalX = nx;
                            let neighborLocalY = ny;
                            let neighborLocalZ = nz;

                            if (nx < 0) {
                                neighborChunkX--;
                                neighborLocalX += CHUNK_SIZE;
                            } else if (nx >= CHUNK_SIZE) {
                                neighborChunkX++;
                                neighborLocalX -= CHUNK_SIZE;
                            }

                            if (ny < 0) {
                                neighborChunkY--;
                                neighborLocalY += CHUNK_SIZE;
                            } else if (ny >= CHUNK_SIZE) {
                                neighborChunkY++;
                                neighborLocalY -= CHUNK_SIZE;
                            }

                            if (nz < 0) {
                                neighborChunkZ--;
                                neighborLocalZ += CHUNK_SIZE;
                            } else if (nz >= CHUNK_SIZE) {
                                neighborChunkZ++;
                                neighborLocalZ -= CHUNK_SIZE;
                            }

                            // Get neighbor chunk
                            const neighborChunk = getNeighborChunk(neighborChunkX, neighborChunkY, neighborChunkZ);
                            if (neighborChunk) {
                                neighborVoxel = neighborChunk.getVoxel(neighborLocalX, neighborLocalY, neighborLocalZ);
                            } else {
                                // Chunk not loaded, so assume air
                                neighborVoxel = VoxelType.AIR;
                            }
                        } else {
                            // Get voxel from this chunk
                            neighborVoxel = chunk.getVoxel(nx, ny, nz);
                        }

                        // Add face if neighbor is air or transparent
                        if (neighborVoxel === VoxelType.AIR ||
                            (this.voxelTypes.isTransparent(neighborVoxel) &&
                                !this.voxelTypes.isTransparent(voxelType))) {

                            // Get vertices for this face
                            const faceVerts = faceVertices[faceDir];
                            const normal = faceNormals[faceDir];
                            const faceName = faceNames[faceDir];

                            // Get color from voxel type manager
                            const color = this.voxelTypes.getColor(voxelType, faceName);

                            // Simple directional shading
                            const shade = 1.0 - 0.2 * Math.abs(faceDir % 3);
                            const finalColor = [
                                color[0] * shade,
                                color[1] * shade,
                                color[2] * shade,
                                color[3]
                            ];

                            // Add vertices for this face
                            for (let i = 0; i < 4; i++) {
                                const vert = faceVerts[i];
                                positions.push(x + vert[0], y + vert[1], z + vert[2]);
                                normals.push(normal[0], normal[1], normal[2]);
                                colors.push(...finalColor);
                            }

                            // Add two triangles (CCW winding order)
                            indices.push(
                                indexOffset, indexOffset + 1, indexOffset + 2,
                                indexOffset, indexOffset + 2, indexOffset + 3
                            );

                            indexOffset += 4;
                        }
                    }
                }
            }
        }

        return {
            positions,
            normals,
            colors,
            indices
        };
    }
}
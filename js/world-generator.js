import { CHUNK_SIZE, MAX_HEIGHT } from './constants.js';
import { VoxelType } from './voxel-types.js';
import { Chunk } from './voxel-data.js';

export class WorldGenerator {
    constructor() {
        // Seed for reproducible generation
        this.seed = Math.random() * 10000;
    }

    // Generate terrain for a chunk
    generateChunk(chunkX, chunkY, chunkZ) {
        console.log(`WorldGenerator.generateChunk called with: ${chunkX}, ${chunkY}, ${chunkZ}`);
        
        try {
            // Create the chunk
            const chunk = new Chunk();
            
            // Verify the chunk was created properly
            if (!chunk || !chunk.rootNode) {
                console.error("Failed to create valid chunk - rootNode is missing");
                // Create a fallback empty chunk
                const fallbackChunk = new Chunk();
                // Ensure rootNode is explicitly created if missing
                if (!fallbackChunk.rootNode) {
                    try {
                        fallbackChunk.rootNode = new OctreeNode(0, 0, 0, CHUNK_SIZE);
                    } catch (e) {
                        console.error("Failed to create fallback rootNode:", e);
                    }
                }
                return fallbackChunk;
            }
            
            // Store chunk coordinates
            chunk.x = chunkX;
            chunk.y = chunkY;
            chunk.z = chunkZ;
            
            // Calculate world position of chunk
            const worldX = chunkX * CHUNK_SIZE;
            const worldY = chunkY * CHUNK_SIZE;
            const worldZ = chunkZ * CHUNK_SIZE;

            // Generate terrain
            let nonAirVoxels = 0;
            let voxelTypes = {};
            
            // Progressive generation to avoid overwhelming the system
            // Rather than trying to generate the entire chunk at once, do it in sections
            const sectionsPerDimension = 4; // Split into 4x4x4 sections (64 total)
            const sectionSize = CHUNK_SIZE / sectionsPerDimension;
            
            for (let sx = 0; sx < sectionsPerDimension; sx++) {
                for (let sy = 0; sy < sectionsPerDimension; sy++) {
                    for (let sz = 0; sz < sectionsPerDimension; sz++) {
                        // Generate one section at a time
                        try {
                            this.generateChunkSection(
                                chunk, 
                                worldX, worldY, worldZ,
                                sx * sectionSize, sy * sectionSize, sz * sectionSize,
                                sectionSize,
                                nonAirVoxels, voxelTypes
                            );
                        } catch (sectionError) {
                            console.error(`Error generating section (${sx},${sy},${sz}):`, sectionError);
                        }
                    }
                }
            }
            
            console.log(`Chunk generated with ${nonAirVoxels} non-air voxels:`, voxelTypes);
            return chunk;
        } catch (error) {
            console.error(`Error generating chunk at ${chunkX}, ${chunkY}, ${chunkZ}:`, error);
            
            // Return an empty chunk as fallback
            const emptyChunk = new Chunk();
            emptyChunk.x = chunkX;
            emptyChunk.y = chunkY;
            emptyChunk.z = chunkZ;
            return emptyChunk;
        }
    }
    
    // Generate a section of the chunk to avoid overwhelming the system
    generateChunkSection(chunk, worldX, worldY, worldZ, startX, startY, startZ, sectionSize, nonAirVoxels, voxelTypes) {
        // End coordinates (exclusive)
        const endX = Math.min(startX + sectionSize, CHUNK_SIZE);
        const endY = Math.min(startY + sectionSize, CHUNK_SIZE);
        const endZ = Math.min(startZ + sectionSize, CHUNK_SIZE);
        
        for (let x = startX; x < endX; x++) {
            for (let z = startZ; z < endZ; z++) {
                // World coordinates
                const wx = worldX + x;
                const wz = worldZ + z;

                // Generate a height value using noise
                const baseHeight = this.getHeight(wx, wz);

                // Fill voxels up to the height
                for (let y = startY; y < endY; y++) {
                    try {
                        const wy = worldY + y;

                        // Determine voxel type based on height
                        let voxelType = VoxelType.AIR; // Default to air

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
                            if (voxelType !== VoxelType.BEDROCK && this.getCaveNoise(wx, wy, wz) > 0.7) {
                                voxelType = VoxelType.AIR;
                            }
                        } else if (wy < 8) {
                            // Water
                            voxelType = VoxelType.WATER;
                        }

                        // Only set non-air voxels to reduce octree complexity
                        if (voxelType !== VoxelType.AIR) {
                            // Set voxel in chunk safely
                            if (chunk && chunk.rootNode) {
                                try {
                                    chunk.setVoxel(x, y, z, voxelType);
                                    
                                    // Count non-air voxels for debugging
                                    nonAirVoxels++;
                                    voxelTypes[voxelType] = (voxelTypes[voxelType] || 0) + 1;
                                } catch (setError) {
                                    console.error(`Error setting voxel at (${x},${y},${z}):`, setError);
                                }
                            }
                        }
                    } catch (error) {
                        console.error(`Error processing voxel at (${x},${y},${z}):`, error);
                    }
                }
            }
        }
    }

    // Height map generation
    getHeight(x, z) {
        // Large scale terrain features
        const mountainHeight = this.smoothNoise(x * 0.01, z * 0.01) * 40;

        // Medium scale rolling hills
        const hillHeight = this.smoothNoise(x * 0.05, z * 0.05) * 10;

        // Small scale detail
        const detailHeight = this.smoothNoise(x * 0.2, z * 0.2) * 3;

        // Combine the different scales
        return Math.floor(10 + mountainHeight + hillHeight + detailHeight);
    }

    // Cave noise function
    getCaveNoise(x, y, z) {
        // 3D noise for cave generation
        return this.smoothNoise3D(x * 0.1, y * 0.1, z * 0.1);
    }

    // Noise functions
    smoothNoise(x, z) {
        // Get integer coordinates
        const x0 = Math.floor(x);
        const z0 = Math.floor(z);

        // Get fractional part
        const xf = x - x0;
        const zf = z - z0;

        // Get corners
        const n00 = this.noise2D(x0, z0);
        const n10 = this.noise2D(x0 + 1, z0);
        const n01 = this.noise2D(x0, z0 + 1);
        const n11 = this.noise2D(x0 + 1, z0 + 1);

        // Interpolate
        const nx0 = this.lerp(n00, n10, xf);
        const nx1 = this.lerp(n01, n11, xf);
        return this.lerp(nx0, nx1, zf);
    }

    smoothNoise3D(x, y, z) {
        // Simplified 3D noise
        const xy = this.smoothNoise(x, y) * 0.5 + 0.5;
        const yz = this.smoothNoise(y, z) * 0.5 + 0.5;
        const xz = this.smoothNoise(x, z) * 0.5 + 0.5;

        return (xy + yz + xz) / 3;
    }

    noise2D(x, z) {
        // Simple hash function with seed
        const n = Math.sin(x * 12.9898 + z * 78.233 + this.seed) * 43758.5453;
        return n - Math.floor(n);
    }

    lerp(a, b, t) {
        // Smooth interpolation
        const t2 = (1 - Math.cos(t * Math.PI)) / 2;
        return a * (1 - t2) + b * t2;
    }
}
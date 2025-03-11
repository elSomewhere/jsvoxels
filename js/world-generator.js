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
        const chunk = new Chunk();

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
                const baseHeight = this.getHeight(wx, wz);

                // Fill voxels up to the height
                for (let y = 0; y < CHUNK_SIZE; y++) {
                    const wy = worldY + y;

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
                        if (voxelType !== VoxelType.BEDROCK && this.getCaveNoise(wx, wy, wz) > 0.7) {
                            voxelType = VoxelType.AIR;
                        }
                    } else if (wy < 8) {
                        // Water - now opaque
                        voxelType = VoxelType.WATER;
                    }

                    // Set voxel in chunk
                    chunk.setVoxel(x, y, z, voxelType);
                }
            }
        }

        return chunk;
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
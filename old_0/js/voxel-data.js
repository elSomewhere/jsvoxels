import { CHUNK_SIZE, DEBUG } from './constants.js';
import { debugLog } from './math-utils.js';

export class Chunk {
    constructor() {
        this.voxels = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
        this.modified = true;
    }

    getVoxel(x, y, z) {
        if (x < 0 || x >= CHUNK_SIZE || y < 0 || y >= CHUNK_SIZE || z < 0 || z >= CHUNK_SIZE) {
            return 0; // Out of bounds
        }
        const index = (y * CHUNK_SIZE * CHUNK_SIZE) + (z * CHUNK_SIZE) + x;
        return this.voxels[index];
    }

    setVoxel(x, y, z, voxelType) {
        if (x < 0 || x >= CHUNK_SIZE || y < 0 || y >= CHUNK_SIZE || z < 0 || z >= CHUNK_SIZE) {
            return; // Out of bounds
        }
        const index = (y * CHUNK_SIZE * CHUNK_SIZE) + (z * CHUNK_SIZE) + x;
        this.voxels[index] = voxelType;
        this.modified = true;
    }

    isEmpty() {
        // Quick check if chunk is completely empty (all air)
        for (let i = 0; i < this.voxels.length; i++) {
            if (this.voxels[i] !== 0) {
                return false;
            }
        }
        return true;
    }
}
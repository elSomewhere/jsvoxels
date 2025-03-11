import { CHUNK_SIZE } from './constants.js';
import { debugLog } from './math-utils.js';
import { VoxelType } from './voxel-types.js';
import { MeshGenerator } from './mesh-generator.js';

export class Mesher {
    constructor(voxelTypeManager, textureAtlas) {
        this.voxelTypes = voxelTypeManager;
        this.textureAtlas = textureAtlas;

        // Create the mesh generator instance
        this.meshGenerator = new MeshGenerator(this.voxelTypes);
    }

    // Generate mesh using the unified implementation
    generateMesh(chunk, chunkX, chunkY, chunkZ, getNeighborChunk) {
        // Use the unified mesh generator
        return this.meshGenerator.generateMesh(chunk, chunkX, chunkY, chunkZ, getNeighborChunk);
    }
}
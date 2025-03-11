import { CHUNK_SIZE, DEBUG } from './constants.js';
import { debugLog } from './math-utils.js';

// Octree node for efficient voxel storage
class OctreeNode {
    constructor(x, y, z, size) {
        this.x = x;
        this.y = y;
        this.z = z;
        this.size = size;
        this.children = null;
        this.voxelType = 0; // 0 = air/empty
        this.isLeaf = true;
    }

    // Split this node into 8 children
    split() {
        if (this.isLeaf && this.size > 1) {
            this.children = [];
            const halfSize = this.size / 2;

            // Create 8 children nodes
            for (let i = 0; i < 8; i++) {
                const childX = this.x + (i & 1 ? halfSize : 0);
                const childY = this.y + (i & 2 ? halfSize : 0);
                const childZ = this.z + (i & 4 ? halfSize : 0);

                const child = new OctreeNode(childX, childY, childZ, halfSize);
                child.voxelType = this.voxelType; // Inherit parent's type
                this.children.push(child);
            }

            this.isLeaf = false;
        }
    }

    // Try to merge children if they all have the same voxel type
    tryMerge() {
        if (!this.isLeaf && this.children) {
            const firstType = this.children[0].voxelType;
            let allSame = true;

            for (let i = 0; i < 8; i++) {
                if (!this.children[i].isLeaf || this.children[i].voxelType !== firstType) {
                    allSame = false;
                    break;
                }
            }

            if (allSame) {
                this.voxelType = firstType;
                this.children = null;
                this.isLeaf = true;
                return true;
            }
        }
        return false;
    }

    // Get the voxel type at a specific position
    get(x, y, z) {
        // If this is a leaf node, return its type
        if (this.isLeaf) {
            return this.voxelType;
        }

        // Otherwise, find which child contains the position
        const halfSize = this.size / 2;
        const childIndex = ((x >= this.x + halfSize) ? 1 : 0) +
            ((y >= this.y + halfSize) ? 2 : 0) +
            ((z >= this.z + halfSize) ? 4 : 0);

        return this.children[childIndex].get(x, y, z);
    }

    // Set the voxel type at a specific position
    set(x, y, z, voxelType) {
        // Base case: we're at a leaf node of size 1 (single voxel)
        if (this.size === 1) {
            this.voxelType = voxelType;
            return;
        }

        // If this is a leaf but size > 1, we need to split it
        if (this.isLeaf) {
            // No need to split if setting to the same type
            if (this.voxelType === voxelType) {
                return;
            }
            this.split();
        }

        // Find which child contains the position
        const halfSize = this.size / 2;
        const childIndex = ((x >= this.x + halfSize) ? 1 : 0) +
            ((y >= this.y + halfSize) ? 2 : 0) +
            ((z >= this.z + halfSize) ? 4 : 0);

        // Recursively set in the child
        this.children[childIndex].set(x, y, z, voxelType);

        // Try to merge children if possible
        this.tryMerge();
    }

    // Check if the node contains any non-air voxels
    isEmpty() {
        return this.isLeaf && this.voxelType === 0;
    }

    // Visit all leaf nodes with a callback
    visitLeaves(callback) {
        if (this.isLeaf) {
            callback(this);
        } else {
            for (let i = 0; i < 8; i++) {
                this.children[i].visitLeaves(callback);
            }
        }
    }

    // Serialize the node for worker transfer
    serialize() {
        const nodeData = {
            x: this.x,
            y: this.y,
            z: this.z,
            size: this.size,
            voxelType: this.voxelType,
            isLeaf: this.isLeaf
        };

        if (!this.isLeaf && this.children) {
            nodeData.children = this.children.map(child => child.serialize());
        }

        return nodeData;
    }

    // Create node from serialized data
    static deserialize(data) {
        const node = new OctreeNode(data.x, data.y, data.z, data.size);
        node.voxelType = data.voxelType;
        node.isLeaf = data.isLeaf;

        if (!data.isLeaf && data.children) {
            node.children = data.children.map(childData => OctreeNode.deserialize(childData));
        }

        return node;
    }
}

export class Chunk {
    constructor() {
        // Create the root octree node for this chunk
        this.rootNode = new OctreeNode(0, 0, 0, CHUNK_SIZE);
        this.modified = true;
        this.nonEmptyVoxelCount = 0;
    }

    getVoxel(x, y, z) {
        if (x < 0 || x >= CHUNK_SIZE || y < 0 || y >= CHUNK_SIZE || z < 0 || z >= CHUNK_SIZE) {
            return 0; // Out of bounds
        }
        return this.rootNode.get(x, y, z);
    }

    setVoxel(x, y, z, voxelType) {
        if (x < 0 || x >= CHUNK_SIZE || y < 0 || y >= CHUNK_SIZE || z < 0 || z >= CHUNK_SIZE) {
            return; // Out of bounds
        }

        const oldVoxelType = this.getVoxel(x, y, z);
        if (oldVoxelType !== voxelType) {
            this.rootNode.set(x, y, z, voxelType);
            this.modified = true;

            // Update non-empty voxel count
            if (oldVoxelType === 0 && voxelType !== 0) {
                this.nonEmptyVoxelCount++;
            } else if (oldVoxelType !== 0 && voxelType === 0) {
                this.nonEmptyVoxelCount--;
            }
        }
    }

    isEmpty() {
        return this.rootNode.isEmpty();
    }

    // Used for debugging/visualization
    countNodes() {
        let count = 0;

        function countRecursive(node) {
            count++;
            if (!node.isLeaf) {
                for (let i = 0; i < 8; i++) {
                    countRecursive(node.children[i]);
                }
            }
        }

        countRecursive(this.rootNode);
        return count;
    }

    // Fill with array data (for compatibility)
    fillFromArray(voxelData) {
        for (let y = 0; y < CHUNK_SIZE; y++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                for (let x = 0; x < CHUNK_SIZE; x++) {
                    const index = (y * CHUNK_SIZE * CHUNK_SIZE) + (z * CHUNK_SIZE) + x;
                    const voxelType = voxelData[index];
                    // Always update the voxel, even if it's 0 (air)
                    this.setVoxel(x, y, z, voxelType);
                }
            }
        }
    }

    // Serialize chunk to flat array for worker transfer
    serialize() {
        const voxelData = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);

        // Fill array with voxel data
        for (let y = 0; y < CHUNK_SIZE; y++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                for (let x = 0; x < CHUNK_SIZE; x++) {
                    const index = (y * CHUNK_SIZE * CHUNK_SIZE) + (z * CHUNK_SIZE) + x;
                    voxelData[index] = this.getVoxel(x, y, z);
                }
            }
        }

        return voxelData;
    }

    // Serialize octree structure for worker transfer
    serializeOctree() {
        return this.rootNode.serialize();
    }

    // Deserialize from octree data
    static deserializeOctree(data) {
        const chunk = new Chunk();
        chunk.rootNode = OctreeNode.deserialize(data);

        // Recalculate non-empty voxel count
        chunk.nonEmptyVoxelCount = 0;

        chunk.rootNode.visitLeaves(node => {
            if (node.voxelType !== 0) {
                // Calculate number of voxels in this leaf node
                const voxelCount = node.size * node.size * node.size;
                chunk.nonEmptyVoxelCount += voxelCount;
            }
        });

        return chunk;
    }
}
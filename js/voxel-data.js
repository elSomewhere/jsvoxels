import { CHUNK_SIZE, DEBUG } from './constants.js';
import { debugLog } from './math-utils.js';

// Create a temporary class for circular reference workaround
let tempOctreeNodeClass;

// Node pool for efficient octree node allocation and reuse
class OctreeNodePool {
    constructor(octreeNodeClass, initialSize = 1000) {
        this.pool = [];
        this.stats = {
            created: 0,
            reused: 0,
            returned: 0,
            poolSize: 0
        };
        
        this.octreeNodeClass = octreeNodeClass;
        
        // Pre-allocate some nodes
        this.expandPool(initialSize);
    }
    
    // Add more nodes to the pool
    expandPool(count) {
        for (let i = 0; i < count; i++) {
            const node = new this.octreeNodeClass(0, 0, 0, 0);
            node._fromPool = true;
            this.pool.push(node);
        }
        this.stats.poolSize = this.pool.length;
    }
    
    // Get a node from the pool or create a new one
    getNode(x, y, z, size) {
        try {
            let node;
            
            if (this.pool.length > 0) {
                // Reuse an existing node
                node = this.pool.pop();
                this.stats.reused++;
                
                // Initialize with new values
                node.x = x;
                node.y = y;
                node.z = z;
                node.size = size;
                node.voxelType = 0;
                node.isLeaf = true;
                node.children = null;
                node.childMask = 0;
            } else {
                // Create a new node
                node = new this.octreeNodeClass(x, y, z, size);
                node._fromPool = true;
                this.stats.created++;
            }
            
            this.stats.poolSize = this.pool.length;
            return node;
        } catch (error) {
            console.error("Error in getNode:", error);
            // Return a basic node as fallback
            try {
                return new this.octreeNodeClass(x, y, z, size);
            } catch (e) {
                console.error("Failed to create fallback node:", e);
                return null;
            }
        }
    }
    
    // Return a node to the pool
    returnNode(node) {
        if (!node || !node._fromPool) return;
        
        // Clear references for GC
        if (node.children) {
            // Make sure all children are properly released first
            for (let i = 0; i < node.children.length; i++) {
                if (node.children[i]) {
                    this.returnNode(node.children[i]);
                }
            }
            node.children = null;
        }
        
        // Reset ALL node properties to initial values
        node.x = 0;
        node.y = 0;
        node.z = 0;
        node.size = 0;
        node.voxelType = 0; // Reset voxel type to air
        node.isLeaf = true; // Reset to leaf state
        node.childMask = 0; // Reset child mask
        
        // Add the node back to the pool
        this.pool.push(node);
        this.stats.returned++;
        this.stats.poolSize = this.pool.length;
        
        // Debug log occasionally to monitor pool health
        if (DEBUG && this.stats.returned % 1000 === 0) {
            debugLog(`Node pool stats: created=${this.stats.created}, reused=${this.stats.reused}, returned=${this.stats.returned}, pool size=${this.stats.poolSize}`);
        }
    }
    
    // Return all nodes from an octree to the pool
    returnOctree(rootNode) {
        if (!rootNode) return;
        
        // Use a non-recursive approach to avoid stack overflow with large trees
        const nodesToProcess = [rootNode];
        let nodeCount = 0;
        
        while (nodesToProcess.length > 0) {
            const node = nodesToProcess.pop();
            
            // Add children to processing queue
            if (node && !node.isLeaf && node.children) {
                for (let i = 0; i < node.children.length; i++) {
                    if (node.children[i]) {
                        nodesToProcess.push(node.children[i]);
                        nodeCount++;
                    }
                }
            }
            
            // Return this node to the pool
            this.returnNode(node);
        }
        
        // Log how many nodes were returned for debugging
        if (DEBUG) {
            debugLog(`Returned ${nodeCount + 1} nodes to pool`);
        }
    }
    
    // Get pool statistics
    getStats() {
        return {...this.stats};
    }
}

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
        this._fromPool = false;
        this.childMask = 0; // Bit mask for active children (for sparse optimization)
    }

    // Split this node into eight child nodes
    split() {
        if (!this.isLeaf) return; // Already split
        
        try {
            // Reset child mask before we start
            this.childMask = 0;
            
            // Always create a fresh children array - don't reuse existing one
            this.children = [];
            
            const halfSize = this.size / 2;
            if (halfSize < 1) {
                console.warn("Cannot split node smaller than 1", this);
                return; // Cannot split nodes smaller than size 1
            }
            
            // Create children in a traditional loop
            for (let i = 0; i < 8; i++) {
                const childX = this.x + (i & 1 ? halfSize : 0);
                const childY = this.y + (i & 2 ? halfSize : 0);
                const childZ = this.z + (i & 4 ? halfSize : 0);

                let child = null;
                
                // Create child nodes directly without pooling to avoid pooling issues
                try {
                    child = new OctreeNode(childX, childY, childZ, halfSize);
                    child.voxelType = this.voxelType; // Inherit parent's type
                } catch (err) {
                    console.error(`Error creating child ${i}:`, err);
                    // Create a minimal placeholder with the essential properties
                    child = {
                        x: childX,
                        y: childY,
                        z: childZ,
                        size: halfSize,
                        voxelType: this.voxelType,
                        isLeaf: true,
                        childMask: 0,
                        get: function(x, y, z) { return this.voxelType; },
                        set: function(x, y, z, v) { this.voxelType = v; }
                    };
                }
                
                // Double-check children array still exists
                if (!this.children) {
                    console.warn("Children array was lost during split. Re-creating.");
                    this.children = [];
                }
                
                // Push to children array
                this.children.push(child);
                
                // Set the bit in the child mask
                this.childMask |= (1 << i);
            }

            // Sanity check before proceeding
            if (!this.children || this.children.length < 8) {
                console.error(`Split failed: Created ${this.children ? this.children.length : 0}/8 children`);
                // If we don't have all 8 children, pad the array
                if (this.children) {
                    while (this.children.length < 8) {
                        const i = this.children.length;
                        const childX = this.x + (i & 1 ? halfSize : 0);
                        const childY = this.y + (i & 2 ? halfSize : 0);
                        const childZ = this.z + (i & 4 ? halfSize : 0);
                        
                        // Create a minimal placeholder
                        const placeholder = {
                            x: childX,
                            y: childY,
                            z: childZ,
                            size: halfSize,
                            voxelType: this.voxelType,
                            isLeaf: true,
                            childMask: 0,
                            get: function(x, y, z) { return this.voxelType; },
                            set: function(x, y, z, v) { this.voxelType = v; }
                        };
                        
                        this.children.push(placeholder);
                        this.childMask |= (1 << i);
                    }
                } else {
                    // We lost the children array entirely, revert to leaf
                    this.isLeaf = true;
                    return;
                }
            }
            
            // Successfully created all 8 children
            this.isLeaf = false;
            
        } catch (error) {
            console.error("Error in split:", error);
            // Reset to initial state if split fails
            this.children = null;
            this.childMask = 0;
            this.isLeaf = true;
        }
    }
    
    // Check if a child exists at index
    hasChildAt(index) {
        return !this.isLeaf && (this.childMask & (1 << index)) !== 0;
    }
    
    // Get child at index (may be null if sparse)
    getChildAt(index) {
        if (this.isLeaf || !this.hasChildAt(index)) return null;
        return this.children[this.getChildArrayIndex(index)];
    }
    
    // Convert logical index to array index based on child mask
    getChildArrayIndex(logicalIndex) {
        if (logicalIndex === 0) return 0;
        
        // Count set bits up to the logical index
        let mask = this.childMask & ((1 << logicalIndex) - 1);
        let count = 0;
        
        while (mask) {
            count += mask & 1;
            mask >>= 1;
        }
        
        return count;
    }
    
    // Add a child at the specified index
    addChildAt(index, child) {
        try {
            // Safety check for valid index
            if (index < 0 || index >= 8) {
                console.error(`Invalid child index: ${index} (must be 0-7)`);
                return;
            }
            
            if (this.isLeaf) {
                // Split this node if it's a leaf
                this.split();
                
                // If split failed, return early
                if (this.isLeaf) {
                    console.warn("Split failed in addChildAt");
                    return;
                }
            }
            
            // Double-check children array exists
            if (!this.children) {
                console.warn("Creating children array in addChildAt");
                this.children = [];
                // Fill array with placeholders if needed
                while (this.children.length < 8) {
                    this.children.push(null);
                }
            }
            
            // Check if we're replacing an existing child or adding a new one
            const oldHasChild = this.hasChildAt(index);
            const childArrayIndex = oldHasChild ? this.getChildArrayIndex(index) : -1;
            
            // For replacing a child: Return the old one to pool if possible
            if (oldHasChild && childArrayIndex >= 0 && childArrayIndex < this.children.length) {
                try {
                    const oldChild = this.children[childArrayIndex];
                    if (oldChild && typeof nodePool !== 'undefined' && nodePool) {
                        nodePool.returnNode(oldChild);
                    }
                } catch (e) {
                    console.warn("Failed to return old child to pool:", e);
                }
            }
            
            // Count how many children we have before this index
            let insertPos = 0;
            let bitMask = 1;
            for (let i = 0; i < index; i++) {
                if (this.childMask & bitMask) {
                    insertPos++;
                }
                bitMask <<= 1;
            }
            
            // Safety check on insert position
            if (insertPos < 0) {
                insertPos = 0;
            } else if (insertPos > this.children.length) {
                insertPos = this.children.length;
            }
            
            // Insert or replace the child
            if (oldHasChild) {
                // Replace existing child
                this.children[insertPos] = child;
            } else {
                // Insert new child
                try {
                    this.children.splice(insertPos, 0, child);
                } catch (e) {
                    console.error("Error in splice operation:", e);
                    // Fallback: just append to the end
                    this.children.push(child);
                }
                
                // Update child mask to include this child
                this.childMask |= (1 << index);
            }
        } catch (error) {
            console.error(`Error in addChildAt(${index}):`, error);
        }
    }
    
    // Remove child at index
    removeChildAt(index) {
        try {
            if (this.isLeaf || !this.hasChildAt(index)) return;
            
            // Ensure children array exists
            if (!this.children) {
                console.warn("Cannot remove child: children array is null");
                return;
            }
            
            // Find array index
            const arrayIndex = this.getChildArrayIndex(index);
            
            // Check array index bounds
            if (arrayIndex < 0 || arrayIndex >= this.children.length) {
                console.error(`Invalid array index ${arrayIndex} when removing child at index ${index}`);
                return;
            }
            
            // Return child to pool if nodePool is available
            if (this.children[arrayIndex] && typeof nodePool !== 'undefined' && nodePool) {
                try {
                    nodePool.returnNode(this.children[arrayIndex]);
                } catch (e) {
                    console.warn("Error returning node to pool:", e);
                }
            }
            
            // Remove from array
            this.children.splice(arrayIndex, 1);
            
            // Update child mask
            this.childMask &= ~(1 << index);
            
            // If no more children, become a leaf
            if (this.childMask === 0) {
                this.children = null;
                this.isLeaf = true;
            }
        } catch (error) {
            console.error(`Error in removeChildAt(${index}):`, error);
        }
    }

    // Try to merge children if they all have the same voxel type
    tryMerge() {
        if (!this.isLeaf && this.children) {
            // Early return if not all 8 children exist or some are not leaves
            if (this.childMask !== 0xFF) return false;
            
            const firstChild = this.children[0];
            if (!firstChild.isLeaf) return false;
            
            const firstType = firstChild.voxelType;
            
            // Check if all children have the same voxel type
            for (let i = 1; i < this.children.length; i++) {
                if (!this.children[i].isLeaf || this.children[i].voxelType !== firstType) {
                    return false;
                }
            }
            
            // All children have the same type, can merge
            this.voxelType = firstType;
            
            // Return children to pool before nullifying the reference
            for (let i = 0; i < this.children.length; i++) {
                nodePool.returnNode(this.children[i]);
            }
            
            this.children = null;
            this.childMask = 0;
            this.isLeaf = true;
            return true;
        }
        return false;
    }

    // Calculate child index for a given coordinate
    getChildIndexForPosition(x, y, z) {
        const halfSize = this.size / 2;
        return ((x >= this.x + halfSize) ? 1 : 0) +
               ((y >= this.y + halfSize) ? 2 : 0) +
               ((z >= this.z + halfSize) ? 4 : 0);
    }

    // Get the voxel type at a specific position
    get(x, y, z, recursionDepth = 0) {
        try {
            // Safety check for recursion depth to prevent stack overflow
            if (recursionDepth > 20) {
                console.warn(`Excessive recursion depth (${recursionDepth}) in OctreeNode.get at (${x},${y},${z}). Returning default value.`);
                return this.voxelType; // Return current value as fallback
            }
            
            // If this is a leaf node, return its type
            if (this.isLeaf) {
                return this.voxelType;
            }

            // Find which child contains the position
            const childIndex = this.getChildIndexForPosition(x, y, z);
            
            // If child doesn't exist (sparse), inherit parent's type
            if (!this.hasChildAt(childIndex)) {
                return this.voxelType;
            }
            
            // Get array index and child
            const arrayIndex = this.getChildArrayIndex(childIndex);
            
            // Safety check for array access
            if (!this.children || arrayIndex >= this.children.length) {
                console.warn(`Invalid child access in get: index=${arrayIndex}, childLen=${this.children ? this.children.length : 0}`);
                return this.voxelType;
            }
            
            // Recursive call with incremented depth counter
            return this.children[arrayIndex].get(x, y, z, recursionDepth + 1);
        } catch (error) {
            console.error(`Error in OctreeNode.get at (${x},${y},${z}):`, error);
            return 0; // Return air as a safe default
        }
    }

    // Set the voxel type at a specific position
    set(x, y, z, voxelType, recursionDepth = 0) {
        try {
            // Safety check for recursion depth to prevent stack overflow
            if (recursionDepth > 20) {
                console.warn(`Excessive recursion depth (${recursionDepth}) in OctreeNode.set at (${x},${y},${z}). Stopping recursion.`);
                this.voxelType = voxelType; // Just set at current level as best effort
                return;
            }
            
            // Fast path: if setting to same value in a leaf, do nothing
            if (this.isLeaf && this.voxelType === voxelType) {
                return;
            }
            
            // Base case: we're at a leaf node of size 1 (single voxel)
            if (this.size === 1) {
                this.voxelType = voxelType;
                return;
            }

            // Find which child contains the position
            const childIndex = this.getChildIndexForPosition(x, y, z);
            
            // If this is a leaf but size > 1, we need to split it
            if (this.isLeaf) {
                this.split();
                
                // If split failed, we need to exit early
                if (this.isLeaf) {
                    console.warn("Failed to split node during set operation");
                    this.voxelType = voxelType; // Just set at current level as best effort
                    return;
                }
            }
            
            // Check if we actually have children after the split
            if (!this.children || this.children.length === 0) {
                console.warn("No children array after split");
                this.voxelType = voxelType;
                return;
            }
            
            // Get array index of the child
            const arrayIndex = this.getChildArrayIndex(childIndex);
            
            // Create child if it doesn't exist
            if (!this.hasChildAt(childIndex)) {
                const halfSize = this.size / 2;
                const childX = this.x + (childIndex & 1 ? halfSize : 0);
                const childY = this.y + (childIndex & 2 ? halfSize : 0);
                const childZ = this.z + (childIndex & 4 ? halfSize : 0);
                
                let child;
                
                // Try to use nodePool, but fall back to direct creation
                if (typeof nodePool !== 'undefined' && nodePool) {
                    child = nodePool.getNode(childX, childY, childZ, halfSize);
                }
                
                if (!child) {
                    // Create directly if nodePool fails
                    child = new OctreeNode(childX, childY, childZ, halfSize);
                }
                
                child.voxelType = this.voxelType; // Inherit parent's type
                
                this.addChildAt(childIndex, child);
            }

            // Ensure we have a valid child before recursing
            if (this.children && arrayIndex < this.children.length) {
                // Recursively set in the child with incremented depth
                this.children[arrayIndex].set(x, y, z, voxelType, recursionDepth + 1);
                
                // Try to merge children if possible
                this.tryMerge();
            } else {
                console.warn(`Invalid child access: index=${arrayIndex}, children.length=${this.children ? this.children.length : 0}`);
                // As fallback, set voxel type on current node
                this.voxelType = voxelType;
            }
        } catch (error) {
            console.error(`Error in OctreeNode.set at (${x},${y},${z}):`, error);
            // Try to set the voxel type directly as a fallback
            this.voxelType = voxelType;
        }
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
            for (let i = 0; i < this.children.length; i++) {
                this.children[i].visitLeaves(callback);
            }
        }
    }
    
    // Create a more memory-efficient copy of this octree
    // by making newly empty regions sparse
    optimizeTree() {
        if (this.isLeaf) return;
        
        // First optimize children recursively
        for (let i = 0; i < this.children.length; i++) {
            this.children[i].optimizeTree();
        }
        
        // Then identify children that are just air and can be removed
        for (let i = 7; i >= 0; i--) {
            if (this.hasChildAt(i)) {
                const arrayIndex = this.getChildArrayIndex(i);
                const child = this.children[arrayIndex];
                
                if (child.isLeaf && child.voxelType === 0 && this.voxelType === 0) {
                    // This child is an air node and our parent is also air
                    // We can remove it to save memory
                    this.removeChildAt(i);
                }
            }
        }
        
        // Try to merge if we can
        this.tryMerge();
    }
}

// Set up for circular reference
tempOctreeNodeClass = OctreeNode;

// Create the node pool with the OctreeNode class
export const nodePool = new OctreeNodePool(OctreeNode);

export class Chunk {
    constructor() {
        try {
            // First try to get a root node from the pool if available
            if (typeof nodePool !== 'undefined' && nodePool) {
                this.rootNode = nodePool.getNode(0, 0, 0, CHUNK_SIZE);
            }
            
            // If nodePool failed or isn't available, create directly
            if (!this.rootNode) {
                console.log("Creating rootNode directly (nodePool unavailable or failed)");
                this.rootNode = new OctreeNode(0, 0, 0, CHUNK_SIZE);
            }
            
            this.modified = true;
            this.nonEmptyVoxelCount = 0;
        } catch (error) {
            console.error("Error creating chunk:", error);
            // Create a minimal valid chunk as fallback
            this.rootNode = new OctreeNode(0, 0, 0, CHUNK_SIZE);
            this.modified = true;
            this.nonEmptyVoxelCount = 0;
        }
    }

    getVoxel(x, y, z) {
        try {
            if (x < 0 || x >= CHUNK_SIZE || y < 0 || y >= CHUNK_SIZE || z < 0 || z >= CHUNK_SIZE) {
                return 0; // Out of bounds
            }
            
            if (!this.rootNode) {
                console.error("Attempt to get voxel from chunk with no rootNode");
                return 0; // Return air for safety
            }
            
            return this.rootNode.get(x, y, z, 0); // Start recursion count at 0
        } catch (error) {
            console.error(`Error in Chunk.getVoxel(${x},${y},${z}):`, error);
            return 0; // Return air for safety
        }
    }

    setVoxel(x, y, z, voxelType) {
        try {
            if (x < 0 || x >= CHUNK_SIZE || y < 0 || y >= CHUNK_SIZE || z < 0 || z >= CHUNK_SIZE) {
                return; // Out of bounds
            }
            
            if (!this.rootNode) {
                console.error("Attempt to set voxel in chunk with no rootNode");
                // Try to rebuild rootNode as last resort
                this.rootNode = new OctreeNode(0, 0, 0, CHUNK_SIZE);
            }

            const oldType = this.getVoxel(x, y, z);
            
            // Update empty voxel count
            if (oldType === 0 && voxelType !== 0) {
                this.nonEmptyVoxelCount++;
            } else if (oldType !== 0 && voxelType === 0) {
                this.nonEmptyVoxelCount--;
                if (this.nonEmptyVoxelCount < 0) this.nonEmptyVoxelCount = 0;
            }

            // Update octree with safety counter
            this.rootNode.set(x, y, z, voxelType, 0);
            this.modified = true;
        } catch (error) {
            console.error(`Error in Chunk.setVoxel(${x},${y},${z},${voxelType}):`, error);
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
                for (let i = 0; i < node.children.length; i++) {
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
                    if (voxelType !== 0) {
                        this.setVoxel(x, y, z, voxelType);
                    }
                }
            }
        }
    }

    // Clean up resources when chunk is unloaded
    dispose() {
        if (this.rootNode) {
            // Log how many nodes are being returned for debugging
            if (DEBUG) {
                const nodeCount = this.countNodes();
                debugLog(`Disposing chunk with ${nodeCount} nodes`);
            }
            
            // Return all nodes to the pool
            nodePool.returnOctree(this.rootNode);
            
            // Explicitly null out the reference
            this.rootNode = null;
            
            // Reset the non-empty voxel count
            this.nonEmptyVoxelCount = 0;
            
            // Make sure modified flag is set (in case chunk is reused)
            this.modified = true;
        }
    }

    // Optimize the octree structure to minimize memory usage
    optimize() {
        if (this.rootNode) {
            this.rootNode.optimizeTree();
        }
    }
}
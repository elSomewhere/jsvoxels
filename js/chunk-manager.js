import { CHUNK_SIZE, RENDER_DISTANCE } from './constants.js';
import { debugLog } from './math-utils.js';
import { Chunk } from './voxel-data.js';
import { mat4 } from './math-utils.js';
import { initWebGPU, generateMeshWithGPU, isChunkEligibleForGPU, getWebGPUStats, convertMeshFormat } from './webgpu-integration.js';
import { VoxelType } from './voxel-types.js';

// Debug - Log VoxelType to make sure it's imported correctly
console.log("VoxelType imported in chunk-manager.js:", VoxelType);

export class ChunkManager {
    constructor(worldGenerator, renderer) {
        this.worldGenerator = worldGenerator;
        this.renderer = renderer;
        this.chunks = new Map();
        this.meshes = new Map();
        this.dirtyChunks = new Set();
        
        console.log("ChunkManager constructor initialized");
        console.log("WorldGenerator:", this.worldGenerator);
        console.log("Renderer:", this.renderer);
        
        // Debug - Check VoxelType import
        console.log("VoxelType import check:", VoxelType);
        
        // Circular buffer configuration
        this.MAX_CHUNKS = 500; // Maximum number of chunks to keep in memory
        this.CHUNKS_PER_FRAME = 3; // Number of chunks to load/unload per frame
        
        // Initialize the circular buffer
        this.chunkBuffer = new Array(this.MAX_CHUNKS).fill(null);
        this.chunkBufferIndex = 0; // Current position in the buffer
        this.totalChunks = 0; // Track actual number of chunks
        
        // Rendering configuration
        this.RENDER_DISTANCE = 10;
        this.VIEW_HEIGHT = 2; // How many chunks above and below player position to render
        
        // Important: Initialize mesh generation queue
        this.meshGenerationQueue = [];
        this.isProcessingMesh = false;

        // Performance configuration
        this.meshesPerFrame = 3;
        this.lastMeshCreationTime = 0;
        this.meshCreationInterval = 0; // No throttling by default
        this.lastOptimizationTime = 0;
        this.optimizationInterval = 1000; // 1 second between octree optimizations
        this.chunksToOptimizePerFrame = 5;
        
        // Stats
        this.stats = {
            chunksLoaded: 0,
            chunksUnloaded: 0,
            meshesCreated: 0
        };

        // Queue for processing chunks
        this.loadQueue = [];      // Queue for chunks to load
        this.unloadQueue = [];    // Queue for chunks to unload (mainly for cleanup)
        
        // Stats
        this.totalNodes = 0;
        this.cullStats = { total: 0, culled: 0 };
        
        // Initialize mesh generation workers
        this.meshWorkers = [];
        this.meshWorkerQueue = [];
        this.pendingMeshes = new Map();
        
        // Debug - Report initialization
        console.log("ChunkManager initialization complete.");
        console.log("CHUNKS_PER_FRAME:", this.CHUNKS_PER_FRAME);
        console.log("RENDER_DISTANCE:", this.RENDER_DISTANCE);
        console.log("meshGenerationQueue initialized:", this.meshGenerationQueue);
        
        // Create workers based on hardware concurrency
        const workerCount = Math.max(1, navigator.hardwareConcurrency - 1 || 2);
        for (let i = 0; i < workerCount; i++) {
            const worker = new Worker('js/mesher-worker.js');
            
            worker.onmessage = (e) => this.handleWorkerMessage(e, i);
            
            // Initialize worker with constants
            worker.postMessage({
                type: 'init',
                data: {
                    CHUNK_SIZE: CHUNK_SIZE
                }
            });
            
            this.meshWorkers.push({
                worker: worker,
                busy: false
            });
        }
        
        // Track performance statistics
        this.meshGenStats = {
            totalMeshesGenerated: 0,
            meshingTimeTotal: 0,
            meshingTimeAvg: 0,
            queueHighWatermark: 0,
            currentQueueSize: 0
        };

        // WebGPU integration
        this.webgpuInitialized = false;
        this.initWebGPU();
    }

    // Initialize WebGPU if available
    async initWebGPU() {
        try {
            this.webgpuInitialized = await initWebGPU();
        } catch (error) {
            console.error('Error initializing WebGPU:', error);
            this.webgpuInitialized = false;
        }
    }

    // Get a chunk by key
    getChunk(x, y, z) {
        const key = this.getChunkKey(x, y, z);
        return this.chunks.get(key) || null;
    }

    // Check if a chunk exists
    hasChunk(x, y, z) {
        const key = this.getChunkKey(x, y, z);
        return this.chunks.has(key);
    }

    // Get a unique key for a chunk position
    getChunkKey(x, y, z) {
        return `${x},${y},${z}`;
    }

    // Get chunk mesh
    getChunkMesh(x, y, z) {
        return this.meshes.get(this.getChunkKey(x, y, z));
    }

    // Mark chunk as dirty (needs mesh rebuild)
    markChunkDirty(x, y, z) {
        const chunkKey = this.getChunkKey(x, y, z);
        
        if (this.chunks.has(chunkKey)) {
            console.log(`Marking chunk as dirty: ${chunkKey}`);
            this.dirtyChunks.add(chunkKey);
            return true;
        } else {
            console.log(`Cannot mark non-existent chunk as dirty: ${chunkKey}`);
            return false;
        }
    }

    // Add a new chunk to the circular buffer, recycling old slots when needed
    addChunkToBuffer(x, y, z) {
        const key = this.getChunkKey(x, y, z);
        
        // If chunk already exists, do nothing
        if (this.chunks.has(key)) return;
        
        // Check if we need to replace an existing chunk
        if (this.totalChunks >= this.MAX_CHUNKS) {
            // Get the slot to recycle
            const slotIndex = this.chunkBufferIndex;
            const oldChunk = this.chunkBuffer[slotIndex];
            
            // If there's a chunk in this slot, dispose it properly
            if (oldChunk) {
                const oldKey = oldChunk.key;
                
                // Clean up the old chunk
                this.unloadChunkByKey(oldKey);
                
                // For debugging
                debugLog(`Recycled chunk slot ${slotIndex} (replaced ${oldKey})`);
            }
            
            // Advance the buffer index for next time
            this.chunkBufferIndex = (this.chunkBufferIndex + 1) % this.MAX_CHUNKS;
        }
        
        // Create the new chunk
        const chunk = this.createChunk(x, y, z);
        
        // If chunk creation failed, return early
        if (!chunk) {
            console.error(`Failed to create chunk at ${x}, ${y}, ${z}`);
            return null;
        }
        
        // Store the chunk in both the Map and the buffer
        this.chunks.set(key, chunk);
        
        // If not at max capacity, use the next empty slot, otherwise use the current recycled slot
        const useSlot = this.totalChunks < this.MAX_CHUNKS ? this.totalChunks : this.chunkBufferIndex - 1;
        
        // Store in pre-allocated buffer and save key for later recycling
        chunk.key = key; // Store key with the chunk for easy reference
        this.chunkBuffer[useSlot] = chunk;
        
        // Update counters
        if (this.totalChunks < this.MAX_CHUNKS) {
            this.totalChunks++;
        }

        return chunk;
    }

    // Unload a chunk by its key (for internal buffer management)
    unloadChunkByKey(key) {
        if (!this.chunks.has(key)) return;
        
        // Get the chunk
        const chunk = this.chunks.get(key);
        
        // Call dispose on the chunk to release octree nodes back to the pool
        if (chunk && chunk.dispose) {
            console.log(`Disposing chunk with key ${key}`);
            chunk.dispose();
        }
        
        // Delete from the Map
        this.chunks.delete(key);
        
        // Delete mesh if it exists
        if (this.meshes.has(key)) {
            const mesh = this.meshes.get(key);
            this.renderer.deleteMesh(mesh);
            this.meshes.delete(key);
        }
        
        // Remove from dirty chunks if present
        this.dirtyChunks.delete(key);
    }

    // Create a new chunk at the given coordinates
    createChunk(x, y, z) {
        console.log(`Creating chunk at position ${x}, ${y}, ${z}`);
        
        // The WorldGenerator.generateChunk method doesn't accept a chunk object as parameter
        // It returns a new chunk, but our interface expects to modify an existing chunk
        // Let's modify our code to correctly use the worldGenerator:
        
        try {
            // Create the chunk using the world generator directly
            console.log("Calling worldGenerator.generateChunk");
            
            if (!this.worldGenerator) {
                console.error("worldGenerator is undefined!");
                return null;
            }
            
            const chunk = this.worldGenerator.generateChunk(x, y, z);
            
            if (!chunk) {
                console.error(`generateChunk returned null for coordinates ${x}, ${y}, ${z}`);
                return null;
            }
            
            console.log(`Chunk created at ${x}, ${y}, ${z}:`, chunk);
            
            // Store chunk coordinates
            chunk.x = x;
            chunk.y = y;
            chunk.z = z;
            
            // Debug - Check if chunk has any non-air voxels
            let hasContent = false;
            let voxelTypes = {};
            
            try {
                for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
                        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                            const voxelType = chunk.getVoxel(lx, ly, lz);
                            if (voxelType !== 0) {
                                hasContent = true;
                                voxelTypes[voxelType] = (voxelTypes[voxelType] || 0) + 1;
                            }
                        }
                    }
                }
            } catch (e) {
                console.error("Error checking chunk content:", e);
            }
            
            console.log(`Chunk ${x},${y},${z} created with content:`, 
                        hasContent ? `Contains ${Object.entries(voxelTypes).map(([type, count]) => `${count} of type ${type}`).join(', ')}` : 'EMPTY (all air)');
            
            // Queue for mesh generation
            const markedDirty = this.markChunkDirty(x, y, z);
            console.log(`Marked chunk as dirty: ${markedDirty}`);
            
            debugLog(`Created chunk at ${x}, ${y}, ${z}`);
            return chunk;
        } catch (error) {
            console.error(`Error creating chunk at ${x}, ${y}, ${z}:`, error);
            return null;
        }
    }

    // Update the getOrCreateChunk method to use our buffer system
    getOrCreateChunk(chunkX, chunkY, chunkZ) {
        const key = this.getChunkKey(chunkX, chunkY, chunkZ);

        // Return existing chunk if it exists
        if (this.chunks.has(key)) {
            return this.chunks.get(key);
        }

        console.log(`Creating new chunk at ${chunkX}, ${chunkY}, ${chunkZ}`);
        
        // Create new chunk and add to buffer
        return this.addChunkToBuffer(chunkX, chunkY, chunkZ);
    }

    // Update chunks based on player position
    updateChunks(playerX, playerY, playerZ) {
        // Convert player position to chunk coordinates
        const playerChunkX = Math.floor(playerX / CHUNK_SIZE);
        const playerChunkY = Math.floor(playerY / CHUNK_SIZE);
        const playerChunkZ = Math.floor(playerZ / CHUNK_SIZE);
        
        // Store last player chunk position to prevent unnecessary rebuilds
        if (!this.lastPlayerChunkPos) {
            this.lastPlayerChunkPos = { x: playerChunkX, y: playerChunkY, z: playerChunkZ };
        }
        
        // Only do a full update if the player has moved to a new chunk or it's the first update
        const hasPlayerMovedChunks = 
            this.lastPlayerChunkPos.x !== playerChunkX || 
            this.lastPlayerChunkPos.y !== playerChunkY || 
            this.lastPlayerChunkPos.z !== playerChunkZ;
        
        if (!hasPlayerMovedChunks && this.totalChunks > 0) {
            // Player hasn't moved to a new chunk, just process mesh generation
            this.processMeshGeneration();
            
            // Optimize octrees if needed
            const now = performance.now();
            if (now - this.lastOptimizationTime > this.optimizationInterval) {
                this.optimizeOctrees(this.chunksToOptimizePerFrame);
                this.lastOptimizationTime = now;
            }
            
            return;
        }
        
        // Update the last player position
        this.lastPlayerChunkPos = { x: playerChunkX, y: playerChunkY, z: playerChunkZ };
        
        // Clear the load queue
        this.loadQueue = [];
        
        // Build a priority-sorted list of chunks to load
        // Use a spiral pattern outward from the player's position
        for (let d = 0; d <= this.RENDER_DISTANCE; d++) {
            // For each distance d, we check all chunks at that Manhattan distance
            for (let dx = -d; dx <= d; dx++) {
                for (let dz = -d; dz <= d; dz++) {
                    // Only consider chunks at exactly distance d (Manhattan distance)
                    if (Math.abs(dx) + Math.abs(dz) !== d) continue;
                    
                    // Check chunks at varying heights
                    for (let dy = -this.VIEW_HEIGHT; dy <= this.VIEW_HEIGHT; dy++) {
                        const chunkX = playerChunkX + dx;
                        const chunkY = playerChunkY + dy;
                        const chunkZ = playerChunkZ + dz;
                        
                        // Skip if chunk already exists
                        const key = this.getChunkKey(chunkX, chunkY, chunkZ);
                        if (this.chunks.has(key)) continue;
                        
                        // Skip underground chunks far from player for optimization
                        if (chunkY < 0 && (Math.abs(dx) > 3 || Math.abs(dz) > 3)) continue;
                        
                        // Add to load queue
                        this.loadQueue.push({
                            x: chunkX,
                            y: chunkY,
                            z: chunkZ,
                            distance: Math.sqrt(dx * dx + dy * dy + dz * dz) // Euclidean distance
                        });
                    }
                }
            }
        }
        
        // Sort load queue by distance
        this.loadQueue.sort((a, b) => a.distance - b.distance);
        
        // Create unload queue - chunks outside render distance WITH A BUFFER ZONE
        const unloadQueue = [];
        const UNLOAD_BUFFER = 3; // Additional chunks to keep loaded beyond render distance
        
        for (const [key, chunk] of this.chunks.entries()) {
            // Extract chunk coordinates from key
            const [chunkX, chunkY, chunkZ] = key.split(',').map(Number);
            
            // Calculate distance from player
            const dx = chunkX - playerChunkX;
            const dy = chunkY - playerChunkY;
            const dz = chunkZ - playerChunkZ;
            
            const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
            
            // If chunk is outside render distance + buffer, add to unload queue
            if (distance > this.RENDER_DISTANCE + UNLOAD_BUFFER) {
                unloadQueue.push({
                    key,
                    distance
                });
            }
        }
        
        // Sort unload queue by distance (furthest first)
        unloadQueue.sort((a, b) => b.distance - a.distance);
        
        // Process the load queue (limited to CHUNKS_PER_FRAME)
        const chunkProcessCount = Math.min(this.CHUNKS_PER_FRAME, this.loadQueue.length);
        for (let i = 0; i < chunkProcessCount; i++) {
            try {
                const { x, y, z } = this.loadQueue[i];
                const chunk = this.addChunkToBuffer(x, y, z);
                if (chunk) {
                    this.stats.chunksLoaded++;
                } else {
                    console.warn(`Failed to add chunk at ${x}, ${y}, ${z} to buffer`);
                }
            } catch (error) {
                console.error("Error processing chunk from load queue:", error);
            }
        }
        
        // Process unload queue (limited to CHUNKS_PER_FRAME/2 to prioritize loading)
        // Only unload chunks if we've exceeded 80% of our MAX_CHUNKS capacity
        if (this.totalChunks > this.MAX_CHUNKS * 0.8) {
            const unloadCount = Math.min(Math.floor(this.CHUNKS_PER_FRAME/2), unloadQueue.length);
            for (let i = 0; i < unloadCount; i++) {
                try {
                    const { key } = unloadQueue[i];
                    const [x, y, z] = key.split(',').map(Number);
            this.unloadChunk(x, y, z);
                } catch (error) {
                    console.error("Error unloading chunk:", error);
                }
            }
        }
        
        // Process mesh generation
        this.processMeshGeneration();
        
        // Optimize octrees if needed
        const now = performance.now();
        if (now - this.lastOptimizationTime > this.optimizationInterval) {
            this.optimizeOctrees(this.chunksToOptimizePerFrame);
            this.lastOptimizationTime = now;
        }
    }

    // Count total nodes in all octrees (for stats display)
    updateNodeCount() {
        let nodeCount = 0;
        for (const chunk of this.chunks.values()) {
            if (chunk.rootNode) {
                nodeCount += chunk.countNodes ? chunk.countNodes() : 1;
            }
        }
        this.totalNodes = nodeCount;
    }

    // Unload a chunk
    unloadChunk(x, y, z) {
        const key = this.getChunkKey(x, y, z);
        console.log(`Attempting to unload chunk at ${x}, ${y}, ${z} with key ${key}`);

        if (this.chunks.has(key)) {
            // Call dispose on the chunk to release octree nodes back to the pool
            const chunk = this.chunks.get(key);
            if (chunk && chunk.dispose) {
                console.log(`Disposing chunk at ${x}, ${y}, ${z}`);
                chunk.dispose();
            }
            
            this.chunks.delete(key);

            // Delete mesh if it exists
            if (this.meshes.has(key)) {
                console.log(`Deleting mesh for chunk at ${x}, ${y}, ${z}`);
                const mesh = this.meshes.get(key);
                this.renderer.deleteMesh(mesh);
                this.meshes.delete(key);
            }

            this.dirtyChunks.delete(key);
            
            // Remove from chunk buffer if it's there
            try {
                const bufferIndex = this.chunkBuffer.findIndex(c => c && c.key === key);
                if (bufferIndex >= 0) {
                    console.log(`Removing chunk from buffer at index ${bufferIndex}`);
                    this.chunkBuffer[bufferIndex] = null;
                }
            } catch (error) {
                console.error(`Error clearing chunk from buffer: ${error.message}`);
            }
            
            this.totalChunks = Math.max(0, this.totalChunks - 1);
            console.log(`Unloaded chunk at ${x}, ${y}, ${z}. Total chunks: ${this.totalChunks}`);
        } else {
            console.log(`No chunk found at ${x}, ${y}, ${z} to unload`);
        }
    }

    // Process the mesh generation queue with time throttling
    processMeshGenerationQueue() {
        const now = performance.now();
        const timeElapsed = now - this.lastMeshCreationTime;
        
        // Throttle mesh creation to avoid frame rate drops
        if (timeElapsed < this.meshCreationInterval || this.meshGenerationQueue.length === 0) {
            return;
        }
        
        // Process next mesh in queue
        const item = this.meshGenerationQueue.shift();
        const { key, mesh, worldOffset } = item;
        
        // Either update existing mesh or create a new one
        let glMesh;
                    if (this.meshes.has(key)) {
            // Try to update the existing mesh (much faster, no flickering)
            glMesh = this.renderer.updateMesh(this.meshes.get(key), mesh);
        } else {
            // Create a new mesh if we don't have one yet
            glMesh = this.renderer.createMesh(mesh, worldOffset);
            this.meshes.set(key, glMesh);
        }
        
        this.lastMeshCreationTime = now;
    }

    // Optimize octrees to reduce memory usage
    optimizeOctrees(chunksToProcess) {
        // Get a list of chunks to optimize (those that haven't been optimized recently)
        const chunksToOptimize = [];
        for (const [key, chunk] of this.chunks.entries()) {
            // Skip chunks without a rootNode or those already optimized
            if (!chunk || !chunk.rootNode || chunk.isOptimized) continue;
            
            chunksToOptimize.push({ key, chunk });
        }
        
        // Process a limited number of chunks
        const processCount = Math.min(chunksToProcess, chunksToOptimize.length);
        for (let i = 0; i < processCount; i++) {
            const { key, chunk } = chunksToOptimize[i];
            
            // Optimize the octree (using rootNode)
            if (chunk && chunk.rootNode) {
                // Call optimize() method on the chunk which will optimize its rootNode
                if (typeof chunk.optimize === 'function') {
                    chunk.optimize();
                    chunk.isOptimized = true;
                    
                    // Mark the chunk as dirty to rebuild its mesh
                    this.dirtyChunks.add(key);
                    
                    debugLog(`Optimized octree for chunk ${key}`);
                }
            }
        }
    }

    // Process mesh generation for dirty chunks
    processMeshGeneration() {
        console.log(`Processing mesh generation: ${this.dirtyChunks.size} dirty chunks`);
        
        // Generate debug statistics
        if (this.dirtyChunks.size > 0) {
            let dirtyChunksArray = Array.from(this.dirtyChunks);
            console.log(`First 5 dirty chunks: ${dirtyChunksArray.slice(0, 5).join(', ')}`);
        }

        // Process dirty chunks from previous updates
        const dirtyChunksToProcess = Math.min(this.dirtyChunks.size, 10);
        if (dirtyChunksToProcess > 0) {
            console.log(`Processing ${dirtyChunksToProcess} dirty chunks out of ${this.dirtyChunks.size}`);
            
            let processedCount = 0;
            for (const chunkKey of this.dirtyChunks) {
                const chunk = this.getChunkByKey(chunkKey);
                if (!chunk) {
                    console.log(`WARNING: Dirty chunk ${chunkKey} not found, removing from dirty set`);
                    this.dirtyChunks.delete(chunkKey);
                    continue;
                }

                // Queue mesh generation for this chunk
                console.log(`Queuing mesh generation for dirty chunk: ${chunkKey}`);
                this.queueMeshGeneration(chunk);
                this.dirtyChunks.delete(chunkKey);
                
                processedCount++;
                if (processedCount >= dirtyChunksToProcess) {
                    break;
                }
            }
            
            console.log(`Processed ${processedCount} dirty chunks, ${this.dirtyChunks.size} remaining`);
        }
        
        // Process mesh generation queue
        if (this.meshGenerationQueue.length > 0) {
            console.log(`Mesh generation queue contains ${this.meshGenerationQueue.length} chunks`);
            this.processNextInMeshQueue();
        }
    }

    // Generate a mesh for a chunk
    async generateChunkMesh(chunk, key) {
        console.log(`Generating mesh for chunk ${key}`);
        
        if (!chunk) {
            console.error(`Cannot generate mesh for null chunk ${key}`);
            return null;
        }
        
        // Extract mesh data
        const meshData = this.generateMeshData(chunk, chunk.x, chunk.y, chunk.z);
        
        if (!meshData) {
            console.error(`Failed to generate mesh data for chunk ${key}`);
            return null;
        }
        
        console.log(`Mesh data generated for chunk ${key}: ${meshData.positions.length / 3} vertices, ${meshData.indices.length / 3} triangles`);

                // Delete old mesh if it exists
                if (this.meshes.has(key)) {
            console.log(`Deleting old mesh for chunk ${key}`);
                    this.renderer.deleteMesh(this.meshes.get(key));
            this.meshes.delete(key);
        }
        
        // Calculate world offset
        const worldOffset = [
            chunk.x * CHUNK_SIZE,
            chunk.y * CHUNK_SIZE,
            chunk.z * CHUNK_SIZE
        ];
        
        // Create mesh
        const mesh = this.renderer.createMesh(meshData, worldOffset);
        
        if (!mesh) {
            console.error(`Failed to create mesh for chunk ${key}`);
            return null;
                }

                // Store mesh
        this.meshes.set(key, mesh);
        
        console.log(`Successfully created mesh for chunk ${key}`);
        return mesh;
    }

    // Generate mesh data for a chunk
    generateMeshData(chunk, chunkX, chunkY, chunkZ) {
        console.log(`Generating mesh data for chunk ${chunkX},${chunkY},${chunkZ}`);
        
        if (!chunk) {
            console.error(`Cannot generate mesh data for null chunk ${chunkX},${chunkY},${chunkZ}`);
            return null;
        }
        
        // Check for empty chunk optimization
        if (chunk.isEmpty && chunk.isEmpty()) {
            console.log(`Chunk ${chunkX},${chunkY},${chunkZ} is empty, skipping mesh generation`);
            return {
                positions: [],
                normals: [],
                colors: [],
                indices: []
            };
        }
        
        // Extract visible voxels
        const visibleVoxels = this.extractVisibleVoxels(chunk);
        
        if (visibleVoxels.length === 0) {
            console.log(`No visible voxels in chunk ${chunkX},${chunkY},${chunkZ}, creating empty mesh`);
            return {
                positions: [],
                normals: [],
                colors: [],
                indices: []
            };
        }
        
        console.log(`Found ${visibleVoxels.length} visible voxels in chunk ${chunkX},${chunkY},${chunkZ}`);
        
        // Arrays to store mesh data
        const positions = [];
        const normals = [];
        const colors = [];
        const indices = [];
        
        // Generate faces for each visible voxel
        for (const voxel of visibleVoxels) {
            const localX = voxel.x - chunkX * CHUNK_SIZE;
            const localY = voxel.y - chunkY * CHUNK_SIZE;
            const localZ = voxel.z - chunkZ * CHUNK_SIZE;
            
            // Add faces for this voxel
            this.addVoxelFaces(
                localX, localY, localZ,
                voxel.type,
                positions, normals, colors, indices,
                chunk, chunkX, chunkY, chunkZ,
                voxel.color
            );
        }
        
        console.log(`Generated mesh with ${positions.length / 3} vertices and ${indices.length / 3} triangles`);
        
        return { positions, normals, colors, indices };
    }

    // Add faces for a voxel to the mesh data
    addVoxelFaces(x, y, z, voxelType, positions, normals, colors, indices, chunk, chunkX, chunkY, chunkZ, color) {
        // Define the 6 possible faces (direction vectors and normals)
        const faces = [
            { dir: [1, 0, 0], norm: [1, 0, 0] },  // +X
            { dir: [-1, 0, 0], norm: [-1, 0, 0] }, // -X
            { dir: [0, 1, 0], norm: [0, 1, 0] },  // +Y
            { dir: [0, -1, 0], norm: [0, -1, 0] }, // -Y
            { dir: [0, 0, 1], norm: [0, 0, 1] },  // +Z
            { dir: [0, 0, -1], norm: [0, 0, -1] }  // -Z
        ];
        
        // For each potential face
        for (const { dir, norm } of faces) {
            const nx = x + dir[0];
            const ny = y + dir[1];
            const nz = z + dir[2];
            
            // Check if neighboring voxel exists and is transparent
            let neighborVoxel;
            
            // If neighbor is within this chunk
            if (nx >= 0 && nx < CHUNK_SIZE && 
                ny >= 0 && ny < CHUNK_SIZE && 
                nz >= 0 && nz < CHUNK_SIZE) {
                neighborVoxel = chunk.getVoxel(nx, ny, nz);
            } 
            // Neighbor is in adjacent chunk
            else {
                // Calculate which chunk the neighbor is in
                let nChunkX = chunkX;
                let nChunkY = chunkY;
                let nChunkZ = chunkZ;
                
                // Adjust chunk coordinates
                if (nx < 0) nChunkX--;
                if (nx >= CHUNK_SIZE) nChunkX++;
                if (ny < 0) nChunkY--;
                if (ny >= CHUNK_SIZE) nChunkY++;
                if (nz < 0) nChunkZ--;
                if (nz >= CHUNK_SIZE) nChunkZ++;
                
                // Convert to local coordinates in the neighboring chunk
                const lx = ((nx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
                const ly = ((ny % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
                const lz = ((nz % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
                
                // Get the neighboring chunk
                const neighborChunk = this.getChunk(nChunkX, nChunkY, nChunkZ);
                if (neighborChunk) {
                    neighborVoxel = neighborChunk.getVoxel(lx, ly, lz);
                } else {
                    // Chunk not loaded, assume air
                    neighborVoxel = 0;
                }
            }
            
            // Add face if neighbor is air or this side should be rendered
            if (neighborVoxel === 0) {
                // Create quad for this face
                const vertexStart = positions.length / 3;
                
                // Add vertices for this face (quad)
                this.addFaceVertices(x, y, z, norm, positions, normals, colors, color);
                
                // Add indices for two triangles making the quad
                indices.push(
                    vertexStart, vertexStart + 1, vertexStart + 2,
                    vertexStart, vertexStart + 2, vertexStart + 3
                );
            }
        }
    }

    // Add vertices for a face (quad)
    addFaceVertices(x, y, z, normal, positions, normals, colors, color) {
        // Determine which axis this face is aligned with
        const axis = normal.findIndex(v => v !== 0);
        const positive = normal[axis] > 0;
        
        // Calculate vertex positions for this face
        const v = positive ? 1 : 0; // Vertex offset for this face
        
        let vertices;
        
        if (axis === 0) { // X-axis face
            vertices = [
                [x + v, y, z],
                [x + v, y, z + 1],
                [x + v, y + 1, z + 1],
                [x + v, y + 1, z]
            ];
        } else if (axis === 1) { // Y-axis face
            vertices = [
                [x, y + v, z],
                [x, y + v, z + 1],
                [x + 1, y + v, z + 1],
                [x + 1, y + v, z]
            ];
        } else { // Z-axis face
            vertices = [
                [x, y, z + v],
                [x + 1, y, z + v],
                [x + 1, y + 1, z + v],
                [x, y + 1, z + v]
            ];
        }
        
        // Add vertices
        for (const [vx, vy, vz] of vertices) {
            positions.push(vx, vy, vz);
            normals.push(normal[0], normal[1], normal[2]);
            colors.push(color.r, color.g, color.b, color.a);
        }
    }

    // Get neighboring chunks for mesh generation
    getChunkNeighbors(x, y, z) {
        const neighbors = {};
        
        // Check all 6 directions
        const directions = [
            { dx: 1, dy: 0, dz: 0, dir: 'px' },
            { dx: -1, dy: 0, dz: 0, dir: 'nx' },
            { dx: 0, dy: 1, dz: 0, dir: 'py' },
            { dx: 0, dy: -1, dz: 0, dir: 'ny' },
            { dx: 0, dy: 0, dz: 1, dir: 'pz' },
            { dx: 0, dy: 0, dz: -1, dir: 'nz' }
        ];
        
        for (const { dx, dy, dz, dir } of directions) {
            const neighborKey = this.getChunkKey(x + dx, y + dy, z + dz);
            neighbors[dir] = this.chunks.get(neighborKey) || null;
        }
        
        return neighbors;
    }

    // Get voxel at world coordinates
    getVoxel(worldX, worldY, worldZ) {
        // Convert to chunk coordinates
        const chunkX = Math.floor(worldX / CHUNK_SIZE);
        const chunkY = Math.floor(worldY / CHUNK_SIZE);
        const chunkZ = Math.floor(worldZ / CHUNK_SIZE);

        // Get chunk
        const chunk = this.getChunk(chunkX, chunkY, chunkZ);
        if (!chunk) {
            return 0; // Assume air if chunk not loaded
        }

        // Convert to local coordinates
        const localX = ((worldX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        const localY = ((worldY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        const localZ = ((worldZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;

        return chunk.getVoxel(localX, localY, localZ);
    }

    // Set voxel at world coordinates
    setVoxel(worldX, worldY, worldZ, voxelType) {
        // Convert to chunk coordinates
        const chunkX = Math.floor(worldX / CHUNK_SIZE);
        const chunkY = Math.floor(worldY / CHUNK_SIZE);
        const chunkZ = Math.floor(worldZ / CHUNK_SIZE);

        // Convert to local coordinates within chunk
        const localX = ((worldX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        const localY = ((worldY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        const localZ = ((worldZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;

        debugLog(`Setting voxel at ${worldX},${worldY},${worldZ} (chunk ${chunkX},${chunkY},${chunkZ}, local ${localX},${localY},${localZ})`);

        // Get or create chunk
        let chunk = this.getChunk(chunkX, chunkY, chunkZ);
        if (!chunk) {
            chunk = this.getOrCreateChunk(chunkX, chunkY, chunkZ);
            console.log(`Created new chunk at ${chunkX},${chunkY},${chunkZ}`);
        }

        // Update voxel in chunk
        const oldVoxelType = chunk.getVoxel(localX, localY, localZ);
        chunk.setVoxel(localX, localY, localZ, voxelType);

        // Mark chunk as dirty
        this.markChunkDirty(chunkX, chunkY, chunkZ);
        console.log(`Marked chunk ${chunkX},${chunkY},${chunkZ} as dirty`);

        // Check if this is a boundary voxel that requires neighboring chunks to be updated
        // We need to check both if it's on a boundary and if we're either:
        // 1. Setting a voxel from air to solid (showing a new face)
        // 2. Setting a voxel from solid to air (showing a previously hidden face)
        const isChangingVisibility = oldVoxelType === 0 || voxelType === 0;
        
        // Always update neighbors when near boundaries, with a 2-voxel buffer to be safe
        // This ensures we handle cases where visibility might change due to neighbor changes
        if (isChangingVisibility) {
            if (localX <= 1) { 
                const neighbor = this.getOrCreateChunk(chunkX - 1, chunkY, chunkZ);
                if (neighbor) {
                    this.markChunkDirty(chunkX - 1, chunkY, chunkZ);
                    console.log(`Marking neighbor chunk ${chunkX-1},${chunkY},${chunkZ} as dirty`);
                }
            }
            if (localX >= CHUNK_SIZE - 2) {
                const neighbor = this.getOrCreateChunk(chunkX + 1, chunkY, chunkZ);
                if (neighbor) {
                    this.markChunkDirty(chunkX + 1, chunkY, chunkZ);
                    console.log(`Marking neighbor chunk ${chunkX+1},${chunkY},${chunkZ} as dirty`);
                }
            }
            if (localY <= 1) {
                const neighbor = this.getOrCreateChunk(chunkX, chunkY - 1, chunkZ);
                if (neighbor) {
                    this.markChunkDirty(chunkX, chunkY - 1, chunkZ);
                    console.log(`Marking neighbor chunk ${chunkX},${chunkY-1},${chunkZ} as dirty`);
                }
            }
            if (localY >= CHUNK_SIZE - 2) {
                const neighbor = this.getOrCreateChunk(chunkX, chunkY + 1, chunkZ);
                if (neighbor) {
                    this.markChunkDirty(chunkX, chunkY + 1, chunkZ);
                    console.log(`Marking neighbor chunk ${chunkX},${chunkY+1},${chunkZ} as dirty`);
                }
            }
            if (localZ <= 1) {
                const neighbor = this.getOrCreateChunk(chunkX, chunkY, chunkZ - 1);
                if (neighbor) {
                    this.markChunkDirty(chunkX, chunkY, chunkZ - 1);
                    console.log(`Marking neighbor chunk ${chunkX},${chunkY},${chunkZ-1} as dirty`);
                }
            }
            if (localZ >= CHUNK_SIZE - 2) {
                const neighbor = this.getOrCreateChunk(chunkX, chunkY, chunkZ + 1);
                if (neighbor) {
                    this.markChunkDirty(chunkX, chunkY, chunkZ + 1);
                    console.log(`Marking neighbor chunk ${chunkX},${chunkY},${chunkZ+1} as dirty`);
                }
            }
        }
    }

    // Create a crater at world coordinates
    createCrater(worldX, worldY, worldZ, radius) {
        debugLog(`Creating crater at ${worldX}, ${worldY}, ${worldZ} with radius ${radius}`);

        const radiusSquared = radius * radius;

        for (let dx = -radius; dx <= radius; dx++) {
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dz = -radius; dz <= radius; dz++) {
                    const distSquared = dx * dx + dy * dy + dz * dz;
                    if (distSquared <= radiusSquared) {
                        this.setVoxel(Math.floor(worldX + dx), Math.floor(worldY + dy), Math.floor(worldZ + dz), 0);
                    }
                }
            }
        }
    }

    // Perform raycast against voxels
    raycast(origin, direction, maxDistance = 100) {
        debugLog(`Raycasting from ${origin} in direction ${direction}`);

        const stepSize = 0.1;
        const maxSteps = maxDistance / stepSize;

        let currentPos = [...origin];

        for (let i = 0; i < maxSteps; i++) {
            const x = Math.floor(currentPos[0]);
            const y = Math.floor(currentPos[1]);
            const z = Math.floor(currentPos[2]);

            // Check if we've hit a voxel
            const voxel = this.getVoxel(x, y, z);
            if (voxel !== 0) {
                debugLog(`Raycast hit at ${x}, ${y}, ${z}, voxel type: ${voxel}`);
                return {
                    position: [x, y, z],
                    voxelType: voxel,
                    distance: i * stepSize
                };
            }

            // Move along the ray
            currentPos[0] += direction[0] * stepSize;
            currentPos[1] += direction[1] * stepSize;
            currentPos[2] += direction[2] * stepSize;
        }

        debugLog(`Raycast missed (exceeded maxDistance)`);
        return null; // No hit
    }

    // Extract visible voxels for instanced rendering
    extractVisibleVoxels(chunk) {
        console.log(`Extracting visible voxels for chunk ${chunk.x},${chunk.y},${chunk.z}`);
        
        if (!chunk || !chunk.rootNode) {
            console.error(`ERROR: Invalid chunk or missing rootNode for chunk ${chunk.x},${chunk.y},${chunk.z}`);
            return [];
        }

        const visibleVoxels = [];
        let skippedInvisible = 0;
        
        // Extract visible voxels
        try {
            const extracted = this.extractVoxelsFromChunk(chunk, chunk.x, chunk.y, chunk.z, visibleVoxels);
            if (extracted) {
                skippedInvisible = extracted.skippedInvisible || 0;
            }
        } catch (error) {
            console.error(`Error extracting voxels:`, error);
            return [];
        }
        
        console.log(`Chunk ${chunk.x},${chunk.y},${chunk.z}: Found ${visibleVoxels.length} visible voxels, skipped ${skippedInvisible} invisible`);
        
        return visibleVoxels;
    }

    // Extract visible voxels from a chunk, skipping hidden voxels
    extractVoxelsFromChunk(chunk, chunkX, chunkY, chunkZ, visibleVoxels) {
        // Only process if we have a valid chunk with octree data
        if (!chunk || !chunk.rootNode) return { skippedInvisible: 0 };
        
        let skippedInvisible = 0;
        
        // Calculate world origin for this chunk
        const worldX = chunkX * CHUNK_SIZE;
        const worldY = chunkY * CHUNK_SIZE;
        const worldZ = chunkZ * CHUNK_SIZE;
        
        // Recursively process visible voxels
        const processNode = (node) => {
            // Skip empty nodes
            if (node.isEmpty()) return;
            
            // If this is a leaf node with voxels, add it to the list
            if (node.isLeaf) {
                // Skip air voxels
                if (node.voxelType === 0) return;
                
                // For large leaf nodes, skip interior voxels that can't be seen
                if (node.size > 1) {
                    // Only include the outer shell to save rendering cost
                    this.extractVoxelShell(node, worldX, worldY, worldZ, visibleVoxels);
                } else {
                    // Single voxel - check if it's visible (has at least one face exposed to air)
                    const voxelWorldX = worldX + node.x;
                    const voxelWorldY = worldY + node.y;
                    const voxelWorldZ = worldZ + node.z;
                    
                    if (this.isVoxelVisible(voxelWorldX, voxelWorldY, voxelWorldZ)) {
                        // Get voxel color from voxel type
                        const color = this.getVoxelColor(node.voxelType);
                        
                        // Add to visible voxels list
                        visibleVoxels.push({
                            x: voxelWorldX,
                            y: voxelWorldY,
                            z: voxelWorldZ,
                            type: node.voxelType,
                            color
                        });
                    } else {
                        skippedInvisible++;
                    }
                }
                return;
            }
            
            // Process children for non-leaf nodes
            if (node.children) {
                for (let i = 0; i < node.children.length; i++) {
                    if (node.children[i]) {
                        processNode(node.children[i]);
                    }
                }
            }
        };
        
        // Start processing from the root
        processNode(chunk.rootNode);
        
        return { skippedInvisible };
    }

    // Extract only the shell of voxels from a larger leaf node
    extractVoxelShell(node, worldX, worldY, worldZ, visibleVoxels) {
        // For large nodes, only extract the outer shell of voxels
        const startX = node.x;
        const startY = node.y;
        const startZ = node.z;
        const endX = startX + node.size - 1;
        const endY = startY + node.size - 1;
        const endZ = startZ + node.size - 1;
        
        // Get voxel color from voxel type
        const color = this.getVoxelColor(node.voxelType);
        
        // Process each face of the cube
        for (let x = startX; x <= endX; x++) {
            for (let y = startY; y <= endY; y++) {
                // Front face
                if (this.isVoxelFaceVisible(worldX + x, worldY + y, worldZ + startZ, 0, 0, -1)) {
                    visibleVoxels.push({
                        x: worldX + x,
                        y: worldY + y,
                        z: worldZ + startZ,
                        type: node.voxelType,
                        color
                    });
                }
                
                // Back face
                if (this.isVoxelFaceVisible(worldX + x, worldY + y, worldZ + endZ, 0, 0, 1)) {
                    visibleVoxels.push({
                        x: worldX + x,
                        y: worldY + y,
                        z: worldZ + endZ,
                        type: node.voxelType,
                        color
                    });
                }
            }
        }
        
        for (let x = startX; x <= endX; x++) {
            for (let z = startZ; z <= endZ; z++) {
                // Bottom face
                if (this.isVoxelFaceVisible(worldX + x, worldY + startY, worldZ + z, 0, -1, 0)) {
                    visibleVoxels.push({
                        x: worldX + x,
                        y: worldY + startY,
                        z: worldZ + z,
                        type: node.voxelType,
                        color
                    });
                }
                
                // Top face
                if (this.isVoxelFaceVisible(worldX + x, worldY + endY, worldZ + z, 0, 1, 0)) {
                    visibleVoxels.push({
                        x: worldX + x,
                        y: worldY + endY,
                        z: worldZ + z,
                        type: node.voxelType,
                        color
                    });
                }
            }
        }
        
        for (let y = startY; y <= endY; y++) {
            for (let z = startZ; z <= endZ; z++) {
                // Left face
                if (this.isVoxelFaceVisible(worldX + startX, worldY + y, worldZ + z, -1, 0, 0)) {
                    visibleVoxels.push({
                        x: worldX + startX,
                        y: worldY + y,
                        z: worldZ + z,
                        type: node.voxelType,
                        color
                    });
                }
                
                // Right face
                if (this.isVoxelFaceVisible(worldX + endX, worldY + y, worldZ + z, 1, 0, 0)) {
                    visibleVoxels.push({
                        x: worldX + endX,
                        y: worldY + y,
                        z: worldZ + z,
                        type: node.voxelType,
                        color
                    });
                }
            }
        }
    }

    // Check if a voxel face is visible by looking at the adjacent voxel
    isVoxelFaceVisible(x, y, z, dx, dy, dz) {
        // Check if the adjacent voxel is air (0) or out of bounds
        const nx = x + dx;
        const ny = y + dy; 
        const nz = z + dz;
        
        return this.getVoxel(nx, ny, nz) === 0;
    }

    // Check if a voxel is visible (has at least one face exposed to air)
    isVoxelVisible(worldX, worldY, worldZ) {
        // Check each of the six adjacent positions
        const directions = [
            [1, 0, 0], [-1, 0, 0],
            [0, 1, 0], [0, -1, 0],
            [0, 0, 1], [0, 0, -1]
        ];
        
        // Calculate chunk coordinates
        const chunkX = Math.floor(worldX / CHUNK_SIZE);
        const chunkY = Math.floor(worldY / CHUNK_SIZE);
        const chunkZ = Math.floor(worldZ / CHUNK_SIZE);
        
        // Get chunk
        const chunkKey = this.getChunkKey(chunkX, chunkY, chunkZ);
        const chunk = this.getChunkByKey(chunkKey);
        
        if (!chunk) {
            console.warn(`No chunk exists at ${chunkKey} for visibility check`);
            return true; // Assume visible if chunk doesn't exist
        }
        
        // Calculate local coordinates
        const localX = worldX - chunkX * CHUNK_SIZE;
        const localY = worldY - chunkY * CHUNK_SIZE;
        const localZ = worldZ - chunkZ * CHUNK_SIZE;
        
        for (const [dx, dy, dz] of directions) {
            const nx = localX + dx;
            const ny = localY + dy;
            const nz = localZ + dz;
            
            // If adjacent position is outside chunk boundaries, check neighbor chunk
            if (nx < 0 || nx >= CHUNK_SIZE || 
                ny < 0 || ny >= CHUNK_SIZE || 
                nz < 0 || nz >= CHUNK_SIZE) {
                
                // Get neighboring chunk coordinates
                let neighborX = chunkX;
                let neighborY = chunkY;
                let neighborZ = chunkZ;
                
                // Adjust based on which boundary we crossed
                if (nx < 0) neighborX--;
                if (nx >= CHUNK_SIZE) neighborX++;
                if (ny < 0) neighborY--;
                if (ny >= CHUNK_SIZE) neighborY++;
                if (nz < 0) neighborZ--;
                if (nz >= CHUNK_SIZE) neighborZ++;
                
                // Get the neighboring chunk
                const neighborKey = this.getChunkKey(neighborX, neighborY, neighborZ);
                const neighborChunk = this.getChunkByKey(neighborKey);
                
                // If there's no neighboring chunk, this face is visible
                if (!neighborChunk) {
                    return true;
                }
                
                // Calculate local coordinates in neighbor chunk
                const neighborLocalX = ((nx + CHUNK_SIZE) % CHUNK_SIZE);
                const neighborLocalY = ((ny + CHUNK_SIZE) % CHUNK_SIZE);
                const neighborLocalZ = ((nz + CHUNK_SIZE) % CHUNK_SIZE);
                
                // If neighbor voxel is air, this face is visible
                if (neighborChunk.getVoxel(neighborLocalX, neighborLocalY, neighborLocalZ) === 0) {
                    return true;
                }
            } 
            // If adjacent voxel is air, this face is visible
            else if (chunk.getVoxel(nx, ny, nz) === 0) {
                return true;
            }
        }
        
        // No visible faces
        return false;
    }

    // Get voxel color based on voxel type
    getVoxelColor(voxelType) {
        // Basic color palette
        switch(voxelType) {
            case 0: // VoxelType.AIR
                return {r: 0.0, g: 0.0, b: 0.0, a: 0.0}; // Air (invisible)
            case 1: // VoxelType.GRASS
                return {r: 0.3, g: 0.75, b: 0.3, a: 1.0}; // Grass (green)
            case 2: // VoxelType.BEDROCK
                return {r: 0.2, g: 0.2, b: 0.2, a: 1.0}; // Bedrock (dark gray)
            case 3: // VoxelType.STONE
                return {r: 0.5, g: 0.5, b: 0.5, a: 1.0}; // Stone (gray)
            case 4: // VoxelType.DIRT
                return {r: 0.5, g: 0.3, b: 0.1, a: 1.0}; // Dirt (brown)
            case 5: // VoxelType.WATER
                return {r: 0.0, g: 0.3, b: 0.8, a: 0.7}; // Water (blue, transparent)
            default: 
                console.warn(`Unknown voxel type: ${voxelType}`);
                return {r: 1.0, g: 0.0, b: 1.0, a: 1.0}; // Missing texture (pink)
        }
    }

    // Render all chunks with GPU acceleration when possible
    render(projectionMatrix, viewMatrix) {
        // Create combined projection-view matrix for frustum culling
        const projViewMatrix = mat4.create();
        mat4.multiply(projViewMatrix, projectionMatrix, viewMatrix);

        // Create frustum for culling
        const frustum = mat4.frustumFromMatrix(projViewMatrix);
        
        // Collect visible meshes
        const visibleMeshes = [];
        
        // For instanced rendering
        let visibleVoxels = [];
        
        // Track culling statistics
        let totalChunks = 0;
        let culledChunks = 0;
        
        // Iterate through all chunks
        for (const [key, chunk] of this.chunks.entries()) {
            totalChunks++;
            
            // Skip empty chunks
            if (chunk.isEmpty && chunk.isEmpty()) {
                culledChunks++;
                continue;
            }
            
            // Parse chunk coordinates and store them in the chunk object
            const [chunkX, chunkY, chunkZ] = key.split(',').map(Number);
            chunk.x = chunkX;
            chunk.y = chunkY;
            chunk.z = chunkZ;
            
            // Calculate chunk bounding box
            const minX = chunkX * CHUNK_SIZE;
            const minY = chunkY * CHUNK_SIZE;
            const minZ = chunkZ * CHUNK_SIZE;
            const maxX = minX + CHUNK_SIZE;
            const maxY = minY + CHUNK_SIZE;
            const maxZ = minZ + CHUNK_SIZE;
            
            // Re-enable frustum culling for better performance
            if (!mat4.isBoxInFrustum(frustum, minX, minY, minZ, maxX, maxY, maxZ)) {
                culledChunks++;
                continue;
            }
            
            // For instanced rendering
            if (this.renderer.supportsInstancedRendering) {
                // Extract visible voxels from this chunk
                const chunkVoxels = this.extractVisibleVoxels(chunk);
                if (chunkVoxels.length > 0) {
                    visibleVoxels.push(...chunkVoxels);
                }
            } 
            // For traditional mesh rendering
            else {
                // If the chunk has a mesh, add it to visible meshes
                const mesh = this.meshes.get(key);
                if (mesh) {
                    const worldOffset = [minX, minY, minZ];
                    visibleMeshes.push({ ...mesh, worldOffset });
                }
            }
        }
        
        // Update culling statistics
        this.cullStats = {
            total: totalChunks,
            culled: culledChunks
        };
        
        // Debug output
        if (totalChunks > 0 && totalChunks % 100 === 0) {
            console.log(`Rendering ${visibleVoxels.length} visible voxels. Culled: ${culledChunks}/${totalChunks} chunks (${Math.round(culledChunks/totalChunks*100)}%)`);
        }
        
        // If using instanced rendering, render all visible voxels in a single draw call
        if (this.renderer.supportsInstancedRendering && visibleVoxels.length > 0) {
            // Render with instanced rendering
            return this.renderer.renderVoxelsInstanced(visibleVoxels, projectionMatrix, viewMatrix);
        }
        
        // Otherwise use traditional mesh rendering
        return this.renderer.renderChunks(visibleMeshes, projectionMatrix, viewMatrix);
    }

    // Handle messages from workers
    handleWorkerMessage(e, workerIndex) {
        const { type, mesh, chunkKey } = e.data;
        
        if (type === 'initialized') {
            console.log(`Mesh worker ${workerIndex} initialized`);
            return;
        }
        
        if (type === 'meshGenerated') {
            const startTime = this.pendingMeshes.get(chunkKey).startTime;
            const elapsed = performance.now() - startTime;
            
            // Update mesh generation stats
            this.meshGenStats.totalMeshesGenerated++;
            this.meshGenStats.meshingTimeTotal += elapsed;
            this.meshGenStats.meshingTimeAvg = this.meshGenStats.meshingTimeTotal / this.meshGenStats.totalMeshesGenerated;
            
            // Get the chunk and process the mesh data
            const chunk = this.getChunkByKey(chunkKey);
            if (chunk) {
                this.processGeneratedMesh(chunk, mesh);
            }
            
            // Mark worker as free
            this.meshWorkers[workerIndex].busy = false;
            this.pendingMeshes.delete(chunkKey);
            
            // Process next in queue
            this.processNextInMeshQueue();
        }
    }
    
    // Process generated mesh data
    processGeneratedMesh(chunk, meshData) {
        // Update chunk's mesh with the data from the worker
        if (this.renderer.supportsInstancedRendering) {
            // For instanced rendering, we just need to extract visible voxels
            chunk.visibleVoxels = this.extractVisibleVoxels(chunk);
            chunk.needsMeshUpdate = false;
            chunk.hasMesh = true;
        } else {
            // For regular mesh rendering, create buffers from the mesh data
            const { positions, normals, colors, indices } = meshData;
            
            // Create WebGL buffers for the mesh
            chunk.mesh = this.renderer.createChunkMesh(positions, normals, colors, indices);
            chunk.needsMeshUpdate = false;
            chunk.hasMesh = true;
            
            // Update memory statistics
            const vertexCount = positions.length / 3;
            const bufferSize = (positions.length + normals.length + colors.length) * 4 + indices.length * 2;
            chunk.vertexCount = vertexCount;
            chunk.bufferSize = bufferSize;
        }
    }
    
    // Queue mesh generation for a chunk
    queueMeshGeneration(chunk) {
        const chunkKey = this.getChunkKey(chunk.x, chunk.y, chunk.z);
        console.log(`Adding chunk ${chunkKey} to mesh generation queue`);
        
        // Check if already in queue
        if (this.meshGenerationQueue.some(c => c.x === chunk.x && c.y === chunk.y && c.z === chunk.z)) {
            console.log(`Chunk ${chunkKey} is already in mesh generation queue, skipping`);
            return;
        }
        
        // Add to queue
        this.meshGenerationQueue.push(chunk);
        
        console.log(`Mesh generation queue now has ${this.meshGenerationQueue.length} chunks`);
    }
    
    // Process next chunk in mesh generation queue
    async processNextInMeshQueue() {
        if (this.meshGenerationQueue.length === 0) {
            return;
        }
        
        if (this.isProcessingMesh) {
            console.log(`Already processing a mesh, waiting...`);
            return;
        }
        
        this.isProcessingMesh = true;
        
        // Get the next chunk from the queue
        const chunk = this.meshGenerationQueue.shift();
        const chunkKey = this.getChunkKey(chunk.x, chunk.y, chunk.z);
        
        console.log(`Processing mesh for chunk ${chunkKey}, ${this.meshGenerationQueue.length} remaining in queue`);
        
        try {
            // Check if chunk still exists (might have been unloaded)
            if (!this.chunks.has(chunkKey)) {
                console.log(`Chunk ${chunkKey} no longer exists, skipping mesh generation`);
                this.isProcessingMesh = false;
                
                // Continue with next chunk if available
                if (this.meshGenerationQueue.length > 0) {
                    setTimeout(() => this.processNextInMeshQueue(), 0);
                }
                return;
            }
            
            // Check if this chunk has any visible voxels
            const visibleVoxels = this.extractVisibleVoxels(chunk);
            console.log(`Chunk ${chunkKey} has ${visibleVoxels.length} visible voxels`);
            
            if (visibleVoxels.length === 0) {
                console.log(`Chunk ${chunkKey} has no visible voxels, skipping mesh generation`);
                // Still create an empty mesh to prevent re-processing
                if (this.meshes.has(chunkKey)) {
                    console.log(`Deleting existing mesh for empty chunk ${chunkKey}`);
                    this.renderer.deleteMesh(this.meshes.get(chunkKey));
                    this.meshes.delete(chunkKey);
                }
                
                // Create empty mesh data
                const emptyMeshData = {
                    positions: [],
                    normals: [],
                    colors: [],
                    indices: []
                };
                
                const worldOffset = [
                    chunk.x * CHUNK_SIZE,
                    chunk.y * CHUNK_SIZE,
                    chunk.z * CHUNK_SIZE
                ];
                
                // Create empty mesh
                const mesh = this.renderer.createMesh(emptyMeshData, worldOffset);
                this.meshes.set(chunkKey, mesh);
                console.log(`Created empty mesh for chunk ${chunkKey}`);
                
                this.isProcessingMesh = false;
                
                // Continue with next chunk if available
                if (this.meshGenerationQueue.length > 0) {
                    setTimeout(() => this.processNextInMeshQueue(), 0);
                }
                return;
            }
            
            // Generate the mesh
            await this.generateChunkMesh(chunk, chunkKey);
            
            console.log(`Mesh generation completed for chunk ${chunkKey}`);
        } catch (error) {
            console.error(`Error processing mesh for chunk ${chunkKey}:`, error);
        }
        
        this.isProcessingMesh = false;
        
        // Continue with next chunk if available
        if (this.meshGenerationQueue.length > 0) {
            setTimeout(() => this.processNextInMeshQueue(), 0);
        }
    }
    
    // Modified prepareChunkForWorker to include WebGPU eligibility
    prepareChunkForWorker(chunk) {
        // Create a serializable representation for transferring to worker
        const serializable = {
            // Implement a serializable version of the chunk's octree that uses getVoxel
            getVoxel: (x, y, z) => chunk.getVoxel(x, y, z),
            // Add WebGPU eligibility flag
            useWebGPU: this.webgpuInitialized && isChunkEligibleForGPU(chunk)
        };
        
        return serializable;
    }
    
    // Modified updateChunkMesh to use workers
    updateChunkMesh(chunk) {
        if (!chunk.needsMeshUpdate) return;
        
        // Use worker for mesh generation
        this.queueMeshGeneration(chunk);
    }
    
    // Get chunk by its key
    getChunkByKey(chunkKey) {
        const [x, y, z] = chunkKey.split(',').map(Number);
        return this.getChunk(x, y, z);
    }
    
    // Get mesh generation statistics
    getMeshGenStats() {
        return {
            ...this.meshGenStats,
            workerCount: this.meshWorkers.length,
            activeWorkers: this.meshWorkers.filter(w => w.busy).length
        };
    }

    // Get all stats including WebGPU stats
    getAllStats() {
        return {
            mesh: this.getMeshGenStats(),
            webgpu: getWebGPUStats()
        };
    }

    // Clear all chunks (for world reset)
    clearAllChunks() {
        // Dispose all chunks
        for (const chunk of this.chunks.values()) {
            if (chunk.dispose) {
                chunk.dispose();
            }
        }
        
        // Delete all meshes
        for (const mesh of this.meshes.values()) {
            this.renderer.deleteMesh(mesh);
        }
        
        // Clear all collections
        this.chunks.clear();
        this.meshes.clear();
        this.dirtyChunks.clear();
        this.chunkBuffer.fill(null);
        this.chunkBufferIndex = 0;
        this.totalChunks = 0;
        
        // Reset stats
        this.stats.chunksLoaded = 0;
        this.stats.chunksUnloaded = 0;
        this.stats.meshesCreated = 0;
    }

    // Get stats about the chunk manager
    getStats() {
        return {
            totalChunks: this.totalChunks,
            maxChunks: this.MAX_CHUNKS,
            dirtyChunks: this.dirtyChunks.size,
            meshCount: this.meshes.size,
            ...this.stats
        };
    }
}
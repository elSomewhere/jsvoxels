import { CHUNK_SIZE, RENDER_DISTANCE, ENABLE_MULTITHREADING, USE_TIGHT_BOUNDS } from './constants.js';
import { debugLog } from './math-utils.js';
import { Chunk } from './voxel-data.js';
import { mat4 } from './math-utils.js';

export class ChunkManager {
    constructor(worldGenerator, mesher, renderer, workerPool, spatialIndex, bufferManager) {
        this.worldGenerator = worldGenerator;
        this.mesher = mesher;
        this.renderer = renderer;
        this.workerPool = workerPool;
        this.spatialIndex = spatialIndex;
        this.bufferManager = bufferManager;

        this.chunks = new Map();      // Map of loaded chunks
        this.meshes = new Map();      // Map of chunk meshes
        this.meshBuffers = new Map(); // Map of mesh buffer IDs for cleanup
        this.dirtyChunks = new Set(); // Chunks that need mesh rebuilding
        this.loadQueue = [];          // Queue for chunks to load
        this.unloadQueue = [];        // Queue for chunks to unload
        this.totalChunks = 0;
        this.totalNodes = 0;
        this.cullStats = { total: 0, culled: 0 };
        this.chunkBounds = new Map(); // Map of chunk bounds for culling

        // Pending operations tracking
        this.pendingOperations = new Map(); // Map of chunk keys to pending operations

        // Hysteresis for chunk loading/unloading to prevent flickering
        this.loadedChunkKeys = new Set(); // Set of currently loaded chunk keys
        this.loadMargin = 1.1;  // Keep chunks loaded within 1.1x render distance
        this.unloadMargin = 1.5; // Unload chunks beyond 1.5x render distance
    }

    // Create chunk key from coordinates
    getChunkKey(x, y, z) {
        return `${x},${y},${z}`;
    }

    // Get chunk at coordinates
    getChunk(x, y, z) {
        return this.chunks.get(this.getChunkKey(x, y, z));
    }

    // Check if chunk exists
    hasChunk(x, y, z) {
        return this.chunks.has(this.getChunkKey(x, y, z));
    }

    // Get chunk mesh
    getChunkMesh(x, y, z) {
        return this.meshes.get(this.getChunkKey(x, y, z));
    }

    // Mark chunk as dirty (needs mesh rebuild)
    markChunkDirty(x, y, z) {
        const key = this.getChunkKey(x, y, z);
        if (this.chunks.has(key)) {
            this.dirtyChunks.add(key);
            debugLog(`Marked chunk dirty: ${key}`);
        }

        // Also mark neighboring chunks as dirty if they could be affected
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    if (dx === 0 && dy === 0 && dz === 0) continue;
                    const neighborKey = this.getChunkKey(x + dx, y + dy, z + dz);
                    if (this.chunks.has(neighborKey)) {
                        this.dirtyChunks.add(neighborKey);
                    }
                }
            }
        }
    }

    // Create or get a chunk
    getOrCreateChunk(chunkX, chunkY, chunkZ) {
        const key = this.getChunkKey(chunkX, chunkY, chunkZ);

        // Return existing chunk if already loaded
        if (this.chunks.has(key)) {
            return this.chunks.get(key);
        }

        // Mark chunk as pending loading
        this.loadedChunkKeys.add(key);

        // Check if there's already a pending operation for this chunk
        if (this.pendingOperations.has(key)) {
            // Create placeholder that can be used while waiting
            const placeholderChunk = new Chunk();
            // IMPORTANT: Don't store this placeholder in this.chunks
            // to avoid race conditions with the real chunk
            return placeholderChunk;
        }

        // Generate a new chunk
        debugLog(`Creating new chunk at ${chunkX}, ${chunkY}, ${chunkZ}`);

        if (ENABLE_MULTITHREADING && this.workerPool) {
            // Record that a generate operation is pending
            this.pendingOperations.set(key, {
                type: 'generate',
                chunkX,
                chunkY,
                chunkZ
            });

            // Queue task for worker pool
            this.workerPool.addTask(
                'generateChunk',
                { chunkX, chunkY, chunkZ },
                this.handleChunkGenerated.bind(this, chunkX, chunkY, chunkZ),
                [], // No transferables for this task
                true // Priority task for nearby chunks
            );

            // Return a placeholder empty chunk while waiting
            // IMPORTANT: Don't store this placeholder in this.chunks
            const placeholderChunk = new Chunk();
            return placeholderChunk;
        } else {
            // Generate chunk synchronously
            const chunk = this.worldGenerator.generateChunk(chunkX, chunkY, chunkZ);

            // Store the chunk in the global chunk map
            this.chunks.set(key, chunk);

            // Mark for meshing
            this.dirtyChunks.add(key);
            this.totalChunks++;

            // Add to spatial index
            this.spatialIndex.addChunk(chunkX, chunkY, chunkZ, chunk);

            // Calculate tight bounds if enabled
            if (USE_TIGHT_BOUNDS) {
                const bounds = this.spatialIndex.calculateTightBounds(chunkX, chunkY, chunkZ, chunk);
                this.chunkBounds.set(key, bounds);
            }

            return chunk;
        }
    }

    // Handle chunk generation completion from worker
    handleChunkGenerated(chunkX, chunkY, chunkZ, result) {
        const key = this.getChunkKey(chunkX, chunkY, chunkZ);

        // Check if we still need this chunk (it might have been unloaded while generating)
        if (!this.loadedChunkKeys.has(key)) {
            this.pendingOperations.delete(key);
            return;
        }

        // Create chunk from voxel data
        const chunk = new Chunk();
        chunk.fillFromArray(result.voxelData);

        // Store chunk
        this.chunks.set(key, chunk);
        this.dirtyChunks.add(key);
        this.totalChunks++;

        // Add to spatial index
        this.spatialIndex.addChunk(chunkX, chunkY, chunkZ, chunk);

        // Calculate tight bounds if enabled
        if (USE_TIGHT_BOUNDS) {
            const bounds = this.spatialIndex.calculateTightBounds(chunkX, chunkY, chunkZ, chunk);
            this.chunkBounds.set(key, bounds);
        }

        // Remove from pending operations
        this.pendingOperations.delete(key);

        debugLog(`Chunk generated from worker: ${key}`);
    }

    // Update chunks based on player position
    updateChunks(playerX, playerY, playerZ) {
        // Convert player position to chunk coordinates
        const centerChunkX = Math.floor(playerX / CHUNK_SIZE);
        const centerChunkY = Math.floor(playerY / CHUNK_SIZE);
        const centerChunkZ = Math.floor(playerZ / CHUNK_SIZE);

        // Use spatial index to find chunks in radius
        const chunksToLoad = [];

        // Increase load radius margin to load chunks before they're needed
        const loadRadiusSquared = Math.pow(RENDER_DISTANCE * this.loadMargin, 2);

        // Use a more conservative unload margin
        const unloadRadiusSquared = Math.pow(RENDER_DISTANCE * this.unloadMargin, 2);

        // Define the range for chunk loading slightly wider than render distance
        const loadRangeHorizontal = RENDER_DISTANCE + 2;
        const loadRangeVertical = Math.max(2, Math.floor(RENDER_DISTANCE / 2)); // Less in vertical direction

        for (let x = centerChunkX - loadRangeHorizontal; x <= centerChunkX + loadRangeHorizontal; x++) {
            for (let y = 0; y <= centerChunkY + loadRangeVertical; y++) {
                for (let z = centerChunkZ - loadRangeHorizontal; z <= centerChunkZ + loadRangeHorizontal; z++) {
                    // Use spherical distance for loading
                    const dx = x - centerChunkX;
                    const dy = y - centerChunkY;
                    const dz = z - centerChunkZ;
                    const distSquared = dx * dx + dy * dy + dz * dz;

                    const key = this.getChunkKey(x, y, z);
                    if (distSquared <= loadRadiusSquared &&
                        !this.hasChunk(x, y, z) &&
                        !this.pendingOperations.has(key)) {
                        // Prioritize chunks closer to player
                        chunksToLoad.push({ coords: [x, y, z], dist: distSquared });
                        // Mark as potentially loaded to prevent adding it multiple times
                        this.loadedChunkKeys.add(key);
                    }
                }
            }
        }

        // Sort load queue by distance for priority loading
        chunksToLoad.sort((a, b) => a.dist - b.dist);

        // Add new chunks to load queue (no duplicates)
        for (const chunk of chunksToLoad) {
            if (!this.loadQueue.some(c =>
                c.coords[0] === chunk.coords[0] &&
                c.coords[1] === chunk.coords[1] &&
                c.coords[2] === chunk.coords[2])) {
                this.loadQueue.push(chunk);
            }
        }

        // Find chunks to unload with a much larger distance threshold
        const chunksToUnload = [];

        for (const [key, chunk] of this.chunks.entries()) {
            const [x, y, z] = key.split(',').map(Number);
            const dx = x - centerChunkX;
            const dy = y - centerChunkY;
            const dz = z - centerChunkZ;
            const distSquared = dx * dx + dy * dy + dz * dz;

            // Use a much larger unload radius to prevent frequent loading/unloading
            if (distSquared > unloadRadiusSquared) {
                chunksToUnload.push([x, y, z]);
                // Remove from loaded chunks set
                this.loadedChunkKeys.delete(key);
            }
        }

        // Process load queue (increased per frame)
        const loadLimit = 4; // Increased from 2
        let loaded = 0;

        while (this.loadQueue.length > 0 && loaded < loadLimit) {
            const { coords } = this.loadQueue.shift();
            const [x, y, z] = coords;
            if (!this.hasChunk(x, y, z) && !this.pendingOperations.has(this.getChunkKey(x, y, z))) {
                this.getOrCreateChunk(x, y, z);
                loaded++;
            }
        }

        // Process unload queue (one at a time to avoid sudden changes)
        const unloadLimit = 1;
        let unloaded = 0;

        while (this.unloadQueue.length > 0 && unloaded < unloadLimit) {
            const [x, y, z] = this.unloadQueue.shift();
            this.unloadChunk(x, y, z);
            unloaded++;
        }

        // Update total octree node count for stats
        this.updateNodeCount();

        // Update stats display
        document.getElementById('chunks').textContent = this.totalChunks;
        document.getElementById('position').textContent = `${Math.floor(playerX)},${Math.floor(playerY)},${Math.floor(playerZ)}`;
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

        if (this.chunks.has(key)) {
            this.chunks.delete(key);

            // Delete mesh if it exists
            if (this.meshes.has(key)) {
                const mesh = this.meshes.get(key);
                this.renderer.deleteMesh(mesh);
                this.meshes.delete(key);

                // Clean up buffer IDs
                if (this.meshBuffers.has(key)) {
                    for (const bufferId of this.meshBuffers.get(key)) {
                        this.bufferManager.releaseBuffer(bufferId);
                    }
                    this.meshBuffers.delete(key);
                }
            }

            this.dirtyChunks.delete(key);
            this.totalChunks--;

            // Remove from spatial index
            this.spatialIndex.removeChunk(x, y, z);

            // Remove bounds
            this.chunkBounds.delete(key);

            // Cancel any pending operations
            if (this.pendingOperations.has(key)) {
                // We can't cancel worker tasks directly, but we can ignore their results
                this.pendingOperations.delete(key);
            }

            // Remove from loaded chunks set
            this.loadedChunkKeys.delete(key);

            debugLog(`Unloaded chunk at ${x}, ${y}, ${z}`);
        }
    }

    // Build/rebuild meshes for dirty chunks
    buildChunkMeshes() {
        // Limit rebuilds per frame
        const rebuildLimit = 2;
        let rebuilt = 0;

        for (const key of this.dirtyChunks) {
            if (rebuilt >= rebuildLimit) break;

            const [x, y, z] = key.split(',').map(Number);
            const chunk = this.getChunk(x, y, z);

            if (chunk) {
                // Skip if there's already a pending mesh operation
                if (this.pendingOperations.has(key) && this.pendingOperations.get(key).type === 'mesh') {
                    continue;
                }

                // Skip if chunk is no longer needed (outside render distance)
                if (!this.loadedChunkKeys.has(key)) {
                    this.dirtyChunks.delete(key);
                    continue;
                }

                if (ENABLE_MULTITHREADING && this.workerPool) {
                    // Get neighbor chunks for proper meshing
                    const neighbors = [];
                    for (let dx = -1; dx <= 1; dx++) {
                        for (let dy = -1; dy <= 1; dy++) {
                            for (let dz = -1; dz <= 1; dz++) {
                                if (dx === 0 && dy === 0 && dz === 0) continue;

                                const nx = x + dx;
                                const ny = y + dy;
                                const nz = z + dz;
                                const nkey = this.getChunkKey(nx, ny, nz);

                                if (this.chunks.has(nkey)) {
                                    const neighbor = this.chunks.get(nkey);
                                    // Serialize neighbor chunk data
                                    neighbors.push({
                                        x: nx,
                                        y: ny,
                                        z: nz,
                                        voxelData: neighbor.serialize()
                                    });
                                }
                            }
                        }
                    }

                    // Mark as pending
                    this.pendingOperations.set(key, {
                        type: 'mesh',
                        x, y, z
                    });

                    // Queue meshing task for worker
                    const chunkData = chunk.serialize();
                    const transferables = [chunkData.buffer];

                    // Add neighbor buffers to transferables
                    for (const neighbor of neighbors) {
                        if (neighbor.voxelData && neighbor.voxelData.buffer) {
                            transferables.push(neighbor.voxelData.buffer);
                        }
                    }

                    this.workerPool.addTask(
                        'generateMesh',
                        {
                            chunkData,
                            x, y, z,
                            neighbors
                        },
                        this.handleMeshGenerated.bind(this),
                        transferables, // Use transferables for better performance
                        false // Meshing is not as high priority as chunk generation
                    );

                    rebuilt++;
                } else {
                    // Generate mesh synchronously
                    const mesh = this.mesher.generateMesh(chunk, x, y, z,
                        (cx, cy, cz) => this.getChunk(cx, cy, cz));

                    // Skip if no vertices (empty chunk)
                    if (mesh.positions.length === 0) {
                        this.dirtyChunks.delete(key);
                        // Delete existing mesh if it exists
                        if (this.meshes.has(key)) {
                            this.renderer.deleteMesh(this.meshes.get(key));
                            this.meshes.delete(key);

                            // Clean up buffer IDs
                            if (this.meshBuffers.has(key)) {
                                for (const bufferId of this.meshBuffers.get(key)) {
                                    this.bufferManager.releaseBuffer(bufferId);
                                }
                                this.meshBuffers.delete(key);
                            }
                        }
                        continue;
                    }

                    // Create WebGL mesh
                    const worldOffset = [x * CHUNK_SIZE, y * CHUNK_SIZE, z * CHUNK_SIZE];
                    const glMesh = this.renderer.createMesh(mesh, worldOffset);

                    // Store buffer IDs for cleanup
                    if (glMesh.bufferIds) {
                        this.meshBuffers.set(key, glMesh.bufferIds);
                    }

                    // Update with tight bounds if enabled
                    if (USE_TIGHT_BOUNDS && this.chunkBounds.has(key)) {
                        glMesh.bounds = this.chunkBounds.get(key);
                    }

                    // Delete old mesh if it exists
                    if (this.meshes.has(key)) {
                        this.renderer.deleteMesh(this.meshes.get(key));

                        // Clean up buffer IDs
                        if (this.meshBuffers.has(key)) {
                            for (const bufferId of this.meshBuffers.get(key)) {
                                this.bufferManager.releaseBuffer(bufferId);
                            }
                        }
                    }

                    // Store mesh
                    this.meshes.set(key, glMesh);
                    this.dirtyChunks.delete(key);
                    rebuilt++;

                    debugLog(`Built mesh for chunk ${key}: ${mesh.positions.length / 3} vertices`);
                }
            }
        }

        // Update total vertex count
        let totalVertices = 0;
        for (const mesh of this.meshes.values()) {
            totalVertices += mesh.vertexCount;
        }
        document.getElementById('vertices').textContent = totalVertices;
    }

    // Handle mesh generation completion from worker
    handleMeshGenerated(result) {
        const { x, y, z, vertexCount } = result;
        const key = this.getChunkKey(x, y, z);

        // Skip if chunk no longer exists or is no longer needed
        if (!this.chunks.has(key) || !this.loadedChunkKeys.has(key)) {
            this.pendingOperations.delete(key);
            return;
        }

        // Skip if empty mesh
        if (vertexCount === 0) {
            this.dirtyChunks.delete(key);
            this.pendingOperations.delete(key);

            // Delete existing mesh if it exists
            if (this.meshes.has(key)) {
                this.renderer.deleteMesh(this.meshes.get(key));
                this.meshes.delete(key);

                // Clean up buffer IDs
                if (this.meshBuffers.has(key)) {
                    for (const bufferId of this.meshBuffers.get(key)) {
                        this.bufferManager.releaseBuffer(bufferId);
                    }
                    this.meshBuffers.delete(key);
                }
            }

            return;
        }

        // Convert typed arrays to mesh data format
        const mesh = {
            positions: Array.from(result.vertexBuffer),
            normals: Array.from(result.normalBuffer),
            colors: Array.from(result.colorBuffer),
            indices: Array.from(result.indexBuffer)
        };

        // Create WebGL mesh
        const worldOffset = [x * CHUNK_SIZE, y * CHUNK_SIZE, z * CHUNK_SIZE];
        const glMesh = this.renderer.createMesh(mesh, worldOffset);

        // Store buffer IDs for cleanup
        if (glMesh.bufferIds) {
            this.meshBuffers.set(key, glMesh.bufferIds);
        }

        // Update with tight bounds if enabled
        if (USE_TIGHT_BOUNDS && this.chunkBounds.has(key)) {
            glMesh.bounds = this.chunkBounds.get(key);
        }

        // Delete old mesh if it exists
        if (this.meshes.has(key)) {
            this.renderer.deleteMesh(this.meshes.get(key));

            // Clean up buffer IDs
            if (this.meshBuffers.has(key)) {
                for (const bufferId of this.meshBuffers.get(key)) {
                    this.bufferManager.releaseBuffer(bufferId);
                }
            }
        }

        // Store mesh and mark as not dirty
        this.meshes.set(key, glMesh);
        this.dirtyChunks.delete(key);
        this.pendingOperations.delete(key);

        debugLog(`Built mesh from worker for chunk ${key}: ${vertexCount} vertices`);
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
        }

        // Update voxel in chunk
        chunk.setVoxel(localX, localY, localZ, voxelType);

        // Mark chunk as dirty
        this.markChunkDirty(chunkX, chunkY, chunkZ);

        // Mark neighboring chunks as dirty if this voxel is on a boundary
        if (localX === 0) this.markChunkDirty(chunkX - 1, chunkY, chunkZ);
        if (localX === CHUNK_SIZE - 1) this.markChunkDirty(chunkX + 1, chunkY, chunkZ);
        if (localY === 0) this.markChunkDirty(chunkX, chunkY - 1, chunkZ);
        if (localY === CHUNK_SIZE - 1) this.markChunkDirty(chunkX, chunkY + 1, chunkZ);
        if (localZ === 0) this.markChunkDirty(chunkX, chunkY, chunkZ - 1);
        if (localZ === CHUNK_SIZE - 1) this.markChunkDirty(chunkX, chunkY, chunkZ + 1);

        // Update bounds
        if (USE_TIGHT_BOUNDS) {
            const key = this.getChunkKey(chunkX, chunkY, chunkZ);
            const bounds = this.spatialIndex.calculateTightBounds(chunkX, chunkY, chunkZ, chunk);
            this.chunkBounds.set(key, bounds);
        }
    }

    // Create a crater at world coordinates
    createCrater(worldX, worldY, worldZ, radius) {
        debugLog(`Creating crater at ${worldX}, ${worldY}, ${worldZ} with radius ${radius}`);

        if (ENABLE_MULTITHREADING && this.workerPool) {
            // Get chunks that might be affected
            const chunkRadius = Math.ceil(radius / CHUNK_SIZE) + 1;
            const centerChunkX = Math.floor(worldX / CHUNK_SIZE);
            const centerChunkY = Math.floor(worldY / CHUNK_SIZE);
            const centerChunkZ = Math.floor(worldZ / CHUNK_SIZE);

            // Collect chunks in radius
            const chunks = [];
            for (let cx = centerChunkX - chunkRadius; cx <= centerChunkX + chunkRadius; cx++) {
                for (let cy = centerChunkY - chunkRadius; cy <= centerChunkY + chunkRadius; cy++) {
                    for (let cz = centerChunkZ - chunkRadius; cz <= centerChunkZ + chunkRadius; cz++) {
                        const key = this.getChunkKey(cx, cy, cz);
                        if (this.chunks.has(key)) {
                            const chunk = this.chunks.get(key);
                            chunks.push({
                                chunkX: cx,
                                chunkY: cy,
                                chunkZ: cz,
                                voxelData: chunk.serialize()
                            });
                        }
                    }
                }
            }

            // Prepare transferables for better performance
            const transferables = [];
            for (const chunk of chunks) {
                if (chunk.voxelData && chunk.voxelData.buffer) {
                    transferables.push(chunk.voxelData.buffer);
                }
            }

            // Send task to worker
            this.workerPool.addTask(
                'createCrater',
                {
                    centerX: worldX,
                    centerY: worldY,
                    centerZ: worldZ,
                    radius,
                    chunks
                },
                this.handleCraterCreated.bind(this),
                transferables, // Use transferables for better performance
                true // Priority task
            );
        } else {
            // Process crater synchronously
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
    }

    // Handle crater creation completed by worker
    handleCraterCreated(result) {
        const { modifiedChunks } = result;

        // Update each modified chunk
        for (const chunkData of modifiedChunks) {
            const { chunkX, chunkY, chunkZ, voxelData } = chunkData;
            const key = this.getChunkKey(chunkX, chunkY, chunkZ);

            // Get chunk if it exists
            if (this.chunks.has(key)) {
                const chunk = this.chunks.get(key);

                // Update with new data - including air voxels
                chunk.fillFromArray(voxelData);

                // Mark as dirty for mesh rebuild
                this.dirtyChunks.add(key);

                // Mark neighboring chunks as dirty if this chunk is on a boundary
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dz = -1; dz <= 1; dz++) {
                            if (dx === 0 && dy === 0 && dz === 0) continue;
                            const neighborKey = this.getChunkKey(chunkX + dx, chunkY + dy, chunkZ + dz);
                            if (this.chunks.has(neighborKey)) {
                                this.dirtyChunks.add(neighborKey);
                            }
                        }
                    }
                }

                // Update bounds
                if (USE_TIGHT_BOUNDS) {
                    const bounds = this.spatialIndex.calculateTightBounds(chunkX, chunkY, chunkZ, chunk);
                    this.chunkBounds.set(key, bounds);
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
        let lastPos = [...origin];

        for (let i = 0; i < maxSteps; i++) {
            lastPos = [...currentPos]; // Save last position for normal calculation

            // Move along the ray
            currentPos[0] += direction[0] * stepSize;
            currentPos[1] += direction[1] * stepSize;
            currentPos[2] += direction[2] * stepSize;

            const x = Math.floor(currentPos[0]);
            const y = Math.floor(currentPos[1]);
            const z = Math.floor(currentPos[2]);

            // Check if we've hit a voxel
            const voxel = this.getVoxel(x, y, z);
            if (voxel !== 0) {
                // Calculate hit normal based on which face was hit
                const dx = currentPos[0] - lastPos[0];
                const dy = currentPos[1] - lastPos[1];
                const dz = currentPos[2] - lastPos[2];

                // Determine which axis had the largest movement
                let normal = [0, 0, 0];
                if (Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) >= Math.abs(dz)) {
                    normal[0] = dx > 0 ? -1 : 1;
                } else if (Math.abs(dy) >= Math.abs(dx) && Math.abs(dy) >= Math.abs(dz)) {
                    normal[1] = dy > 0 ? -1 : 1;
                } else {
                    normal[2] = dz > 0 ? -1 : 1;
                }

                debugLog(`Raycast hit at ${x}, ${y}, ${z}, voxel type: ${voxel}`);
                return {
                    position: [x, y, z],
                    voxelType: voxel,
                    distance: i * stepSize,
                    normal
                };
            }
        }

        debugLog(`Raycast missed (exceeded maxDistance)`);
        return null; // No hit
    }

    // Render all chunks with frustum culling
    render(projectionMatrix, viewMatrix) {
        // Create combined projection-view matrix
        const projViewMatrix = mat4.create();
        mat4.multiply(projViewMatrix, projectionMatrix, viewMatrix);

        // Get visible meshes using spatial index
        const cameraPosition = [
            -viewMatrix[12], -viewMatrix[13], -viewMatrix[14]
        ];

        // Update frustum for culling
        const frustum = mat4.frustumFromMatrix(projViewMatrix);

        // Filter meshes based on frustum culling using either spatial index or direct iteration
        let visibleMeshes;
        if (this.spatialIndex) {
            // Use spatial index to find potentially visible chunks
            const visibleChunks = this.spatialIndex.findVisibleChunks(cameraPosition, frustum);
            this.cullStats.total = this.meshes.size;

            // Get meshes for visible chunks
            visibleMeshes = visibleChunks
                .map(({ x, y, z }) => this.getChunkMesh(x, y, z))
                .filter(mesh => mesh !== undefined);

            this.cullStats.culled = this.cullStats.total - visibleMeshes.length;
        } else {
            // Fall back to direct iteration and culling
            const meshArray = Array.from(this.meshes.values());
            this.cullStats.total = meshArray.length;

            visibleMeshes = meshArray.filter(mesh =>
                mesh && this.renderer.isMeshInFrustum(mesh, projViewMatrix)
            );

            this.cullStats.culled = this.cullStats.total - visibleMeshes.length;
        }

        // Render visible meshes
        return this.renderer.renderChunks(visibleMeshes, projectionMatrix, viewMatrix);
    }
}
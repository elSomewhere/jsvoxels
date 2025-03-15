// threaded-chunk-manager.js
import { CHUNK_SIZE, RENDER_DISTANCE } from './constants.js';
import { debugLog } from './math-utils.js';
import { Chunk } from './voxel-data.js';
import { mat4 } from './math-utils.js';
import { WorkerPool } from './worker-pool.js';

export class ThreadedChunkManager {
    constructor(renderer) {
        this.renderer = renderer;

        // Core data structures
        this.chunks = new Map();           // Map of loaded chunks
        this.meshes = new Map();           // Map of chunk meshes
        this.dirtyChunks = new Set();      // Chunks that need mesh rebuilding
        this.loadQueue = [];               // Queue for chunks to load
        this.unloadQueue = [];             // Queue for chunks to unload
        this.pendingChunks = new Map();    // Map of chunks being generated
        this.pendingMeshes = new Map();    // Map of meshes being generated

        // Stats
        this.totalChunks = 0;
        this.totalNodes = 0;
        this.cullStats = { total: 0, culled: 0 };

        const baseUrl = new URL('./', window.location.href).href;
        this.terrainWorkers = new WorkerPool(baseUrl + 'terrain-worker.js', 2);
        this.meshingWorkers = new WorkerPool(baseUrl + 'meshing-worker.js', 2);

        // Initialize workers
        this.initializeWorkers();
    }

    async initializeWorkers() {
        // Initialize terrain workers with a seed
        await new Promise(resolve => {
            this.terrainWorkers.addTask('init', {
                seed: Math.random() * 10000
            }, {
                onComplete: () => resolve(),
                onError: (err) => {
                    console.error('Failed to initialize terrain worker:', err);
                    resolve();
                }
            });
        });

        // Initialize meshing workers
        await new Promise(resolve => {
            this.meshingWorkers.addTask('init', {}, {
                onComplete: () => resolve(),
                onError: (err) => {
                    console.error('Failed to initialize meshing worker:', err);
                    resolve();
                }
            });
        });

        debugLog('Workers initialized');
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

    // Request a chunk to be generated in a worker
    requestChunk(chunkX, chunkY, chunkZ) {
        const key = this.getChunkKey(chunkX, chunkY, chunkZ);

        // Skip if already loaded or pending
        if (this.chunks.has(key) || this.pendingChunks.has(key)) {
            return;
        }

        // Mark as pending
        this.pendingChunks.set(key, {
            chunkX,
            chunkY,
            chunkZ,
            priority: this.calculateChunkPriority(chunkX, chunkY, chunkZ)
        });

        // Add task to worker
        this.terrainWorkers.addTask('generateChunk', {
            chunkX,
            chunkY,
            chunkZ
        }, {
            onComplete: (result) => this.onChunkGenerated(result),
            onError: (error) => {
                console.error(`Error generating chunk ${key}:`, error);
                this.pendingChunks.delete(key);
            }
        });
    }

    // Calculate priority for chunk loading (lower = higher priority)
    calculateChunkPriority(chunkX, chunkY, chunkZ) {
        // This will be used to prioritize chunks closer to the player
        const centerChunkX = Math.floor(this.playerX / CHUNK_SIZE);
        const centerChunkY = Math.floor(this.playerY / CHUNK_SIZE);
        const centerChunkZ = Math.floor(this.playerZ / CHUNK_SIZE);

        const dx = chunkX - centerChunkX;
        const dy = chunkY - centerChunkY;
        const dz = chunkZ - centerChunkZ;

        return dx * dx + dy * dy + dz * dz;
    }

    // Handle chunk data received from worker
    onChunkGenerated(result) {
        const { chunkX, chunkY, chunkZ, chunkData } = result;
        const key = this.getChunkKey(chunkX, chunkY, chunkZ);

        // Create a new chunk
        const chunk = new Chunk();

        // Deserialize the chunk data
        for (let y = 0; y < CHUNK_SIZE; y++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                for (let x = 0; x < CHUNK_SIZE; x++) {
                    const index = (y * CHUNK_SIZE * CHUNK_SIZE) + (z * CHUNK_SIZE) + x;
                    const voxelType = chunkData[index];

                    if (voxelType !== 0) {
                        chunk.setVoxel(x, y, z, voxelType);
                    }
                }
            }
        }

        // Store the chunk
        this.chunks.set(key, chunk);
        this.pendingChunks.delete(key);
        this.totalChunks++;

        // Mark for meshing
        this.dirtyChunks.add(key);

        debugLog(`Chunk generated: ${chunkX}, ${chunkY}, ${chunkZ}`);
    }

    // Update chunks based on player position
    updateChunks(playerX, playerY, playerZ) {
        // Store player position for priority calculations
        this.playerX = playerX;
        this.playerY = playerY;
        this.playerZ = playerZ;

        // Convert player position to chunk coordinates
        const centerChunkX = Math.floor(playerX / CHUNK_SIZE);
        const centerChunkY = Math.floor(playerY / CHUNK_SIZE);
        const centerChunkZ = Math.floor(playerZ / CHUNK_SIZE);

        // Add chunks that should be loaded to queue
        for (let x = centerChunkX - RENDER_DISTANCE; x <= centerChunkX + RENDER_DISTANCE; x++) {
            for (let y = 0; y <= Math.max(0, centerChunkY + RENDER_DISTANCE); y++) {
                for (let z = centerChunkZ - RENDER_DISTANCE; z <= centerChunkZ + RENDER_DISTANCE; z++) {
                    // Skip chunks that are too far away (use spherical distance)
                    const dx = x - centerChunkX;
                    const dy = y - centerChunkY;
                    const dz = z - centerChunkZ;
                    const distSquared = dx * dx + dy * dy + dz * dz;

                    if (distSquared <= RENDER_DISTANCE * RENDER_DISTANCE &&
                        !this.hasChunk(x, y, z) &&
                        !this.pendingChunks.has(this.getChunkKey(x, y, z))) {
                        // Add to load queue with priority
                        this.loadQueue.push({
                            coords: [x, y, z],
                            dist: distSquared
                        });
                    }
                }
            }
        }

        // Sort load queue by distance for priority loading
        this.loadQueue.sort((a, b) => a.dist - b.dist);

        // Add chunks that should be unloaded to queue
        for (const [key, chunk] of this.chunks.entries()) {
            const [x, y, z] = key.split(',').map(Number);
            const dx = x - centerChunkX;
            const dy = y - centerChunkY;
            const dz = z - centerChunkZ;
            const distSquared = dx * dx + dy * dy + dz * dz;

            if (distSquared > RENDER_DISTANCE * RENDER_DISTANCE * 1.5) { // 1.5x radius for unloading
                this.unloadQueue.push([x, y, z]);
            }
        }

        // Process load queue (limited per frame)
        const loadLimit = 4; // Can process more since actual generation is async
        let loaded = 0;

        while (this.loadQueue.length > 0 && loaded < loadLimit) {
            const { coords } = this.loadQueue.shift();
            const [x, y, z] = coords;

            // Request chunk generation in worker
            this.requestChunk(x, y, z);
            loaded++;
        }

        // Process unload queue
        const unloadLimit = 2;
        let unloaded = 0;

        while (this.unloadQueue.length > 0 && unloaded < unloadLimit) {
            const [x, y, z] = this.unloadQueue.shift();
            this.unloadChunk(x, y, z);
            unloaded++;
        }

        // Update stats display
        document.getElementById('chunks').textContent = this.totalChunks;
        document.getElementById('position').textContent = `${Math.floor(playerX)},${Math.floor(playerY)},${Math.floor(playerZ)}`;

        // Update worker stats if debug info is available
        const terrainStats = this.terrainWorkers.getStats();
        const meshingStats = this.meshingWorkers.getStats();

        if (document.getElementById('workerStats')) {
            document.getElementById('workerStats').textContent =
                `Terrain: ${terrainStats.activeWorkers}/${terrainStats.poolSize} active, ${terrainStats.queuedTasks} queued | ` +
                `Meshing: ${meshingStats.activeWorkers}/${meshingStats.poolSize} active, ${meshingStats.queuedTasks} queued`;
        }
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
            }

            this.dirtyChunks.delete(key);
            this.totalChunks--;
            debugLog(`Unloaded chunk at ${x}, ${y}, ${z}`);
        }

        // Cancel any pending tasks for this chunk
        if (this.pendingChunks.has(key)) {
            // We can't truly cancel a worker task, but we can ignore the result
            this.pendingChunks.delete(key);
        }

        if (this.pendingMeshes.has(key)) {
            this.pendingMeshes.delete(key);
        }
    }

    // Build/rebuild meshes for dirty chunks
    buildChunkMeshes() {
        // Limit rebuilds per frame
        const rebuildLimit = 4;  // We can queue more rebuilds since they're async
        let queued = 0;

        // Convert dirty chunks set to array and sort by priority
        const dirtyChunksArray = Array.from(this.dirtyChunks).map(key => {
            const [x, y, z] = key.split(',').map(Number);
            return {
                key,
                priority: this.calculateChunkPriority(x, y, z)
            };
        }).sort((a, b) => a.priority - b.priority);

        for (const { key } of dirtyChunksArray) {
            if (queued >= rebuildLimit) break;

            // Skip if already being processed
            if (this.pendingMeshes.has(key)) continue;

            const [x, y, z] = key.split(',').map(Number);
            const chunk = this.getChunk(x, y, z);

            if (chunk) {
                // Mark as pending
                this.pendingMeshes.set(key, { x, y, z });

                // Remove from dirty set
                this.dirtyChunks.delete(key);

                // Get neighbor chunks for proper face culling
                const neighborChunks = {};

                // For each neighboring chunk position
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dz = -1; dz <= 1; dz++) {
                            if (dx === 0 && dy === 0 && dz === 0) continue;

                            const nx = x + dx;
                            const ny = y + dy;
                            const nz = z + dz;
                            const neighborKey = this.getChunkKey(nx, ny, nz);
                            const neighborChunk = this.getChunk(nx, ny, nz);

                            if (neighborChunk) {
                                // Serialize this neighbor for the worker
                                const neighborData = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);

                                // Fill the array with voxel types
                                for (let y = 0; y < CHUNK_SIZE; y++) {
                                    for (let z = 0; z < CHUNK_SIZE; z++) {
                                        for (let x = 0; x < CHUNK_SIZE; x++) {
                                            const index = (y * CHUNK_SIZE * CHUNK_SIZE) + (z * CHUNK_SIZE) + x;
                                            neighborData[index] = neighborChunk.getVoxel(x, y, z);
                                        }
                                    }
                                }

                                neighborChunks[neighborKey] = neighborData;
                            }
                        }
                    }
                }

                // Serialize the chunk data
                const chunkData = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
                for (let y = 0; y < CHUNK_SIZE; y++) {
                    for (let z = 0; z < CHUNK_SIZE; z++) {
                        for (let x = 0; x < CHUNK_SIZE; x++) {
                            const index = (y * CHUNK_SIZE * CHUNK_SIZE) + (z * CHUNK_SIZE) + x;
                            chunkData[index] = chunk.getVoxel(x, y, z);
                        }
                    }
                }

                // Create list of transferables for efficient transfer
                const transferables = [chunkData.buffer];
                for (const buffer of Object.values(neighborChunks)) {
                    transferables.push(buffer.buffer);
                }

                // Queue mesh generation in worker
                this.meshingWorkers.addTask('generateMesh', {
                    chunkX: x,
                    chunkY: y,
                    chunkZ: z,
                    chunkData,
                    neighborChunks
                }, {
                    onComplete: (meshData) => this.onMeshGenerated(meshData),
                    onError: (error) => {
                        console.error(`Error generating mesh for chunk ${key}:`, error);
                        this.pendingMeshes.delete(key);
                        // Mark as dirty again to retry later
                        this.dirtyChunks.add(key);
                    }
                }, transferables);

                queued++;
            }
        }
    }

    // Handle mesh data received from worker
    onMeshGenerated(meshData) {
        const { chunkX, chunkY, chunkZ, positions, normals, colors, indices } = meshData;
        const key = this.getChunkKey(chunkX, chunkY, chunkZ);

        // Clear pending status
        this.pendingMeshes.delete(key);

        // Skip if chunk was unloaded while mesh was being generated
        if (!this.chunks.has(key)) {
            return;
        }

        // Skip if no vertices (empty chunk)
        if (positions.length === 0) {
            // Delete existing mesh if it exists
            if (this.meshes.has(key)) {
                this.renderer.deleteMesh(this.meshes.get(key));
                this.meshes.delete(key);
            }
            return;
        }

        // Create WebGL mesh
        const worldOffset = [chunkX * CHUNK_SIZE, chunkY * CHUNK_SIZE, chunkZ * CHUNK_SIZE];
        const mesh = {
            positions,
            normals,
            colors,
            indices
        };
        const glMesh = this.renderer.createMesh(mesh, worldOffset);

        // Delete old mesh if it exists
        if (this.meshes.has(key)) {
            this.renderer.deleteMesh(this.meshes.get(key));
        }

        // Store mesh
        this.meshes.set(key, glMesh);

        debugLog(`Built mesh for chunk ${key}: ${positions.length / 3} vertices`);
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

        // Get chunk
        const chunk = this.getChunk(chunkX, chunkY, chunkZ);
        if (!chunk) {
            // Chunk not loaded, can't modify
            return;
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

    // Render all chunks with frustum culling
    render(projectionMatrix, viewMatrix) {
        // Create combined projection-view matrix
        const projViewMatrix = mat4.create();
        mat4.multiply(projViewMatrix, projectionMatrix, viewMatrix);

        // Filter meshes based on frustum culling
        const meshArray = Array.from(this.meshes.values());
        this.cullStats.total = meshArray.length;

        const visibleMeshes = meshArray.filter(mesh =>
            mesh && this.renderer.isMeshInFrustum(mesh, projViewMatrix)
        );

        this.cullStats.culled = this.cullStats.total - visibleMeshes.length;

        // Render visible meshes
        return this.renderer.renderChunks(visibleMeshes, projectionMatrix, viewMatrix);
    }

    // Clean up resources when done
    dispose() {
        this.terrainWorkers.terminate();
        this.meshingWorkers.terminate();
    }
}
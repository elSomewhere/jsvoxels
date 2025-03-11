import { CHUNK_SIZE, RENDER_DISTANCE } from './constants.js';
import { debugLog } from './math-utils.js';
import { Chunk } from './voxel-data.js';
import { mat4 } from './math-utils.js';

export class ChunkManager {
    constructor(worldGenerator, mesher, renderer) {
        this.worldGenerator = worldGenerator;
        this.mesher = mesher;
        this.renderer = renderer;

        this.chunks = new Map();  // Map of loaded chunks
        this.meshes = new Map();  // Map of chunk meshes
        this.dirtyChunks = new Set(); // Chunks that need mesh rebuilding
        this.loadQueue = [];      // Queue for chunks to load
        this.unloadQueue = [];    // Queue for chunks to unload
        this.totalChunks = 0;
        this.totalNodes = 0;
        this.cullStats = { total: 0, culled: 0 };
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

        if (this.chunks.has(key)) {
            return this.chunks.get(key);
        }

        // Generate a new chunk
        debugLog(`Creating new chunk at ${chunkX}, ${chunkY}, ${chunkZ}`);
        const chunk = this.worldGenerator.generateChunk(chunkX, chunkY, chunkZ);

        this.chunks.set(key, chunk);
        this.dirtyChunks.add(key);
        this.totalChunks++;

        return chunk;
    }

    // Update chunks based on player position
    updateChunks(playerX, playerY, playerZ) {
        // Convert player position to chunk coordinates
        const centerChunkX = Math.floor(playerX / CHUNK_SIZE);
        const centerChunkY = Math.floor(playerY / CHUNK_SIZE);
        const centerChunkZ = Math.floor(playerZ / CHUNK_SIZE);

        // Add chunks that should be loaded to queue
        for (let x = centerChunkX - RENDER_DISTANCE; x <= centerChunkX + RENDER_DISTANCE; x++) {
            for (let y = 0; y <= centerChunkY + RENDER_DISTANCE; y++) {
                for (let z = centerChunkZ - RENDER_DISTANCE; z <= centerChunkZ + RENDER_DISTANCE; z++) {
                    // Skip chunks that are too far away (use spherical distance)
                    const dx = x - centerChunkX;
                    const dy = y - centerChunkY;
                    const dz = z - centerChunkZ;
                    const distSquared = dx * dx + dy * dy + dz * dz;

                    if (distSquared <= RENDER_DISTANCE * RENDER_DISTANCE && !this.hasChunk(x, y, z)) {
                        // Prioritize chunks closer to player
                        this.loadQueue.push({ coords: [x, y, z], dist: distSquared });
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
        const loadLimit = 2;
        let loaded = 0;

        while (this.loadQueue.length > 0 && loaded < loadLimit) {
            const { coords } = this.loadQueue.shift();
            const [x, y, z] = coords;
            if (!this.hasChunk(x, y, z)) {
                this.getOrCreateChunk(x, y, z);
                loaded++;
            }
        }

        // Process unload queue
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
            }

            this.dirtyChunks.delete(key);
            this.totalChunks--;
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
                // Generate mesh
                const mesh = this.mesher.generateMesh(chunk, x, y, z,
                    (cx, cy, cz) => this.getChunk(cx, cy, cz));

                // Skip if no vertices (empty chunk)
                if (mesh.positions.length === 0) {
                    this.dirtyChunks.delete(key);
                    // Delete existing mesh if it exists
                    if (this.meshes.has(key)) {
                        this.renderer.deleteMesh(this.meshes.get(key));
                        this.meshes.delete(key);
                    }
                    continue;
                }

                // Create WebGL mesh
                const worldOffset = [x * CHUNK_SIZE, y * CHUNK_SIZE, z * CHUNK_SIZE];
                const glMesh = this.renderer.createMesh(mesh, worldOffset);

                // Delete old mesh if it exists
                if (this.meshes.has(key)) {
                    this.renderer.deleteMesh(this.meshes.get(key));
                }

                // Store mesh
                this.meshes.set(key, glMesh);
                this.dirtyChunks.delete(key);
                rebuilt++;

                debugLog(`Built mesh for chunk ${key}: ${mesh.positions.length / 3} vertices`);
            }
        }

        // Update total vertex count
        let totalVertices = 0;
        for (const mesh of this.meshes.values()) {
            totalVertices += mesh.vertexCount;
        }
        document.getElementById('vertices').textContent = totalVertices;
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
}
// Spatial index for efficient chunk lookups
import { CHUNK_SIZE, RENDER_DISTANCE } from './constants.js';
import { debugLog, mat4 } from './math-utils.js';

// Spatial hashing constants
const CELL_SIZE = CHUNK_SIZE * 4; // Larger cells for coarse indexing

export class SpatialIndex {
    constructor() {
        // Main spatial hash map
        this.cells = new Map();

        // Secondary indices
        this.chunkToCell = new Map(); // Maps chunk keys to cell keys
        this.allChunks = new Set(); // Set of all chunk keys

        // Statistics
        this.stats = {
            totalChunks: 0,
            totalCells: 0,
            avgChunksPerCell: 0,
            maxChunksPerCell: 0
        };
    }

    // Convert 3D coordinates to cell key
    getCellKey(x, y, z) {
        const cellX = Math.floor(x / CELL_SIZE);
        const cellY = Math.floor(y / CELL_SIZE);
        const cellZ = Math.floor(z / CELL_SIZE);
        return `${cellX},${cellY},${cellZ}`;
    }

    // Get chunk key from coordinates
    getChunkKey(x, y, z) {
        return `${x},${y},${z}`;
    }

    // Add a chunk to the spatial index
    addChunk(chunkX, chunkY, chunkZ, chunk) {
        const chunkKey = this.getChunkKey(chunkX, chunkY, chunkZ);

        // Skip if already indexed
        if (this.allChunks.has(chunkKey)) {
            return;
        }

        // Calculate cell coordinates
        const worldX = chunkX * CHUNK_SIZE;
        const worldY = chunkY * CHUNK_SIZE;
        const worldZ = chunkZ * CHUNK_SIZE;
        const cellKey = this.getCellKey(worldX, worldY, worldZ);

        // Add to cell
        if (!this.cells.has(cellKey)) {
            this.cells.set(cellKey, new Set());
            this.stats.totalCells++;
        }

        const cell = this.cells.get(cellKey);
        cell.add(chunkKey);

        // Update secondary indices
        this.chunkToCell.set(chunkKey, cellKey);
        this.allChunks.add(chunkKey);

        // Update stats
        this.stats.totalChunks++;
        this.stats.maxChunksPerCell = Math.max(this.stats.maxChunksPerCell, cell.size);
        this.stats.avgChunksPerCell = this.stats.totalChunks / this.stats.totalCells;
    }

    // Remove a chunk from the spatial index
    removeChunk(chunkX, chunkY, chunkZ) {
        const chunkKey = this.getChunkKey(chunkX, chunkY, chunkZ);

        // Skip if not indexed
        if (!this.allChunks.has(chunkKey)) {
            return;
        }

        // Get cell key
        const cellKey = this.chunkToCell.get(chunkKey);
        if (!cellKey || !this.cells.has(cellKey)) {
            return;
        }

        // Remove from cell
        const cell = this.cells.get(cellKey);
        cell.delete(chunkKey);

        // Remove empty cells
        if (cell.size === 0) {
            this.cells.delete(cellKey);
            this.stats.totalCells--;
        }

        // Update secondary indices
        this.chunkToCell.delete(chunkKey);
        this.allChunks.delete(chunkKey);

        // Update stats
        this.stats.totalChunks--;
        if (this.stats.totalCells > 0) {
            this.stats.avgChunksPerCell = this.stats.totalChunks / this.stats.totalCells;
        } else {
            this.stats.avgChunksPerCell = 0;
        }
    }

    // Check if a chunk exists in the index
    hasChunk(chunkX, chunkY, chunkZ) {
        const chunkKey = this.getChunkKey(chunkX, chunkY, chunkZ);
        return this.allChunks.has(chunkKey);
    }

    // Find chunks within a radius of a point
    findChunksInRadius(worldX, worldY, worldZ, radius) {
        const result = [];
        const radiusSquared = radius * radius;

        // Convert to chunk coordinates
        const centerChunkX = Math.floor(worldX / CHUNK_SIZE);
        const centerChunkY = Math.floor(worldY / CHUNK_SIZE);
        const centerChunkZ = Math.floor(worldZ / CHUNK_SIZE);

        // Calculate cell range to check
        const cellRadius = Math.ceil(radius / CELL_SIZE) + 1;
        const minCellX = Math.floor((worldX - radius) / CELL_SIZE);
        const maxCellX = Math.floor((worldX + radius) / CELL_SIZE);
        const minCellY = Math.floor((worldY - radius) / CELL_SIZE);
        const maxCellY = Math.floor((worldY + radius) / CELL_SIZE);
        const minCellZ = Math.floor((worldZ - radius) / CELL_SIZE);
        const maxCellZ = Math.floor((worldZ + radius) / CELL_SIZE);

        // Check each cell in range
        for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
            for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
                for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
                    const cellKey = `${cellX},${cellY},${cellZ}`;
                    const cell = this.cells.get(cellKey);

                    if (!cell) continue;

                    // Check each chunk in the cell
                    for (const chunkKey of cell) {
                        const [x, y, z] = chunkKey.split(',').map(Number);

                        // Calculate chunk center in world coordinates
                        const chunkCenterX = (x + 0.5) * CHUNK_SIZE;
                        const chunkCenterY = (y + 0.5) * CHUNK_SIZE;
                        const chunkCenterZ = (z + 0.5) * CHUNK_SIZE;

                        // Calculate squared distance
                        const dx = chunkCenterX - worldX;
                        const dy = chunkCenterY - worldY;
                        const dz = chunkCenterZ - worldZ;
                        const distSquared = dx * dx + dy * dy + dz * dz;

                        // Check if within radius
                        if (distSquared <= radiusSquared) {
                            result.push({
                                x, y, z,
                                distanceSquared: distSquared
                            });
                        }
                    }
                }
            }
        }

        // Sort by distance
        result.sort((a, b) => a.distanceSquared - b.distanceSquared);

        return result;
    }

    // Find chunks visible from a position with frustum culling
    findVisibleChunks(viewPosition, frustum) {
        const result = [];

        // Get cells that might be visible
        const cellX = Math.floor(viewPosition[0] / CELL_SIZE);
        const cellY = Math.floor(viewPosition[1] / CELL_SIZE);
        const cellZ = Math.floor(viewPosition[2] / CELL_SIZE);

        // Search range based on render distance
        const searchRange = Math.ceil(RENDER_DISTANCE * CHUNK_SIZE / CELL_SIZE) + 1;

        // Check each potentially visible cell
        for (let x = cellX - searchRange; x <= cellX + searchRange; x++) {
            for (let y = 0; y <= cellY + searchRange; y++) {
                for (let z = cellZ - searchRange; z <= cellZ + searchRange; z++) {
                    const cellKey = `${x},${y},${z}`;
                    const cell = this.cells.get(cellKey);

                    if (!cell) continue;

                    // Check each chunk in the cell
                    for (const chunkKey of cell) {
                        const [chunkX, chunkY, chunkZ] = chunkKey.split(',').map(Number);

                        // Calculate chunk bounds
                        const minX = chunkX * CHUNK_SIZE;
                        const minY = chunkY * CHUNK_SIZE;
                        const minZ = chunkZ * CHUNK_SIZE;
                        const maxX = minX + CHUNK_SIZE;
                        const maxY = minY + CHUNK_SIZE;
                        const maxZ = minZ + CHUNK_SIZE;

                        // Check if chunk is in frustum using mat4.isBoxInFrustum instead of frustum.isBoxInFrustum
                        if (mat4.isBoxInFrustum(frustum, minX, minY, minZ, maxX, maxY, maxZ)) {
                            result.push({
                                x: chunkX,
                                y: chunkY,
                                z: chunkZ
                            });
                        }
                    }
                }
            }
        }

        return result;
    }

    // Find neighboring chunks
    findNeighbors(chunkX, chunkY, chunkZ) {
        const neighbors = [];

        // Check all 26 possible neighbors
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    if (dx === 0 && dy === 0 && dz === 0) continue;

                    const nx = chunkX + dx;
                    const ny = chunkY + dy;
                    const nz = chunkZ + dz;

                    if (this.hasChunk(nx, ny, nz)) {
                        neighbors.push({ x: nx, y: ny, z: nz });
                    }
                }
            }
        }

        return neighbors;
    }

    // Calculate tight bounding box for a chunk
    calculateTightBounds(chunkX, chunkY, chunkZ, chunk) {
        // Default is full chunk size
        const bounds = {
            minX: 0,
            minY: 0,
            minZ: 0,
            maxX: CHUNK_SIZE - 1,
            maxY: CHUNK_SIZE - 1,
            maxZ: CHUNK_SIZE - 1
        };

        // Skip if chunk doesn't have sparse data
        if (!chunk || !chunk.rootNode) {
            return bounds;
        }

        // Initialize bounds to opposites to find actual bounds
        let minX = CHUNK_SIZE - 1;
        let minY = CHUNK_SIZE - 1;
        let minZ = CHUNK_SIZE - 1;
        let maxX = 0;
        let maxY = 0;
        let maxZ = 0;
        let foundSolid = false;

        // Scan chunk for non-empty voxels
        for (let y = 0; y < CHUNK_SIZE; y++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                for (let x = 0; x < CHUNK_SIZE; x++) {
                    const voxel = chunk.getVoxel(x, y, z);
                    if (voxel !== 0) {
                        minX = Math.min(minX, x);
                        minY = Math.min(minY, y);
                        minZ = Math.min(minZ, z);
                        maxX = Math.max(maxX, x);
                        maxY = Math.max(maxY, y);
                        maxZ = Math.max(maxZ, z);
                        foundSolid = true;
                    }
                }
            }
        }

        // If we found solid voxels, update bounds
        if (foundSolid) {
            bounds.minX = minX;
            bounds.minY = minY;
            bounds.minZ = minZ;
            bounds.maxX = maxX;
            bounds.maxY = maxY;
            bounds.maxZ = maxZ;
        }

        // Convert to world coordinates
        bounds.worldMinX = chunkX * CHUNK_SIZE + bounds.minX;
        bounds.worldMinY = chunkY * CHUNK_SIZE + bounds.minY;
        bounds.worldMinZ = chunkZ * CHUNK_SIZE + bounds.minZ;
        bounds.worldMaxX = chunkX * CHUNK_SIZE + bounds.maxX + 1;
        bounds.worldMaxY = chunkY * CHUNK_SIZE + bounds.maxY + 1;
        bounds.worldMaxZ = chunkZ * CHUNK_SIZE + bounds.maxZ + 1;

        return bounds;
    }
}
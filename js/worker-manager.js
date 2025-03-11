// worker-manager.js
// Manages a pool of web workers for offloading heavy tasks
import { CHUNK_SIZE } from './constants.js';

export class WorkerManager {
    constructor(workerCount = navigator.hardwareConcurrency || 4) {
        try {
            if (typeof Worker === 'undefined') {
                console.error('Web Workers are not supported in this browser');
                throw new Error('Web Workers not supported');
            }

            this.workers = [];
            this.taskQueue = [];
            this.availableWorkers = [];
            this.nextTaskId = 0;
            this.taskCallbacks = new Map();

            // Limit workers to a reasonable number
            workerCount = Math.min(workerCount, 4);
            console.log(`Initializing ${workerCount} workers`);

            // Create worker pool
            for (let i = 0; i < workerCount; i++) {
                this.createWorker();
            }
        } catch (e) {
            console.error('Failed to initialize workers:', e);
            // Continue without workers - engine will be slower but should still work
            this.workersEnabled = false;
        }
    }

    createWorker() {
        // Create worker with inline code instead of trying to load external files
        const workerScript = `
        // Worker variables
        // Import CHUNK_SIZE from constants
        const CHUNK_SIZE = ${CHUNK_SIZE}; // Use the same CHUNK_SIZE as the main thread
        
        const VoxelType = {
            AIR: 0,
            GRASS: 1,
            BEDROCK: 2,
            STONE: 3,
            DIRT: 4,
            WATER: 5,
            SAND: 6
        };
        
        // Create a simple chunk class for the worker
        class WorkerChunk {
            constructor() {
                this.data = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
                this.nonEmptyCount = 0;
            }
            
            getVoxel(x, y, z) {
                if (x < 0 || x >= CHUNK_SIZE || y < 0 || y >= CHUNK_SIZE || z < 0 || z >= CHUNK_SIZE) {
                    return 0;
                }
                const index = (y * CHUNK_SIZE * CHUNK_SIZE) + (z * CHUNK_SIZE) + x;
                return this.data[index];
            }
            
            setVoxel(x, y, z, value) {
                if (x < 0 || x >= CHUNK_SIZE || y < 0 || y >= CHUNK_SIZE || z < 0 || z >= CHUNK_SIZE) {
                    return;
                }
                const index = (y * CHUNK_SIZE * CHUNK_SIZE) + (z * CHUNK_SIZE) + x;
                
                if (this.data[index] === 0 && value !== 0) {
                    this.nonEmptyCount++;
                } else if (this.data[index] !== 0 && value === 0) {
                    this.nonEmptyCount--;
                }
                
                this.data[index] = value;
            }
            
            serialize() {
                return {
                    type: 'array',
                    data: this.data.buffer,
                    nonEmptyVoxelCount: this.nonEmptyCount
                };
            }
        }
        
        // Implementation of noise functions
        function noise2D(x, z, seed) {
            return Math.sin(x * 12.9898 + z * 78.233 + seed) * 43758.5453 % 1;
        }
        
        function generateChunkFromSeed(chunkX, chunkY, chunkZ, seed) {
            const chunk = new WorkerChunk();
            const worldX = chunkX * CHUNK_SIZE;
            const worldY = chunkY * CHUNK_SIZE;
            const worldZ = chunkZ * CHUNK_SIZE;
            
            // Special case for the origin chunk
            if (chunkX === 0 && chunkY === 0 && chunkZ === 0) {
                for (let x = 0; x < CHUNK_SIZE; x++) {
                    for (let z = 0; z < CHUNK_SIZE; z++) {
                        // Create a flat platform of stone with grass on top
                        for (let y = 0; y < 10; y++) {
                            chunk.setVoxel(x, y, z, VoxelType.STONE);
                        }
                        chunk.setVoxel(x, 10, z, VoxelType.GRASS);
                    }
                }
                return chunk.serialize();
            }
            
            // Basic terrain generation
            for (let x = 0; x < CHUNK_SIZE; x++) {
                for (let z = 0; z < CHUNK_SIZE; z++) {
                    const wx = worldX + x;
                    const wz = worldZ + z;
                    
                    // Generate a simple height using noise
                    const noiseVal = noise2D(wx * 0.01, wz * 0.01, seed);
                    const height = Math.floor(20 + noiseVal * 10);
                    
                    // Fill voxels up to the height
                    for (let y = 0; y < CHUNK_SIZE; y++) {
                        const wy = worldY + y;
                        if (wy < height) {
                            if (wy < 1) {
                                chunk.setVoxel(x, y, z, VoxelType.BEDROCK);
                            } else if (wy < height - 1) {
                                chunk.setVoxel(x, y, z, VoxelType.STONE);
                            } else {
                                chunk.setVoxel(x, y, z, VoxelType.GRASS);
                            }
                        } else if (wy < 12) { // Water level
                            chunk.setVoxel(x, y, z, VoxelType.WATER);
                        }
                    }
                }
            }
            
            return chunk.serialize();
        }
        
        // Simple mesh generation code - This can be simplified since we'll use the unified mesher
        function generateMeshFromChunk(chunk, chunkX, chunkY, chunkZ, neighbors) {
            // Create a basic mesh with just one cube per voxel
            const positions = [];
            const normals = [];
            const colors = [];
            const indices = [];
            let vertexCount = 0;
            
            // For testing, just create a cube for each non-air voxel
            const chunkData = new Uint8Array(chunk.data);
            for (let y = 0; y < CHUNK_SIZE; y++) {
                for (let z = 0; z < CHUNK_SIZE; z++) {
                    for (let x = 0; x < CHUNK_SIZE; x++) {
                        const index = (y * CHUNK_SIZE * CHUNK_SIZE) + (z * CHUNK_SIZE) + x;
                        const voxelType = chunkData[index];
                        
                        if (voxelType !== 0) {
                            // Add cube at this position (simplified for testing)
                            addCube(positions, normals, colors, indices, x, y, z, voxelType, vertexCount);
                            vertexCount += 24; // 24 vertices for a cube (4 per face * 6 faces)
                        }
                    }
                }
            }
            
            return {
                positions: new Float32Array(positions),
                normals: new Float32Array(normals),
                colors: new Float32Array(colors),
                indices: new Uint16Array(indices)
            };
        }
        
        function addCube(positions, normals, colors, indices, x, y, z, voxelType, startVertex) {
            // Define vertices for a cube centered at the origin with side length 1
            const vertices = [
                // Front face
                x, y, z+1,
                x+1, y, z+1,
                x+1, y+1, z+1,
                x, y+1, z+1,
                
                // Back face
                x+1, y, z,
                x, y, z,
                x, y+1, z,
                x+1, y+1, z,
                
                // Top face
                x, y+1, z,
                x, y+1, z+1,
                x+1, y+1, z+1,
                x+1, y+1, z,
                
                // Bottom face
                x, y, z,
                x+1, y, z,
                x+1, y, z+1,
                x, y, z+1,
                
                // Right face
                x+1, y, z,
                x+1, y, z+1,
                x+1, y+1, z+1,
                x+1, y+1, z,
                
                // Left face
                x, y, z+1,
                x, y, z,
                x, y+1, z,
                x, y+1, z+1
            ];
            
            positions.push(...vertices);
            
            // Add normals
            const normalSets = [
                // Front
                0, 0, 1,
                0, 0, 1,
                0, 0, 1,
                0, 0, 1,
                
                // Back
                0, 0, -1,
                0, 0, -1,
                0, 0, -1,
                0, 0, -1,
                
                // Top
                0, 1, 0,
                0, 1, 0,
                0, 1, 0,
                0, 1, 0,
                
                // Bottom
                0, -1, 0,
                0, -1, 0,
                0, -1, 0,
                0, -1, 0,
                
                // Right
                1, 0, 0,
                1, 0, 0,
                1, 0, 0,
                1, 0, 0,
                
                // Left
                -1, 0, 0,
                -1, 0, 0,
                -1, 0, 0,
                -1, 0, 0
            ];
            
            normals.push(...normalSets);
            
            // Add colors based on voxel type
            let voxelColor;
            
            if (voxelType === 1) { // Grass
                voxelColor = [0.3, 0.75, 0.3, 1.0];
            } else if (voxelType === 2) { // Bedrock
                voxelColor = [0.2, 0.2, 0.2, 1.0];
            } else if (voxelType === 3) { // Stone
                voxelColor = [0.5, 0.5, 0.5, 1.0];
            } else if (voxelType === 4) { // Dirt
                voxelColor = [0.5, 0.3, 0.1, 1.0];
            } else if (voxelType === 5) { // Water
                voxelColor = [0.0, 0.3, 0.8, 0.7];
            } else {
                voxelColor = [1.0, 0.0, 1.0, 1.0]; // Magenta for unknown types
            }
            
            // Add the same color for all vertices of this cube
            for (let i = 0; i < 24; i++) {
                colors.push(...voxelColor);
            }
            
            // Add indices for each of the 6 faces (2 triangles per face)
            for (let face = 0; face < 6; face++) {
                const baseIndex = startVertex + face * 4;
                
                // First triangle of the face
                indices.push(baseIndex, baseIndex + 1, baseIndex + 2);
                
                // Second triangle of the face
                indices.push(baseIndex, baseIndex + 2, baseIndex + 3);
            }
        }
        
        // Handle messages from main thread
        self.onmessage = function(e) {
            const { taskId, taskType, data } = e.data;
            
            let result;
            
            // Process different task types
            if (taskType === 'generateMesh') {
                result = generateMeshFromChunk(data.chunk, data.chunkX, data.chunkY, data.chunkZ, data.neighborChunks);
            } else if (taskType === 'generateChunk') {
                result = generateChunkFromSeed(data.chunkX, data.chunkY, data.chunkZ, data.seed);
            }
            
            // Send result back to main thread
            const transferables = [];
            if (result.positions) transferables.push(result.positions.buffer);
            if (result.normals) transferables.push(result.normals.buffer);
            if (result.colors) transferables.push(result.colors.buffer);
            if (result.indices) transferables.push(result.indices.buffer);
            
            self.postMessage({
                taskId: taskId,
                result: result
            }, transferables);
        };
    `;

        const blob = new Blob([workerScript], { type: 'application/javascript' });
        const worker = new Worker(URL.createObjectURL(blob));

        // Rest of the createWorker function remains the same...
        // Handle worker responses
        worker.onmessage = (e) => {
            const { taskId, result } = e.data;

            // Get and invoke callback
            const callback = this.taskCallbacks.get(taskId);
            if (callback) {
                callback(result);
                this.taskCallbacks.delete(taskId);
            }

            // Mark worker as available and process next task
            this.availableWorkers.push(worker);
            this.processNextTask();
        };

        this.availableWorkers.push(worker);
        this.workers.push(worker);

        return worker;
    }


    // Queue a task for processing
    queueTask(taskType, data, callback) {
        const taskId = this.nextTaskId++;

        this.taskQueue.push({
            taskId,
            taskType,
            data
        });

        this.taskCallbacks.set(taskId, callback);
        this.processNextTask();

        return taskId;
    }

    // Process next task if workers are available
    processNextTask() {
        if (this.taskQueue.length === 0 || this.availableWorkers.length === 0) {
            return;
        }

        const worker = this.availableWorkers.pop();
        const task = this.taskQueue.shift();

        worker.postMessage({
            taskId: task.taskId,
            taskType: task.taskType,
            data: task.data
        });
    }

    // Generate a mesh using workers
    generateMesh(chunk, chunkX, chunkY, chunkZ, neighborChunks, callback) {
        this.queueTask('generateMesh', {
            chunk: chunk.serialize(),
            chunkX,
            chunkY,
            chunkZ,
            neighborChunks: this.serializeNeighborChunks(neighborChunks)
        }, callback);
    }

    // Generate a chunk using workers
    generateChunk(chunkX, chunkY, chunkZ, seed, callback) {
        this.queueTask('generateChunk', {
            chunkX,
            chunkY,
            chunkZ,
            seed
        }, callback);
    }

    // Helper to serialize neighbor chunks for transfer to worker
    serializeNeighborChunks(neighborChunkFunc) {
        // Create a serializable representation of neighbor chunks
        const neighbors = {};

        // Sample neighbors in all directions
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    if (dx === 0 && dy === 0 && dz === 0) continue;

                    const key = `${dx},${dy},${dz}`;
                    const chunk = neighborChunkFunc(dx, dy, dz);

                    if (chunk) {
                        neighbors[key] = chunk.serialize();
                    }
                }
            }
        }

        return neighbors;
    }

    // Terminate all workers
    terminate() {
        this.workers.forEach(worker => worker.terminate());
        this.workers = [];
        this.availableWorkers = [];
    }
}
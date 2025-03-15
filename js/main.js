import { CHUNK_SIZE, RENDER_DISTANCE } from './constants.js';
import { mat4 } from './math-utils.js';
import { VoxelTypeManager } from './voxel-types.js';
import { WorldGenerator } from './world-generator.js';
import { Mesher } from './mesher.js';
import { ChunkManager } from './chunk-manager.js';
import { Renderer } from './renderer.js';
import { Controls } from './controls.js';
import { nodePool } from './voxel-data.js';

// Main class that ties everything together
class VoxelEngine {
    constructor(canvas) {
        this.canvas = canvas;
        this.renderer = new Renderer(canvas);
        
        // Initialize timing variables
        this.lastFrameTime = 0;
        this.lastFPSUpdateTime = 0;
        this.frameCount = 0;
        this.fps = 0;
        this.memoryUsage = 0;
        
        // Debugging flags
        this.showChunkWireframes = false;
        this.forceAllVisible = true; // Force all chunks to be visible initially
        
        // Initialize camera
        this.camera = {
            position: [0, 20, 20], // Position camera to see our test structure
            rotation: [0, -0.5, 0]    // [yaw, pitch, roll] - Look down slightly
        };
        
        // Create world generator
        this.worldGenerator = new WorldGenerator();
        
        // Create chunk manager
        this.chunkManager = new ChunkManager(this.worldGenerator, this.renderer);
        
        console.log("Creating test voxels and chunks...");
        
        // Force create chunks in an area around the player
        this.forceCreateInitialChunks();
        
        // Create a test voxel to see if rendering works
        console.log("Creating test voxels to form a visible structure");

        // Create a small platform
        for (let x = -2; x <= 2; x++) {
            for (let z = -2; z <= 2; z++) {
                this.chunkManager.setVoxel(x, 10, z, 1); // Grass platform
            }
        }

        // Create a small column
        for (let y = 11; y <= 15; y++) {
            this.chunkManager.setVoxel(0, y, 0, 3); // Stone column
        }

        // Create a marker at the top
        this.chunkManager.setVoxel(0, 16, 0, 4); // Dirt block on top
        
        // Set up controls
        this.controls = new Controls(canvas, this.camera, this.chunkManager);
        
        // Add debug display
        this.debugElement = this.addDebugDisplay();
        
        // Add event listener for toggling wireframes
        window.addEventListener('keydown', (e) => {
            if (e.key === 'w' && e.ctrlKey) {
                this.showChunkWireframes = !this.showChunkWireframes;
                console.log(`Chunk wireframes ${this.showChunkWireframes ? 'enabled' : 'disabled'}`);
            }
            if (e.key === 'v' && e.ctrlKey) {
                this.forceAllVisible = !this.forceAllVisible;
                console.log(`Force all chunks visible: ${this.forceAllVisible ? 'enabled' : 'disabled'}`);
            }
        });
        
        // Start render loop
        this.render = this.render.bind(this);
        requestAnimationFrame(this.render);
    }

    // Force create chunks around the player camera position
    forceCreateInitialChunks() {
        console.log("Force creating initial chunks around player");
        
        // Convert player position to chunk coordinates
        const playerPos = this.camera.position;
        const playerChunkX = Math.floor(playerPos[0] / CHUNK_SIZE);
        const playerChunkY = Math.floor(playerPos[1] / CHUNK_SIZE);
        const playerChunkZ = Math.floor(playerPos[2] / CHUNK_SIZE);
        
        console.log(`Player is at chunk coordinates: ${playerChunkX}, ${playerChunkY}, ${playerChunkZ}`);
        
        // Create chunks in a small radius around player
        const radius = 2;
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dz = -radius; dz <= radius; dz++) {
                    const chunkX = playerChunkX + dx;
                    const chunkY = playerChunkY + dy;
                    const chunkZ = playerChunkZ + dz;
                    
                    console.log(`Creating chunk at ${chunkX}, ${chunkY}, ${chunkZ}`);
                    const chunk = this.chunkManager.getOrCreateChunk(chunkX, chunkY, chunkZ);
                    
                    if (chunk) {
                        // Ensure this chunk is marked as dirty so it gets rendered
                        this.chunkManager.markChunkDirty(chunkX, chunkY, chunkZ);
                        
                        // Fill it with some sample data
                        if (dy === 0) {
                            // Create a flat surface at y=0 level
                            for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                                for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                                    chunk.setVoxel(lx, 0, lz, 1); // Grass (type 1)
                                    
                                    // Add some random terrain
                                    if (Math.random() < 0.1) {
                                        const height = 1 + Math.floor(Math.random() * 3);
                                        for (let h = 1; h <= height; h++) {
                                            chunk.setVoxel(lx, h, lz, 3); // Stone (type 3)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        
        console.log("Finished creating initial chunks");
        console.log(`Current chunks: ${this.chunkManager.chunks.size}`);
        console.log(`Dirty chunks: ${this.chunkManager.dirtyChunks.size}`);
    }

    addPerformanceDisplay() {
        const statsDiv = document.getElementById('stats');
        if (statsDiv) {
            // Add memory usage display
            const memoryElement = document.createElement('p');
            memoryElement.innerHTML = 'Memory: <span id="memory">0</span> MB';
            statsDiv.appendChild(memoryElement);

            // Add octree stats display
            const octreeElement = document.createElement('p');
            octreeElement.innerHTML = 'Nodes: <span id="nodes">0</span>';
            statsDiv.appendChild(octreeElement);

            // Add culling stats display
            const cullingElement = document.createElement('p');
            cullingElement.innerHTML = 'Culled: <span id="culled">0</span>%';
            statsDiv.appendChild(cullingElement);
            
            // Add buffer pooling stats display
            const bufferElement = document.createElement('p');
            bufferElement.innerHTML = 'Buffer Pool: <span id="buffer-created">0</span> created, <span id="buffer-reused">0</span> reused';
            statsDiv.appendChild(bufferElement);
            
            const bufferUpdateElement = document.createElement('p');
            bufferUpdateElement.innerHTML = 'Buffer Updates: <span id="buffer-updated">0</span> / <span id="buffer-resized">0</span>';
            statsDiv.appendChild(bufferUpdateElement);
            
            const poolSizeElement = document.createElement('p');
            poolSizeElement.innerHTML = 'Pool Size: <span id="buffer-poolsize">0</span>';
            statsDiv.appendChild(poolSizeElement);
            
            // Add octree node pool stats
            const nodePoolElement = document.createElement('p');
            nodePoolElement.innerHTML = 'Node Pool: <span id="node-created">0</span> created, <span id="node-reused">0</span> reused';
            statsDiv.appendChild(nodePoolElement);
            
            const nodePoolSizeElement = document.createElement('p');
            nodePoolSizeElement.innerHTML = 'Node Pool Size: <span id="node-poolsize">0</span>';
            statsDiv.appendChild(nodePoolSizeElement);
            
            // Add octree memory stats
            const octreeEfficiencyElement = document.createElement('p');
            octreeEfficiencyElement.innerHTML = 'Octree Efficiency: <span id="octree-efficiency">0</span>%';
            statsDiv.appendChild(octreeEfficiencyElement);
        }
    }

    render(now) {
        // Calculate delta time
        const deltaTime = now - this.lastFrameTime;
        this.lastFrameTime = now;
        
        // Request next frame
        requestAnimationFrame(this.render);
        
        // Resize canvas if needed
        this.renderer.resizeCanvasToDisplaySize();
        
        // Update FPS counter
        this.frameCount++;
        const elapsedSinceLastFPS = now - this.lastFPSUpdateTime;
        if (elapsedSinceLastFPS > 1000) {
            this.fps = Math.round((this.frameCount * 1000) / elapsedSinceLastFPS);
            this.frameCount = 0;
            this.lastFPSUpdateTime = now;
            
            // Update memory usage display every second
            if (window.performance && window.performance.memory) {
                this.memoryUsage = Math.round(window.performance.memory.usedJSHeapSize / (1024 * 1024));
            }
            
            // Update octree stats (do this less frequently to save CPU)
            this.updateDebugStats();
        }
        
        // Store previous position for movement detection
        if (!this.prevCameraPos) {
            this.prevCameraPos = [...this.camera.position];
            this.prevCameraRot = [...this.camera.rotation];
        }
        
        // Update player position and controls
        this.controls.update(deltaTime);
        
        // Calculate movement magnitude since last frame
        const movementDelta = [
            this.camera.position[0] - this.prevCameraPos[0],
            this.camera.position[1] - this.prevCameraPos[1],
            this.camera.position[2] - this.prevCameraPos[2]
        ];
        
        const rotationDelta = [
            this.camera.rotation[0] - this.prevCameraRot[0],
            this.camera.rotation[1] - this.prevCameraRot[1],
            this.camera.rotation[2] - this.prevCameraRot[2]
        ];
        
        const movementMagnitude = Math.sqrt(
            movementDelta[0] * movementDelta[0] + 
            movementDelta[1] * movementDelta[1] + 
            movementDelta[2] * movementDelta[2]
        );
        
        const rotationMagnitude = Math.sqrt(
            rotationDelta[0] * rotationDelta[0] + 
            rotationDelta[1] * rotationDelta[1] + 
            rotationDelta[2] * rotationDelta[2]
        );
        
        // Update chunks based on player position
        const position = this.camera.position;
        const MOVEMENT_THRESHOLD = 0.1;  // Only update chunks if moved significantly
        const ROTATION_THRESHOLD = 0.01; // Only update chunks on significant rotation
        
        // Force forceAllVisible to stay true to prevent world from disappearing
        this.forceAllVisible = true;
        
        // Track significant camera changes to prevent flickering during movement
        const hasMoved = movementMagnitude > MOVEMENT_THRESHOLD;
        const hasRotated = rotationMagnitude > ROTATION_THRESHOLD;
        const isFirstUpdate = !this.lastChunkUpdateTime;
        const timeSinceLastUpdate = now - (this.lastChunkUpdateTime || 0);
        const needsUpdate = isFirstUpdate || hasMoved || hasRotated || timeSinceLastUpdate > 200;
        
        // Update chunks when player moves
        if (needsUpdate) {
            // Update all chunks within render distance
            this.chunkManager.updateChunks(position[0], position[1], position[2]);
            
            // Process dirty chunks immediately when forcing all visible
            if (this.forceAllVisible) {
                // Process all dirty chunks that have been waiting
                const dirtyChunks = Array.from(this.chunkManager.dirtyChunks);
                
                for (const chunkKey of dirtyChunks) {
                    const chunk = this.chunkManager.getChunkByKey(chunkKey);
                    if (chunk) {
                        this.chunkManager.queueMeshGeneration(chunk);
                        this.chunkManager.dirtyChunks.delete(chunkKey);
                    }
                }
                
                // Process a batch of queued chunks each frame to avoid stuttering
                const chunkBatchSize = 5; // Process 5 chunks per frame
                const chunksToProcess = Math.min(chunkBatchSize, this.chunkManager.meshGenerationQueue.length);
                
                for (let i = 0; i < chunksToProcess; i++) {
                    const chunk = this.chunkManager.meshGenerationQueue.shift();
                    if (chunk) {
                        const chunkKey = this.chunkManager.getChunkKey(chunk.x, chunk.y, chunk.z);
                        
                        // Skip if chunk no longer exists
                        if (!this.chunkManager.chunks.has(chunkKey)) {
                            continue;
                        }
                        
                        // Generate mesh data and create/update mesh
                        const meshData = this.chunkManager.generateMeshData(chunk, chunk.x, chunk.y, chunk.z);
                        
                        if (meshData) {
                            // Calculate world offset
                            const worldOffset = [
                                chunk.x * CHUNK_SIZE,
                                chunk.y * CHUNK_SIZE,
                                chunk.z * CHUNK_SIZE
                            ];
                            
                            // Try to update existing mesh if possible
                            if (this.chunkManager.meshes.has(chunkKey)) {
                                const existingMesh = this.chunkManager.meshes.get(chunkKey);
                                const updatedMesh = this.renderer.updateMesh(existingMesh, meshData);
                                
                                if (!updatedMesh) {
                                    // If update fails, create new mesh
                                    this.renderer.deleteMesh(existingMesh);
                                    const newMesh = this.renderer.createMesh(meshData, worldOffset);
                                    if (newMesh) {
                                        this.chunkManager.meshes.set(chunkKey, newMesh);
                                    }
                                }
                            } else {
                                // Create and store new mesh
                                const mesh = this.renderer.createMesh(meshData, worldOffset);
                                if (mesh) {
                                    this.chunkManager.meshes.set(chunkKey, mesh);
                                }
                            }
                        }
                    }
                }
            } else {
                // Process mesh generation normally
                this.chunkManager.processMeshGeneration();
            }
            
            this.lastChunkUpdateTime = now;
        } else {
            // Just process mesh generation for already dirty chunks
            this.chunkManager.processMeshGeneration();
        }
        
        // Update previous position for next frame
        this.prevCameraPos = [...this.camera.position];
        this.prevCameraRot = [...this.camera.rotation];
        
        // Set up camera matrices
        // Create projection matrix with wider FOV for better visibility
        const projectionMatrix = mat4.create();
        const fieldOfView = 80 * Math.PI / 180; // Increased from 70 to 80 degrees for wider view
        const aspect = this.canvas.clientWidth / this.canvas.clientHeight;
        const zNear = 0.1;
        // Increase far plane distance to see more chunks
        const zFar = CHUNK_SIZE * (RENDER_DISTANCE + 2) * 2.0; // Increased multiplier for further view
        mat4.perspective(projectionMatrix, fieldOfView, aspect, zNear, zFar);
        
        // Create view matrix from camera position and rotation
        const viewMatrix = mat4.create();
        
        // Calculate look-at point based on camera rotation
        const yaw = this.camera.rotation[0];
        const pitch = this.camera.rotation[1];
        
        // Calculate the forward direction vector
        const lookX = Math.sin(yaw) * Math.cos(pitch);
        const lookY = Math.sin(pitch);
        const lookZ = Math.cos(yaw) * Math.cos(pitch);
        
        // Create a target point in front of the camera
        const target = [
            position[0] + lookX,
            position[1] + lookY,
            position[2] + lookZ
        ];
        
        // Use the look-at function to create the view matrix
        mat4.lookAt(
            viewMatrix,      // output matrix
            position,        // camera position
            target,          // point to look at
            [0, 1, 0]        // up vector (y-axis)
        );
        
        // Render the scene
        this.renderer.clear();
        
        // Get all meshes
        const meshList = Array.from(this.chunkManager.meshes.values());
        
        // Render meshes
        if (meshList.length > 0) {
            this.renderer.renderChunks(meshList, projectionMatrix, viewMatrix);
        }
        
        // Render chunk wireframes if enabled
        if (this.showChunkWireframes) {
            // Create a list of chunk data with worldOffset for rendering
            const chunksToShow = [];
            for (const [key, chunk] of this.chunkManager.chunks.entries()) {
                const [x, y, z] = key.split(',').map(Number);
                chunksToShow.push({
                    worldOffset: [x * CHUNK_SIZE, y * CHUNK_SIZE, z * CHUNK_SIZE]
                });
            }
            this.renderer.renderChunkBoundaries(chunksToShow, projectionMatrix, viewMatrix);
        }
        
        // Update debug display
        if (this.debugElement && this.frameCount % 10 === 0) {
            const debugOptions = [];
            if (this.showChunkWireframes) debugOptions.push("Wireframes ON");
            if (this.forceAllVisible) debugOptions.push("<strong style='color: #0f0;'>Force Visible ON</strong>");
            else debugOptions.push("<strong style='color: #f00;'>Force Visible OFF</strong>");
            
            this.debugElement.innerHTML = `
                FPS: ${this.fps} | 
                Chunks: ${this.chunkManager.chunks.size}/${this.chunkManager.MAX_CHUNKS} | 
                Meshes: ${this.chunkManager.meshes.size} |
                Position: ${Math.floor(position[0])},${Math.floor(position[1])},${Math.floor(position[2])}
                ${debugOptions.length > 0 ? '<br>' + debugOptions.join(' | ') : ''}
            `;
        }
    }

    updateDebugStats() {
        // Update octree stats
        const nodeCount = this.chunkManager.totalNodes || 0;
        const nodesEl = document.getElementById('nodes');
        if (nodesEl) nodesEl.textContent = nodeCount;
        
        // Update node pool stats
        const nodePoolStats = nodePool.getStats();
        const nodeCreatedEl = document.getElementById('node-created');
        const nodeReusedEl = document.getElementById('node-reused');
        const nodePoolSizeEl = document.getElementById('node-poolsize');
        
        if (nodeCreatedEl) nodeCreatedEl.textContent = nodePoolStats.created;
        if (nodeReusedEl) nodeReusedEl.textContent = nodePoolStats.reused;
        if (nodePoolSizeEl) nodePoolSizeEl.textContent = nodePoolStats.poolSize;

        // Debug output
        console.log("=== DEBUG INFO ===");
        console.log(`FPS: ${this.fps}`);
        console.log(`Memory: ${this.memoryUsage} MB`);
        console.log(`Total Chunks: ${this.chunkManager.totalChunks}`);
        console.log(`Total Nodes: ${this.chunkManager.totalNodes}`);
        console.log(`Node Pool Size: ${nodePoolStats.poolSize}`);
        console.log("=================");
        
        // Update culling stats if available
        if (this.chunkManager.cullStats) {
            const { total, culled } = this.chunkManager.cullStats;
            const cullPercent = total > 0 ? Math.round((culled / total) * 100) : 0;
            const culledEl = document.getElementById('culled');
            if (culledEl) culledEl.textContent = cullPercent;
        }
        
        // Update buffer pool stats
        if (this.renderer.getBufferPoolStats) {
            const stats = this.renderer.getBufferPoolStats();
            const bufferCreatedEl = document.getElementById('buffer-created');
            const bufferReusedEl = document.getElementById('buffer-reused');
            const bufferUpdatedEl = document.getElementById('buffer-updated');
            const bufferResizedEl = document.getElementById('buffer-resized');
            const bufferPoolSizeEl = document.getElementById('buffer-poolsize');
            
            if (bufferCreatedEl) bufferCreatedEl.textContent = stats.created;
            if (bufferReusedEl) bufferReusedEl.textContent = stats.reused;
            if (bufferUpdatedEl) bufferUpdatedEl.textContent = stats.updated;
            if (bufferResizedEl) bufferResizedEl.textContent = stats.resized;
            
            // Calculate total pool size (sum of all buffer pools)
            if (bufferPoolSizeEl && stats.poolSizes) {
                const totalPoolSize = Object.values(stats.poolSizes).reduce((a, b) => a + b, 0);
                bufferPoolSizeEl.textContent = totalPoolSize;
            }
        }
        
        // Calculate octree efficiency (how many nodes compared to a full grid)
        if (this.chunkManager && this.chunkManager.totalChunks > 0) {
            const totalVoxels = this.chunkManager.totalChunks * CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE;
            const octreeEfficiency = Math.round((1 - (this.chunkManager.totalNodes / totalVoxels)) * 100);
            const octreeEfficiencyEl = document.getElementById('octree-efficiency');
            if (octreeEfficiencyEl) octreeEfficiencyEl.textContent = octreeEfficiency;
        }
    }

    // Create and add debug display element
    addDebugDisplay() {
        const debugDiv = document.createElement('div');
        debugDiv.id = 'debug-info';
        debugDiv.style.position = 'absolute';
        debugDiv.style.top = '10px';
        debugDiv.style.left = '10px';
        debugDiv.style.color = 'white';
        debugDiv.style.fontFamily = 'monospace';
        debugDiv.style.fontSize = '14px';
        debugDiv.style.textShadow = '1px 1px 2px black';
        debugDiv.style.pointerEvents = 'none';
        document.body.appendChild(debugDiv);
        return debugDiv;
    }
}

// Initialize the engine when the page loads
window.onload = () => {
    const canvas = document.getElementById('glCanvas');
    if (!canvas) {
        console.error('Canvas element with id "glCanvas" not found!');
        return;
    }
    window.voxelEngine = new VoxelEngine(canvas);
};

// Add WebGPU stats to the UI display
function updateStats() {
    // ... existing code ...
    
    // Display buffer statistics
    const bufferStats = renderer.getBufferStats();
    document.getElementById('buffer-created').textContent = bufferStats.created;
    document.getElementById('buffer-reused').textContent = bufferStats.reused;
    document.getElementById('buffer-updated').textContent = bufferStats.updated;
    document.getElementById('buffer-resized').textContent = bufferStats.resized;
    
    // Add worker/meshing statistics
    const allStats = chunkManager.getAllStats();
    const meshGenStats = allStats.mesh;
    const webgpuStats = allStats.webgpu;
    
    document.getElementById('mesh-workers').textContent = `${meshGenStats.activeWorkers}/${meshGenStats.workerCount}`;
    document.getElementById('mesh-queue').textContent = meshGenStats.currentQueueSize;
    document.getElementById('mesh-total').textContent = meshGenStats.totalMeshesGenerated;
    document.getElementById('mesh-time').textContent = meshGenStats.meshingTimeAvg.toFixed(2) + 'ms';
    
    // Add WebGPU statistics
    document.getElementById('webgpu-status').textContent = webgpuStats.available ? 'Active' : 'Not Available';
    document.getElementById('webgpu-meshes').textContent = webgpuStats.totalMeshesGenerated;
    document.getElementById('webgpu-time').textContent = webgpuStats.avgMeshGenTime.toFixed(2) + 'ms';
    
    // Add node pool statistics
    const nodePoolStats = nodePool ? nodePool.getStats() : { totalCreated: 0, available: 0 };
    document.getElementById('node-created').textContent = nodePoolStats.totalCreated;
    document.getElementById('node-available').textContent = nodePoolStats.available;
    
    // ... existing code ...
}

// Create the stats container if it doesn't exist
function createStatsContainer() {
    const container = document.createElement('div');
    container.id = 'stats-container';
    container.className = 'stats-container';
    
    // Create the HTML for the stats container
    let html = `
        <div class="stats-section">
            <h3>Performance</h3>
            <div class="stat-row">
                <span class="stat-label">FPS:</span>
                <span id="fps" class="stat-value">0</span>
            </div>
            <div class="stat-row">
                <span class="stat-label">Memory:</span>
                <span id="memory" class="stat-value">0 MB</span>
            </div>
        </div>
        
        <div class="stats-section">
            <h3>World</h3>
            <div class="stat-row">
                <span class="stat-label">Chunks:</span>
                <span id="chunk-count" class="stat-value">0</span>
            </div>
            <div class="stat-row">
                <span class="stat-label">Meshes:</span>
                <span id="mesh-count" class="stat-value">0</span>
            </div>
            <div class="stat-row">
                <span class="stat-label">Dirty Chunks:</span>
                <span id="dirty-chunks" class="stat-value">0</span>
            </div>
        </div>
        
        <div class="stats-section">
            <h3>Buffer Pool</h3>
            <div class="stat-row">
                <span class="stat-label">Created:</span>
                <span id="buffer-created" class="stat-value">0</span>
            </div>
            <div class="stat-row">
                <span class="stat-label">Reused:</span>
                <span id="buffer-reused" class="stat-value">0</span>
            </div>
            <div class="stat-row">
                <span class="stat-label">Updated:</span>
                <span id="buffer-updated" class="stat-value">0</span>
            </div>
            <div class="stat-row">
                <span class="stat-label">Resized:</span>
                <span id="buffer-resized" class="stat-value">0</span>
            </div>
        </div>
        
        <div class="stats-section">
            <h3>Node Pool</h3>
            <div class="stat-row">
                <span class="stat-label">Created:</span>
                <span id="node-created" class="stat-value">0</span>
            </div>
            <div class="stat-row">
                <span class="stat-label">Reused:</span>
                <span id="node-reused" class="stat-value">0</span>
            </div>
            <div class="stat-row">
                <span class="stat-label">Pool Size:</span>
                <span id="node-poolsize" class="stat-value">0</span>
            </div>
        </div>
        
        <div class="stats-section">
            <h3>Mesh Workers</h3>
            <div class="stat-row">
                <span class="stat-label">Active/Total:</span>
                <span id="mesh-workers" class="stat-value">0/0</span>
            </div>
            <div class="stat-row">
                <span class="stat-label">Queue Size:</span>
                <span id="mesh-queue" class="stat-value">0</span>
            </div>
            <div class="stat-row">
                <span class="stat-label">Meshes Generated:</span>
                <span id="mesh-total" class="stat-value">0</span>
            </div>
            <div class="stat-row">
                <span class="stat-label">Avg. Mesh Time:</span>
                <span id="mesh-time" class="stat-value">0ms</span>
            </div>
        </div>
        
        <div class="stats-section">
            <h3>WebGPU</h3>
            <div class="stat-row">
                <span class="stat-label">Status:</span>
                <span id="webgpu-status" class="stat-value">Not Available</span>
            </div>
            <div class="stat-row">
                <span class="stat-label">Meshes Generated:</span>
                <span id="webgpu-meshes" class="stat-value">0</span>
            </div>
            <div class="stat-row">
                <span class="stat-label">Avg. Time:</span>
                <span id="webgpu-time" class="stat-value">0ms</span>
            </div>
        </div>
    `;
    
    // Add the HTML to the container
    container.innerHTML = html;
    
    // Add styles
    const style = document.createElement('style');
    style.textContent = `
        .stats-container {
            position: fixed;
            top: 10px;
            right: 10px;
            background-color: rgba(0, 0, 0, 0.7);
            color: white;
            font-family: monospace;
            font-size: 12px;
            padding: 10px;
            border-radius: 5px;
            max-width: 250px;
            z-index: 1000;
        }
        .stats-section {
            margin-bottom: 10px;
        }
        .stats-section h3 {
            margin: 0 0 5px 0;
            font-size: 14px;
            border-bottom: 1px solid #555;
        }
        .stat-row {
            display: flex;
            justify-content: space-between;
        }
        .stat-label {
            margin-right: 5px;
        }
    `;
    document.head.appendChild(style);
    
    // Add the container to the document
    document.body.appendChild(container);
    
    return container;
}
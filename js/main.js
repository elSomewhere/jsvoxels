import { CHUNK_SIZE, RENDER_DISTANCE, WORKER_COUNT, ENABLE_MULTITHREADING, DEBUG } from './constants.js';
import { mat4 } from './math-utils.js';
import { VoxelTypeManager } from './voxel-types.js';
import { WorldGenerator } from './world-generator.js';
import { Mesher } from './mesher.js';
import { ChunkManager } from './chunk-manager.js';
import { Renderer } from './renderer.js';
import { Controls } from './controls.js';
import { WorkerPool } from './worker-pool.js';
import { SpatialIndex } from './spatial-index.js';
import { BufferManager } from './buffer-manager.js';
import { debugLog } from './math-utils.js';
window.DEBUG = DEBUG;

// Main class that ties everything together
class VoxelEngine {
    constructor() {
        // Camera state
        this.camera = {
            position: [0, 20, 0],
            rotation: [0, 0] // [yaw, pitch]
        };

        // Performance tracking
        this.lastFrameTime = 0;
        this.frameCount = 0;
        this.fps = 0;
        this.memoryUsage = 0;
        this.lastMemCheckTime = 0;
        this.initialized = false;
        this.engineReady = false;

        // Add memory usage display element
        this.addPerformanceDisplay();

        // Initialize components
        this.canvas = document.getElementById('glCanvas');
        this.renderer = new Renderer(this.canvas);

        // Create buffer manager
        this.bufferManager = new BufferManager(this.renderer.gl);

        // Set buffer manager in renderer
        this.renderer.setBufferManager(this.bufferManager);

        // Create spatial index
        this.spatialIndex = new SpatialIndex();

        // Initialize voxel types
        this.voxelTypes = new VoxelTypeManager();

        // Initialize worker pool if multithreading is enabled
        this.workerPool = null;
        this.workerInitPromise = Promise.resolve(); // Default to resolved promise

        if (ENABLE_MULTITHREADING) {
            try {
                this.workerPool = new WorkerPool(WORKER_COUNT);
                console.log(`Worker pool initialized with ${this.workerPool.workers.length} workers`);
            } catch (error) {
                console.error("Failed to initialize worker pool:", error);
                // Continue without workers
            }
        }

        // Create world generator
        this.worldGenerator = new WorldGenerator();

        // Create mesher
        this.mesher = new Mesher(this.voxelTypes);

        // Create chunk manager
        this.chunkManager = new ChunkManager(
            this.worldGenerator,
            this.mesher,
            this.renderer,
            this.workerPool,
            this.spatialIndex,
            this.bufferManager
        );

        // Create controls
        this.controls = new Controls(this.canvas, this.camera, this.chunkManager);

        // Set up resize handler
        window.addEventListener('resize', this.handleResize.bind(this));

        // Initialize the engine
        this.initEngine();
    }

    // Initialize the engine
    async initEngine() {
        try {
            console.log("Engine initialized successfully");
            this.engineReady = true;

            // Now start the game loop
            requestAnimationFrame(this.render.bind(this));

            // Add enhanced debugging
            this.addEnhancedDebugging();
        } catch (error) {
            console.error("Failed to initialize engine:", error);

            // Try to continue anyway
            this.engineReady = true;
            requestAnimationFrame(this.render.bind(this));
        }
    }

    // Enhanced debugging functionality
    addEnhancedDebugging() {
        // Skip if not in debug mode
        if (!window.DEBUG) return;

        const debugPanel = document.createElement('div');
        debugPanel.style.position = 'fixed';
        debugPanel.style.bottom = '10px';
        debugPanel.style.left = '10px';
        debugPanel.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
        debugPanel.style.color = 'white';
        debugPanel.style.padding = '10px';
        debugPanel.style.fontFamily = 'monospace';
        debugPanel.style.fontSize = '12px';
        debugPanel.style.maxHeight = '200px';
        debugPanel.style.overflowY = 'auto';
        debugPanel.style.zIndex = '1000';
        debugPanel.id = 'debug-panel';

        // Add header
        const header = document.createElement('div');
        header.textContent = 'Debug Panel';
        header.style.fontWeight = 'bold';
        header.style.marginBottom = '5px';
        debugPanel.appendChild(header);

        // Add content div
        const content = document.createElement('div');
        content.id = 'debug-content';
        debugPanel.appendChild(content);

        // Add to document
        document.body.appendChild(debugPanel);

        // Log old console methods
        const originalLog = console.log;
        const originalWarn = console.warn;
        const originalError = console.error;

        // Limit the number of messages to keep
        const MAX_MESSAGES = 30;
        const messages = [];

        // Helper to add message to debug panel
        function addMessage(type, args) {
            if (messages.length >= MAX_MESSAGES) {
                messages.shift();
            }

            const msg = document.createElement('div');
            msg.style.marginBottom = '2px';

            // Format the message
            let text = '';
            for (const arg of args) {
                if (typeof arg === 'object') {
                    try {
                        text += JSON.stringify(arg) + ' ';
                    } catch (e) {
                        text += '[Object] ';
                    }
                } else {
                    text += arg + ' ';
                }
            }

            // Set color based on type
            switch (type) {
                case 'log':
                    msg.style.color = 'white';
                    break;
                case 'warn':
                    msg.style.color = 'yellow';
                    break;
                case 'error':
                    msg.style.color = 'red';
                    break;
            }

            // Add timestamp
            const time = new Date().toLocaleTimeString();
            msg.textContent = `[${time}] ${text}`;

            messages.push(msg);

            // Update the panel
            const content = document.getElementById('debug-content');
            if (content) {
                content.innerHTML = '';
                for (const m of messages) {
                    content.appendChild(m.cloneNode(true));
                }
                content.scrollTop = content.scrollHeight;
            }
        }

        // Override console methods
        console.log = function (...args) {
            originalLog.apply(console, args);
            addMessage('log', args);
        };

        console.warn = function (...args) {
            originalWarn.apply(console, args);
            addMessage('warn', args);
        };

        console.error = function (...args) {
            originalError.apply(console, args);
            addMessage('error', args);
        };

        // Add worker, chunk, and buffer stats
        setInterval(() => {
            if (window.voxelEngine && window.voxelEngine.engineReady) {
                const stats = [];

                // Worker stats
                if (window.voxelEngine.workerPool) {
                    const pool = window.voxelEngine.workerPool;
                    stats.push(`Workers: ${pool.workers.length} (${pool.idleWorkers.length} idle)`);
                    stats.push(`Tasks: ${pool.taskQueue.length + pool.priorityTaskQueue.length} queued, ${pool.activeTaskCount} active`);
                }

                // Chunk stats
                if (window.voxelEngine.chunkManager) {
                    const cm = window.voxelEngine.chunkManager;
                    stats.push(`Chunks: ${cm.totalChunks} (${cm.dirtyChunks.size} dirty)`);
                    stats.push(`Load Queue: ${cm.loadQueue.length}, Unload Queue: ${cm.unloadQueue.length}`);
                    stats.push(`Pending Ops: ${cm.pendingOperations.size}`);
                }

                // Buffer stats
                if (window.voxelEngine.bufferManager) {
                    const bm = window.voxelEngine.bufferManager;
                    const bmStats = bm.getStats();
                    stats.push(`Buffers: ${bmStats.active}/${bmStats.created} (${bmStats.reused} reused, ${bmStats.released} released)`);
                }

                // Update stats in panel
                const content = document.getElementById('debug-content');
                if (content) {
                    const statsDiv = document.createElement('div');
                    statsDiv.style.borderTop = '1px solid #555';
                    statsDiv.style.marginTop = '5px';
                    statsDiv.style.paddingTop = '5px';

                    for (const stat of stats) {
                        const div = document.createElement('div');
                        div.textContent = stat;
                        statsDiv.appendChild(div);
                    }

                    content.appendChild(statsDiv);
                    content.scrollTop = content.scrollHeight;

                    // Trim old messages
                    while (content.childNodes.length > MAX_MESSAGES + 5) {
                        content.removeChild(content.firstChild);
                    }
                }
            }
        }, 1000);

        // Add toggle button
        const toggleButton = document.createElement('button');
        toggleButton.textContent = 'Debug';
        toggleButton.style.position = 'fixed';
        toggleButton.style.bottom = '10px';
        toggleButton.style.right = '10px';
        toggleButton.style.zIndex = '1001';
        toggleButton.style.padding = '5px 10px';
        toggleButton.style.backgroundColor = '#444';
        toggleButton.style.color = 'white';
        toggleButton.style.border = 'none';
        toggleButton.style.borderRadius = '3px';
        toggleButton.onclick = () => {
            debugPanel.style.display = debugPanel.style.display === 'none' ? 'block' : 'none';
        };
        document.body.appendChild(toggleButton);

        console.log("Enhanced debugging initialized");
    }

    handleResize() {
        this.renderer.resizeCanvasToDisplaySize();
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

            // Add threading stats
            const threadingElement = document.createElement('p');
            threadingElement.innerHTML = 'Workers: <span id="workers">0</span> tasks';
            statsDiv.appendChild(threadingElement);

            // Add buffer stats
            const bufferElement = document.createElement('p');
            bufferElement.innerHTML = 'Buffers: <span id="buffers">0</span>';
            statsDiv.appendChild(bufferElement);
        }
    }

    render(now) {
        // Calculate delta time (in seconds)
        const deltaTime = (now - (this.lastTime || now)) / 1000;
        this.lastTime = now;

        // Check if we're fully initialized - safety check
        if (!this.engineReady) {
            console.warn("Engine not fully initialized yet, waiting...");
            requestAnimationFrame(this.render.bind(this));
            return;
        }

        // Calculate FPS
        this.frameCount++;
        if (now - this.lastFrameTime >= 1000) {
            this.fps = Math.round((this.frameCount * 1000) / (now - this.lastFrameTime));
            document.getElementById('fps').textContent = this.fps;
            this.frameCount = 0;
            this.lastFrameTime = now;

            // Update memory usage every second
            try {
                if (window.performance && window.performance.memory) {
                    this.memoryUsage = Math.round(window.performance.memory.usedJSHeapSize / (1024 * 1024));
                    document.getElementById('memory').textContent = this.memoryUsage;
                }
            } catch (e) {
                // Memory API might not be available or accessible
                document.getElementById('memory').textContent = "N/A";
            }

            // Update octree stats
            const nodeCount = this.chunkManager.totalNodes || 0;
            document.getElementById('nodes').textContent = nodeCount;

            // Update worker stats
            if (ENABLE_MULTITHREADING && this.workerPool) {
                const workerTasks = this.workerPool.getTotalTaskCount();
                document.getElementById('workers').textContent = workerTasks;
            } else {
                document.getElementById('workers').textContent = "disabled";
            }

            // Update buffer stats
            const bufferStats = this.bufferManager.getStats();
            document.getElementById('buffers').textContent =
                `${bufferStats.active}/${bufferStats.created} (${bufferStats.reused} reused)`;
        }

        // Update controls
        this.controls.update(deltaTime);

        // Update worker pool with player position for task prioritization
        if (ENABLE_MULTITHREADING && this.workerPool) {
            this.workerPool.updatePlayerPosition(
                this.camera.position[0],
                this.camera.position[1],
                this.camera.position[2]
            );
        }

        // Update chunks based on camera position
        this.chunkManager.updateChunks(
            this.camera.position[0],
            this.camera.position[1],
            this.camera.position[2]
        );

        // Build/update chunk meshes
        this.chunkManager.buildChunkMeshes();

        // Resize canvas
        this.renderer.resizeCanvasToDisplaySize();

        // Clear the screen
        this.renderer.clear();

        // Set up camera and projection matrices
        const projectionMatrix = mat4.create();
        const fieldOfView = 70 * Math.PI / 180; // Wider FOV for better visibility
        const aspect = this.canvas.clientWidth / this.canvas.clientHeight;
        const zNear = 0.1;
        const zFar = CHUNK_SIZE * (RENDER_DISTANCE + 1) * 1.5;

        mat4.perspective(projectionMatrix, fieldOfView, aspect, zNear, zFar);

        // Create camera view matrix
        const viewMatrix = mat4.create();
        const forward = [
            Math.sin(this.camera.rotation[0]) * Math.cos(this.camera.rotation[1]),
            Math.sin(this.camera.rotation[1]),
            Math.cos(this.camera.rotation[0]) * Math.cos(this.camera.rotation[1])
        ];

        // Ensure forward vector is normalized
        const forwardLength = Math.sqrt(
            forward[0] * forward[0] +
            forward[1] * forward[1] +
            forward[2] * forward[2]
        );

        if (forwardLength > 0.00001) {
            forward[0] /= forwardLength;
            forward[1] /= forwardLength;
            forward[2] /= forwardLength;
        }

        const target = [
            this.camera.position[0] + forward[0],
            this.camera.position[1] + forward[1],
            this.camera.position[2] + forward[2]
        ];

        const up = [0, 1, 0];
        mat4.lookAt(viewMatrix, this.camera.position, target, up);

        // Render all chunks
        const drawnChunks = this.chunkManager.render(projectionMatrix, viewMatrix);

        // Update culling stats if available
        if (this.chunkManager.cullStats) {
            const { total, culled } = this.chunkManager.cullStats;
            const cullPercent = total > 0 ? Math.round((culled / total) * 100) : 0;
            document.getElementById('culled').textContent = cullPercent;
        }

        // Request next frame
        requestAnimationFrame(this.render.bind(this));
    }

    // Clean up resources
    dispose() {
        // Terminate workers
        if (this.workerPool) {
            this.workerPool.terminate();
        }

        // Dispose buffer manager
        if (this.bufferManager) {
            this.bufferManager.dispose();
        }

        // Dispose renderer
        if (this.renderer) {
            this.renderer.dispose();
        }
    }
}

// Initialize the engine when the page loads
window.onload = () => {
    try {
        window.voxelEngine = new VoxelEngine();

        // Set up cleanup on unload
        window.addEventListener('beforeunload', () => {
            if (window.voxelEngine) {
                window.voxelEngine.dispose();
            }
        });
    } catch (error) {
        console.error("Failed to initialize VoxelEngine:", error);
        // Display error to user
        const errorDiv = document.createElement('div');
        errorDiv.style.position = 'fixed';
        errorDiv.style.top = '50%';
        errorDiv.style.left = '50%';
        errorDiv.style.transform = 'translate(-50%, -50%)';
        errorDiv.style.backgroundColor = 'rgba(255, 0, 0, 0.8)';
        errorDiv.style.color = 'white';
        errorDiv.style.padding = '20px';
        errorDiv.style.borderRadius = '5px';
        errorDiv.style.zIndex = '1000';
        errorDiv.style.maxWidth = '80%';
        errorDiv.style.textAlign = 'center';
        errorDiv.innerHTML = `<h3>Error initializing engine</h3><p>${error.message}</p><p>Check console for details.</p>`;
        document.body.appendChild(errorDiv);
    }
};
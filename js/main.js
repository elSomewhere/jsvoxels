// main.js (modified for threading)
import { CHUNK_SIZE, RENDER_DISTANCE } from './constants.js';
import { mat4 } from './math-utils.js';
import { VoxelTypeManager } from './voxel-types.js';
import { Renderer } from './renderer.js';
import { Controls } from './controls.js';
import { ThreadedChunkManager } from './threaded-chunk-manager.js';

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

        // Add memory usage display element
        this.addPerformanceDisplay();

        // Initialize components
        this.canvas = document.getElementById('glCanvas');
        this.renderer = new Renderer(this.canvas);
        this.voxelTypes = new VoxelTypeManager();

        // Use threaded chunk manager instead of old one
        this.chunkManager = new ThreadedChunkManager(this.renderer);
        this.controls = new Controls(this.canvas, this.camera, this.chunkManager);

        // Start the game loop
        requestAnimationFrame(this.render.bind(this));
    }

    addPerformanceDisplay() {
        const statsDiv = document.getElementById('stats');
        if (statsDiv) {
            // Add memory usage display
            const memoryElement = document.createElement('p');
            memoryElement.innerHTML = 'Memory: <span id="memory">0</span> MB';
            statsDiv.appendChild(memoryElement);

            // Add worker stats display
            const workerElement = document.createElement('p');
            workerElement.innerHTML = 'Workers: <span id="workerStats">Initializing...</span>';
            statsDiv.appendChild(workerElement);

            // Add culling stats display
            const cullingElement = document.createElement('p');
            cullingElement.innerHTML = 'Culled: <span id="culled">0</span>%';
            statsDiv.appendChild(cullingElement);
        }
    }

    render(now) {
        // Calculate delta time (in seconds)
        const deltaTime = (now - (this.lastTime || now)) / 1000;
        this.lastTime = now;

        // Calculate FPS
        this.frameCount++;
        if (now - this.lastFrameTime >= 1000) {
            this.fps = Math.round((this.frameCount * 1000) / (now - this.lastFrameTime));
            document.getElementById('fps').textContent = this.fps;
            this.frameCount = 0;
            this.lastFrameTime = now;

            // Update memory usage every second
            if (window.performance && window.performance.memory) {
                this.memoryUsage = Math.round(window.performance.memory.usedJSHeapSize / (1024 * 1024));
                document.getElementById('memory').textContent = this.memoryUsage;
            }
        }

        // Update controls
        this.controls.update(deltaTime);

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

    // Clean up resources when window unloads
    dispose() {
        if (this.chunkManager) {
            this.chunkManager.dispose();
        }
    }
}

// Initialize the engine when the page loads
window.onload = () => {
    window.voxelEngine = new VoxelEngine();

    // Add event listener for cleanup
    window.addEventListener('unload', () => {
        if (window.voxelEngine) {
            window.voxelEngine.dispose();
        }
    });
};
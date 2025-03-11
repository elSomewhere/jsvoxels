import { normalizeVector, debugLog } from './math-utils.js';
import { VoxelType } from './voxel-types.js';

export class Controls {
    constructor(canvas, camera, chunkManager) {
        this.canvas = canvas;
        this.camera = camera;
        this.chunkManager = chunkManager;

        // Movement state
        this.moveForward = false;
        this.moveBackward = false;
        this.moveLeft = false;
        this.moveRight = false;
        this.moveUp = false;
        this.moveDown = false;

        // Mouse state
        this.isPointerLocked = false;

        this.setupInputHandlers();
    }

    setupInputHandlers() {
        // Mouse movement for camera rotation
        document.addEventListener('mousemove', (e) => {
            if (this.isPointerLocked) {
                const sensitivity = 0.002;
                this.camera.rotation[0] -= e.movementX * sensitivity;
                this.camera.rotation[1] -= e.movementY * sensitivity;

                // Clamp vertical rotation to prevent flipping
                this.camera.rotation[1] = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, this.camera.rotation[1]));
            }
        });

        // Handle pointer lock
        document.addEventListener('pointerlockchange', () => {
            this.isPointerLocked = document.pointerLockElement === this.canvas;
            debugLog(`Pointer lock: ${this.isPointerLocked}`);
        });

        // Click to lock pointer
        this.canvas.addEventListener('click', () => {
            if (!this.isPointerLocked) {
                this.canvas.requestPointerLock();
            }
        });

        // Mouse down to create crater
        this.canvas.addEventListener('mousedown', (e) => {
            // Only proceed if pointer is locked (we have control)
            if (this.isPointerLocked) {
                this.createCraterAtLookDirection(3);
            }
        });

        // Keyboard controls
        window.addEventListener('keydown', (e) => {
            switch (e.key.toLowerCase()) {
                case 'w': this.moveForward = true; break;
                case 's': this.moveBackward = true; break;
                case 'a': this.moveLeft = true; break;
                case 'd': this.moveRight = true; break;
                case 'c': this.moveUp = true; break;
                case 'x': this.moveDown = true; break;
                case ' ': // Space to create crater at look direction
                    this.createCraterAtLookDirection(5);
                    break;
            }
        });

        window.addEventListener('keyup', (e) => {
            switch (e.key.toLowerCase()) {
                case 'w': this.moveForward = false; break;
                case 's': this.moveBackward = false; break;
                case 'a': this.moveLeft = false; break;
                case 'd': this.moveRight = false; break;
                case 'c': this.moveUp = false; break;
                case 'x': this.moveDown = false; break;
            }
        });
    }

    createCraterAtLookDirection(radius) {
        // Calculate ray from camera
        const ray = {
            origin: [...this.camera.position],
            direction: this.getLookDirection()
        };

        // Raycast to find hit point
        const hit = this.chunkManager.raycast(ray.origin, ray.direction, 50);
        if (hit) {
            this.chunkManager.createCrater(hit.position[0], hit.position[1], hit.position[2], radius);
        }
    }

    getLookDirection() {
        const direction = [
            Math.sin(this.camera.rotation[0]) * Math.cos(this.camera.rotation[1]),
            Math.sin(this.camera.rotation[1]),
            Math.cos(this.camera.rotation[0]) * Math.cos(this.camera.rotation[1])
        ];

        return normalizeVector(direction);
    }

    update(deltaTime) {
        // Get forward and right vectors
        const forward = [
            Math.sin(this.camera.rotation[0]) * Math.cos(this.camera.rotation[1]),
            0, // No vertical component for forward movement
            Math.cos(this.camera.rotation[0]) * Math.cos(this.camera.rotation[1])
        ];
        normalizeVector(forward);

        const right = [
            Math.sin(this.camera.rotation[0] + Math.PI / 2),
            0,
            Math.cos(this.camera.rotation[0] + Math.PI / 2)
        ];

        // Apply movement
        const moveSpeed = 10 * deltaTime; // Units per second

        if (this.moveForward) {
            this.camera.position[0] += forward[0] * moveSpeed;
            this.camera.position[2] += forward[2] * moveSpeed;
        }
        if (this.moveBackward) {
            this.camera.position[0] -= forward[0] * moveSpeed;
            this.camera.position[2] -= forward[2] * moveSpeed;
        }
        if (this.moveRight) {
            this.camera.position[0] += right[0] * moveSpeed;
            this.camera.position[2] += right[2] * moveSpeed;
        }
        if (this.moveLeft) {
            this.camera.position[0] -= right[0] * moveSpeed;
            this.camera.position[2] -= right[2] * moveSpeed;
        }
        if (this.moveUp) {
            this.camera.position[1] += moveSpeed;
        }
        if (this.moveDown) {
            this.camera.position[1] -= moveSpeed;
        }
    }
}
// Worker pool for multithreaded processing
import { CHUNK_SIZE } from './constants.js';
import { debugLog } from './math-utils.js';

export class WorkerPool {
    constructor(workerCount = navigator.hardwareConcurrency || 4) {
        this.workers = [];
        this.idleWorkers = [];
        this.taskQueue = [];
        this.priorityTaskQueue = [];
        this.taskIdCounter = 0;
        this.callbacks = new Map();
        this.playerPosition = [0, 0, 0];
        this.activeTaskCount = 0;

        // Create workers with better error handling
        for (let i = 0; i < workerCount; i++) {
            try {
                // First try the standard path
                const worker = new Worker('js/worker.js', { type: 'module' });
                this.setupWorker(worker);
            } catch (e) {
                console.warn("Failed to load worker with standard path, trying alternate path:", e);
                try {
                    // Try an alternate path if the first one fails
                    const worker = new Worker('./worker.js', { type: 'module' });
                    this.setupWorker(worker);
                } catch (e2) {
                    console.error("Failed to initialize worker:", e2);
                    // Don't add a worker in this case
                }
            }
        }

        // Log actual number of workers created
        console.log(`WorkerPool initialized with ${this.workers.length} workers`);
    }

    // Update player position for task prioritization
    updatePlayerPosition(x, y, z) {
        this.playerPosition = [x, y, z];
    }

    // Calculate priority based on distance to player
    calculatePriority(chunkX, chunkY, chunkZ) {
        const dx = chunkX * CHUNK_SIZE - this.playerPosition[0];
        const dy = chunkY * CHUNK_SIZE - this.playerPosition[1];
        const dz = chunkZ * CHUNK_SIZE - this.playerPosition[2];

        return dx * dx + dy * dy + dz * dz;
    }

    // Add a task to the queue
    addTask(type, data, callback, transferables = [], priority = false) {
        const taskId = this.taskIdCounter++;

        // Store callback
        this.callbacks.set(taskId, callback);

        const task = {
            taskId,
            type,
            data,
            transferables,
            priority
        };

        // Add priority for chunk tasks
        if (type === 'generateChunk' || type === 'generateMesh') {
            const chunkX = data.chunkX || data.x;
            const chunkY = data.chunkY || data.y;
            const chunkZ = data.chunkZ || data.z;

            // Lower number = higher priority
            task.distancePriority = this.calculatePriority(chunkX, chunkY, chunkZ);
        }

        // Add to appropriate queue
        if (priority) {
            // Insert into priority queue based on distance
            const index = this.priorityTaskQueue.findIndex(t =>
                !t.distancePriority || t.distancePriority > task.distancePriority
            );

            if (index === -1) {
                this.priorityTaskQueue.push(task);
            } else {
                this.priorityTaskQueue.splice(index, 0, task);
            }
        } else {
            this.taskQueue.push(task);
        }

        // Process task immediately if workers are available
        this.processNextTask();
    }

    // Process the next task in the queue
    processNextTask() {
        if (this.idleWorkers.length === 0) return;

        // Get next task (priority queue first)
        const task = this.priorityTaskQueue.shift() || this.taskQueue.shift();
        if (!task) return;

        const worker = this.idleWorkers.pop();

        // Increment active task count
        this.activeTaskCount++;

        // Send task to worker
        worker.postMessage({
            taskId: task.taskId,
            type: task.type,
            data: task.data
        }, task.transferables);
    }

    // Get total tasks (queued + active)
    getTotalTaskCount() {
        return this.taskQueue.length + this.priorityTaskQueue.length + this.activeTaskCount;
    }

    // Terminate all workers (cleanup)
    terminate() {
        for (const worker of this.workers) {
            worker.terminate();
        }
        this.workers = [];
        this.idleWorkers = [];
        this.taskQueue = [];
        this.priorityTaskQueue = [];
        this.callbacks.clear();
    }

    // Helper method to set up a worker
    setupWorker(worker) {
        worker.onmessage = (e) => {
            // Handle multiple possible message formats
            let taskId, result;

            if (e.data.taskId !== undefined) {
                taskId = e.data.taskId;
                // Get result from the appropriate field
                result = e.data.result;
            } else {
                console.error("Received message without taskId:", e.data);
                return;
            }

            // Execute callback for this task
            if (this.callbacks.has(taskId)) {
                const callback = this.callbacks.get(taskId);
                try {
                    callback(result);
                } catch (error) {
                    console.error("Error in task callback:", error);
                }
                this.callbacks.delete(taskId);
            } else {
                console.warn(`No callback found for task ${taskId}`);
            }

            // Decrement active task count
            this.activeTaskCount--;

            // Return worker to idle pool
            this.idleWorkers.push(worker);

            // Process next task if available
            this.processNextTask();
        };

        // Add error handler
        worker.onerror = (err) => {
            console.error("Worker error:", err);

            // Put the worker back in the idle pool
            if (!this.idleWorkers.includes(worker)) {
                this.idleWorkers.push(worker);
                this.activeTaskCount--;
            }
        };

        this.idleWorkers.push(worker);
        this.workers.push(worker);
    }
}
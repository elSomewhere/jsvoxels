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

        // Add timeout checking for tasks
        this.taskTimeoutMs = 5000; // 5 seconds timeout
        this.checkTimeoutsInterval = setInterval(() => this.checkTaskTimeouts(), 1000);
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

        // Deep clone data to avoid buffer detachment issues when we don't want to use transferables
        // This makes a copy instead of transferring the original buffer
        let dataToSend = data;
        let transferablesToUse = [];

        if (transferables && transferables.length > 0) {
            // If transferables are provided, use them
            transferablesToUse = transferables;
        } else {
            // Otherwise, clone the data to avoid detaching buffers
            // Note: We only need to clone ArrayBuffers, the rest can be referenced
            dataToSend = this.cloneDataWithoutBuffers(data);
        }

        const task = {
            taskId,
            type,
            data: dataToSend,
            transferables: transferablesToUse,
            priority,
            timestamp: performance.now() // Add timestamp for timeout detection
        };

        // Add priority for chunk tasks
        if (type === 'generateChunk' || type === 'generateMesh') {
            const chunkX = data.chunkX || data.x;
            const chunkY = data.chunkY || data.y;
            const chunkZ = data.chunkZ || data.z;

            // Lower number = higher priority
            task.distancePriority = this.calculatePriority(chunkX, chunkY, chunkZ);
        }

        // Higher priority for crater tasks and mesh regeneration after destruction
        if (type === 'createCrater' ||
            (type === 'generateMesh' && priority)) {
            task.distancePriority = -1; // Highest priority
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

        return taskId;
    }

    // Helper method to clone data without detaching ArrayBuffers
    cloneDataWithoutBuffers(data) {
        if (!data) return data;

        // For primitive types, return as is
        if (typeof data !== 'object' || data === null) {
            return data;
        }

        // Handle arrays
        if (Array.isArray(data)) {
            return data.map(item => this.cloneDataWithoutBuffers(item));
        }

        // Handle typed arrays by making a copy
        if (ArrayBuffer.isView(data)) {
            return new data.constructor(data);
        }

        // For regular objects, clone each property
        const result = {};
        for (const key in data) {
            if (data.hasOwnProperty(key)) {
                result[key] = this.cloneDataWithoutBuffers(data[key]);
            }
        }
        return result;
    }

    // Process the next task in the queue
    processNextTask() {
        if (this.idleWorkers.length === 0) return;

        // Get next task (priority queue first)
        const task = this.priorityTaskQueue.shift() || this.taskQueue.shift();
        if (!task) return;

        const worker = this.idleWorkers.pop();

        // Track task for timeout detection
        worker.currentTaskId = task.taskId;
        worker.currentTaskStarted = performance.now();

        // Increment active task count
        this.activeTaskCount++;

        // Send task to worker
        worker.postMessage({
            taskId: task.taskId,
            type: task.type,
            data: task.data
        }, task.transferables);
    }

    // Add a method to check for task timeouts
    checkTaskTimeouts() {
        const now = performance.now();
        const timeoutThreshold = now - this.taskTimeoutMs;

        // Check all active tasks
        let timeoutDetected = false;

        // For each worker, check if it's been processing a task for too long
        this.workers.forEach((worker, index) => {
            if (!this.idleWorkers.includes(worker) && worker.currentTaskStarted) {
                if (worker.currentTaskStarted < timeoutThreshold) {
                    console.warn(`Worker ${index} appears stuck on task ${worker.currentTaskId}, restarting worker`);

                    // Create a new worker to replace the stuck one
                    try {
                        const newWorker = new Worker('js/worker.js', { type: 'module' });
                        this.setupWorker(newWorker);

                        // Remove the old worker from the pool
                        this.workers = this.workers.filter(w => w !== worker);

                        // Terminate the stuck worker
                        worker.terminate();

                        // Requeue the task if we know what it was
                        if (worker.currentTaskId !== undefined &&
                            this.callbacks.has(worker.currentTaskId)) {
                            console.log(`Requeuing task ${worker.currentTaskId}`);
                            const callback = this.callbacks.get(worker.currentTaskId);

                            // Requeue with high priority
                            // Note: We don't have the original data, so we can only send an error
                            this.callbacks.delete(worker.currentTaskId);
                            if (callback) {
                                callback({ error: 'Task timed out and was restarted' });
                            }
                        }

                        timeoutDetected = true;
                    } catch (e) {
                        console.error("Failed to create replacement worker:", e);
                    }
                }
            }
        });

        // If we detected a timeout, try processing the next task
        if (timeoutDetected) {
            this.processNextTask();
        }
    }

    // Get total tasks (queued + active)
    getTotalTaskCount() {
        return this.taskQueue.length + this.priorityTaskQueue.length + this.activeTaskCount;
    }

    // Helper method to set up a worker
    setupWorker(worker) {
        worker.currentTaskId = undefined;
        worker.currentTaskStarted = undefined;

        worker.onmessage = (e) => {
            // Reset task tracking
            const taskId = worker.currentTaskId;
            worker.currentTaskId = undefined;
            worker.currentTaskStarted = undefined;

            // Handle message (unchanged)
            let result;

            if (e.data.taskId !== undefined) {
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

    // Terminate all workers (cleanup)
    terminate() {
        // Clear the timeout checking interval
        if (this.checkTimeoutsInterval) {
            clearInterval(this.checkTimeoutsInterval);
            this.checkTimeoutsInterval = null;
        }

        for (const worker of this.workers) {
            worker.terminate();
        }
        this.workers = [];
        this.idleWorkers = [];
        this.taskQueue = [];
        this.priorityTaskQueue = [];
        this.callbacks.clear();
    }
}